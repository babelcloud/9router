import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: authMocks.getProviderConnections,
  updateProviderConnection: authMocks.updateProviderConnection,
  getSettings: authMocks.getSettings,
  getProxyPools: vi.fn().mockResolvedValue([]),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    proxyPoolId: null,
    vercelRelayUrl: "",
  }),
  pickProxyPoolId: vi.fn(),
}));

vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: vi.fn((provider) => provider),
  FREE_PROVIDERS: {},
}));

vi.mock("@/sse/utils/logger.js", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
}));

import {
  classifyProviderError,
  isClaudeRequestSchemaError,
} from "../../open-sse/services/accountFallback.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { markAccountUnavailable } from "../../src/sse/services/auth.js";

const CLAUDE_SCHEMA_ERROR = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "diagnostics: Extra inputs are not permitted",
  },
  request_id: "req_probe",
};

const SCREENSHOT_ERROR = `[claude/claude-opus-5] [400]: ${JSON.stringify(CLAUDE_SCHEMA_ERROR)} (reset after 30s)`;
const CLASSIFICATION = {
  category: "request_schema",
  accountFallback: false,
  cooldownMs: 0,
  comboScope: "provider",
};
const log = { info: vi.fn(), warn: vi.fn() };

function errorResponse(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Claude request schema classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });
    authMocks.updateProviderConnection.mockResolvedValue(undefined);
  });

  it.each([
    ["Anthropic error envelope", "claude", CLAUDE_SCHEMA_ERROR],
    ["raw JSON", "claude", JSON.stringify(CLAUDE_SCHEMA_ERROR)],
    ["status-wrapped JSON", "claude", `[400]: ${JSON.stringify(CLAUDE_SCHEMA_ERROR)}`],
    ["screenshot wrapper with stale cooldown", "claude", SCREENSHOT_ERROR],
    ["quoted field path", "anthropic", { error: { message: "'diagnostics': Extra inputs are not permitted" } }],
    ["context_management leftover", "claude", { error: { message: "context_management: Extra inputs are not permitted" } }],
    ["Claude OAuth provider", "claude", CLAUDE_SCHEMA_ERROR],
    ["Anthropic API-key provider", "anthropic", CLAUDE_SCHEMA_ERROR],
    ["Anthropic-compatible provider", "anthropic-compatible-company", CLAUDE_SCHEMA_ERROR],
    ["invalid anthropic-beta value", "anthropic", {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "anthropic-beta header contains an unsupported value: future-beta-2099-01-01",
      },
    }],
  ])("classifies %s without account fallback", (_name, provider, value) => {
    expect(isClaudeRequestSchemaError(provider, 400, value)).toBe(true);
    expect(classifyProviderError(provider, 400, value)).toEqual(CLASSIFICATION);
  });

  it.each([
    ["non-Claude provider", "openai", 400, CLAUDE_SCHEMA_ERROR],
    ["unauthorized", "claude", 401, CLAUDE_SCHEMA_ERROR],
    ["forbidden", "claude", 403, CLAUDE_SCHEMA_ERROR],
    ["rate limit", "claude", 429, CLAUDE_SCHEMA_ERROR],
    ["server error", "claude", 500, CLAUDE_SCHEMA_ERROR],
    ["invalid_prompt code", "claude", 400, { error: { type: "invalid_request_error", code: "invalid_prompt", message: "diagnostics: Extra inputs are not permitted" } }],
    ["invalid_prompt type", "claude", 400, { error: { type: "invalid_prompt", message: "diagnostics: Extra inputs are not permitted" } }],
    ["invalid_prompt message", "claude", 400, { error: { type: "invalid_request_error", message: "Invalid prompt: diagnostics: Extra inputs are not permitted" } }],
    ["context limit", "claude", 400, { error: { type: "invalid_request_error", message: "prompt is too long: 220000 tokens > 200000 maximum" } }],
    ["model permission", "claude", 400, { error: { type: "invalid_request_error", message: "You do not have access to model claude-opus-5" } }],
    ["account beta permission", "claude", 400, { error: { type: "invalid_request_error", message: "Your account does not have permission to use the anthropic-beta header value" } }],
    ["unsupported beta for account", "claude", 400, { error: { type: "invalid_request_error", message: "Unsupported anthropic-beta header value for this account" } }],
    ["organization beta entitlement", "claude", 400, { error: { type: "invalid_request_error", message: "The anthropic-beta header value is not enabled for this organization" } }],
    ["model beta entitlement", "claude", 400, { error: { type: "invalid_request_error", message: "Model claude-opus-5 does not have access to this anthropic-beta header value" } }],
    ["capacity", "claude", 400, { error: { type: "invalid_request_error", message: "Selected model is at capacity" } }],
    ["overloaded type", "claude", 400, { error: { type: "overloaded_error", message: "diagnostics: Extra inputs are not permitted" } }],
    ["no field path", "claude", 400, { error: { type: "invalid_request_error", message: "Extra inputs are not permitted" } }],
    ["unrelated invalid request", "claude", 400, { error: { type: "invalid_request_error", message: "temperature must be between 0 and 1" } }],
  ])("does not classify %s", (_name, provider, status, value) => {
    expect(isClaudeRequestSchemaError(provider, status, value)).toBe(false);
  });

  it("does not persist an account lock when the defensive marker receives the schema 400", async () => {
    authMocks.getProviderConnections.mockResolvedValue([{
      id: "claude-account-1",
      provider: "claude",
      displayName: "Subash",
      backoffLevel: 0,
    }]);

    const result = await markAccountUnavailable(
      "claude-account-1",
      400,
      SCREENSHOT_ERROR,
      "claude",
      "claude-opus-5",
    );

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(authMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it.each([
    "Your account does not have permission to use the anthropic-beta header value",
    "Unsupported anthropic-beta header value for this account",
    "The anthropic-beta header value is not enabled for this organization",
    "Model claude-opus-5 does not have access to this anthropic-beta header value",
  ])("keeps beta permission errors on normal account fallback: %s", message => {
    expect(classifyProviderError("claude", 400, {
      error: { type: "invalid_request_error", message },
    })).toEqual({
      category: "provider_error",
      accountFallback: true,
      cooldownMs: 30000,
      comboScope: "model",
    });
  });
});

describe("Claude provider-scoped Combo fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips remaining Claude models after the first schema 400", async () => {
    const firstResponse = errorResponse(400, CLAUDE_SCHEMA_ERROR);
    const handleSingleModel = vi.fn().mockResolvedValue(firstResponse);
    const response = await handleComboChat({
      body: {},
      models: ["cc/claude-opus-5", "cc/claude-sonnet-5"],
      handleSingleModel,
      resolveModelProvider: async () => "claude",
      log,
      autoSwitch: false,
    });

    expect(response).toBe(firstResponse);
    expect(handleSingleModel).toHaveBeenCalledOnce();
  });

  it("continues a heterogeneous Combo after the Claude schema 400", async () => {
    const calls = [];
    const providers = {
      "cc/claude-opus-5": "claude",
      "cc/claude-sonnet-5": "claude",
      "openai/gpt-5.5": "openai",
    };
    const response = await handleComboChat({
      body: {},
      models: Object.keys(providers),
      handleSingleModel: vi.fn(async (_body, model) => {
        calls.push(model);
        return model.startsWith("openai/")
          ? new Response("ok", { status: 200 })
          : errorResponse(400, CLAUDE_SCHEMA_ERROR);
      }),
      resolveModelProvider: async model => providers[model],
      log,
      autoSwitch: false,
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["cc/claude-opus-5", "openai/gpt-5.5"]);
  });

  it.each([429, 502, 503, 504])("keeps normal fallback for HTTP %s", async status => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(errorResponse(status, { message: status === 429 ? "rate limit" : "upstream unavailable" }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const response = await handleComboChat({
      body: {},
      models: ["cc/claude-opus-5", "cc/claude-sonnet-5"],
      handleSingleModel,
      resolveModelProvider: async () => "claude",
      log,
      autoSwitch: false,
    });

    expect(response.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });
});

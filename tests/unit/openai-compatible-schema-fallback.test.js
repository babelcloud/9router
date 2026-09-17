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
  isOpenAICompatibleRequestSchemaError,
} from "../../open-sse/services/accountFallback.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { markAccountUnavailable } from "../../src/sse/services/auth.js";

const LITELLM_PROVIDER = "openai-compatible-responses-ce56549-a10f-4574-ac9f-f6cdee4291c";
const LITELLM_SCHEMA_ERROR = {
  error: {
    message: "litellm.UnsupportedParamsError: bedrock does not support parameters: ['prompt_cache_key'], for model=global.openai.gpt-5.6-luna. To drop these, set `litellm_params['drop_params']=True` or for proxy: `litellm_settings: drop_params: true`. If you want to use these params dynamically send allowed_openai_params=['prompt_cache_key'] in your request. No fallback model group found for original model_group=gpt-5.6-luna. Fallbacks={'*': 'None'}. Received Model Group=gpt-5.6-luna\nAvailable Model Group Fallbacks=None",
    type: "None",
    param: null,
    code: "400",
  },
};
const SCREENSHOT_ERROR = `[${LITELLM_PROVIDER}/gpt-5.6-luna] [400]: ${JSON.stringify(LITELLM_SCHEMA_ERROR)}`;
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

describe("OpenAI-compatible LiteLLM schema classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });
    authMocks.updateProviderConnection.mockResolvedValue(undefined);
  });

  it.each([
    ["LiteLLM envelope", LITELLM_PROVIDER, LITELLM_SCHEMA_ERROR],
    ["raw JSON", LITELLM_PROVIDER, JSON.stringify(LITELLM_SCHEMA_ERROR)],
    ["status-wrapped JSON", LITELLM_PROVIDER, `[400]: ${JSON.stringify(LITELLM_SCHEMA_ERROR)}`],
    ["screenshot wrapper", LITELLM_PROVIDER, SCREENSHOT_ERROR],
    ["does not support parameters only", LITELLM_PROVIDER, {
      error: { message: "bedrock does not support parameters: ['prompt_cache_key']", type: "None", code: "400" },
    }],
  ])("classifies %s without account fallback", (_name, provider, value) => {
    expect(isOpenAICompatibleRequestSchemaError(provider, 400, value)).toBe(true);
    expect(classifyProviderError(provider, 400, value)).toEqual(CLASSIFICATION);
  });

  it.each([
    ["official OpenAI", "openai", 400, LITELLM_SCHEMA_ERROR],
    ["Codex", "codex", 400, LITELLM_SCHEMA_ERROR],
    ["unauthorized", LITELLM_PROVIDER, 401, LITELLM_SCHEMA_ERROR],
    ["forbidden", LITELLM_PROVIDER, 403, LITELLM_SCHEMA_ERROR],
    ["rate limit", LITELLM_PROVIDER, 429, LITELLM_SCHEMA_ERROR],
    ["server error", LITELLM_PROVIDER, 500, LITELLM_SCHEMA_ERROR],
    ["context limit", LITELLM_PROVIDER, 400, { error: { message: "This model's maximum context length is 128000 tokens" } }],
    ["unrelated invalid request", LITELLM_PROVIDER, 400, { error: { message: "temperature must be between 0 and 1" } }],
  ])("does not classify %s", (_name, provider, status, value) => {
    expect(isOpenAICompatibleRequestSchemaError(provider, status, value)).toBe(false);
  });

  it("does not persist an account lock when LiteLLM rejects prompt_cache_key", async () => {
    authMocks.getProviderConnections.mockResolvedValue([{
      id: "litelm",
      provider: LITELLM_PROVIDER,
      displayName: "litelm",
      backoffLevel: 0,
    }]);

    const result = await markAccountUnavailable(
      "litelm",
      400,
      SCREENSHOT_ERROR,
      LITELLM_PROVIDER,
      "gpt-5.6-luna",
    );

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(authMocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});

describe("OpenAI-compatible provider-scoped Combo fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips remaining LiteLLM models after the first schema 400", async () => {
    const firstResponse = errorResponse(400, LITELLM_SCHEMA_ERROR);
    const handleSingleModel = vi.fn().mockResolvedValue(firstResponse);
    const response = await handleComboChat({
      body: {},
      models: ["gpt-6-astra", "gpt-5.6-luna"],
      handleSingleModel,
      resolveModelProvider: async () => LITELLM_PROVIDER,
      log,
      autoSwitch: false,
    });

    expect(response).toBe(firstResponse);
    expect(handleSingleModel).toHaveBeenCalledOnce();
  });

  it("continues a heterogeneous Combo after the LiteLLM schema 400", async () => {
    const calls = [];
    const providers = {
      "gpt-6-astra": LITELLM_PROVIDER,
      "gpt-5.6-luna": LITELLM_PROVIDER,
      "claude-opus-4-8": "claude",
    };
    const response = await handleComboChat({
      body: {},
      models: Object.keys(providers),
      handleSingleModel: vi.fn(async (_body, model) => {
        calls.push(model);
        return model === "claude-opus-4-8"
          ? new Response("ok", { status: 200 })
          : errorResponse(400, LITELLM_SCHEMA_ERROR);
      }),
      resolveModelProvider: async model => providers[model],
      log,
      autoSwitch: false,
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["gpt-6-astra", "claude-opus-4-8"]);
  });

  it.each([429, 502, 503, 504])("keeps normal fallback for HTTP %s", async status => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(errorResponse(status, { message: status === 429 ? "rate limit" : "upstream unavailable" }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const response = await handleComboChat({
      body: {},
      models: ["gpt-6-astra", "gpt-5.6-luna"],
      handleSingleModel,
      resolveModelProvider: async () => LITELLM_PROVIDER,
      log,
      autoSwitch: false,
    });

    expect(response.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });
});

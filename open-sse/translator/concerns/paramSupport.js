import { getCapabilitiesForModel } from "../../providers/capabilities.js";

// Strip request params a given provider/model rejects upstream (e.g. HTTP 400).
// Config-driven: add a rule instead of scattering `delete body.x` across executors.

// Each rule: optional provider, regex match on model, and parameter operations.
// An operation runs only when its source param is present (!== undefined).
const STRIP_RULES = [
  // All Claude models: temperature deprecated/rejected upstream (Anthropic 400). #1748
  { match: /claude/i, drop: ["temperature"] },
  // GitHub Copilot gpt-5.4: temperature unsupported.
  { provider: "github", match: /gpt-5\.4/i, drop: ["temperature"] },
  // GitHub Copilot Claude (except opus/sonnet 4.6): thinking + reasoning_effort rejected. #713
  { provider: "github", match: (m) => /claude/i.test(m) && !/claude.*(opus|sonnet).*4\.6/i.test(m), drop: ["thinking", "reasoning_effort"] },
  // Cloudflare Workers AI: content must be plain string, rejects OpenAI content-part array (#1926)
  { provider: "cloudflare-ai", flattenContent: true },
  { provider: "volcengine-ark", match: /glm-5/i, clampToModelMaxOutput: true },
  // VolcEngine Ark caps the Kimi family at max_tokens <= 32768, but the model's
  // advertised ceiling is far higher (Kimi-K2.7-Code resolves to maxOutput 262144),
  // so clampToModelMaxOutput alone leaves it uncapped and the request 400s with
  // "integer above maximum value, expected <= 32768". Pin an explicit endpoint cap;
  // min() with the model ceiling still applies if a variant's own limit is lower.
  { provider: "volcengine-ark", match: /kimi/i, maxOutputCap: 32768, clampToModelMaxOutput: true },
  // OpenAI GPT-5.5/5.6 reject the legacy Chat Completions token limit field.
  {
    provider: "openai",
    match: /^(?:gpt-5\.5|gpt-5\.6-(?:sol|terra|luna))(?:\([^()]+\))?$/i,
    rename: { max_tokens: "max_completion_tokens" },
  },
  // Custom OpenAI-compatible nodes (LiteLLM / Bedrock) reject OpenAI prompt caching.
  // Official openai/codex keep prompt_cache_key.
  {
    provider: (p) => typeof p === "string" && p.startsWith("openai-compatible-"),
    drop: ["prompt_cache_key"],
  },
  // Strict OpenAI-compatible validators reject unknown assistant-message fields.
  // Clients that talk to reasoning models (e.g. Hermes) echo the prior turn's
  // reasoning back on every assistant message; Groq answers 400 and Mistral 422
  // ("extra_forbidden") on it, which knocks these providers out of every
  // multi-turn combo. Providers that *require* the field (DeepSeek, Kimi) are
  // handled by reasoningContentInjector and are not listed here.
  { provider: "groq", dropMessageFields: ["reasoning_content", "reasoning", "reasoning_details"] },
  { provider: "mistral", dropMessageFields: ["reasoning_content", "reasoning", "reasoning_details"] },
  { provider: "cerebras", dropMessageFields: ["reasoning_content", "reasoning", "reasoning_details"] },
];

function matchesValue(matcher, value) {
  if (!matcher) return true;
  return typeof matcher === "function" ? matcher(value) : matcher.test(value);
}

function matchesProvider(rule, provider) {
  if (!rule.provider) return true;
  return typeof rule.provider === "function"
    ? rule.provider(provider)
    : rule.provider === provider;
}

// Test a rule's match (regex or predicate) against the model id.
function matches(rule, model) {
  return matchesValue(rule.match, model);
}

function clampNumber(body, key, ceiling) {
  if (typeof body[key] === "number" && Number.isFinite(body[key]) && body[key] > ceiling) {
    body[key] = ceiling;
  }
}

// Remove unsupported params from body in place; returns body.
export function stripUnsupportedParams(provider, model, body) {
  if (!model || !body || typeof body !== "object") return body;
  for (const rule of STRIP_RULES) {
    if (!matchesProvider(rule, provider)) continue;
    if (!matches(rule, model)) continue;
    for (const key of rule.drop || []) {
      if (body[key] !== undefined) delete body[key];
    }
    for (const [source, target] of Object.entries(rule.rename || {})) {
      if (body[source] === undefined || source === target) continue;
      if (body[target] === undefined) body[target] = body[source];
      delete body[source];
    }
    // Per-message field drop (assistant turns only — that is where clients replay reasoning).
    if (Array.isArray(rule.dropMessageFields) && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!msg || msg.role !== "assistant") continue;
        for (const key of rule.dropMessageFields) {
          if (msg[key] !== undefined) delete msg[key];
        }
      }
    }
    // CF Workers AI oneOf root schema only accepts content as plain string (#1926)
    if (rule.flattenContent && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg && Array.isArray(msg.content)) {
          msg.content = msg.content
            .map(b => (b?.type === "text" && typeof b.text === "string") ? b.text : "")
            .join("");
        }
      }
    }
    if (rule.clampToModelMaxOutput || Number.isFinite(rule.maxOutputCap)) {
      const modelCeiling = getCapabilitiesForModel(provider, model).maxOutput;
      const candidates = [];
      if (rule.clampToModelMaxOutput && Number.isFinite(modelCeiling) && modelCeiling > 0) {
        candidates.push(modelCeiling);
      }
      if (Number.isFinite(rule.maxOutputCap) && rule.maxOutputCap > 0) {
        candidates.push(rule.maxOutputCap);
      }
      if (candidates.length > 0) {
        const ceiling = Math.min(...candidates);
        clampNumber(body, "max_tokens", ceiling);
        clampNumber(body, "max_completion_tokens", ceiling);
        clampNumber(body, "max_output_tokens", ceiling);
      }
    }
  }
  return body;
}

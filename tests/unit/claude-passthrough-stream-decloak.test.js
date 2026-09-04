/**
 * Regression: Claude → Claude streaming uses createPassthroughStreamWithLogger
 * because needsTranslation(claude, claude) is false. translateResponse()'s
 * decloakStreamChunk hook therefore never runs, and OAuth-cloaked tool names
 * (CLAUDE_TOOL_SUFFIX / "_ide") leak to the client.
 *
 * toolNameMap is the LAST optional arg of createPassthroughStreamWithLogger
 * (do not insert it as the 3rd positional — that shifts model/connectionId).
 */
import { describe, expect, it } from "vitest";

import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { CLAUDE_TOOL_SUFFIX } from "../../open-sse/config/appConstants.js";

const CLOAKED = "run_code" + CLAUDE_TOOL_SUFFIX;
const ORIGINAL = "run_code";

const toolUseStart = (name) => ({
  type: "content_block_start",
  index: 1,
  content_block: { type: "tool_use", id: "toolu_01XYZ", name, input: {} },
});

async function runPassthrough(input, toolNameMap = null) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });

  const output = stream.pipeThrough(
    createPassthroughStreamWithLogger(
      "claude",
      null,
      "claude-sonnet-5",
      "conn-1",
      null,
      null,
      null,
      toolNameMap,
    ),
  );

  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const dataLines = (sse) =>
  sse
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));

describe("Claude passthrough stream decloaks OAuth tool names", () => {
  const toolNameMap = new Map([[CLOAKED, ORIGINAL]]);

  it("restores the original name on tool_use content_block_start", async () => {
    const sse = [
      "event: content_block_start",
      `data: ${JSON.stringify(toolUseStart(CLOAKED))}`,
      "",
    ].join("\n");

    const out = await runPassthrough(sse, toolNameMap);
    expect(out).not.toContain(CLOAKED);
    expect(out).toContain(`"name":"${ORIGINAL}"`);
    const start = dataLines(out).find((c) => c.type === "content_block_start");
    expect(start.content_block.name).toBe(ORIGINAL);
  });

  it("leaves the cloaked name when no map is passed (8th arg stays optional)", async () => {
    const sse = `data: ${JSON.stringify(toolUseStart(CLOAKED))}\n`;
    const out = await runPassthrough(sse);
    expect(out).toContain(CLOAKED);
    expect(dataLines(out)[0].content_block.name).toBe(CLOAKED);
  });

  it("passes through decoy / unknown tool names", async () => {
    const sse = `data: ${JSON.stringify(toolUseStart("Bash"))}\n`;
    const out = await runPassthrough(sse, toolNameMap);
    expect(dataLines(out)[0].content_block.name).toBe("Bash");
  });

  it("does not rewrite text deltas or input_json_delta", async () => {
    const delta = {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "{\"q\":1}" },
    };
    const sse = `data: ${JSON.stringify(delta)}\n`;
    const out = await runPassthrough(sse, toolNameMap);
    expect(dataLines(out)[0]).toEqual(delta);
  });

  it("decloaks a content_block_start that arrives without a trailing newline", async () => {
    const sse = `data: ${JSON.stringify(toolUseStart(CLOAKED))}`;
    const out = await runPassthrough(sse, toolNameMap);
    expect(out).not.toContain(CLOAKED);
    expect(out).toContain(`"name":"${ORIGINAL}"`);
  });

  it("does not treat toolNameMap as the 3rd positional (model) argument", async () => {
    // If someone ports decolua#2392 and inserts toolNameMap as arg 3,
    // "claude-sonnet-5" would be the map and this assertion would fail.
    const sse = `data: ${JSON.stringify(toolUseStart(CLOAKED))}\n`;
    const out = await runPassthrough(sse, toolNameMap);
    expect(dataLines(out)[0].content_block.name).toBe(ORIGINAL);
  });

  it("still forwards OpenAI-shaped chunks when a cloak map is present", async () => {
    const chunk = {
      id: "chatcmpl-test123",
      object: "chat.completion.chunk",
      created: 1,
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
    };
    const sse = `data: ${JSON.stringify(chunk)}\n`;
    const out = await runPassthrough(sse, toolNameMap);
    const parsed = dataLines(out)[0];
    expect(parsed.choices[0].delta.content).toBe("hi");
    expect(out).not.toContain(CLOAKED);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/providers/llm.ts";
import { getProfile, listModels, MINIMAX_DEFAULT } from "../src/providers/models.ts";
import { tempHome } from "./helpers.ts";

/** A stand-in for api.minimax.io/v1: records request bodies and streams back thinking plus a tool call. */
async function fakeMiniMax() {
  const bodies: any[] = [];
  const srv = createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ object: "list", data: [{ id: "MiniMax-M3.1-Flash" }, { id: "MiniMax-M3" }, { id: "MiniMax-Next" }] }));
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.setHeader("content-type", "text/event-stream");
      const chunks = [
        { choices: [{ delta: { reasoning_content: "The user wants a file. " } }] },
        { choices: [{ delta: { reasoning_content: "I'll read it." } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
      ];
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  return { bodies, srv, base: `http://127.0.0.1:${(srv.address() as any).port}/v1` };
}

test("MiniMax is a built-in provider, even when a saved config lists providers", () => {
  const home = tempHome({ providers: [{ name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" }, { name: "ollama", baseUrl: "http://10.0.0.2:11434/v1" }] });
  const cfg = home.config();
  assert.deepEqual(cfg.providers.find((p) => p.name === "minimax"), { name: "minimax", baseUrl: "https://api.minimax.io/v1", apiKeyEnv: "MINIMAX_API_KEY" });
  assert.equal(cfg.providers.find((p) => p.name === "ollama")?.baseUrl, "http://10.0.0.2:11434/v1", "the user's own edits stay");
  assert.equal(getProfile(home, MINIMAX_DEFAULT).contextWindow, 1_000_000);
});

test("MiniMax calls keep its thinking for tool calls and skip OpenRouter-only fields", async () => {
  const { bodies, srv, base } = await fakeMiniMax();
  const home = tempHome({ providers: [{ name: "minimax", baseUrl: base, apiKeyEnv: "MINIMAX_API_KEY" }, { name: "other", baseUrl: base }] });
  home.setEnv("MINIMAX_API_KEY", "sk-cp-test-key-0123456789abcdef");
  try {
    const tools = [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }];
    const res = await complete(home, { model: MINIMAX_DEFAULT, messages: [{ role: "user", content: "read a.txt" }], tools, jsonMode: true });
    assert.equal(res.reasoning, "The user wants a file. I'll read it.");
    assert.equal(res.toolCalls[0].function.name, "read_file");
    const first = bodies[0];
    assert.equal(first.model, "MiniMax-M3.1-Flash");
    assert.equal(first.reasoning_split, true);
    assert.equal(first.response_format, undefined, "MiniMax has no JSON mode");
    assert.equal(first.usage, undefined, "OpenRouter's usage flag is not sent");

    const history = [
      { role: "user" as const, content: "read a.txt" },
      { role: "assistant" as const, content: null, tool_calls: res.toolCalls, reasoning_content: res.reasoning },
      { role: "tool" as const, tool_call_id: res.toolCalls[0].id, name: "read_file", content: "hello" },
    ];
    await complete(home, { model: MINIMAX_DEFAULT, messages: history, tools });
    assert.equal(bodies[1].messages[1].reasoning_content, "The user wants a file. I'll read it.", "thinking goes back with its tool calls");
    await complete(home, { model: "other:some-model", messages: history, tools });
    assert.equal(bodies[2].messages[1].reasoning_content, undefined, "other providers never see it");
    assert.deepEqual(bodies[2].usage, { include: true });

    const models = await listModels(home);
    assert.deepEqual(models.filter((m) => m.provider === "minimax").map((m) => m.ref), ["minimax:MiniMax-M3.1-Flash", "minimax:MiniMax-M3", "minimax:MiniMax-Next"]);
  } finally {
    srv.close();
  }
});

test("MiniMax models are not listed until a key is saved", async () => {
  const home = tempHome();
  assert.equal((await listModels(home)).filter((m) => m.provider === "minimax").length, 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Harness } from "../src/harness.ts";
import { asCreditsError, CreditsError, ProviderError } from "../src/providers/client.ts";
import { complete } from "../src/providers/llm.ts";
import * as store from "../src/store.ts";
import { mock, reply, tempHome } from "./helpers.ts";

const OPENROUTER_402 = `402 Payment Required: {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 2454. To increase, visit https://openrouter.ai/workspaces/default/keys/abc and adjust the key's total limit","code":402}}`;

test("credit errors are recognised for OpenRouter and MiniMax", () => {
  const or = asCreditsError(new ProviderError(OPENROUTER_402, 402), "openrouter");
  assert.ok(or instanceof CreditsError);
  assert.equal(or.affordable, 2454);
  assert.equal(or.requested, 65536);
  assert.ok(!or.message.includes("openrouter.ai"), "no key URL leaks into the message");
  assert.ok(asCreditsError(new ProviderError("insufficient balance (status_code 1008)", 402), "minimax"));
  assert.equal(asCreditsError(new ProviderError("500 Internal Server Error", 500), "openrouter"), null);
});

test("a low balance that still covers a reply retries with a reply length that fits", async () => {
  const seen: (number | undefined)[] = [];
  mock("lowbalance", (req) => {
    seen.push(req.maxTokens);
    if (req.maxTokens === undefined) throw new ProviderError(OPENROUTER_402, 402);
    return reply("fits");
  });
  const home = tempHome();
  const res = await complete(home, { model: "mock:lowbalance", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.content, "fits");
  assert.deepEqual(seen, [undefined, 2454 - 64]);
});

test("an empty balance ends the chat turn with a credits card, not a raw error", async () => {
  mock("broke", () => {
    throw new ProviderError(OPENROUTER_402.replace("2454", "120"), 402);
  });
  const home = tempHome({ defaults: { chatModel: "mock:broke", taskModel: "mock:broke", reflectorModel: "mock:broke", judgeModel: "mock:broke" } });
  const h = new Harness(home);
  const chat = store.createChat(home, {});
  const turn = await h.chat(chat.id, "hello", { model: "mock:broke" });
  assert.deepEqual(turn.failure, { kind: "credits", provider: "mock", affordable: 120 });
  assert.ok(!turn.content.includes("402"), turn.content);
  assert.ok(!turn.content.includes("openrouter.ai"));
});

test("MiniMax's 200-with-JSON error body becomes a credits error", async () => {
  const srv = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ base_resp: { status_code: 1008, status_msg: "insufficient balance" } }));
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}/v1`;
  const home = tempHome({ providers: [{ name: "minimax", baseUrl: base, apiKeyEnv: "MINIMAX_API_KEY" }] });
  home.setEnv("MINIMAX_API_KEY", "sk-test-0123456789");
  try {
    await assert.rejects(complete(home, { model: "minimax:MiniMax-M3.1-Flash", messages: [{ role: "user", content: "hi" }] }), (e) => e instanceof CreditsError && e.provider === "minimax");
  } finally {
    srv.close();
  }
});

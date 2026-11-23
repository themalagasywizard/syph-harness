// Switching models in the middle of a chat: the new model gets a history it can accept, and its
// answer always reaches the chat.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.ts";
import { store } from "../src/index.ts";
import { compactHistory } from "../src/context.ts";
import { normalizeHistory } from "../src/providers/llm.ts";
import type { ChatMessage } from "../src/types.ts";
import { call, mock, reply, tempHome } from "./helpers.ts";

/** What a strict provider (Anthropic, OpenAI) checks before it answers. */
function assertValid(messages: ChatMessage[]) {
  const ids = new Set<string>();
  const open = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool") {
      assert.ok(open.delete(m.tool_call_id!), `tool result ${m.tool_call_id} answers a call just before it`);
      continue;
    }
    assert.equal(open.size, 0, "every call has its result before the next message");
    for (const c of m.tool_calls ?? []) {
      assert.match(c.id, /^[A-Za-z0-9_-]+$/);
      assert.ok(!ids.has(c.id), `tool call id ${c.id} is unique`);
      ids.add(c.id);
      open.add(c.id);
    }
    if (m.role === "assistant" && !m.tool_calls?.length) assert.ok(m.content, "assistant text is not empty");
  }
  assert.equal(open.size, 0);
}

test("history from one model is made valid for another", () => {
  const raw: ChatMessage[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "x", arguments: "" } }] },
    { role: "tool", tool_call_id: "call_0", name: "x", content: "1" },
    { role: "assistant", content: "" },
    { role: "user", content: "b" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "x", arguments: "{}" } }, { id: "tool:1/2", type: "function", function: { name: "y", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_0", name: "x", content: "2" },
    { role: "tool", tool_call_id: "ghost", name: "z", content: "orphan" },
    { role: "user", content: "c" },
  ];
  const out = normalizeHistory(raw);
  assertValid(out);
  assert.equal(out.filter((m) => m.role === "tool").length, 3, "the missing result is filled in, the orphan dropped");
  assert.equal(out.find((m) => m.role === "tool" && m.content === "2")?.tool_call_id, out[5].tool_calls![0].id, "results keep pointing at their call");
});

test("switching models mid-chat: the new model's answer shows up", async () => {
  const home = tempHome();
  const h = new Harness(home.root);
  await h.init({ scheduler: false } as any);
  let n = 0;
  // The first model reuses one call id for every call, as some providers do.
  mock("main", () => (n++ < 2 ? reply("", [{ ...call("list_files", { path: "." }), id: "call_0" }]) : reply("A's answer")));
  mock("strict", (req) => {
    assertValid(req.messages);
    return reply("B's answer");
  });
  const c = store.createChat(h.home, { model: "mock:main" });
  assert.equal((await h.chat(c.id, "look around", {})).content, "A's answer");
  const tokens: string[] = [];
  const t = await h.chat(c.id, "now you", { model: "mock:strict", emit: (e) => e.type === "token" && tokens.push(e.text) });
  assert.equal(t.content, "B's answer");
  assert.equal(store.getChat(h.home, c.id)!.turns.at(-1)!.content, "B's answer");
});

test("a model that keeps replying with nothing says so instead of leaving a blank answer", async () => {
  const home = tempHome();
  const h = new Harness(home.root);
  await h.init({ scheduler: false } as any);
  mock("silent", () => ({ ...reply(""), finishReason: "length" }));
  const c = store.createChat(h.home, { model: "mock:silent" });
  const t = await h.chat(c.id, "hello", {});
  assert.match(t.content, /empty reply twice.*length/);
});

test("fitting a long chat into a smaller window never fails the run", async () => {
  const long: ChatMessage[] = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i} ${"x".repeat(2000)}` }) as ChatMessage);
  let started = false;
  let asked = 0;
  const out = await compactHistory(long, 8000, async (t) => {
    asked = t.length;
    throw new Error("context too long");
  }, () => (started = true));
  assert.ok(started, "the user is told it is summarising");
  assert.ok(asked <= 12_100, "the summary request is cut to fit");
  assert.match(out[0].content!, /dropped to fit/);
  assert.ok(out.length < long.length);
});

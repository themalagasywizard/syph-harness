// Harness upgrades for long tasks: lean context, exits, budgets, contracts, progress and checks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../src/loop.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { builtinTools } from "../src/tools/builtin.ts";
import { elideToolResult, shrinkToolResults } from "../src/context.ts";
import { Harness } from "../src/harness.ts";
import { store } from "../src/index.ts";
import { headTail } from "../src/util.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { call, mock, reply, tempHome } from "./helpers.ts";

const ctxFor = (home: ReturnType<typeof tempHome>): ToolContext => ({ home, workspace: home.path("workspace"), runId: "r", approve: async () => false, propose: () => { throw new Error("no"); }, hooks: {} });

test("long outputs keep their head and tail; old tool results become stubs", () => {
  const s = "a".repeat(5000) + "THE END";
  const ht = headTail(s, 1000);
  assert.ok(ht.length < 1100 && ht.endsWith("THE END") && ht.startsWith("aaa"));
  assert.equal(elideToolResult("short"), "short");
  assert.match(elideToolResult("x".repeat(5000), 100), /dropped to save context/);
  const msgs = [1, 2, 3].map((i) => ({ role: "tool" as const, name: "read_file", tool_call_id: String(i), content: String(i).repeat(5000) }));
  const out = shrinkToolResults(msgs, 1, 100);
  assert.ok(out[0].content!.length < 400 && out[1].content!.length < 400);
  assert.equal(out[2].content, msgs[2].content);
});

test("read_file pages long files and fails loudly", async () => {
  const home = tempHome();
  writeFileSync(join(home.path("workspace"), "big.txt"), Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n"));
  const reg = new ToolRegistry(builtinTools);
  const r = await reg.execute("read_file", JSON.stringify({ path: "big.txt" }), ctxFor(home));
  assert.match(r.result, /lines 1-400 of 1000; read more with startLine=401/);
  assert.ok(!r.result.includes("line 401"));
  const missing = await reg.execute("read_file", JSON.stringify({ path: "nope.txt" }), ctxFor(home));
  assert.equal(missing.ok, false);
});

test("the loop stops when the same error comes back twice", async () => {
  const home = tempHome();
  let calls = 0;
  mock("main", (req) => (req.tools?.length ? (calls++, reply("", [call("read_file", { path: "missing.txt" })])) : reply("I need the file missing.txt to exist.")));
  const res = await runAgent({ home, model: "mock:main", messages: [{ role: "user", content: "read it" }], tools: new ToolRegistry(builtinTools), ctx: ctxFor(home) });
  assert.equal(res.stopReason, "repeated_error");
  assert.equal(calls, 2);
  assert.match(res.content, /missing\.txt/);
});

test("the step budget pauses the run instead of looping on", async () => {
  const home = tempHome();
  let n = 0;
  mock("main", (req) => (req.tools?.length ? reply("", [call("list_files", { path: ".", depth: n++ % 6 })]) : reply("Status: listed files, nothing else done.")));
  const res = await runAgent({ home, model: "mock:main", messages: [{ role: "user", content: "go" }], tools: new ToolRegistry(builtinTools), ctx: ctxFor(home), maxSteps: 3 });
  assert.equal(res.stopReason, "budget");
  assert.equal(n, 3);
  assert.match(res.content, /Status/);
});

test("context is trimmed inside a long turn, and history keeps only stubs of tool output", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  writeFileSync(join(home.path("workspace"), "huge.txt"), Array.from({ length: 400 }, () => "x".repeat(150)).join("\n"));
  let step = 0;
  let sawTrim = false;
  mock("main", (req) => {
    step++;
    const tool = req.messages.filter((m) => m.role === "tool");
    if (tool.length >= 2 && tool[0].content!.length < 3000) sawTrim = true;
    return step <= 3 ? reply("", [call("read_file", { path: "huge.txt", startLine: step, endLine: 400 })]) : reply("done");
  });
  // A small window so three reads of a 60 KB file overflow it.
  const { saveProfile } = await import("../src/providers/models.ts");
  saveProfile(home, { id: "mock:main", contextWindow: 30000, nativeTools: true, strategy: "direct", fewShot: 0 });
  const chat = store.createChat(home, {});
  await h.chat(chat.id, "read the file three times");
  assert.ok(sawTrim, "older tool results were trimmed mid-turn");
  const saved = store.getChat(home, chat.id)!;
  for (const m of saved.history.filter((m) => m.role === "tool")) assert.ok(m.content!.length < 3000, "history keeps stubs");
});

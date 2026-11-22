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

test("contract: writes outside scope are refused, and checks gate 'done'", async () => {
  const home = tempHome({ approval: { yolo: true } });
  const h = await new Harness(home).init({ mcp: false });
  const ws = home.path("workspace");
  let fixed = false;
  mock("main", (req) => {
    const last = req.messages.at(-1)!;
    const tools = req.messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");
    if (!tools.length) return reply("", [call("set_contract", { goal: "Make ok.txt say yes", scope: ["src/**", "ok.txt"], never: ["db/**"], done_when: [{ text: "ok.txt says yes", command: process.platform === "win32" ? "findstr yes ok.txt" : "grep -q yes ok.txt" }] })]);
    if (tools.length === 1) return reply("", [call("write_file", { path: "db/config.txt", content: "hack" })]);
    if (tools.length === 2) return reply("", [call("write_file", { path: "ok.txt", content: "no" })]);
    if (last.role === "user" && /checks and 1 failed/.test(last.content ?? "")) {
      fixed = true;
      return reply("", [call("write_file", { path: "ok.txt", content: "yes" })]);
    }
    return reply("All done.");
  });
  const chat = store.createChat(home, {});
  const events: string[] = [];
  const turn = await h.chat(chat.id, "make ok.txt say yes", { emit: (e) => events.push(e.type) });
  const db = turn.toolCalls!.find((c) => c.name === "write_file" && (c.args as any).path === "db/config.txt")!;
  assert.equal(db.ok, false);
  assert.match(db.result!, /off limits/);
  assert.ok(fixed, "the failed check went back to the model");
  assert.equal(turn.checks![0].status, "pass");
  assert.equal(turn.recap!.checks!.passed, 1);
  assert.ok(events.includes("contract") && events.includes("checks"));
  const { readProgress } = await import("../src/longtask.ts");
  assert.equal(readProgress(home, `chat-${chat.id}`).contract!.goal, "Make ok.txt say yes");
  const { existsSync } = await import("node:fs");
  assert.ok(!existsSync(join(ws, "db/config.txt")));
});

test("progress survives turns and task runs; ask_user ends the turn with options", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  const seen: string[] = [];
  mock("main", (req) => {
    const sys = req.messages[0].content ?? "";
    seen.push(sys);
    const lastUser = req.messages.findLastIndex((m) => m.role === "user");
    const tools = req.messages.slice(lastUser).filter((m) => m.role === "tool").length;
    if (/remember/.test(req.messages[lastUser].content ?? "") && !tools) return reply("", [call("note_progress", { decision: "snake_case fields in v2" })]);
    if (/streaming/.test(req.messages[lastUser].content ?? "") && !tools) return reply("", [call("ask_user", { question: "Stream /v1/export or paginate it?", options: ["Stream", "Paginate"] })]);
    return reply("ok");
  });
  const chat = store.createChat(home, {});
  await h.chat(chat.id, "remember the naming rule");
  const asked = await h.chat(chat.id, "what about streaming?");
  assert.deepEqual(asked.question, { question: "Stream /v1/export or paginate it?", options: ["Stream", "Paginate"] });
  assert.equal(asked.stopReason, "question");
  assert.match(seen.at(-1)!, /snake_case fields in v2/);
  // A scheduled task: the second run sees what the first one saved.
  const task = store.upsertTask(home, { name: "nightly", prompt: "remember this", schedule: "0 3 * * *" });
  await h.runTask(task.id);
  store.patchTask(home, task.id, { prompt: "carry on" });
  seen.length = 0;
  await h.runTask(task.id);
  assert.match(seen[0], /snake_case fields in v2/);
});

test("git checkpoints go to a side ref and leave the branch alone", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { checkpointCommit, git } = await import("../src/repos.ts");
  const dir = mkdtempSync(join(tmpdir(), "syph-ckpt-"));
  const id = { name: "T", email: "t@example.com" };
  await git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "a.txt"), "1");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-qm", "init"], { identity: id });
  assert.equal(await checkpointCommit(dir, "chat-x", "nothing", id), null);
  writeFileSync(join(dir, "a.txt"), "2");
  writeFileSync(join(dir, "new.txt"), "n");
  const sha = await checkpointCommit(dir, "chat-x", "Checkpoint: step", id);
  assert.ok(sha);
  const status = (await git(dir, ["status", "--porcelain"])).stdout;
  assert.match(status, /a\.txt/);
  assert.match(status, /new\.txt/);
  assert.match((await git(dir, ["show", "--stat", sha!])).stdout, /new\.txt/);
  assert.equal((await git(dir, ["log", "--oneline"])).stdout.trim().split("\n").length, 1);
});

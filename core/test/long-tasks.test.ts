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

test("attachments: documents are inlined, images reach vision models only", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  const { saveProfile } = await import("../src/providers/models.ts");
  const { wireMessages } = await import("../src/providers/client.ts");
  let last: any = null;
  mock("main", (req) => ((last = req), reply("seen")));
  const chat = store.createChat(home, {});
  const note = h.saveUpload(chat.id, "notes.md", Buffer.from("# Plan\nShip on Friday").toString("base64"));
  const png = h.saveUpload(chat.id, "shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
  assert.equal(note.kind, "text");
  assert.equal(h.saveUpload(chat.id, "notes.md", "eA==").name, "notes (2).md");
  saveProfile(home, { id: "mock:main", contextWindow: 30000, nativeTools: true, strategy: "direct", fewShot: 0, vision: false });
  await h.chat(chat.id, "read these", { attachments: [note, png] });
  const user = last.messages.findLast((m: any) => m.role === "user");
  assert.match(user.content, /Ship on Friday/);
  assert.match(user.content, /can't see images/);
  assert.equal(user.images, undefined);
  saveProfile(home, { id: "mock:main", contextWindow: 30000, nativeTools: true, strategy: "direct", fewShot: 0, vision: true });
  await h.chat(chat.id, "and now?", { attachments: [png] });
  const wired = wireMessages(last.messages) as any[];
  assert.equal(wired.findLast((m) => m.role === "user").content[1].type, "image_url");
  // Images are not kept in history, and paths outside uploads/ are ignored.
  assert.ok(store.getChat(home, chat.id)!.history.every((m) => !m.images));
  const turn = await h.chat(chat.id, "sneaky", { attachments: [{ name: "x", path: "/etc/passwd", kind: "text", size: 1 }] });
  assert.equal(store.getChat(home, chat.id)!.turns.at(-2)!.attachments, undefined);
  assert.equal(turn.content, "seen");
});

test("a message sent mid-run reaches the agent at its next step", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let sawSteer = false;
  mock("main", async (req) => {
    if (req.messages.some((m) => m.role === "user" && m.content?.includes("use tabs"))) sawSteer = true;
    if (!req.messages.some((m) => m.role === "tool")) {
      await gate;
      return reply("", [call("list_files", {})]);
    }
    return reply("done");
  });
  const chat = store.createChat(home, {});
  h.startChat(chat.id, "format the files");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(h.queueMessage(chat.id, "use tabs, not spaces"), { ok: true, queued: 1 });
  release();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(sawSteer);
  const saved = store.getChat(home, chat.id)!;
  assert.deepEqual(saved.turns.at(-1)!.steering, ["use tabs, not spaces"]);
  assert.ok(saved.history.some((m) => m.role === "user" && m.content?.includes("use tabs")));
  assert.throws(() => h.queueMessage(chat.id, "late"), /isn't running/);
});

test("long-task mode drafts a contract with read-only tools until the user approves", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  const offered: string[][] = [];
  mock("main", (req) => {
    offered.push((req.tools ?? []).map((t) => t.function.name));
    const tools = req.messages.slice(req.messages.findLastIndex((m) => m.role === "user")).filter((m) => m.role === "tool").length;
    return tools ? reply("Contract ready for review.") : reply("", [call("set_contract", { goal: "Migrate endpoints", done_when: [{ text: "tests pass", command: "npm test" }] })]);
  });
  const chat = store.createChat(home, {});
  await h.chat(chat.id, "migrate 40 endpoints", { mode: "long" });
  assert.ok(!offered[0].includes("write_file") && offered[0].includes("set_contract"));
  let p = h.progressOf(chat.id);
  assert.equal(p.contract!.draft, true);
  assert.equal(p.contract!.goal, "Migrate endpoints");
  p = h.updateContract(chat.id, { doneWhen: [{ text: "tests pass", command: "npm test -- --run" }], approve: true });
  assert.equal(p.contract!.draft, undefined);
  offered.length = 0;
  await h.chat(chat.id, "approved, go");
  assert.ok(offered[0].includes("write_file"));
});

test("app tools load on demand, and the prompt prefix is cache-friendly", async () => {
  const { z } = await import("zod");
  const { defineTool } = await import("../src/tools/types.ts");
  const { findToolsTool } = await import("../src/longtask.ts");
  const { wireMessages } = await import("../src/providers/client.ts");
  const mail = defineTool({ name: "gmail_send", description: "Send an email with Gmail.", schema: z.object({}), permission: "auto", run: () => "sent" });
  const cal = defineTool({ name: "calendar_list", description: "List calendar events.", schema: z.object({}), permission: "auto", run: () => "none" });
  const reg: ToolRegistry = new ToolRegistry([...builtinTools, findToolsTool((ctx) => reg.hidden(ctx)), mail, cal], {}, ["gmail_send", "calendar_list"]);
  const home = tempHome();
  const ctx = { ...ctxFor(home), loadedTools: new Set<string>() };
  ctx.hooks.loadTools = (n) => n.forEach((x) => ctx.loadedTools.add(x));
  assert.ok(!reg.specs(ctx).some((t) => t.name === "gmail_send"));
  const r = await reg.execute("find_tools", JSON.stringify({ query: "send an email" }), ctx);
  assert.match(r.result, /gmail_send/);
  assert.ok(reg.specs(ctx).some((t) => t.name === "gmail_send"));
  assert.ok(!reg.specs(ctx).some((t) => t.name === "calendar_list"));
  // Cache breakpoints on the system prompt and the newest user message only.
  const wired = wireMessages([{ role: "system", content: "s" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }], true) as any[];
  assert.equal(wired[0].content[0].cache_control.type, "ephemeral");
  assert.equal(typeof wired[1].content, "string");
  assert.equal(wired[3].content[0].cache_control.type, "ephemeral");
  const { buildSystemPrompt } = await import("../src/context.ts");
  const sys = buildSystemPrompt(home, { model: "mock:main", query: "x", connectors: "# Connectors\nnone", extra: "# Progress so far" });
  assert.ok(sys.indexOf("# Connectors") < sys.indexOf("Today is") && sys.indexOf("Today is") < sys.indexOf("# Progress so far"));
});

test("scope globs, repo maps and the Tasks command allow-list", async () => {
  const { scopeViolation } = await import("../src/scope.ts");
  const c = { goal: "g", scope: ["api/routes/**", "tests/api/"], never: ["db/**"], doneWhen: [], updatedAt: "" };
  assert.equal(scopeViolation(c, "api/routes/v2/users.ts"), null);
  assert.equal(scopeViolation(c, "tests/api/a.test.ts"), null);
  assert.match(scopeViolation(c, "auth/login.ts")!, /outside this task's scope/);
  assert.match(scopeViolation(c, "db/config.ts")!, /off limits/);
  const { mkdtempSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { repoMap } = await import("../src/repos.ts");
  const dir = mkdtempSync(join(tmpdir(), "syph-map-"));
  writeFileSync(join(dir, "AGENTS.md"), "# Rules\n## Error format\n## Naming\n");
  mkdirSync(join(dir, "api"));
  writeFileSync(join(dir, "api", "RULES.md"), "# API rules\n");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "README.md"), "# nope");
  const map = repoMap(dir, "demo");
  assert.match(map, /demo\/AGENTS\.md: Rules · Error format · Naming/);
  assert.match(map, /demo\/api\/RULES\.md/);
  assert.ok(!map.includes("node_modules"));
  // Unattended tasks run only the commands the user allowed for Tasks.
  const home = tempHome({ approval: { taskCommands: ["echo ok"] } });
  const h = await new Harness(home).init({ mcp: false });
  mock("main", (req) => {
    const t = req.messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");
    if (t.length === 0) return reply("", [call("shell", { command: "echo ok" })]);
    if (t.length === 1) return reply("", [call("shell", { command: "echo nope" })]);
    return reply(t.join(" | "));
  });
  const task = store.upsertTask(home, { name: "t", prompt: "run", schedule: "0 3 * * *" });
  await h.runTask(task.id);
  const out = store.getChat(home, store.listTasks(home)[0].lastChatId!)!.turns.at(-1)!.content;
  assert.match(out, /exit code: 0[\s\S]*declined/);
});

test("short requests nudge at 30 steps; planned long tasks run to completion", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  let n = 0;
  let nudged = false;
  mock("main", (req) => {
    if (req.messages.some((m) => m.role === "user" && m.content?.startsWith("[Harness] This request has taken"))) nudged = true;
    const u = req.messages[req.messages.findLastIndex((m) => m.role === "user" && !m.content?.startsWith("[Harness]"))].content ?? "";
    n++;
    if (/big job/.test(u)) {
      if (n === 1) return reply("", [call("update_plan", { steps: [{ text: "a", status: "in_progress" }, { text: "b" }, { text: "c" }] })]);
      return n < 75 ? reply("", [call("search_files", { pattern: `p${n}` })]) : reply("All done.");
    }
    return nudged ? reply("Done, it was smaller than it looked.") : reply("", [call("search_files", { pattern: `q${n}` })]);
  });
  const chat = store.createChat(home, {});
  const small = await h.chat(chat.id, "quick look");
  assert.ok(nudged, "asked to plan at the short budget");
  assert.equal(small.stopReason, undefined);
  assert.equal(small.content, "Done, it was smaller than it looked.");
  n = 0;
  nudged = false;
  const big = await h.chat(chat.id, "a big job");
  assert.equal(big.stopReason, undefined, "a long task isn't paused for Continue");
  assert.ok(n >= 75);
  assert.ok(!nudged);
});

test("a run with many mistakes is reviewed and a fix is proposed in Evolve", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  mock("main", (req) => {
    const t = req.messages.filter((m) => m.role === "tool").length;
    return t < 4 ? reply("", [call("read_file", { path: `missing-${t}.csv` })]) : reply("I couldn't find the data.");
  });
  let seen = "";
  mock("reflector", (req) => {
    seen = req.messages.map((m) => m.content).join("\n");
    return reply(JSON.stringify({ diagnosis: "It guessed file names instead of listing the folder.", question: "do", kind: "skill", title: "Add a find-data-files skill", reason: "List before reading.", files: [{ path: "skills/find-data-files/SKILL.md", content: "---\nname: find-data-files\ndescription: Find data files before reading them\n---\n1. list_files first.\n" }] }));
  });
  const chat = store.createChat(home, {});
  const turn = await h.chat(chat.id, "summarise my sales data");
  assert.equal(turn.review?.status, "running");
  for (let i = 0; i < 50 && store.getChat(home, chat.id)!.turns.at(-1)!.review?.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
  const review = store.getChat(home, chat.id)!.turns.at(-1)!.review!;
  assert.equal(review.status, "proposed");
  assert.match(seen, /FAILED read_file/);
  const p = h.proposals().find((x) => x.id === review.proposalId)!;
  assert.equal(p.kind, "skill");
  assert.equal(p.status, "pending");
  assert.match(p.reason, /listing the folder/);
});

test("a run that only takes notes is told to act, gets the tool it named, and stops if it still stalls", async () => {
  const { z } = await import("zod");
  const { defineTool } = await import("../src/tools/types.ts");
  const { findToolsTool, noteProgressTool } = await import("../src/longtask.ts");
  let wrote = 0;
  const write = defineTool({ name: "sheets_write", description: "Write values to a Google Sheet range.", schema: z.object({ range: z.string() }), permission: "auto", run: () => (wrote++, "Wrote 10 rows.") });
  const reg: ToolRegistry = new ToolRegistry([...builtinTools, noteProgressTool, findToolsTool((ctx) => reg.hidden(ctx)), write], {}, ["sheets_write"]);
  const home = tempHome();
  const mkCtx = () => {
    const ctx = { ...ctxFor(home), loadedTools: new Set<string>() };
    ctx.hooks.loadTools = (n) => n.forEach((x) => ctx.loadedTools.add(x));
    ctx.hooks.progress = () => "Noted.";
    return ctx;
  };
  // Stalls until sheets_write is in its tools, then writes.
  let i = 0;
  mock("main", (req) => {
    const has = req.tools?.some((t) => t.function.name === "sheets_write");
    if (has && !wrote) return reply("", [call("sheets_write", { range: "A2:L11" })]);
    if (wrote) return reply("Done: wrote 10 rows.");
    return reply("", [call("note_progress", { decision: `Issuing sheets_write for A2:L11 now (${i++}).` })]);
  });
  const ok = await runAgent({ home, model: "mock:main", messages: [{ role: "user", content: "update the sheet" }], tools: reg, ctx: mkCtx() });
  assert.equal(wrote, 1, "the named hidden tool was loaded and used");
  assert.equal(ok.content, "Done: wrote 10 rows.");
  assert.equal(i, 3, "nudged after three note-only steps");

  // A model that never acts is stopped with a clear reason instead of looping forever.
  let notes = 0;
  mock("main", (req) => (req.tools?.length ? reply("", [call("note_progress", { decision: `Writing now (${notes++}).` })]) : reply("I could not make the write call.")));
  const stalled = await runAgent({ home, model: "mock:main", messages: [{ role: "user", content: "update the sheet" }], tools: reg, ctx: mkCtx(), isLong: () => true });
  assert.equal(stalled.stopReason, "repeated_error");
  assert.ok(notes <= 9, `stopped after ${notes} notes`);
  assert.match(stalled.content, /could not/);
});

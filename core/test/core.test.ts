import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { nextRun, parseCron } from "../src/cron.ts";
import { parseTextToolCalls, toTextToolMessages } from "../src/providers/llm.ts";
import { runAgent } from "../src/loop.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { builtinTools } from "../src/tools/builtin.ts";
import { acceptProposal, createProposal, rollbackProposal } from "../src/evolve/proposals.ts";
import { buildSystemPrompt, compactHistory } from "../src/context.ts";
import { addExample, retrieve } from "../src/examples.ts";
import { Harness } from "../src/harness.ts";
import { saveProfile } from "../src/providers/models.ts";
import { store } from "../src/index.ts";
import { Scheduler } from "../src/scheduler.ts";
import { call, lastUser, mock, reply, tempHome } from "./helpers.ts";

test("cron parses and finds the next run", () => {
  const from = new Date(2026, 10, 22, 7, 59); // Sun 22 Nov 2026 07:59 local
  assert.equal(nextRun("0 8 * * *", from)!.getHours(), 8);
  const weekday = nextRun("0 8 * * 1-5", from)!;
  assert.equal(weekday.getDay(), 1);
  assert.equal(nextRun("*/15 * * * *", from)!.getMinutes(), 0);
  assert.throws(() => parseCron("61 * * * *"));
  assert.throws(() => parseCron("* * *"));
});

test("text tool protocol round-trips for models without native tools", () => {
  const { content, toolCalls } = parseTextToolCalls('Let me look.\n<tool_call>{"name": "read_file", "arguments": {"path": "a.txt"}}</tool_call>');
  assert.equal(content, "Let me look.");
  assert.equal(toolCalls[0].function.name, "read_file");
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { path: "a.txt" });
  const bad = parseTextToolCalls("<tool_call>{not json}</tool_call>");
  assert.equal(bad.toolCalls[0].function.name, "__malformed__");
  const msgs = toTextToolMessages(
    [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [toolCalls[0]] },
      { role: "tool", tool_call_id: "x", name: "read_file", content: "data" },
    ],
    [{ name: "read_file", description: "read", parameters: {} }],
  );
  assert.match(msgs[0].content!, /# Tools/);
  assert.equal(msgs.at(-1)!.role, "user");
  assert.match(msgs.at(-1)!.content!, /tool_result/);
});

test("agent loop runs tools and returns the final answer", async () => {
  const home = tempHome();
  writeFileSync(join(home.path("workspace"), "config.env"), "PORT=8421\n");
  mock("main", (req) => (req.messages.some((m) => m.role === "tool") ? reply("PORT is 8421.") : reply("", [call("read_file", { path: "config.env" })])));
  const res = await runAgent({
    home,
    model: "mock:main",
    messages: [{ role: "system", content: "s" }, { role: "user", content: "port?" }],
    tools: new ToolRegistry(builtinTools),
    ctx: { home, workspace: home.path("workspace"), runId: "r", approve: async () => false, propose: () => { throw new Error("no"); }, hooks: {} },
  });
  assert.equal(res.content, "PORT is 8421.");
  assert.deepEqual(res.toolsCalled, ["read_file"]);
});

test("loop repairs malformed tool calls and bad arguments", async () => {
  const home = tempHome();
  let n = 0;
  mock("main", () => (n++ === 0 ? reply("", [call("read_file", { wrong: 1 })]) : reply("done")));
  const res = await runAgent({
    home,
    model: "mock:main",
    messages: [{ role: "user", content: "x" }],
    tools: new ToolRegistry(builtinTools),
    ctx: { home, workspace: home.path("workspace"), runId: "r", approve: async () => false, propose: () => { throw new Error("no"); }, hooks: {} },
  });
  const toolMsg = res.added.find((m) => m.role === "tool")!;
  assert.match(toolMsg.content!, /invalid arguments/);
  assert.equal(res.content, "done");
});

test("file tools cannot escape the workspace", async () => {
  const home = tempHome();
  const reg = new ToolRegistry(builtinTools);
  const ctx = { home, workspace: home.path("workspace"), runId: "r", approve: async () => false, propose: () => { throw new Error("no"); }, hooks: {} };
  const r = await reg.execute("read_file", JSON.stringify({ path: "../.env" }), ctx);
  assert.equal(r.ok, false);
  assert.match(r.result, /outside the workspace/);
  const shell = await reg.execute("shell", JSON.stringify({ command: "echo hi" }), ctx);
  assert.match(shell.result, /declined/);
});

test("proposals: protected paths are refused, accept and rollback are exact", () => {
  const home = tempHome();
  assert.throws(() => createProposal(home, { kind: "prompt", title: "x", reason: "x", files: [{ path: "evals/cases/a.json", content: "{}" }], source: "reflector" }), /protected/);
  assert.throws(() => createProposal(home, { kind: "prompt", title: "x", reason: "x", files: [{ path: "prompts/judge.md", content: "easy" }], source: "reflector" }), /protected/);
  assert.throws(() => createProposal(home, { kind: "prompt", title: "x", reason: "x", files: [{ path: "../outside.md", content: "x" }], source: "reflector" }));
  const before = home.read("prompts/system.md");
  const p = createProposal(home, { kind: "prompt", title: "Add line", reason: "r", files: [{ path: "prompts/system.md", content: before + "\n- New rule.\n" }], source: "reflector" });
  assert.match(p.diff, /\+- New rule\./);
  acceptProposal(home, p.id);
  assert.match(home.read("prompts/system.md")!, /New rule/);
  rollbackProposal(home, p.id);
  assert.equal(home.read("prompts/system.md"), before);
});

test("context includes memory, skills and retrieved examples within budget", () => {
  const home = tempHome();
  home.write("memory/user.md", "# About the user\n\n- Prefers metric units.\n");
  saveProfile(home, { id: "mock:small", contextWindow: 8000, nativeTools: false, strategy: "verify", fewShot: 2 });
  addExample(home, { input: "Convert 5 miles to km", output: "8.05 km", model: "x", source: "manual" });
  addExample(home, { input: "Bake a cake", output: "…", model: "x", source: "manual" });
  const sys = buildSystemPrompt(home, { model: "mock:small", query: "convert 10 miles to km please" });
  assert.match(sys, /Prefers metric units/);
  assert.match(sys, /summarise:/);
  assert.match(sys, /8\.05 km/);
  assert.doesNotMatch(sys, /Bake a cake/);
  assert.equal(retrieve(home, "miles to km", 1)[0].output, "8.05 km");
});

test("history compaction summarises instead of dropping", async () => {
  const big = "word ".repeat(3000);
  const history = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `${i} ${big}` }));
  const out = await compactHistory(history, 8000, async () => "SUMMARY");
  assert.ok(out.length < history.length);
  assert.match(out[0].content!, /SUMMARY/);
  assert.equal(out.at(-1)!.content, history.at(-1)!.content);
});

test("harness chat: streams, saves turns, proposes memory, rating makes an example", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  mock("main", (req) => (req.messages.some((m) => m.role === "tool") ? reply("Noted, metric it is.") : reply("", [call("propose_memory", { fact: "Prefers metric units." })])));
  const chat = store.createChat(home, {});
  const events: string[] = [];
  const turn = await h.chat(chat.id, "Remember I prefer metric units", { emit: (e) => events.push(e.type) });
  assert.equal(turn.content, "Noted, metric it is.");
  assert.ok(events.includes("token") && events.includes("tool_result") && events.includes("run_end"));
  const saved = store.getChat(home, chat.id)!;
  assert.equal(saved.turns.length, 2);
  assert.equal(saved.title, "Remember I prefer metric units");
  const pending = h.proposals().filter((p) => p.status === "pending");
  assert.equal(pending[0].kind, "memory");
  await h.decide(pending[0].id, "accept");
  assert.match(home.read("memory/user.md")!, /metric/);
  h.rate(chat.id, turn.id, "up");
  assert.equal(retrieve(home, "prefer metric units", 1).length, 1);
  assert.equal(h.runs().at(-1)!.status, "ok");
});

test("approval: ask-tools wait for the user in chat", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  mock("main", (req) => (req.messages.some((m) => m.role === "tool") ? reply(String(req.messages.find((m) => m.role === "tool")!.content).includes("hello-from-shell") ? "ran" : "blocked") : reply("", [call("shell", { command: "echo hello-from-shell" })])));
  const chat = store.createChat(home, {});
  const turn = await h.chat(chat.id, "run echo", { emit: (e) => { if (e.type === "approval_request") setTimeout(() => h.resolveApproval(e.id, true), 5); } });
  assert.equal(turn.content, "ran");
});

test("scheduler runs a due task and records the result", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  mock("main", () => reply("digest done"));
  const t = store.upsertTask(home, { name: "Digest", prompt: "Make the digest", schedule: "* * * * *" });
  const s = new Scheduler(home, (task) => h.runTask(task.id).then(() => undefined));
  await s.tick(new Date(Date.now() + 61_000));
  const after = store.listTasks(home).find((x) => x.id === t.id)!;
  assert.equal(after.lastStatus, "ok");
  assert.equal(store.getChat(home, after.lastChatId!)!.turns.at(-1)!.content, "digest done");
});

test("verify strategy revises when the self-check fails", async () => {
  const home = tempHome();
  saveProfile(home, { id: "mock:main", contextWindow: 8000, nativeTools: true, strategy: "verify", fewShot: 0 });
  mock("main", (req) => {
    const sys = req.messages[0]?.content ?? "";
    if (sys.includes("You check an assistant")) return reply(lastUser(req).includes("Answer:\nTOKYO") ? '{"ok": true, "issues": []}' : '{"ok": false, "issues": ["Must be one word in capitals"], "confidence": 0.9}');
    return reply(lastUser(req).includes("review found") ? "TOKYO" : "The capital is Tokyo.");
  });
  const h = await new Harness(home).init({ mcp: false });
  const chat = store.createChat(home, {});
  const turn = await h.chat(chat.id, "Capital of Japan, one word in capitals");
  assert.equal(turn.content, "TOKYO");
});

test("extensions load, add tools and fail safely", async () => {
  const home = tempHome();
  home.write("extensions/wordcount.ts", `export default (syph) => ({ tools: [syph.defineTool({ name: "word_count", description: "Count words", permission: "auto", schema: syph.z.object({ text: syph.z.string() }), run: ({ text }: { text: string }) => String(text.split(/\\s+/).filter(Boolean).length) })], test: () => {} });`);
  home.write("extensions/broken.ts", "export default 42;");
  const h = await new Harness(home).init({ mcp: false });
  assert.ok(h.tools().get("word_count"));
  const r = await h.tools().execute("word_count", '{"text":"a b c"}', { home, workspace: home.path("workspace"), runId: "r", approve: async () => false, propose: () => { throw new Error(); }, hooks: {} });
  assert.equal(r.result, "3");
  assert.equal(h.extensionReports.find((x) => x.name === "broken")!.ok, false);
});

test("budgets stop background spend", async () => {
  const home = tempHome({ budgets: { dailyUsd: { chat: 2, tasks: 0.00001, evolve: 2 } } });
  mock("main", () => reply("ok"));
  const { complete } = await import("../src/providers/llm.ts");
  await complete(home, { model: "mock:main", messages: [{ role: "user", content: "x" }], category: "tasks" });
  await assert.rejects(complete(home, { model: "mock:main", messages: [{ role: "user", content: "x" }], category: "tasks" }), /budget/);
  assert.ok(existsSync(join(home.ledgerDir)));
});

test("keys saved in Settings win over the environment and can be removed", () => {
  const home = tempHome();
  const prev = process.env.SYPH_TEST_KEY;
  process.env.SYPH_TEST_KEY = "from-env";
  try {
    assert.equal(home.env("SYPH_TEST_KEY"), "from-env");
    assert.equal(home.envSource("SYPH_TEST_KEY"), "environment");
    home.setEnv("SYPH_TEST_KEY", "sk-or-v1-abc");
    home.setEnv("OTHER_KEY", "x");
    assert.equal(home.env("SYPH_TEST_KEY"), "sk-or-v1-abc");
    assert.equal(home.envSource("SYPH_TEST_KEY"), "settings");
    home.setEnv("SYPH_TEST_KEY", "sk-or-v1-def");
    assert.equal(home.read(".env")!.match(/SYPH_TEST_KEY=/g)!.length, 1);
    assert.throws(() => home.setEnv("SYPH_TEST_KEY", "a\nEVIL=1"));
    home.setEnv("SYPH_TEST_KEY", null);
    assert.equal(home.env("SYPH_TEST_KEY"), "from-env");
    assert.equal(home.env("OTHER_KEY"), "x");
  } finally {
    if (prev === undefined) delete process.env.SYPH_TEST_KEY;
    else process.env.SYPH_TEST_KEY = prev;
  }
});

test("live chats run in the background, in parallel, and can be re-watched mid-run", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  const gates: Record<string, () => void> = {};
  mock("main", async (req) => {
    const q = lastUser(req);
    await new Promise<void>((r) => (gates[q] = r));
    return reply(`answer to ${q}`);
  });
  const a = store.createChat(home, {});
  const b = store.createChat(home, {});
  h.startChat(a.id, "alpha");
  h.startChat(b.id, "beta");
  assert.deepEqual(h.liveChats(), { [a.id]: "running", [b.id]: "running" });
  assert.throws(() => h.startChat(a.id, "again"), /still working/);
  await new Promise((r) => setTimeout(r, 20));
  // A late watcher gets the replay, then the live end.
  const seen: string[] = [];
  const ended = new Promise<void>((done) => h.watchChat(b.id, (e) => (seen.push(e.type), (e as any).type === "closed" && done())));
  gates.beta();
  gates.alpha();
  await ended;
  assert.equal(seen[0], "run_start");
  assert.ok(seen.includes("run_end"));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.liveChats(), {});
  assert.equal(store.getChat(home, a.id)!.turns.at(-1)!.content, "answer to alpha");
  assert.equal(store.getChat(home, b.id)!.turns.at(-1)!.content, "answer to beta");
  assert.equal(h.watchChat(a.id, () => {}), false);
});

test("stopping a live chat cancels only that chat", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  mock("main", (req) => new Promise((res, rej) => {
    if (lastUser(req) === "quick") return res(reply("quick done"));
    req.signal?.addEventListener("abort", () => rej(new Error("aborted")));
  }));
  const slow = store.createChat(home, {});
  const quick = store.createChat(home, {});
  h.startChat(slow.id, "slow");
  h.startChat(quick.id, "quick");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.stopChat(slow.id), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.getChat(home, slow.id)!.turns.at(-1)!.content, "(stopped)");
  assert.equal(store.getChat(home, quick.id)!.turns.at(-1)!.content, "quick done");
});

test("YOLO mode runs ask-first tools without asking, and frees a waiting one", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  mock("main", (req) => (req.messages.some((m) => m.role === "tool") ? reply(String(req.messages.find((m) => m.role === "tool")!.content).includes("yolo-ok") ? "ran" : "blocked") : reply("", [call("shell", { command: "echo yolo-ok" })])));
  // Waiting for approval, then YOLO is switched on.
  const c1 = store.createChat(home, {});
  const events: string[] = [];
  const t1 = h.chat(c1.id, "run it", { emit: (e) => { events.push(e.type); if (e.type === "approval_request") setTimeout(() => { home.saveConfig({ approval: { yolo: true } } as any); h.approveAllPending(); }, 5); } });
  assert.equal((await t1).content, "ran");
  assert.ok(events.includes("approval_done"));
  // With YOLO on, no approval is requested at all.
  const c2 = store.createChat(home, {});
  const ev2: string[] = [];
  assert.equal((await h.chat(c2.id, "run it", { emit: (e) => ev2.push(e.type) })).content, "ran");
  assert.ok(!ev2.includes("approval_request"));
});

test("each model uses its full context window unless the user set a limit", async () => {
  const { createServer } = await import("node:http");
  const { getProfile, learnContextWindow, saveProfile } = await import("../src/providers/models.ts");
  const srv = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "big/model", context_length: 1_000_000 }, { id: "small/model", context_length: 32_768 }] }));
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as any).port;
  const home = tempHome({ providers: [{ name: "remote", baseUrl: `http://127.0.0.1:${port}/v1` }] });
  try {
    assert.notEqual(getProfile(home, "remote:big/model").contextWindow, 1_000_000, "a default before the provider is asked");
    assert.equal(await learnContextWindow(home, "remote:big/model"), 1_000_000);
    assert.equal(getProfile(home, "remote:big/model").contextWindow, 1_000_000);
    assert.equal(getProfile(home, "remote:small/model").contextWindow, 32_768, "one lookup learns every model the provider lists");
    // A stale saved number doesn't shrink the window; a limit the user chose does.
    saveProfile(home, { ...getProfile(home, "remote:big/model"), contextWindow: 128000 });
    assert.equal(getProfile(home, "remote:big/model").contextWindow, 1_000_000);
    saveProfile(home, { ...getProfile(home, "remote:big/model"), contextWindow: 200_000, contextWindowSet: true });
    assert.equal(getProfile(home, "remote:big/model").contextWindow, 200_000);
  } finally {
    srv.close();
  }
});

test("chat search matches titles and message text, newest first", () => {
  const home = tempHome();
  const a = store.createChat(home, { title: "Newsletter recap" });
  const b = store.createChat(home, { title: "Fix the build" });
  store.saveChat(home, { ...store.getChat(home, b.id)!, turns: [{ id: "t1", role: "user", content: "Why does the weekly newsletter fail to send on Mondays?", createdAt: new Date().toISOString() }] });
  const hits = store.searchChats(home, "newsletter");
  assert.deepEqual(hits.map((h) => h.id).sort(), [a.id, b.id].sort());
  assert.equal(hits.find((h) => h.id === a.id)?.snippet, undefined);
  assert.match(hits.find((h) => h.id === b.id)?.snippet ?? "", /weekly newsletter fail/);
  assert.deepEqual(store.searchChats(home, "newsletter mondays").map((h) => h.id), [b.id]);
  assert.deepEqual(store.searchChats(home, "  "), []);
});

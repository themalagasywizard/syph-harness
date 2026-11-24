import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness } from "../src/harness.ts";
import { store } from "../src/index.ts";
import { linkedFolders, linkFolder, linkProblem } from "../src/folders.ts";
import { builtinTools, resolvePath } from "../src/tools/builtin.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { Terminal } from "../src/terminal.ts";
import { call, mock, reply, tempHome } from "./helpers.ts";

const userFolder = (files: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "syph-user-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
};
/** A tool ran since the user's last message (earlier turns' tool messages stay in the history). */
const ranTool = (req: any) => {
  const i = req.messages.map((m: any) => m.role).lastIndexOf("user");
  return req.messages.slice(i).some((m: any) => m.role === "tool");
};
const toolResult = (req: any) => String([...req.messages].reverse().find((m: any) => m.role === "tool")?.content ?? "");

test("folders: a thread uses its own, its coordinator's and its project's folders", () => {
  const home = tempHome();
  const p = store.createProject(home, { name: "P" });
  const coord = store.getOrCreateCoordinator(home, p.id);
  const thread = store.createChat(home, { projectId: p.id, role: "thread", parentId: coord.id });
  const a = userFolder(), b = userFolder(), c = userFolder();
  linkFolder(home, { projectId: p.id, path: a, access: "read" });
  linkFolder(home, { chatId: coord.id, path: b });
  linkFolder(home, { chatId: thread.id, path: c });
  const list = linkedFolders(home, store.getChat(home, thread.id));
  assert.deepEqual(list.map((f) => [f.path, f.scope, f.access]), [[c, "chat", "write"], [b, "coordinator", "write"], [a, "project", "read"]]);
  // Every other chat in the project (each is a thread of the coordinator) gets the shared ones, not this thread's.
  const other = store.createChat(home, { projectId: p.id });
  assert.deepEqual(linkedFolders(home, store.getChat(home, other.id)).map((f) => f.path), [b, a]);
});

test("folders: Syph's own data, drives and missing folders can't be linked", () => {
  const home = tempHome();
  assert.match(linkProblem(home, home.root)!, /Syph's own data/);
  assert.match(linkProblem(home, join(home.root, ".."))!, /Syph's own data/);
  assert.match(linkProblem(home, "/")!, /whole drive/);
  assert.match(linkProblem(home, join(tmpdir(), "nope-" + Date.now()))!, /no folder/);
  assert.match(linkProblem(home, "relative/path")!, /full path/);
  assert.equal(linkProblem(home, userFolder()), null);
});

test("file tools: read and write in linked folders, nothing outside, no writes in read-only ones", async () => {
  const home = tempHome();
  const rw = userFolder({ "notes.txt": "hello" });
  const ro = userFolder({ "secret.txt": "look only" });
  const outside = userFolder({ "x.txt": "no" });
  const folders = [{ path: rw, name: "rw", access: "write" as const, linkedAt: "", scope: "chat" as const }, { path: ro, name: "ro", access: "read" as const, linkedAt: "", scope: "project" as const }];
  const ctx = { home, workspace: home.path("workspace"), folders, runId: "r", approve: async () => false, propose: () => { throw new Error("no"); }, hooks: {} };
  const reg = new ToolRegistry(builtinTools);
  const run = (name: string, args: unknown) => reg.execute(name, JSON.stringify(args), ctx as any);

  assert.equal((await run("read_file", { path: join(rw, "notes.txt") })).result, "hello");
  assert.equal((await run("read_file", { path: join(ro, "secret.txt") })).result, "look only");
  assert.ok((await run("write_file", { path: join(rw, "sub", "new.md"), content: "# hi" })).ok);
  assert.equal(readFileSync(join(rw, "sub", "new.md"), "utf8"), "# hi");
  assert.ok((await run("edit_file", { path: join(rw, "notes.txt"), old_text: "hello", new_text: "bye" })).ok);
  assert.equal(readFileSync(join(rw, "notes.txt"), "utf8"), "bye");

  const w = await run("write_file", { path: join(ro, "secret.txt"), content: "changed" });
  assert.equal(w.ok, false);
  assert.match(w.result, /read-only/);
  assert.equal(readFileSync(join(ro, "secret.txt"), "utf8"), "look only");

  const r = await run("read_file", { path: join(outside, "x.txt") });
  assert.equal(r.ok, false);
  assert.match(r.result, /outside the workspace/);
  assert.equal((await run("read_file", { path: join(rw, "..", "..", outside, "x.txt") })).ok, false);
  assert.match((await run("list_files", { path: rw })).result, /notes\.txt/);
  // A link inside a linked folder that points outside it doesn't open a way out.
  symlinkSync(outside, join(rw, "escape"), "junction");
  const viaLink = await run("read_file", { path: join(rw, "escape", "x.txt") });
  assert.equal(viaLink.ok, false);
  assert.equal((await run("write_file", { path: join(rw, "escape", "new.txt"), content: "x" })).ok, false);
  assert.ok(!existsSync(join(outside, "new.txt")));
  assert.match((await run("search_files", { pattern: "look", path: ro })).result, /secret\.txt:1/);
  // Relative paths are still the workspace.
  assert.equal(resolvePath(ctx, "a.txt"), join(home.path("workspace"), "a.txt"));
});

test("terminal: a command runs in the linked folder, is logged, and the run sees its output", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  const dir = userFolder({ "data.txt": "x" });
  const chat = store.createChat(home, {});
  h.linkFolder({ chatId: chat.id, path: dir });
  const events: any[] = [];
  mock("main", (req) => (ranTool(req) ? reply(toolResult(req)) : reply("", [call("shell", { command: process.platform === "win32" ? "Get-ChildItem -Name" : "ls" })])));
  const turn = await h.chat(chat.id, "list it", { emit: (e) => { events.push(e); if (e.type === "approval_request") setTimeout(() => h.resolveApproval(e.id, true), 5); } });
  assert.match(turn.content, /data\.txt/);
  assert.match(turn.content, /exit code: 0/);
  const ask = events.find((e) => e.type === "approval_request");
  assert.match(ask.reason, new RegExp(dir.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
  const log = h.terminalState(chat.id).entries;
  assert.equal(log.length, 1);
  assert.equal(log[0].cwd, dir);
  assert.equal(log[0].status, "done");
  assert.ok(events.some((e) => e.type === "terminal" && e.entry.status === "running"));
});

test("terminal: a cwd outside the linked folders is refused before anyone is asked", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  const chat = store.createChat(home, {});
  h.linkFolder({ chatId: chat.id, path: userFolder() });
  let asked = false;
  mock("main", (req) => (ranTool(req) ? reply(toolResult(req)) : reply("", [call("shell", { command: "echo hi", cwd: userFolder() })])));
  const turn = await h.chat(chat.id, "go", { emit: (e) => { if (e.type === "approval_request") asked = true; } });
  assert.equal(asked, false);
  assert.match(turn.content, /outside the workspace/);
});

test("terminal permissions: Allow for this chat, auto mode, and read-only folders that always ask", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  const rw = userFolder();
  const ro = userFolder();
  const chat = store.createChat(home, {});
  h.linkFolder({ chatId: chat.id, path: rw });
  h.linkFolder({ chatId: chat.id, path: ro, access: "read" });
  let cwd = rw;
  mock("main", (req) => (ranTool(req) ? reply(toolResult(req)) : reply("", [call("shell", { command: "echo ok-run", cwd })])));
  let asks = 0;
  const chatOnce = (answer: "session" | "deny" | "none") =>
    h.chat(chat.id, "go", { emit: (e) => {
      if (e.type !== "approval_request") return;
      asks++;
      setTimeout(() => (answer === "session" ? h.allowSession(e.id) : h.resolveApproval(e.id, false)), 5);
    } });

  assert.match((await chatOnce("session")).content, /ok-run/);
  assert.equal(asks, 1);
  assert.equal(h.terminalState(chat.id).session, true);
  // Next command in the same chat: no question.
  assert.match((await chatOnce("deny")).content, /ok-run/);
  assert.equal(asks, 1);
  // A read-only folder still asks.
  cwd = ro;
  assert.match((await chatOnce("deny")).content, /declined/);
  assert.equal(asks, 2);
  // Taking it back: asks again.
  h.endTerminalSession(chat.id);
  cwd = rw;
  assert.match((await chatOnce("deny")).content, /declined/);
  assert.equal(asks, 3);
  // Auto mode in Settings: writable folders run without asking.
  home.saveConfig({ approval: { ...home.config().approval, terminal: "auto" } } as any);
  assert.match((await chatOnce("deny")).content, /ok-run/);
  assert.equal(asks, 3);
});

test("terminal: Stop kills a running command and the model is told", async () => {
  const home = tempHome();
  const t = new Terminal(home);
  const { entry, done } = t.start({ command: process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30", cwd: userFolder(), chatId: "c1", timeoutMs: 60_000 });
  assert.equal(t.log("c1")[0].status, "running");
  setTimeout(() => t.stop(entry.id), 200);
  const end = await done;
  assert.equal(end.status, "stopped");
  assert.equal(t.log("c1")[0].status, "stopped");
});

test("terminal: background commands keep running; command_output and stop_command reach them", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  const dir = userFolder();
  const chat = store.createChat(home, {});
  h.linkFolder({ chatId: chat.id, path: dir });
  home.saveConfig({ approval: { ...home.config().approval, terminal: "auto" } } as any);
  const cmd = process.platform === "win32" ? "Write-Output started; Start-Sleep -Seconds 30" : "echo started; sleep 30";
  let step = 0;
  let id = "";
  mock("main", (req) => {
    step++;
    if (step === 1) return reply("", [call("shell", { command: cmd, background: true })]);
    if (step === 2) {
      id = /as (cmd_\w+)/.exec(toolResult(req))?.[1] ?? "";
      return reply("", [call("command_output", { id })]);
    }
    if (step === 3) return reply("", [call("stop_command", { id })]);
    return reply(toolResult(req));
  });
  const turn = await h.chat(chat.id, "start a server");
  assert.ok(id, "got an id");
  assert.match(turn.content, /Stopped/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.terminal.get(id)?.status, "stopped");
});

test("files written in a linked folder show in the chat", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  const dir = userFolder();
  const chat = store.createChat(home, {});
  h.linkFolder({ chatId: chat.id, path: dir });
  mock("main", (req) => (ranTool(req) ? reply("done") : reply("", [call("write_file", { path: join(dir, "report.md"), content: "# Report" })])));
  const turn = await h.chat(chat.id, "write a report");
  assert.ok(existsSync(join(dir, "report.md")));
  assert.equal(turn.files?.[0]?.path, join(dir, "report.md"));
  assert.equal(turn.files?.[0]?.action, "created");
  assert.ok(h.inLinkedFolder(join(dir, "report.md")));
});

test("the system prompt lists the linked folders", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  const dir = userFolder();
  const chat = store.createChat(home, {});
  h.linkFolder({ chatId: chat.id, path: dir, access: "read" });
  let sys = "";
  mock("main", (req) => ((sys = String(req.messages[0].content)), reply("hi")));
  await h.chat(chat.id, "hello");
  assert.ok(sys.includes(`${dir} (read only`));
  assert.match(sys, /# Terminal/);
});

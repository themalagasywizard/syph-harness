// Project threads: the coordinator starts threads, follows them and reports on them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Harness } from "../src/harness.ts";
import { store } from "../src/index.ts";
import { firstLines } from "../src/threads.ts";
import type { CompletionRequest } from "../src/providers/client.ts";
import { call, mock, reply, tempHome } from "./helpers.ts";

const sys = (req: CompletionRequest) => req.messages[0]?.content ?? "";
const isCoordinator = (req: CompletionRequest) => sys(req).includes("You are this project's coordinator");
const isThread = (req: CompletionRequest) => sys(req).includes("You are working in a thread");
const isBrief = (req: CompletionRequest) => sys(req).startsWith("Write one plain sentence");
const toolNames = (req: CompletionRequest) => (req.tools ?? []).map((t) => t.function.name);
/** Tool results since the last user message. */
const since = (req: CompletionRequest) => req.messages.slice(req.messages.findLastIndex((m) => m.role === "user")).filter((m) => m.role === "tool");
const lastUserText = (req: CompletionRequest) => req.messages.findLast((m) => m.role === "user")?.content ?? "";

async function until(cond: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("Timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup(config: Record<string, unknown> = {}) {
  const home = tempHome(config);
  const h = await new Harness(home).init({ mcp: false });
  const project = store.createProject(home, { name: "Site" });
  const coord = store.getOrCreateCoordinator(home, project.id);
  const idle = async () => {
    await until(() => Object.keys(h.liveChats()).length === 0);
    await h.threads.settled();
    await until(() => Object.keys(h.liveChats()).length === 0);
  };
  return { home, h, project, coord, idle };
}

test("the coordinator starts a thread, gets a card when it ends, and wakes to report", async () => {
  const { home, h, project, coord, idle } = await setup();
  const coordinatorTools: string[][] = [];
  const threadTools: string[][] = [];
  let wokeWith = "";
  mock("main", (req) => {
    if (isBrief(req)) return reply("Wrote notes.md with the three launch steps.");
    if (isCoordinator(req)) {
      coordinatorTools.push(toolNames(req));
      if (lastUserText(req).startsWith("(Syph: your threads changed")) {
        wokeWith = req.messages.map((m) => m.content ?? "").join("\n");
        return reply("The launch notes are done: notes.md has the three steps.");
      }
      return since(req).length ? reply("Started a thread to write the launch notes.") : reply("", [call("start_thread", { title: "Write launch notes", prompt: "Write notes.md with three launch steps." })]);
    }
    if (isThread(req)) {
      threadTools.push(toolNames(req));
      return since(req).length ? reply("Done. I wrote notes.md with the three launch steps.") : reply("", [call("write_file", { path: "notes.md", content: "1. a\n2. b\n3. c\n" })]);
    }
    return reply("plain");
  });

  h.startChat(coord.id, "Write the launch notes");
  await idle();

  const threads = store.listThreads(home, coord.id);
  assert.equal(threads.length, 1);
  const t = threads[0];
  assert.equal(t.title, "Write launch notes");
  assert.equal(t.role, "thread");
  assert.equal(t.projectId, project.id);
  assert.equal(t.threadState, "review_ready", "a thread that changed files waits for review");
  assert.ok(existsSync(join(store.workspaceFor(home, project.id), "notes.md")));

  // Coordinators get the thread tools; threads never do (no threads inside threads).
  assert.ok(coordinatorTools[0].includes("start_thread"));
  assert.ok(!threadTools[0].includes("start_thread") && !threadTools[0].includes("message_thread"));

  const c = store.getChat(home, coord.id)!;
  const card = c.turns.find((x) => x.threadUpdate);
  assert.ok(card, "an update card is posted in the coordinator chat");
  assert.equal(card!.threadUpdate!.threadId, t.id);
  assert.equal(card!.threadUpdate!.state, "review_ready");
  assert.equal(card!.threadUpdate!.summary, "Wrote notes.md with the three launch steps.");
  assert.equal(card!.threadUpdate!.filesChanged, 1);

  // It woke once, read the note in its history, and answered.
  const auto = c.turns.filter((x) => x.auto);
  assert.equal(auto.length, 1);
  assert.match(wokeWith, /Thread update \(from Syph, not the user\): thread .* "Write launch notes" is now review_ready/);
  assert.equal(c.turns.at(-1)!.content, "The launch notes are done: notes.md has the three steps.");
  assert.equal(c.pendingNotes, undefined, "notes are consumed by the turn that read them");
  assert.equal(c.title, "Site", "the coordinator keeps the project's name as its title");

  // Plain chats are untouched: no thread tools, no thread prompt.
  let plainTools: string[] = [];
  mock("main", (req) => ((plainTools = toolNames(req)), reply("hi")));
  const plain = store.createChat(home, { projectId: project.id });
  await h.chat(plain.id, "hello");
  assert.ok(!plainTools.includes("start_thread"));
  await h.close();
});

test("threads past the limit wait in a queue and start as slots free up", async () => {
  const { home, h, coord, idle } = await setup({ agent: { maxThreads: 1, coordinatorWakesPerHour: 0, threadBriefs: false } });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const order: string[] = [];
  mock("main", async (req) => {
    if (isThread(req)) {
      const who = lastUserText(req);
      order.push(who);
      if (who === "first") await gate;
      return reply(`finished ${who}`);
    }
    return reply("ok");
  });
  const a = h.threads.start(coord.id, { title: "First", prompt: "first" });
  const b = h.threads.start(coord.id, { title: "Second", prompt: "second" });
  await until(() => order.length === 1);
  assert.equal(store.getChat(home, a.id)!.threadState, "working");
  assert.equal(store.getChat(home, b.id)!.threadState, "queued");
  assert.match(h.threads.list(coord.id), /Second": queued/);
  release();
  await idle();
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(store.getChat(home, b.id)!.threadState, "done");
  assert.equal(store.getChat(home, b.id)!.queuedStart, undefined);
  // Without wake-ups the coordinator only gets the cards and notes.
  const c = store.getChat(home, coord.id)!;
  assert.equal(c.turns.filter((x) => x.threadUpdate).length, 2);
  assert.equal(c.turns.filter((x) => x.auto).length, 0);
  assert.equal(c.pendingNotes?.length, 2);
  await h.close();
});

test("a thread that asks a question is blocked and doesn't wake the coordinator", async () => {
  const { home, h, coord, idle } = await setup({ agent: { threadBriefs: false } });
  mock("main", (req) => {
    if (isThread(req)) return since(req).length ? reply("Waiting for your answer.") : reply("", [call("ask_user", { question: "Blue or green?", options: ["Blue", "Green"] })]);
    return reply("coordinator spoke");
  });
  const t = h.threads.start(coord.id, { title: "Pick a colour", prompt: "pick" });
  await idle();
  const after = store.getChat(home, t.id)!;
  assert.equal(after.threadState, "blocked");
  const card = store.getChat(home, coord.id)!.turns.find((x) => x.threadUpdate)!;
  assert.equal(card.threadUpdate!.state, "blocked");
  assert.equal(card.threadUpdate!.needs, "Blue or green?");
  assert.equal(store.getChat(home, coord.id)!.turns.filter((x) => x.auto).length, 0);

  // Messaging an idle thread starts a new turn there.
  mock("main", (req) => (isThread(req) ? reply(`Going with ${lastUserText(req)}.`) : reply("ok")));
  assert.match(h.threads.message(coord.id, t.id, "Blue"), /working on your message/);
  await idle();
  assert.equal(store.getChat(home, t.id)!.threadState, "done");
  assert.equal(store.getChat(home, t.id)!.turns.at(-1)!.content, "Going with Blue.");
  // Other coordinators can't reach this thread.
  const other = store.getOrCreateCoordinator(home, store.createProject(home, { name: "Other" }).id);
  assert.throws(() => h.threads.read(other.id, t.id), /No thread/);
  assert.match(h.threads.resolve(coord.id, t.id), /Resolved/);
  assert.equal(store.getChat(home, t.id)!.resolved, true);
  await h.close();
});

test("wake-ups are capped per hour, so two agents can't ping-pong", async () => {
  const { home, h, coord, idle } = await setup({ agent: { coordinatorWakesPerHour: 2, threadBriefs: false } });
  let wakes = 0;
  mock("main", (req) => {
    if (isCoordinator(req)) {
      if (lastUserText(req).startsWith("(Syph:")) {
        if (since(req).length) return reply("Asked for another pass.");
        wakes++;
        // Each wake pokes the thread again: without the cap this would never stop.
        const tid = store.listThreads(home, coord.id)[0].id;
        return reply("", [call("message_thread", { id: tid, text: "again" })]);
      }
      return reply("ok");
    }
    return reply("pass done");
  });
  h.threads.start(coord.id, { title: "Loop", prompt: "go" });
  await idle();
  await new Promise((r) => setTimeout(r, 50));
  await idle();
  assert.equal(wakes, 2);
  assert.equal(store.getChat(home, coord.id)!.wakes!.length, 2);
  await h.close();
});

test("a stopped thread reports stopped; a restart stops threads that were working", async () => {
  const { home, h, coord, idle } = await setup({ agent: { threadBriefs: false, coordinatorWakesPerHour: 0 } });
  mock("main", (req) => new Promise((_r, rej) => req.signal?.addEventListener("abort", () => rej(new Error("aborted")))));
  const t = h.threads.start(coord.id, { title: "Slow", prompt: "go" });
  await until(() => h.isLive(t.id));
  assert.match(h.threads.stop(coord.id, t.id), /Stopping/);
  await idle();
  assert.equal(store.getChat(home, t.id)!.threadState, "stopped");
  store.patchChat(home, t.id, (c) => void (c.threadState = "working"));
  const h2 = await new Harness(home).init({ mcp: false });
  assert.equal(store.getChat(home, t.id)!.threadState, "stopped");
  await h.close();
  await h2.close();
});

test("a task can run as a thread of its project's coordinator", async () => {
  const { home, h, project, coord, idle } = await setup({ agent: { threadBriefs: false, coordinatorWakesPerHour: 0 } });
  mock("main", (req) => reply(isThread(req) ? "Checked the site: all pages load." : "ok"));
  const task = store.upsertTask(home, { name: "Site check", prompt: "check the site", schedule: "0 9 * * *", projectId: project.id, viaCoordinator: true });
  await h.runTask(task.id);
  await idle();
  const threads = store.listThreads(home, coord.id);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].title, "Site check");
  assert.equal(threads[0].progressKey, `task-${task.id}`);
  const card = store.getChat(home, coord.id)!.turns.find((x) => x.threadUpdate)!;
  assert.equal(card.threadUpdate!.summary, "Checked the site: all pages load.");
  await h.close();
});

test("cards keep the first sentences of long answers", () => {
  assert.equal(firstLines("Short answer."), "Short answer.");
  const long = "First sentence here. " + "Second sentence goes on and on. ".repeat(20);
  const out = firstLines(long, 80);
  assert.ok(out.length <= 81 && out.endsWith("."));
  assert.equal(firstLines("# Title\n\n**Bold** `code`"), "Title Bold code");
});

test("coordinator eval cases get the thread tools, and tool_not_called scores", async () => {
  const { runCaseOnce, scoreCheck } = await import("../src/evals/index.ts");
  const home = tempHome();
  mock("main", (req) => (isCoordinator(req) && toolNames(req).includes("start_thread") && !since(req).length ? reply("", [call("start_thread", { title: "Rename photos", prompt: "do it" })]) : reply("Started a thread for it.")));
  const c = { id: "x", input: "Rename my photos", coordinator: true, checks: [{ type: "tool_called" as const, name: "start_thread" }, { type: "tool_not_called" as const, name: "write_file" }], createdAt: "" };
  const out = await runCaseOnce(home, "mock:main", c);
  assert.ok(out.toolsCalled.includes("start_thread"));
  for (const check of c.checks) assert.equal((await scoreCheck(home, check, c, out)).score, 1);
});

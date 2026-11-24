// Project threads: a coordinator chat starts threads (ordinary chats with a parent), follows them,
// and gets a short update card when each one finishes or needs the user. A thread runs through the
// same live-chat path as any chat, so budgets, loop guards, approvals, contracts and Evolve reviews
// all apply unchanged. Nothing here runs for chats that are neither a coordinator nor a thread.
import type { Home } from "./home.ts";
import { progressKey, readProgress } from "./longtask.ts";
import { complete } from "./providers/llm.ts";
import * as store from "./store.ts";
import type { ThreadHooks } from "./tools/types.ts";
import type { ChatRecord, ThreadState, ThreadUpdate, Turn } from "./types.ts";
import { id, now } from "./util.ts";

/** What the thread manager needs from the harness. */
export interface ThreadHost {
  home: Home;
  isLive(chatId: string): boolean;
  /** Start a run in the background (like startChat). */
  startRun(chatId: string, text: string, opts: { model?: string; mode?: "long"; auto?: boolean }): void;
  /** Steer a running chat. */
  steer(chatId: string, text: string): void;
  stop(chatId: string): boolean;
  changed(coordinatorId?: string): void;
}

/** The message a woken coordinator gets. The updates themselves are in its history just before it. */
export const WAKE_TEXT = "(Syph: your threads changed; the updates are just above. Follow up if something is needed — start or message a thread — otherwise tell me the outcome in one or two sentences.)";

/** How long a wake-up waits for other threads that finish at about the same time. */
const WAKE_DELAY_MS = 1500;
const ACTIVE: ThreadState[] = ["queued", "working", "blocked"];
const money = (usd: number) => (usd >= 0.01 ? `$${usd.toFixed(2)}` : usd > 0 ? "<$0.01" : "$0");

/** First lines of an answer, cut to fit a card. */
export function firstLines(text: string, max = 280) {
  const flat = text.replace(/```[\s\S]*?```/g, " ").replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…").trim();
}

/** The state a thread is in after a run, from facts the harness saw. */
export function stateAfterRun(home: Home, chat: ChatRecord, turn: Turn | undefined, cancelled: boolean): { state: ThreadState; needs?: string } {
  if (cancelled || turn?.content === "(stopped)") return { state: "stopped" };
  if (!turn || turn.failure || turn.content.startsWith("Something went wrong")) return { state: "failed", needs: turn?.failure?.kind === "credits" ? "The provider is out of credit." : undefined };
  const contract = readProgress(home, progressKey(chat)).contract;
  if (contract?.draft) return { state: "blocked", needs: "Approve the contract in the thread to start the work." };
  if (turn.stopReason === "question") return { state: "blocked", needs: turn.question?.question ?? "It asked you a question." };
  if (turn.stopReason === "budget") return { state: "blocked", needs: "It reached its budget. Open it and press Continue." };
  if (turn.stopReason === "repeated_error") return { state: "failed" };
  if (turn.stopReason === "checks_failed") return { state: "failed", needs: "Its done-when checks still fail." };
  return { state: (turn.recap?.filesChanged ?? turn.files?.length ?? 0) > 0 ? "review_ready" : "done" };
}

export class Threads {
  /** Threads with a run in progress. */
  private running = new Set<string>();
  /** Coordinators that should wake once their current run ends. */
  private wakeLater = new Set<string>();
  /** Coordinators with a wake-up about to start (updates arriving together share one). */
  private wakeTimers = new Set<string>();
  /** Work still finishing in the background (briefs, posts), so tests and shutdown can wait. */
  private pending = new Set<Promise<unknown>>();

  constructor(private host: ThreadHost) {}

  private get home() {
    return this.host.home;
  }

  private get maxThreads() {
    return Math.max(1, this.home.config().agent.maxThreads ?? 3);
  }

  /** Wait for background posts and briefs (tests). */
  async settled() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track<T>(p: Promise<T>) {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p)).catch(() => {});
    return p;
  }

  /** After a restart nothing is running: threads that were working are stopped, queued ones wait for a slot.
   *  Project chats from before threads become threads of their project's coordinator. */
  recover() {
    for (const c of store.listChats(this.home)) {
      if (!c.role && c.projectId && store.getProject(this.home, c.projectId)) store.adoptIntoProject(this.home, c.id, c.projectId);
      if (c.role !== "thread") continue;
      if (c.threadState === "working") store.patchChat(this.home, c.id, (x) => void (x.threadState = "stopped"));
    }
    this.drain();
  }

  // ---------- Coordinator actions ----------

  /** Start a thread under a coordinator, or queue it when enough are already running. */
  start(coordinatorId: string, t: { title: string; prompt: string; model?: string; long?: boolean }): ChatRecord {
    const coord = store.getChat(this.home, coordinatorId);
    if (!coord || coord.role !== "coordinator") throw new Error("Only a coordinator chat can start threads.");
    const title = t.title.replace(/\s+/g, " ").trim().slice(0, 80) || "Thread";
    const model = t.model ?? coord.model;
    const chat = store.createChat(this.home, { projectId: coord.projectId, title, model, role: "thread", parentId: coordinatorId, threadState: "queued", origin: "coordinator" });
    const start = { prompt: t.prompt, ...(model ? { model } : {}), ...(t.long ? { mode: "long" as const } : {}) };
    store.patchChat(this.home, chat.id, (c) => void (c.queuedStart = start));
    this.drain();
    this.host.changed(coordinatorId);
    return store.getChat(this.home, chat.id) ?? chat;
  }

  /** Start queued threads while there are free slots, oldest first. */
  drain() {
    let free = this.maxThreads - this.running.size;
    if (free <= 0) return;
    const queued = store
      .listChats(this.home)
      .filter((c) => c.role === "thread" && c.threadState === "queued" && !this.host.isLive(c.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const q of queued) {
      if (free <= 0) break;
      const chat = store.getChat(this.home, q.id);
      const start = chat?.queuedStart;
      if (!chat || !start) continue;
      store.patchChat(this.home, chat.id, (c) => {
        delete c.queuedStart;
        c.threadState = "working";
      });
      this.running.add(chat.id);
      free--;
      try {
        this.host.startRun(chat.id, start.prompt, { model: start.model, mode: start.mode });
      } catch (e) {
        this.running.delete(chat.id);
        store.patchChat(this.home, chat.id, (c) => void (c.threadState = "failed"));
        this.post(chat.id, { state: "failed", summary: `It could not start: ${(e as Error).message}` });
      }
    }
  }

  private own(coordinatorId: string, threadId: string) {
    const t = store.getChat(this.home, threadId);
    if (!t || t.parentId !== coordinatorId) throw new Error(`No thread ${threadId} in this project. Use list_threads to see the ids.`);
    return t;
  }

  message(coordinatorId: string, threadId: string, text: string) {
    const t = this.own(coordinatorId, threadId);
    if (this.host.isLive(t.id)) {
      this.host.steer(t.id, text);
      return `Sent to "${t.title}". It reads it at its next step.`;
    }
    if (t.threadState === "queued" && t.queuedStart) {
      store.patchChat(this.home, t.id, (c) => void (c.queuedStart = { ...c.queuedStart!, prompt: `${c.queuedStart!.prompt}\n\n${text}` }));
      return `"${t.title}" is still queued; your message was added to its prompt.`;
    }
    store.patchChat(this.home, t.id, (c) => {
      c.threadState = "queued";
      c.resolved = false;
      c.queuedStart = { prompt: text, ...(t.model ? { model: t.model } : {}) };
    });
    this.drain();
    this.host.changed(coordinatorId);
    const now_ = store.getChat(this.home, t.id);
    return now_?.threadState === "queued" ? `"${t.title}" is queued behind other threads; it starts with your message when a slot frees up.` : `"${t.title}" is working on your message.`;
  }

  list(coordinatorId: string) {
    const threads = store.listThreads(this.home, coordinatorId);
    if (!threads.length) return "No threads yet.";
    return threads
      .map((t) => `- ${t.id} "${t.title}": ${t.threadState ?? "done"}${t.resolved ? " (resolved)" : ""}, ${money(t.costUsd)}${t.summary ? ` — ${t.summary}` : ""}`)
      .join("\n");
  }

  read(coordinatorId: string, threadId: string, lastTurns = 6) {
    const t = this.own(coordinatorId, threadId);
    const turns = t.turns.slice(-lastTurns);
    const lines = [`Thread ${t.id} "${t.title}" — ${t.threadState ?? "done"}${this.host.isLive(t.id) ? " (running now)" : ""}`];
    for (const x of turns) {
      lines.push(`\n[${x.role}${x.auto ? ", from you" : ""}] ${x.content.slice(0, 1500)}${x.content.length > 1500 ? " …" : ""}`);
      if (x.plan?.length) lines.push(`Plan: ${x.plan.map((s) => `${s.status === "done" ? "✓" : s.status === "in_progress" ? "…" : "○"} ${s.text}`).join("; ")}`);
      if (x.files?.length) lines.push(`Files: ${x.files.map((f) => f.path).join(", ")}`);
      if (x.question) lines.push(`Asked the user: ${x.question.question}`);
    }
    if (!turns.length) lines.push("No messages yet.");
    return lines.join("\n");
  }

  stop(coordinatorId: string, threadId: string) {
    const t = this.own(coordinatorId, threadId);
    if (t.threadState === "queued") {
      store.patchChat(this.home, t.id, (c) => {
        delete c.queuedStart;
        c.threadState = "stopped";
      });
      this.host.changed(coordinatorId);
      return `Took "${t.title}" off the queue.`;
    }
    return this.host.stop(t.id) ? `Stopping "${t.title}".` : `"${t.title}" isn't running.`;
  }

  resolve(coordinatorId: string, threadId: string, resolved = true) {
    const t = this.own(coordinatorId, threadId);
    if (resolved && (this.host.isLive(t.id) || t.threadState === "queued")) return `"${t.title}" is still working; stop it first.`;
    store.patchChat(this.home, t.id, (c) => {
      c.resolved = resolved;
      if (resolved && c.threadState === "review_ready") c.threadState = "done";
    });
    this.host.changed(coordinatorId);
    return resolved ? `Resolved "${t.title}".` : `Reopened "${t.title}".`;
  }

  hooksFor(coordinatorId: string): ThreadHooks {
    return {
      start: (t) => {
        const chat = this.start(coordinatorId, t);
        return `Started thread ${chat.id} "${chat.title}"${chat.threadState === "queued" ? " (queued: other threads are running; it starts when a slot frees up)" : ""}. You'll get an update when it finishes or needs the user.`;
      },
      message: (tid, text) => this.message(coordinatorId, tid, text),
      list: () => this.list(coordinatorId),
      read: (tid, n) => this.read(coordinatorId, tid, n),
      stop: (tid) => this.stop(coordinatorId, tid),
      resolve: (tid) => this.resolve(coordinatorId, tid),
    };
  }

  // ---------- Run lifecycle (called by the harness) ----------

  onRunStart(chat: ChatRecord) {
    if (chat.role !== "thread") return;
    this.running.add(chat.id);
    store.patchChat(this.home, chat.id, (c) => {
      c.threadState = "working";
      c.resolved = false;
      delete c.queuedStart;
    });
    this.host.changed(chat.parentId);
  }

  /** The thread is waiting on the user mid-run (an approval). Posts one card, not one per approval. */
  onBlocked(chatId: string, needs: string) {
    const t = store.getChat(this.home, chatId);
    if (t?.role !== "thread" || t.threadState === "blocked") return;
    store.patchChat(this.home, chatId, (c) => void (c.threadState = "blocked"));
    this.post(chatId, { state: "blocked", summary: needs, needs }, { note: false });
  }

  onUnblocked(chatId: string) {
    const t = store.getChat(this.home, chatId);
    if (t?.role !== "thread" || t.threadState !== "blocked" || !this.host.isLive(chatId)) return;
    store.patchChat(this.home, chatId, (c) => void (c.threadState = "working"));
    this.host.changed(t.parentId);
  }

  /** A run ended. Threads: set the state, post the update, start queued work, maybe wake the coordinator. */
  onRunEnd(chatId: string, turn: Turn | undefined, cancelled: boolean) {
    const chat = store.getChat(this.home, chatId);
    if (!chat) return;
    if (chat.role === "coordinator") {
      if (this.wakeLater.delete(chatId)) this.wake(chatId);
      return;
    }
    if (chat.role !== "thread") return;
    this.running.delete(chatId);
    const { state, needs } = stateAfterRun(this.home, chat, turn, cancelled);
    store.patchChat(this.home, chatId, (c) => void (c.threadState = state));
    const base = state === "stopped" ? "Stopped before it finished." : turn ? firstLines(turn.content) : "It ended without an answer.";
    const usage = chat.turns.reduce((s, t) => s + (t.usage?.costUsd ?? 0), 0);
    const facts: Partial<ThreadUpdate> = { recap: turn?.recap, costUsd: usage, filesChanged: turn?.recap?.filesChanged ?? turn?.files?.length ?? 0, ...(needs ? { needs } : {}) };
    this.track(
      (async () => {
        // A chat the user is having themselves needs no brief: they read the answer as it comes.
        const brief = state === "stopped" || !turn || chat.origin === "user" ? null : await this.brief(chat, turn, state).catch(() => null);
        this.post(chatId, { state, summary: brief ?? (needs && state === "blocked" ? needs : base), ...facts }, { wake: state === "done" || state === "review_ready" || state === "failed" });
      })(),
    );
    this.drain();
  }

  /** One sentence on what the thread did, from the reflector (or the chat model). Null when off or it fails. */
  private async brief(chat: ChatRecord, turn: Turn, state: ThreadState) {
    const cfg = this.home.config();
    if (cfg.agent.threadBriefs === false || !turn.content.trim()) return null;
    const model = cfg.defaults.chatModel;
    const facts = [`State: ${state}`, turn.recap ? `Files changed: ${turn.recap.filesChanged}; tool calls: ${turn.recap.toolCalls}, failed: ${turn.recap.failedCalls}${turn.recap.checks ? `; checks ${turn.recap.checks.passed}/${turn.recap.checks.total} passed` : ""}` : ""].filter(Boolean).join("\n");
    const r = await Promise.race([
      complete(this.home, {
        model,
        category: "chat",
        messages: [
          { role: "system", content: "Write one plain sentence (at most 30 words) telling the user what this piece of work achieved, or what it still needs. Use the facts; don't claim more than they show. No preamble." },
          { role: "user", content: `Task: ${chat.title}\n${facts}\n\nFinal answer:\n${turn.content.slice(0, 3000)}` },
        ],
      }),
      new Promise<null>((r) => setTimeout(() => r(null), 20_000).unref?.()),
    ]);
    const text = r?.content?.replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 300) : null;
  }

  /** Post a card in the coordinator chat, and a note it reads on its next turn. */
  private post(threadId: string, u: Omit<ThreadUpdate, "threadId" | "title">, opts: { note?: boolean; wake?: boolean } = {}) {
    const t = store.getChat(this.home, threadId);
    if (!t?.parentId) return;
    const update: ThreadUpdate = { threadId, title: t.title, ...u };
    store.patchChat(this.home, threadId, (c) => void (c.summary = u.summary));
    const turn: Turn = { id: id("tu_"), role: "assistant", content: u.summary, threadUpdate: update, createdAt: now() };
    const note = `Thread update (from Syph, not the user): thread ${threadId} "${t.title}" is now ${u.state}. ${u.summary}${u.needs && u.needs !== u.summary ? ` Needs: ${u.needs}` : ""}${u.filesChanged ? ` Files changed: ${u.filesChanged}.` : ""}${u.costUsd ? ` Cost so far: ${money(u.costUsd)}.` : ""}`;
    // A thread the user started by opening a chat is theirs to follow: the coordinator only gets a note.
    const quiet = t.origin === "user";
    const coord = store.patchChat(this.home, t.parentId, (c) => {
      if (!quiet) c.turns.push(turn);
      if (opts.note !== false) c.pendingNotes = [...(c.pendingNotes ?? []), note];
    });
    this.host.changed(t.parentId);
    if (coord && opts.wake && !quiet) this.maybeWake(coord);
  }

  /** Wake the coordinator so it can react, within the hourly cap (the loop guard between agents). */
  private maybeWake(coord: ChatRecord) {
    const project = coord.projectId ? store.getProject(this.home, coord.projectId) : null;
    if (project?.coordinatorWake === false) return;
    if (this.host.isLive(coord.id)) {
      this.wakeLater.add(coord.id);
      return;
    }
    // Threads often finish close together: wait a moment so one wake-up covers them all.
    if (this.wakeTimers.has(coord.id)) return;
    this.wakeTimers.add(coord.id);
    this.track(
      new Promise<void>((done) =>
        setTimeout(() => {
          this.wakeTimers.delete(coord.id);
          if (this.host.isLive(coord.id)) this.wakeLater.add(coord.id);
          else this.wake(coord.id);
          done();
        }, WAKE_DELAY_MS),
      ),
    );
  }

  private wake(coordinatorId: string) {
    const coord = store.getChat(this.home, coordinatorId);
    if (!coord?.pendingNotes?.length || this.host.isLive(coordinatorId)) return;
    const cap = this.home.config().agent.coordinatorWakesPerHour ?? 6;
    const hourAgo = Date.now() - 3600_000;
    const recent = (coord.wakes ?? []).filter((w) => Date.parse(w) > hourAgo);
    if (cap <= 0 || recent.length >= cap) return;
    store.patchChat(this.home, coordinatorId, (c) => void (c.wakes = [...recent, now()]));
    try {
      this.host.startRun(coordinatorId, WAKE_TEXT, { auto: true });
    } catch {
      /* the coordinator is busy or gone: the notes wait for its next turn */
    }
  }

  /** Threads that still need something (for the project page and the phone). */
  active(coordinatorId: string) {
    return store.listThreads(this.home, coordinatorId).filter((t) => !t.resolved && ACTIVE.includes(t.threadState ?? "done"));
  }
}

// Harness: wires home, tools, context, strategies, traces, tasks and the improvement loop
// together. The server and CLI are thin layers over this class.
import { Connectors } from "./connectors/index.ts";
import { googleWorkspace } from "./connectors/google.ts";
import { GITHUB_API, github, listGithubRepos } from "./connectors/github.ts";
import { activeRepo, allLinkedRepos, cloneAndLink, explainGitError, git, linkedRepos, repoPrompt, repoStatus, repoTools, setActiveRepo, unlinkRepo, type RepoHost } from "./repos.ts";
import { planPrompt, updatePlanTool } from "./plan.ts";
import { connectorAgentTools, connectorPrompt } from "./connectors/agent-tools.ts";
import { buildSystemPrompt, compactHistory, elideToolResult } from "./context.ts";
import { caseFromRun, evalHistory, listCases, runSuite } from "./evals/index.ts";
import { evolveOnce, gate } from "./evolve/engine.ts";
import { acceptProposal, createProposal, getProposal, listProposals, rejectProposal, rollbackProposal, save } from "./evolve/proposals.ts";
import { addExample } from "./examples.ts";
import { exportDatasets } from "./export.ts";
import { loadExtensions, type ExtensionReport } from "./extensions.ts";
import { Home } from "./home.ts";
import { addUsage, emptyUsage, runAgent, STEER_PREFIX } from "./loop.ts";
import { connectMcp, type McpConnection } from "./mcp.ts";
import { complete } from "./providers/llm.ts";
import { getProfile, listModels, saveProfile } from "./providers/models.ts";
import { Scheduler } from "./scheduler.ts";
import { getStrategy } from "./strategies/index.ts";
import * as store from "./store.ts";
import { builtinTools } from "./tools/builtin.ts";
import { ToolRegistry } from "./tools/registry.ts";
import type { Tool, ToolContext } from "./tools/types.ts";
import { Trace, addRating, listRuns } from "./trace.ts";
import type { AgentEvent, ChatMessage, ChatRecord, PlanStep, Task, Turn } from "./types.ts";
import { id, now } from "./util.ts";
import { FileIndex, changedFiles, mentionedFiles, snapshot } from "./files/index.ts";
import { actionAt, checkUi, fillTemplate, flattenItem, getUi, itemsFrom, uiAgentTools, uiPrompt, type UiButton, type UiEnv } from "./ui-ext.ts";
import type { FileRef, RepoLink } from "./types.ts";
import { resolve } from "node:path";

/** Images are sent once, with the message they came with; history keeps the text that names them. */
const stripImages = (m: ChatMessage): ChatMessage => {
  if (!m.images) return m;
  const { images: _drop, ...rest } = m;
  return rest;
};

export interface Job {
  id: string;
  kind: "eval" | "evolve" | "gate" | "task";
  title: string;
  status: "running" | "done" | "error";
  log: string[];
  result?: unknown;
  startedAt: string;
  endedAt?: string;
}

type Listener = (e: { type: "job"; job: Job } | { type: "task"; task: Task } | { type: "proposal"; id: string } | { type: "chats" } | { type: "connectors" } | { type: "ui" }) => void;

interface LiveRun {
  ac: AbortController;
  events: AgentEvent[];
  listeners: Set<(e: AgentEvent) => void>;
}

/** Tools that never write files, so there is nothing to look for after them. */
const READ_ONLY_TOOLS = new Set(["list_files", "read_file", "search_files", "web_fetch", "read_skill", "list_connectors", "list_ui", "propose_ui_change", "propose_skill", "propose_memory", "create_task", "create_connector", "update_plan", "list_repos", "github_repos", "github_api", "github_pr_create"]);
/** Tools that change many files the agent didn't write (a clone, a pull, a checkout): not shown as files it made. */
const QUIET_FILE_TOOLS = new Set(["git", "github_clone"]);

export class Harness {
  readonly home: Home;
  private extTools: Tool[] = [];
  private mcp: McpConnection[] = [];
  extensionReports: ExtensionReport[] = [];
  scheduler?: Scheduler;
  private approvals = new Map<string, { resolve: (ok: boolean) => void; emit: (e: AgentEvent) => void; chatId?: string }>();
  /** Chats that are running right now, each independent of any open window. */
  private live = new Map<string, LiveRun>();
  readonly jobs = new Map<string, Job>();
  private listeners = new Set<Listener>();
  /** App connectors (Google Workspace, and any the agent writes). */
  readonly connectors: Connectors;

  constructor(home?: Home | string) {
    this.home = home instanceof Home ? home : new Home(home);
    this.connectors = new Connectors(this.home, [googleWorkspace, github]);
  }

  async init(opts: { scheduler?: boolean; mcp?: boolean } = {}) {
    this.home.init();
    await this.reloadExtensions();
    await this.connectors.reload();
    if (opts.mcp !== false && this.home.config().mcpServers.length) this.mcp = await connectMcp(this.home.config().mcpServers);
    if (opts.scheduler) {
      this.scheduler = new Scheduler(this.home, (t) => this.runTask(t.id).then(() => undefined));
      this.scheduler.start();
    }
    return this;
  }

  async close() {
    this.scheduler?.stop();
    await Promise.all(this.mcp.map((m) => m.close()));
  }

  async reloadExtensions() {
    const { extensions, reports } = await loadExtensions(this.home);
    this.extTools = extensions.flatMap((e) => e.tools);
    this.extensionReports = reports;
  }

  /** Reload connector tools after keys, sign-in or code changed, and tell open windows. */
  async connectorsChanged() {
    await this.connectors.reload();
    this.broadcast({ type: "connectors" });
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private broadcast: Listener = (e) => this.listeners.forEach((l) => l(e));

  tools(): ToolRegistry {
    const connectorTools = [...connectorAgentTools(this.connectors, () => this.broadcast({ type: "connectors" })), ...this.connectors.tools()];
    return new ToolRegistry([...builtinTools, updatePlanTool, ...this.extTools, ...connectorTools, ...repoTools(this.repoHost), ...uiAgentTools(this.home, () => this.uiEnv()), ...this.mcp.flatMap((m) => m.tools)], this.home.config().toolPermissions ?? {});
  }

  // ---------- GitHub and linked repositories ----------

  private ghIdentity?: { name: string; email: string } | null;

  /** The GitHub connector, when it is set up and switched on. */
  private githubRuntime() {
    const m = this.connectors.manifests().find((x) => x.id === "github");
    if (!m || !this.connectors.isEnabled("github") || this.connectors.state(m) !== "ready") return null;
    return this.connectors.runtime(m);
  }

  private _repoHost?: RepoHost;
  get repoHost(): RepoHost {
    return (this._repoHost ??= this.makeRepoHost());
  }

  private makeRepoHost = (): RepoHost => ({
    home: this.home,
    token: async () => (this.githubRuntime() ? this.connectors.bearerToken("github").catch(() => null) : null),
    identity: async () => {
      if (this.ghIdentity !== undefined) return this.ghIdentity;
      const g = this.githubRuntime();
      if (!g) return null;
      try {
        const u = await g.json(`${GITHUB_API}/user`);
        this.ghIdentity = { name: u.name || u.login, email: `${u.id}+${u.login}@users.noreply.github.com` };
      } catch {
        return null;
      }
      return this.ghIdentity;
    },
    changed: () => this.broadcast({ type: "chats" }),
    yolo: () => !!this.home.config().approval?.yolo,
  });

  /** GitHub as the UI sees it: connected or not, and as whom. */
  githubState() {
    const c = this.connectors.list().find((x) => x.id === "github");
    return { connected: !!c && c.enabled && c.state === "ready", account: c?.account, state: c ? (c.enabled ? c.state : "off") : "missing", error: c?.error };
  }

  async githubRepos(query?: string) {
    const g = this.githubRuntime();
    if (!g) throw Object.assign(new Error("Connect GitHub first: open Connectors and paste a token."), { status: 400 });
    return listGithubRepos(g, { query, max: 300 });
  }

  linkRepo(input: { repo: string; name?: string; scope?: "project" | "chat"; projectId?: string; chatId?: string }) {
    return cloneAndLink(this.repoHost, input);
  }

  unlinkRepo(target: { projectId?: string; chatId?: string }, path: string) {
    unlinkRepo(this.home, target, path);
    this.broadcast({ type: "chats" });
    return { ok: true };
  }

  setActiveRepo(chatId: string, path: string | null) {
    setActiveRepo(this.home, chatId, path);
    this.broadcast({ type: "chats" });
    return { ok: true };
  }

  /** Linked repos with their branch and changes, for a chat or project. */
  async repoStatuses(target: { projectId?: string; chatId?: string }) {
    const chat = target.chatId ? store.getChat(this.home, target.chatId) : null;
    const active = activeRepo(this.home, chat, target.projectId);
    const rows = await Promise.all(linkedRepos(this.home, target).map(repoStatus));
    return rows.map((r) => ({ ...r, active: !!active && resolve(active.path) === resolve(r.path) }));
  }

  /** Push a linked repo's current branch from the UI (sets the upstream the first time; never forces). */
  async pushRepo(path: string) {
    const r = allLinkedRepos(this.home).find((x) => resolve(x.path) === resolve(path));
    if (!r) throw Object.assign(new Error("That folder isn't a linked repo."), { status: 404 });
    const token = r.url.startsWith("https://github.com/") ? await this.repoHost.token() : null;
    const st = await repoStatus(r);
    const args = st.upstream ? ["push"] : ["push", "-u", "origin", "HEAD"];
    const out = await git(r.path, args, { token }).catch((e) => {
      throw Object.assign(new Error(explainGitError((e as Error).message)), { status: 400 });
    });
    this.broadcast({ type: "chats" });
    return { ok: true, output: [out.stdout, out.stderr].join("\n").trim(), status: await repoStatus(r) };
  }

  /** Pull (fast-forward only) a linked repo from the UI. */
  async pullRepo(path: string) {
    const r = allLinkedRepos(this.home).find((x) => resolve(x.path) === resolve(path));
    if (!r) throw Object.assign(new Error("That folder isn't a linked repo."), { status: 404 });
    const token = r.url.startsWith("https://github.com/") ? await this.repoHost.token() : null;
    const out = await git(r.path, ["pull", "--ff-only"], { token }).catch((e) => {
      throw Object.assign(new Error(explainGitError((e as Error).message)), { status: 400 });
    });
    this.broadcast({ type: "chats" });
    return { ok: true, output: [out.stdout, out.stderr].join("\n").trim(), status: await repoStatus(r) };
  }

  /** What interface changes may refer to: connectors that exist, and tools that only read. */
  uiEnv(): UiEnv {
    const reg = new ToolRegistry([...builtinTools, ...this.extTools, ...this.connectors.tools(), ...this.mcp.flatMap((m) => m.tools)], this.home.config().toolPermissions ?? {});
    const readTools = new Set(reg.list().filter((t) => reg.permissionOf(t) === "auto" && !t.needsApproval).map((t) => t.name));
    return { connectors: new Set(this.connectors.manifests().map((m) => m.id)), readTools };
  }

  /** The system prompt section about connectors, the interface, plans and the chat's repos. */
  private async appPrompt(projectId?: string, chat?: ChatRecord | null) {
    const parts = [connectorPrompt(this.connectors), uiPrompt, planPrompt, `# Files you make\nYour workspace folder is ${store.workspaceFor(this.home, projectId)}. Save documents, decks, sheets and other deliverables inside it (for example in reports/): every file you create or change there appears in the chat with a preview, its full path and Open / Show in folder buttons. When you finish, name the file and its full path.`];
    const gh = this.githubState();
    parts.push(await repoPrompt(this.home, chat ?? null, projectId));
    parts.push(gh.connected ? `GitHub is connected${gh.account ? ` as ${gh.account}` : ""}: handle it yourself with github_repos, github_clone, git, github_pr_create and github_api.` : "GitHub isn't connected, so only public repos can be cloned. If the user wants their own repos, ask them to open Connectors → GitHub and paste a token.");
    return parts.join("\n\n");
  }

  mcpStatus() {
    return this.mcp.map((m) => ({ name: m.name, tools: m.tools.map((t) => t.name), error: m.error }));
  }

  // ---------- Approvals for "ask" tools ----------

  resolveApproval(approvalId: string, ok: boolean, auto = false) {
    const r = this.approvals.get(approvalId);
    if (!r) return false;
    this.approvals.delete(approvalId);
    r.emit({ type: "approval_done", id: approvalId, allow: ok, auto });
    r.resolve(ok);
    return true;
  }

  /** YOLO switched on: let every tool that is waiting for an answer run. */
  approveAllPending() {
    for (const id of [...this.approvals.keys()]) this.resolveApproval(id, true, true);
  }

  private interactiveApprove(emit: (e: AgentEvent) => void, signal?: AbortSignal, chatId?: string) {
    return (tool: string, args: unknown, reason: string) =>
      new Promise<boolean>((resolve) => {
        if (this.home.config().approval?.yolo) {
          emit({ type: "note", text: `YOLO mode: ran ${tool} without asking.` });
          return resolve(true);
        }
        const aid = id("ap_");
        this.approvals.set(aid, { resolve, emit, chatId });
        emit({ type: "approval_request", id: aid, tool, args, reason });
        signal?.addEventListener("abort", () => this.resolveApproval(aid, false));
        setTimeout(() => this.resolveApproval(aid, false), 30 * 60_000).unref?.();
      });
  }

  // ---------- Live chats: each run lives on the server, so any number can run at once ----------

  /** Chats running now, and whether one is waiting for an approval. */
  liveChats(): Record<string, "running" | "waiting"> {
    const out: Record<string, "running" | "waiting"> = {};
    const waiting = new Set([...this.approvals.values()].map((a) => a.chatId));
    for (const id of this.live.keys()) out[id] = waiting.has(id) ? "waiting" : "running";
    return out;
  }

  isLive(chatId: string) {
    return this.live.has(chatId);
  }

  /** Start a chat turn in the background. Returns at once; follow it with watchChat. */
  startChat(chatId: string, text: string, opts: { model?: string } = {}) {
    if (!text.trim()) throw Object.assign(new Error("Message is empty."), { status: 400 });
    if (this.live.has(chatId)) throw Object.assign(new Error("This chat is still working. Stop it or wait for it to finish."), { status: 409 });
    if (!store.getChat(this.home, chatId)) throw Object.assign(new Error(`No chat ${chatId}`), { status: 404 });
    const done = this.runLive(chatId, text, opts);
    done.catch(() => {});
    return { ok: true };
  }

  /**
   * Follow a chat: replays everything since its current run started, then streams live.
   * Returns false (and sends nothing) when the chat isn't running. The callback gets run_end last.
   */
  watchChat(chatId: string, listener: (e: AgentEvent) => void): false | (() => void) {
    const run = this.live.get(chatId);
    if (!run) return false;
    for (const e of run.events) listener(e);
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  stopChat(chatId: string) {
    const run = this.live.get(chatId);
    if (!run) return false;
    run.ac.abort();
    return true;
  }

  private async runLive(chatId: string, text: string, opts: { model?: string; approve?: ToolContext["approve"] }) {
    const run: LiveRun = { ac: new AbortController(), events: [], listeners: new Set() };
    this.live.set(chatId, run);
    const emit = (e: AgentEvent) => {
      const last = run.events.at(-1);
      // Keep the replay buffer small: consecutive tokens are merged.
      if (e.type === "token" && last?.type === "token") run.events[run.events.length - 1] = { type: "token", text: last.text + e.text };
      else if (e.type !== "step" && e.type !== "message") run.events.push(e);
      else if (e.type === "message" && (e.message as ChatMessage).tool_calls?.length) run.events.push({ type: "note", text: "", reset: true });
      for (const l of run.listeners) l(e);
      if (e.type === "approval_request" || e.type === "approval_done") this.broadcast({ type: "chats" });
    };
    this.broadcast({ type: "chats" });
    try {
      return await this.chat(chatId, text, { model: opts.model, signal: run.ac.signal, emit, approve: opts.approve });
    } finally {
      this.live.delete(chatId);
      for (const l of run.listeners) l({ type: "closed" } as any);
      run.listeners.clear();
      this.broadcast({ type: "chats" });
    }
  }

  private toolContext(runId: string, opts: { projectId?: string; chatId?: string; approve: ToolContext["approve"]; signal?: AbortSignal; model: string; depth?: number; onPlan?: (steps: PlanStep[]) => void }): ToolContext {
    return {
      home: this.home,
      workspace: store.workspaceFor(this.home, opts.projectId),
      projectId: opts.projectId,
      chatId: opts.chatId,
      runId,
      signal: opts.signal,
      approve: opts.approve,
      propose: (input) => {
        const p = createProposal(this.home, input);
        this.broadcast({ type: "proposal", id: p.id });
        return p;
      },
      hooks: {
        plan: opts.onPlan,
        createTask: (t) => {
          const task = store.upsertTask(this.home, { ...t, model: undefined });
          this.broadcast({ type: "task", task });
          return task;
        },
        runSubagent:
          (opts.depth ?? 0) >= 1
            ? undefined
            : async (prompt) => {
                const tools = this.tools();
                tools.remove("run_subagent");
                const ctx = this.toolContext(runId, { ...opts, depth: (opts.depth ?? 0) + 1, onPlan: undefined });
                const res = await runAgent({
                  home: this.home,
                  model: opts.model,
                  messages: [
                    { role: "system", content: buildSystemPrompt(this.home, { model: opts.model, projectId: opts.projectId, query: prompt, extra: "You are a sub-agent. Do the task and reply with a complete, self-contained result.", connectors: await this.appPrompt(opts.projectId, opts.chatId ? store.getChat(this.home, opts.chatId) : null) }) },
                    { role: "user", content: prompt },
                  ],
                  tools,
                  ctx,
                  maxSteps: 8,
                  signal: opts.signal,
                });
                return res.content;
              },
      },
    };
  }

  // ---------- Chat ----------

  async chat(chatId: string, text: string, opts: { model?: string; signal?: AbortSignal; emit?: (e: AgentEvent) => void; approve?: ToolContext["approve"] } = {}): Promise<Turn> {
    const chat = store.getChat(this.home, chatId);
    if (!chat) throw new Error(`No chat ${chatId}`);
    const emit = opts.emit ?? (() => {});
    const model = opts.model ?? chat.model ?? this.home.config().defaults.chatModel;
    chat.model = model;
    const userTurn: Turn = { id: id("u_"), role: "user", content: text, createdAt: now() };
    chat.turns.push(userTurn);
    if (chat.turns.length === 1) chat.title = text.replace(/\s+/g, " ").slice(0, 60) + (text.length > 60 ? "…" : "");
    store.saveChat(this.home, chat);

    const profile = getProfile(this.home, model);
    const trace = new Trace(this.home, { kind: "chat", model, strategy: profile.strategy, chatId, projectId: chat.projectId, input: text });
    const turn: Turn = { id: id("a_"), role: "assistant", content: "", runId: trace.runId, model, toolCalls: [], createdAt: now() };
    // Files: compare the workspace before and after each tool that may write, so every file the
    // run made (with write_file, a script, anything) shows up in the chat with its full path.
    const workspace = store.workspaceFor(this.home, chat.projectId);
    const started = Date.now();
    let snap = snapshot(workspace);
    const files = new Map<string, FileRef>();
    const trackFiles = (e: Extract<AgentEvent, { type: "tool_result" }>) => {
      if (READ_ONLY_TOOLS.has(e.name)) return;
      if (QUIET_FILE_TOOLS.has(e.name)) {
        snap = snapshot(workspace);
        return;
      }
      const next = snapshot(workspace);
      const found = changedFiles(workspace, snap, next);
      snap = next;
      if (e.name === "shell" || e.name.includes("__")) {
        const call = turn.toolCalls!.find((c) => c.id === e.id);
        found.push(...mentionedFiles(`${JSON.stringify(call?.args ?? "")}\n${e.result}`, started, new Set([...next.keys(), ...files.keys()])));
      }
      const fresh = found.map((f) => ({ ...f, action: files.get(f.path)?.action === "created" ? ("created" as const) : f.action }));
      if (!fresh.length) return;
      for (const f of fresh) files.set(f.path, f);
      turn.files = [...files.values()];
      new FileIndex(this.home).add(fresh.map((f) => f.path));
      relay({ type: "files", files: fresh });
    };
    const relay = (e: AgentEvent) => {
      trace.event(e);
      if (e.type === "tool_call") turn.toolCalls!.push({ id: e.id, name: e.name, args: e.args });
      if (e.type === "tool_result") Object.assign(turn.toolCalls!.find((c) => c.id === e.id) ?? {}, { result: e.result.slice(0, 4000), ok: e.ok, ms: e.ms });
      emit(e);
      if (e.type === "tool_result") {
        try {
          trackFiles(e);
        } catch {
          /* tracking files must never break a run */
        }
      }
    };
    relay({ type: "run_start", runId: trace.runId, model, strategy: profile.strategy, at: started });

    const usage = emptyUsage();
    try {
      let history: ChatMessage[] = [...chat.history, { role: "user", content: text }];
      history = await compactHistory(history, profile.contextWindow, async (t) => {
        const r = await complete(this.home, { model, messages: [{ role: "system", content: "Summarise this conversation so it can continue: decisions, facts, open tasks, file paths. Be concise." }, { role: "user", content: t }] });
        addUsage(usage, r);
        return r.content;
      });
      const system = buildSystemPrompt(this.home, { model, projectId: chat.projectId, query: text, connectors: await this.appPrompt(chat.projectId, chat) });
      const onPlan = (steps: PlanStep[]) => {
        turn.plan = steps;
        relay({ type: "plan", steps });
      };
      const ctx = this.toolContext(trace.runId, { projectId: chat.projectId, chatId, approve: opts.approve ?? this.interactiveApprove(relay, opts.signal, chatId), signal: opts.signal, model, onPlan });
      const result = await getStrategy(profile.strategy).run({
        home: this.home,
        model,
        request: text,
        messages: [{ role: "system", content: system }, ...history],
        tools: this.tools(),
        ctx,
        category: "chat",
        signal: opts.signal,
        emit: relay,
      });
      addUsage(usage, result.usage);
      // What the next turn re-reads: the calls and what the user said mid-run, but only a stub of
      // each tool's output (the full text stays in the trace). This is most of a long chat's tokens.
      const kept = result.added
        .filter((m) => m.role === "tool" || (m.role === "assistant" && m.tool_calls?.length) || (m.role === "user" && m.content?.startsWith(STEER_PREFIX)))
        .map((m) => (m.role === "tool" ? { ...m, content: elideToolResult(m.content ?? "", 1500, ` (full output in run ${trace.runId})`) } : m));
      chat.history = [...history.map(stripImages), ...kept, { role: "assistant", content: result.content }];
      turn.content = result.content;
      if (result.stopReason !== "done") turn.stopReason = result.stopReason;
      if (result.question) turn.question = result.question;
      trace.finish({ status: "ok", output: result.content, ...usage });
      relay({ type: "run_end", runId: trace.runId, content: result.content, usage, status: "ok", stopReason: result.stopReason });
    } catch (e) {
      const cancelled = opts.signal?.aborted;
      turn.content = cancelled ? "(stopped)" : `Something went wrong: ${(e as Error).message}`;
      chat.history = [...chat.history, { role: "user", content: text }];
      trace.finish({ status: cancelled ? "cancelled" : "error", output: turn.content, ...usage });
      relay({ type: "error", error: turn.content });
      relay({ type: "run_end", runId: trace.runId, content: turn.content, usage, status: cancelled ? "cancelled" : "error" });
    }
    turn.durationMs = Date.now() - started;
    const fresh = store.getChat(this.home, chatId);
    if (!fresh) return turn; // deleted while it ran
    fresh.turns = [...chat.turns, turn];
    fresh.history = chat.history;
    fresh.title = chat.title;
    fresh.model = model;
    store.saveChat(this.home, fresh);
    return turn;
  }

  /** Rate an answer. Up: it becomes a few-shot example. Either way it is recorded for evals. */
  rate(chatId: string, turnId: string, rating: "up" | "down" | null, note?: string) {
    const chat = store.getChat(this.home, chatId);
    if (!chat) throw new Error(`No chat ${chatId}`);
    const i = chat.turns.findIndex((t) => t.id === turnId);
    const turn = chat.turns[i];
    if (!turn || turn.role !== "assistant") throw new Error("Only assistant answers can be rated.");
    turn.rating = rating ?? undefined;
    store.saveChat(this.home, chat);
    if (rating && turn.runId) {
      addRating(this.home, { runId: turn.runId, rating, note });
      const question = chat.turns.slice(0, i).reverse().find((t) => t.role === "user")?.content ?? "";
      if (rating === "up" && question) addExample(this.home, { input: question, output: turn.content, model: turn.model ?? "", source: "rating" });
    }
    return turn;
  }

  async turnIntoEval(runId: string, rating: "up" | "down", expectation?: string) {
    return caseFromRun(this.home, runId, rating, expectation);
  }

  // ---------- Tasks ----------

  async runTask(taskId: string) {
    const task = store.listTasks(this.home).find((t) => t.id === taskId);
    if (!task) throw new Error(`No task ${taskId}`);
    this.broadcast({ type: "task", task: store.patchTask(this.home, taskId, { lastStatus: "running" }) });
    const chat = store.createChat(this.home, { projectId: task.projectId, title: `${task.name} · ${new Date().toLocaleString()}`, model: task.model ?? this.home.config().defaults.taskModel });
    let status: Task["lastStatus"] = "ok";
    let runId: string | undefined;
    try {
      const turn = await this.chatUnattended(chat.id, task.prompt, task.model ?? this.home.config().defaults.taskModel);
      runId = turn.runId;
      if (turn.content.startsWith("Something went wrong")) status = "error";
    } catch {
      status = "error";
    }
    const updated = store.patchTask(this.home, taskId, { lastRun: now(), lastStatus: status, lastRunId: runId, lastChatId: chat.id });
    this.broadcast({ type: "task", task: updated });
    return updated;
  }

  /** A task run: live like any chat, but tools that need approval are declined (nobody is watching) unless YOLO covers Tasks. */
  private chatUnattended(chatId: string, text: string, model: string) {
    return this.runLive(chatId, text, { model, approve: async () => !!this.home.config().approval?.yoloTasks });
  }

  // ---------- Jobs: evals and evolution run in the background with a live log ----------

  startJob(kind: Job["kind"], title: string, work: (log: (m: string) => void) => Promise<unknown>): Job {
    const job: Job = { id: id("job_"), kind, title, status: "running", log: [], startedAt: now() };
    this.jobs.set(job.id, job);
    const log = (m: string) => {
      job.log.push(m);
      this.broadcast({ type: "job", job });
    };
    this.broadcast({ type: "job", job });
    work(log)
      .then((r) => {
        job.result = r;
        job.status = "done";
      })
      .catch((e) => {
        job.status = "error";
        job.log.push(`Error: ${(e as Error).message}`);
      })
      .finally(() => {
        job.endedAt = now();
        this.broadcast({ type: "job", job });
      });
    return job;
  }

  runEvals(model = this.home.config().defaults.chatModel, samples = 1) {
    return this.startJob("eval", `Evals on ${model}`, async (log) => {
      log(`Running ${listCases(this.home).length} cases on ${model}…`);
      const r = await runSuite(this.home, model, { samples, onProgress: (d, t, c) => log(`${d}/${t} ${c.id}: ${Math.round(c.score * 100)}%${c.notes.length ? ` (${c.notes[0]})` : ""}`) });
      log(`Score ${(r.score * 100).toFixed(1)}%, held-out ${(r.heldOutScore * 100).toFixed(1)}%.`);
      return { id: r.id, score: r.score, heldOutScore: r.heldOutScore };
    });
  }

  evolve(model = this.home.config().defaults.chatModel) {
    return this.startJob("evolve", `Improve ${model}`, async (log) => {
      const r = await evolveOnce(this.home, model, log);
      log(r.message);
      if (r.proposal) this.broadcast({ type: "proposal", id: r.proposal.id });
      return r;
    });
  }

  gateProposal(pid: string, model = this.home.config().defaults.chatModel) {
    return this.startJob("gate", `Measure proposal ${pid}`, async (log) => {
      const p = getProposal(this.home, pid);
      if (!p) throw new Error(`No proposal ${pid}`);
      p.gate = await gate(this.home, p, model, { log });
      save(this.home, p);
      this.broadcast({ type: "proposal", id: pid });
      log(`${p.gate.passed ? "Passed" : "Did not pass"}: ${(p.gate.baseline * 100).toFixed(1)}% → ${(p.gate.candidate * 100).toFixed(1)}%. ${p.gate.notes.join(" ")}`);
      return p.gate;
    });
  }

  async decide(pid: string, decision: "accept" | "reject" | "rollback", note?: string) {
    if (decision === "accept") {
      const pending = getProposal(this.home, pid);
      // Interface changes are checked again right before they go live: the app may have changed since.
      for (const c of pending?.kind === "ui" ? pending.changes : []) {
        if (c.after === null) continue;
        const { errors } = checkUi(JSON.parse(c.after), this.uiEnv());
        if (errors.length) throw Object.assign(new Error(`This interface change no longer passes its checks: ${errors.join("; ")}`), { status: 400 });
      }
    }
    const p = decision === "accept" ? acceptProposal(this.home, pid, note) : decision === "reject" ? rejectProposal(this.home, pid, note) : rollbackProposal(this.home, pid);
    if (p.kind === "extension") await this.reloadExtensions();
    this.broadcast({ type: "proposal", id: pid });
    if (p.kind === "ui") this.broadcast({ type: "ui" });
    return p;
  }

  uiChanged() {
    this.broadcast({ type: "ui" });
  }

  // ---------- Interface actions: run on the server from an approved extension, never from the page's own input ----------

  private uiButton(extId: string, elementId: string): UiButton {
    const spec = getUi(this.home, extId);
    const el = spec?.elements.find((e) => e.id === elementId);
    if (!el || el.type !== "button") throw Object.assign(new Error("That button isn't installed (or is switched off)."), { status: 404 });
    return el;
  }

  /** The items a picker shows: read with a connector's sign-in, or from a read-only tool. */
  async uiSource(extId: string, elementId: string, step: number, vars: Record<string, unknown>, projectId?: string) {
    const action = actionAt(this.uiButton(extId, elementId), step);
    if (action?.type !== "picker") throw Object.assign(new Error("That step isn't a list."), { status: 400 });
    const s = action.source;
    let raw: unknown[] = [];
    if (s.connector && s.get) {
      const m = this.connectors.manifest(s.connector);
      if (!this.connectors.isEnabled(m.id)) throw new Error(`${m.name} is switched off. Turn it on in Connectors.`);
      const rt = this.connectors.runtime(m);
      let url: string | null = fillTemplate(s.get, vars, true);
      const host = new URL(url).host;
      for (let page = 0; url && page < (s.pages ?? 1); page++) {
        const res = await rt.fetch(url, { headers: { accept: "application/json" } });
        const text = await res.text();
        if (!res.ok) throw new Error(`${m.name} answered ${res.status}: ${text.slice(0, 300)}`);
        raw.push(...itemsFrom(JSON.parse(text || "null"), s.items));
        const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
        url = next && new URL(next).host === host ? next : null;
      }
    } else if (s.tool) {
      if (!this.uiEnv().readTools.has(s.tool)) throw new Error(`${s.tool} isn't a read-only tool.`);
      const ctx = this.toolContext(id("ui_"), { projectId, approve: async () => false, model: this.home.config().defaults.chatModel });
      const r = await this.tools().execute(s.tool, JSON.stringify(s.input ?? {}), ctx);
      if (!r.ok) throw new Error(r.result.replace(/^Error:\s*/, ""));
      try {
        raw = itemsFrom(JSON.parse(r.result), s.items);
      } catch {
        raw = r.result.split("\n").filter((l) => l.trim()).map((line, i) => ({ line: line.replace(/^\s*[-*]\s*/, ""), index: i + 1 }));
      }
    }
    return { items: raw.slice(0, 1000).map((it) => flattenItem(it)) };
  }

  /** Clone a repository into the project's folder and connect it to the project. */
  async uiClone(extId: string, elementId: string, step: number, vars: Record<string, unknown>, projectId?: string, chatId?: string): Promise<{ repo: RepoLink; already: boolean }> {
    const action = actionAt(this.uiButton(extId, elementId), step);
    if (action?.type !== "clone_repo") throw Object.assign(new Error("That step isn't a clone."), { status: 400 });
    const url = fillTemplate(action.url, vars, true);
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`Not a repository URL: ${url}`);
    }
    if (u.protocol !== "https:" || !action.hosts.includes(u.hostname)) throw new Error(`Only https:// repositories on ${action.hosts.join(", ")} can be cloned here.`);
    const name = fillTemplate(action.name ?? "", vars) || undefined;
    const r = await cloneAndLink(this.repoHost, { repo: `${u.origin}${u.pathname}`, name, projectId, chatId, scope: projectId ? "project" : "chat" });
    new FileIndex(this.home).add([r.repo.path]);
    return r;
  }

  // ---------- Read models for the UI ----------

  proposals = () => listProposals(this.home);
  evalHistory = () => evalHistory(this.home);
  runs = () => listRuns(this.home);
  models = () => listModels(this.home);
  exportDatasets = () => exportDatasets(this.home);
  profile = (ref: string) => getProfile(this.home, ref);
  saveProfile = (p: Parameters<typeof saveProfile>[1]) => saveProfile(this.home, p);
}

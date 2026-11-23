// Harness: wires home, tools, context, strategies, traces, tasks and the improvement loop
// together. The server and CLI are thin layers over this class.
import { Connectors } from "./connectors/index.ts";
import { googleWorkspace } from "./connectors/google.ts";
import { GITHUB_API, github, listGithubRepos } from "./connectors/github.ts";
import { activeRepo, allLinkedRepos, checkpointCommit, cloneAndLink, explainGitError, git, linkedRepos, repoPrompt, repoStatus, repoTools, setActiveRepo, unlinkRepo, type RepoHost } from "./repos.ts";
import { planPrompt, updatePlanTool } from "./plan.ts";
import { failedChecksMessage, findToolsTool, longTaskPrompt, longTaskTools, planToProgress, progressKey, progressPrompt, readProgress, runChecks, updateProgress } from "./longtask.ts";
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
import { getProfile, learnContextWindow, listModels, saveProfile } from "./providers/models.ts";
import { Scheduler } from "./scheduler.ts";
import { getStrategy } from "./strategies/index.ts";
import * as store from "./store.ts";
import { builtinTools } from "./tools/builtin.ts";
import { ToolRegistry } from "./tools/registry.ts";
import type { Tool, ToolContext } from "./tools/types.ts";
import { Trace, addRating, listRuns } from "./trace.ts";
import type { AgentEvent, Attachment, ChatMessage, ChatRecord, Contract, PlanStep, Recap, Task, Turn } from "./types.ts";
import { id, now } from "./util.ts";
import { FileIndex, changedFiles, mentionedFiles, snapshot } from "./files/index.ts";
import { actionAt, checkUi, fillTemplate, flattenItem, getUi, itemsFrom, uiAgentTools, uiPrompt, type UiButton, type UiEnv } from "./ui-ext.ts";
import type { FileRef, RepoLink } from "./types.ts";
import { resolve, relative, sep, isAbsolute, extname } from "node:path";
import { mistakes, needsReview, reviewRun } from "./evolve/review.ts";
import { attachmentsForModel, saveAttachment } from "./attachments.ts";

/** Files people read: shown in the answer. Code and data files are shown only when the user asked for them. */
const READABLE = /\.(md|markdown|txt|pdf|docx?|odt|rtf|xlsx?|ods|csv|tsv|pptx?|odp|key|html?|png|jpe?g|gif|webp|svg|bmp|mp3|wav|m4a|mp4|mov|webm|zip)$/i;
const SCRATCH = /(^|[\\/])(node_modules|__pycache__|\.cache|\.venv|venv|tmp|temp|scratch|\.git)[\\/]/i;
export function showInChat(path: string, request: string) {
  if (SCRATCH.test(path)) return false;
  if (READABLE.test(path)) return true;
  const ext = extname(path).slice(1).toLowerCase();
  // Only an explicit ask for code ("write a script…", "give me the JSON") counts, or naming the file type.
  const wantsCode = /\b(write|create|make|build|generate|give me|send me|export|save)\b[^.?!\n]{0,60}\b(scripts?|code|programs?|functions?|modules?|snippets?|cli|json|yaml|config files?)\b/i.test(request);
  return wantsCode || (!!ext && new RegExp(`\\.${ext}\\b|\\b${ext}\\b`, "i").test(request));
}

/** The command a shell-like call would run, for allow-lists. */
const commandOf = (tool: string, args: unknown) => (tool === "shell" && args && typeof (args as { command?: unknown }).command === "string" ? ((args as { command: string }).command).trim() : null);

/** Facts for the end-of-run recap, taken from what the harness saw, not from the answer. */
function recapOf(turn: Turn, stopReason: Recap["stopReason"]): Recap {
  // Counted like the chat's tool row: everything but the plan and the question, which have their own cards.
  const calls = (turn.toolCalls ?? []).filter((c) => c.name !== "update_plan" && c.name !== "ask_user");
  const ran = (turn.checks ?? []).filter((c) => c.status !== "skipped");
  return {
    stopReason,
    filesChanged: turn.files?.length ?? 0,
    toolCalls: calls.length,
    failedCalls: calls.filter((c) => c.ok === false).length,
    ...(ran.length ? { checks: { passed: ran.filter((c) => c.status === "pass").length, total: ran.length } } : {}),
    unfinished: [...(turn.plan ?? []).filter((s) => s.status !== "done").map((s) => s.text), ...(turn.checks ?? []).filter((c) => c.status === "fail").map((c) => `Check failing: ${c.text}`)],
  };
}

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
  /** Messages the user sent while it runs: the loop reads them at its next step. */
  inbox: string[];
  events: AgentEvent[];
  listeners: Set<(e: AgentEvent) => void>;
}

/** Tools that never write files, so there is nothing to look for after them. */
const READ_ONLY_TOOLS = new Set(["list_files", "read_file", "search_files", "web_fetch", "read_skill", "list_connectors", "list_ui", "propose_ui_change", "propose_skill", "propose_memory", "create_task", "create_connector", "update_plan", "list_repos", "github_repos", "github_api", "github_pr_create"]);
/** What the agent may use while it drafts a contract in long-task mode: look around, write nothing. */
const DRAFT_TOOLS = ["list_files", "read_file", "search_files", "web_fetch", "read_skill", "list_repos", "github_repos", "list_connectors", "set_contract", "ask_user", "update_plan", "note_progress"];
const DRAFT_PROMPT = `# Long-task mode: draft the contract first
The user switched on long-task mode. Before any work: look around as much as you need (read-only), then call set_contract with the goal, the scope, the paths never to touch, and done_when checks with commands that prove the work is done. Then stop and tell the user, in two or three lines, that the contract is ready for them to review, edit and approve. Don't change any file yet: that starts once they approve.`;

/** Tools that change many files the agent didn't write (a clone, a pull, a checkout): not shown as files it made. */
const QUIET_FILE_TOOLS = new Set(["git", "github_clone"]);

export class Harness {
  readonly home: Home;
  private extTools: Tool[] = [];
  private mcp: McpConnection[] = [];
  extensionReports: ExtensionReport[] = [];
  scheduler?: Scheduler;
  private approvals = new Map<string, { resolve: (ok: boolean) => void; emit: (e: AgentEvent) => void; chatId?: string; tool?: string; command?: string | null }>();
  /** Chats that are running right now, each independent of any open window. */
  private live = new Map<string, LiveRun>();
  readonly jobs = new Map<string, Job>();
  private listeners = new Set<Listener>();
  /** When each chat last had its mistakes reviewed (at most one review per chat every 20 minutes). */
  private lastReview = new Map<string, number>();
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
    const appTools = [...this.connectors.tools(), ...this.mcp.flatMap((m) => m.tools)];
    // Tools for apps and MCP servers are shown only once a chat asks for them (find_tools).
    // GitHub stays loaded: the repo prompt tells the agent to use its tools directly.
    const lazy = this.home.config().agent.lazyTools ? appTools.map((t) => t.name).filter((n) => !n.startsWith("github_")) : [];
    const reg: ToolRegistry = new ToolRegistry(
      [...builtinTools, updatePlanTool, ...longTaskTools, ...(lazy.length ? [findToolsTool((ctx) => reg.hidden(ctx))] : []), ...this.extTools, ...connectorAgentTools(this.connectors, () => this.broadcast({ type: "connectors" })), ...repoTools(this.repoHost), ...uiAgentTools(this.home, () => this.uiEnv()), ...appTools],
      this.home.config().toolPermissions ?? {},
      lazy,
    );
    return reg;
  }

  /** The prompt line about tools that load on demand. */
  private lazyToolsPrompt() {
    if (!this.home.config().agent.lazyTools) return "";
    const hidden = this.tools().hidden();
    if (!hidden.length) return "";
    const groups = [...new Set(hidden.map((t) => t.name.split(/__|_/)[0]))];
    return `# Tools on demand\nTools for ${groups.join(", ")} (${hidden.length} in all) aren't loaded yet, to save context. Call find_tools with what you need (for example "send email" or "list issues") and they become usable on your next step.`;
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
    const parts = [connectorPrompt(this.connectors), this.lazyToolsPrompt(), uiPrompt, planPrompt, longTaskPrompt, `# Files you make\nYour workspace folder is ${store.workspaceFor(this.home, projectId)}. Save documents, decks, sheets and other deliverables inside it (for example in reports/): every file you create or change there appears in the chat with a preview, its full path and Open / Show in folder buttons. When you finish, name the file and its full path.`];
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

  /** "Always allow": this exact shell command (or this tool) runs without asking from now on. */
  allowAlways(approvalId: string) {
    const r = this.approvals.get(approvalId);
    if (!r) return false;
    const a = this.home.config().approval;
    if (r.command) this.home.saveConfig({ approval: { ...a, allowCommands: [...new Set([...(a.allowCommands ?? []), r.command])] } } as any);
    else if (r.tool) this.home.saveConfig({ toolPermissions: { ...(this.home.config().toolPermissions ?? {}), [r.tool]: "auto" } });
    return this.resolveApproval(approvalId, true);
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
        const command = commandOf(tool, args);
        if (command && (this.home.config().approval?.allowCommands ?? []).includes(command)) return resolve(true);
        const aid = id("ap_");
        this.approvals.set(aid, { resolve, emit, chatId, tool, command });
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
  startChat(chatId: string, text: string, opts: { model?: string; attachments?: Attachment[]; mode?: "long" } = {}) {
    if (!text.trim() && !opts.attachments?.length) throw Object.assign(new Error("Message is empty."), { status: 400 });
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

  /** Steer a running chat: the message reaches the agent at its next step. */
  queueMessage(chatId: string, text: string) {
    const run = this.live.get(chatId);
    if (!text.trim()) throw Object.assign(new Error("Message is empty."), { status: 400 });
    if (!run) throw Object.assign(new Error("This chat isn't running. Send the message normally."), { status: 409 });
    run.inbox.push(text.trim());
    return { ok: true, queued: run.inbox.length };
  }

  stopChat(chatId: string) {
    const run = this.live.get(chatId);
    if (!run) return false;
    run.ac.abort();
    return true;
  }

  /** The chat's contract and progress, for the UI. */
  /** Approved contracts still in play, newest first, one per progress file (a task's runs share one). */
  ongoingContracts() {
    const seen = new Set<string>();
    const out: { chatId: string; title: string; projectId?: string; running: boolean; progress: ReturnType<typeof readProgress> }[] = [];
    for (const c of store.listChats(this.home)) {
      const key = progressKey(c);
      if (seen.has(key)) continue;
      seen.add(key);
      const p = readProgress(this.home, key);
      if (!p.contract || p.contract.draft) continue;
      out.push({ chatId: c.id, title: c.title, projectId: c.projectId, running: this.isLive(c.id), progress: p });
    }
    return out;
  }

  progressOf(chatId: string) {
    const chat = store.getChat(this.home, chatId);
    if (!chat) throw Object.assign(new Error(`No chat ${chatId}`), { status: 404 });
    return readProgress(this.home, progressKey(chat));
  }

  /** The user edits or approves the contract (long-task mode: approving starts the work). */
  updateContract(chatId: string, patch: { goal?: string; scope?: string[]; never?: string[]; doneWhen?: { text: string; command?: string }[]; approve?: boolean; clear?: boolean }) {
    const chat = store.getChat(this.home, chatId);
    if (!chat) throw Object.assign(new Error(`No chat ${chatId}`), { status: 404 });
    const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 30) : undefined);
    const p = updateProgress(this.home, progressKey(chat), (p) => {
      if (patch.clear) return void (p.contract = undefined);
      const c = p.contract ?? { goal: "", scope: [], never: [], doneWhen: [], updatedAt: now() };
      if (typeof patch.goal === "string") c.goal = patch.goal.slice(0, 500);
      c.scope = strs(patch.scope) ?? c.scope;
      c.never = strs(patch.never) ?? c.never;
      if (Array.isArray(patch.doneWhen)) c.doneWhen = patch.doneWhen.filter((d) => d && String(d.text ?? "").trim()).slice(0, 15).map((d) => ({ text: String(d.text).trim().slice(0, 300), ...(d.command && String(d.command).trim() ? { command: String(d.command).trim().slice(0, 500) } : {}) }));
      if (patch.approve) delete c.draft;
      c.updatedAt = now();
      p.contract = c;
    });
    this.broadcast({ type: "chats" });
    return p;
  }

  /** Save a file the user attached; it is sent with their next message. */
  saveUpload(chatId: string, name: string, base64: string): Attachment {
    const chat = store.getChat(this.home, chatId);
    if (!chat) throw Object.assign(new Error(`No chat ${chatId}`), { status: 404 });
    if (!name || typeof base64 !== "string") throw Object.assign(new Error("Send a file name and its data."), { status: 400 });
    return saveAttachment(store.workspaceFor(this.home, chat.projectId), name, Buffer.from(base64, "base64"));
  }

  private async runLive(chatId: string, text: string, opts: { model?: string; approve?: ToolContext["approve"]; attachments?: Attachment[]; mode?: "long" }) {
    const run: LiveRun = { ac: new AbortController(), inbox: [], events: [], listeners: new Set() };
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
      return await this.chat(chatId, text, { model: opts.model, signal: run.ac.signal, emit, approve: opts.approve, attachments: opts.attachments, mode: opts.mode });
    } finally {
      this.live.delete(chatId);
      for (const l of run.listeners) l({ type: "closed" } as any);
      run.listeners.clear();
      this.broadcast({ type: "chats" });
    }
  }

  private toolContext(runId: string, opts: { projectId?: string; chatId?: string; approve: ToolContext["approve"]; signal?: AbortSignal; model: string; depth?: number; onPlan?: (steps: PlanStep[]) => void; progressKey?: string; onContract?: (c: Contract) => void }): ToolContext {
    const key = opts.progressKey;
    const ctxRef: ToolContext = {
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
        loadTools: (names) => names.forEach((n) => ctxRef.loadedTools?.add(n)),
        contract: key
          ? {
              get: () => readProgress(this.home, key).contract,
              set: (c) => {
                updateProgress(this.home, key, (p) => void (p.contract = c));
                opts.onContract?.(c);
              },
            }
          : undefined,
        progress: key
          ? (e) => {
              updateProgress(this.home, key, (p) => {
                if (e.decision) p.decisions.push(e.decision);
                if (e.deadEnd) p.deadEnds.push(e.deadEnd);
                if (e.blocked) p.blocked.push(e.blocked);
                if (e.done) p.done.push(e.done);
              });
              return "Saved to progress.";
            }
          : undefined,
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
      loadedTools: new Set(),
    };
    return ctxRef;
  }

  /** Record how a mistake review ended on the turn it was about, so the chat can link to the proposal. */
  private finishReview(chatId: string, turnId: string, review: NonNullable<Turn["review"]>) {
    const c = store.getChat(this.home, chatId);
    const t = c?.turns.find((x) => x.id === turnId);
    if (!c || !t) return;
    t.review = review;
    store.saveChat(this.home, c);
    this.broadcast({ type: "chats" });
  }

  /** Done-when checks are shell commands the model wrote: they run only when the shell would. */
  private allowCheck(command: string, approve: ToolContext["approve"]) {
    return approve("shell", { command }, `Syph wants to run a done-when check: ${command}`);
  }

  /** Save a linked repo's state after a finished plan step, on a side ref (never the branch, never pushed). */
  private async checkpoint(path: string, key: string, step: string, emit: (e: AgentEvent) => void) {
    try {
      const identity = (await this.repoHost.identity()) ?? { name: "Syph", email: "syph@localhost" };
      const sha = await checkpointCommit(path, key, `Checkpoint: ${step}`.slice(0, 200), identity);
      if (!sha) return;
      updateProgress(this.home, key, (p) => void (p.checkpoints = [...(p.checkpoints ?? []), `${sha.slice(0, 7)} after: ${step.slice(0, 120)} (restore with git checkout ${sha.slice(0, 7)} -- .)`]));
      emit({ type: "note", text: `Checkpoint ${sha.slice(0, 7)} saved after: ${step}` });
    } catch {
      /* a checkpoint must never break a run */
    }
  }

  // ---------- Chat ----------

  async chat(chatId: string, text: string, opts: { model?: string; signal?: AbortSignal; emit?: (e: AgentEvent) => void; approve?: ToolContext["approve"]; attachments?: Attachment[]; mode?: "long" } = {}): Promise<Turn> {
    const chat = store.getChat(this.home, chatId);
    if (!chat) throw new Error(`No chat ${chatId}`);
    // Attachments must be files saved in this chat's workspace (by saveUpload), never arbitrary paths.
    const ws = store.workspaceFor(this.home, chat.projectId);
    const attachments = (opts.attachments ?? []).filter((a) => {
      const r = relative(ws, resolve(String(a?.path ?? "")));
      return !!r && !r.startsWith("..") && !isAbsolute(r) && r.split(sep)[0] === "uploads";
    });
    const emit = opts.emit ?? (() => {});
    const model = opts.model ?? chat.model ?? this.home.config().defaults.chatModel;
    chat.model = model;
    const userTurn: Turn = { id: id("u_"), role: "user", content: text, createdAt: now(), ...(attachments.length ? { attachments } : {}) };
    chat.turns.push(userTurn);
    if (chat.turns.length === 1) chat.title = (text.trim() ? text.replace(/\s+/g, " ").slice(0, 60) + (text.length > 60 ? "…" : "") : attachments.map((a) => a.name).join(", ").slice(0, 60));
    store.saveChat(this.home, chat);

    await learnContextWindow(this.home, model);
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
      new FileIndex(this.home).add(found.map((f) => f.path));
      // Only deliverables are shown: documents, sheets, decks, images. The scripts and data files the
      // agent writes along the way stay out of the answer unless the user asked for code.
      const fresh = found.filter((f) => showInChat(f.rel ?? f.path, text)).map((f) => ({ ...f, action: files.get(f.path)?.action === "created" ? ("created" as const) : f.action }));
      if (!fresh.length) return;
      for (const f of fresh) files.set(f.path, f);
      turn.files = [...files.values()];
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
      const att = attachmentsForModel(attachments, profile);
      const userMessage: ChatMessage = { role: "user", content: [text, att.text].filter(Boolean).join("\n\n"), ...(att.images.length ? { images: att.images } : {}) };
      let history: ChatMessage[] = [...chat.history, userMessage];
      history = await compactHistory(history, profile.contextWindow, async (t) => {
        const r = await complete(this.home, { model, messages: [{ role: "system", content: "Summarise this conversation so it can continue: decisions, facts, open tasks, file paths. Be concise." }, { role: "user", content: t }] });
        addUsage(usage, r);
        return r.content;
      }, () => relay({ type: "note", text: `Summarising earlier messages to fit ${model.replace(/^openrouter:/, "")}'s context window…` }));
      const key = progressKey(chat);
      if (opts.mode === "long" && !readProgress(this.home, key).contract?.draft) {
        updateProgress(this.home, key, (p) => void (p.contract = { goal: text.slice(0, 300), scope: [], never: [], doneWhen: [], draft: true, updatedAt: now() }));
      }
      const drafting = !!readProgress(this.home, key).contract?.draft;
      const system = buildSystemPrompt(this.home, { model, projectId: chat.projectId, query: text, connectors: await this.appPrompt(chat.projectId, chat), extra: [progressPrompt(readProgress(this.home, key)), drafting ? DRAFT_PROMPT : ""].filter(Boolean).join("\n\n") });
      const repo = activeRepo(this.home, chat, chat.projectId);
      let checkpoints = Promise.resolve();
      const onPlan = (steps: PlanStep[]) => {
        const before = new Set((turn.plan ?? []).filter((s) => s.status === "done").map((s) => s.text));
        turn.plan = steps;
        relay({ type: "plan", steps });
        updateProgress(this.home, key, (p) => planToProgress(p, steps));
        // A git checkpoint per finished step, so a fresh session can resume from the repo itself.
        const finished = steps.filter((s) => s.status === "done" && !before.has(s.text));
        if (repo && finished.length && this.home.config().agent.gitCheckpoints) checkpoints = checkpoints.then(() => this.checkpoint(repo.path, key, finished.map((s) => s.text).join("; "), relay));
      };
      const approve = opts.approve ?? this.interactiveApprove(relay, opts.signal, chatId);
      const ctx = this.toolContext(trace.runId, { projectId: chat.projectId, chatId, approve, signal: opts.signal, model, onPlan, progressKey: key, onContract: (c) => relay({ type: "contract", contract: c }) });
      for (const t of chat.loadedTools ?? []) ctx.loadedTools!.add(t);
      const tools = drafting ? this.tools().pick(DRAFT_TOOLS) : this.tools();
      const strategy = getStrategy(profile.strategy);
      // Long task: an approved contract, or a plan of three or more steps. It then runs to completion.
      const isLong = () => {
        if (drafting) return false;
        const c = readProgress(this.home, key).contract;
        return (!!c && !c.draft) || (turn.plan?.length ?? 0) >= 3;
      };
      const inbox = () => {
        const queued = this.live.get(chatId)?.inbox.splice(0) ?? [];
        if (queued.length) turn.steering = [...(turn.steering ?? []), ...queued];
        return queued;
      };
      let result = await strategy.run({ home: this.home, model, request: text, messages: [{ role: "system", content: system }, ...history], tools, ctx, category: "chat", signal: opts.signal, emit: relay, inbox, isLong });
      addUsage(usage, result.usage);

      // Sensors: when the work changed something and the contract has commands, the harness runs
      // them itself. Red output goes back to the model (twice at most); "done" needs green.
      const wrote = (r: typeof result) => r.toolsCalled.some((t) => !READ_ONLY_TOOLS.has(t) && !["set_contract", "note_progress", "ask_user", "find_tools"].includes(t));
      let changed = wrote(result);
      for (let round = 0; result.stopReason === "done" && changed; round++) {
        const contract = readProgress(this.home, key).contract;
        if (!contract || contract.draft || !contract.doneWhen.some((d) => d.command)) break;
        relay({ type: "note", text: "Running the done-when checks…" });
        const checks = await runChecks(contract, repo?.path ?? ctx.workspace, (command) => this.allowCheck(command, approve), opts.signal);
        turn.checks = checks;
        relay({ type: "checks", checks });
        if (!checks.some((c) => c.status === "fail")) break;
        if (round >= 2) {
          result = { ...result, stopReason: "checks_failed" };
          break;
        }
        relay({ type: "note", text: `${checks.filter((c) => c.status === "fail").length} check(s) failed. Fixing.`, reset: true });
        const again = await strategy.run({ home: this.home, model, request: text, messages: [...result.messages, { role: "user", content: failedChecksMessage(checks) }], tools, ctx, category: "chat", signal: opts.signal, emit: relay, inbox, isLong });
        addUsage(usage, again.usage);
        changed = wrote(again);
        result = { ...again, added: [...result.added, ...again.added], toolsCalled: [...result.toolsCalled, ...again.toolsCalled] };
      }
      await checkpoints;
      chat.loadedTools = [...(ctx.loadedTools ?? [])];

      // What the next turn re-reads: the calls and what the user said mid-run, but only a stub of
      // each tool's output (the full text stays in the trace). This is most of a long chat's tokens.
      const kept = result.added
        .filter((m) => m.role === "tool" || (m.role === "assistant" && m.tool_calls?.length) || (m.role === "user" && m.content?.startsWith(STEER_PREFIX)))
        .map((m) => (m.role === "tool" ? { ...m, content: elideToolResult(m.content ?? "", 1500, ` (full output in run ${trace.runId})`) } : m));
      chat.history = [...history.map(stripImages), ...kept, { role: "assistant", content: result.content }];
      turn.content = result.content;
      if (result.stopReason !== "done") turn.stopReason = result.stopReason;
      if (result.question) turn.question = result.question;
      turn.usage = usage;
      turn.recap = recapOf(turn, result.stopReason);
      if (result.stopReason === "repeated_error") updateProgress(this.home, key, (p) => p.blocked.push(`Run stopped: ${result.content.split("\n")[0].slice(0, 200)}`));
      // Too many mistakes: have the reflector find the missing harness part and propose it in Evolve.
      if (needsReview(this.home, turn) && Date.now() - (this.lastReview.get(chatId) ?? 0) > 20 * 60_000) {
        this.lastReview.set(chatId, Date.now());
        turn.review = { status: "running", mistakes: mistakes(turn).length };
        const reviewed = { ...turn };
        this.startJob("evolve", `Review ${mistakes(turn).length} mistakes in “${chat.title}”`, async (log) => {
          log("Looking for what Syph was missing…");
          const r = await reviewRun(this.home, { model, runId: trace.runId, request: text, turn: reviewed });
          this.finishReview(chatId, turn.id, r.proposal ? { status: "proposed", mistakes: reviewed.review!.mistakes, proposalId: r.proposal.id, title: r.proposal.title } : { status: "none", mistakes: reviewed.review!.mistakes, note: r.diagnosis });
          if (r.proposal) this.broadcast({ type: "proposal", id: r.proposal.id });
          log(r.proposal ? `Proposed: ${r.proposal.title}. It waits for you in Evolve.` : `No change proposed: ${r.diagnosis}`);
          return r.proposal?.id ?? null;
        });
      }
      trace.finish({ status: "ok", output: result.content, ...usage });
      relay({ type: "run_end", runId: trace.runId, content: result.content, usage, status: "ok", stopReason: result.stopReason, recap: turn.recap, question: turn.question });
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
    // Start from what is on disk: a mistake review may have updated an earlier turn meanwhile.
    const known = new Set(fresh.turns.map((t) => t.id));
    fresh.turns = [...fresh.turns, ...chat.turns.filter((t) => !known.has(t.id)), turn];
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
    // Every run of a task shares one progress file, so the next run resumes instead of starting cold.
    const chat = store.createChat(this.home, { projectId: task.projectId, title: `${task.name} · ${new Date().toLocaleString()}`, model: task.model ?? this.home.config().defaults.taskModel, progressKey: `task-${task.id}` });
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
    return this.runLive(chatId, text, { model, approve: async (tool, args) => {
      const a = this.home.config().approval;
      if (a?.yoloTasks) return true;
      // Walls for unattended runs: only the command prefixes the user allowed for Tasks.
      const command = commandOf(tool, args);
      return !!command && (a?.taskCommands ?? []).some((p) => command === p || command.startsWith(p + " "));
    } });
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
  /** The profile with the model's context window looked up first, for Settings. */
  profileFresh = async (ref: string) => (await learnContextWindow(this.home, ref), getProfile(this.home, ref));
  saveProfile = (p: Parameters<typeof saveProfile>[1]) => saveProfile(this.home, p);
}

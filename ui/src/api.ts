// Thin client for the Syph server. Shapes mirror @syph/core types.
export type Role = "user" | "assistant";

export interface ToolCallView {
  id: string;
  name: string;
  args: unknown;
  result?: string;
  ok?: boolean;
  ms?: number;
}

export interface Turn {
  id: string;
  role: Role;
  content: string;
  runId?: string;
  model?: string;
  toolCalls?: ToolCallView[];
  rating?: "up" | "down";
  files?: FileRef[];
  plan?: PlanStep[];
  durationMs?: number;
  stopReason?: StopReason;
  question?: { question: string; options: string[] };
  checks?: CheckResult[];
  recap?: Recap;
  steering?: string[];
  attachments?: Attachment[];
  usage?: Usage;
  review?: { status: "running" | "proposed" | "none"; mistakes: number; proposalId?: string; title?: string; note?: string };
  createdAt: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  cachedTokens?: number;
}

export type StopReason = "done" | "budget" | "repeated_error" | "question" | "checks_failed";

export interface Contract {
  goal: string;
  scope: string[];
  never: string[];
  doneWhen: { text: string; command?: string }[];
  draft?: boolean;
  updatedAt: string;
}

export interface OngoingContract {
  chatId: string;
  title: string;
  projectId?: string;
  running: boolean;
  progress: Progress;
}

export interface CheckResult {
  text: string;
  command?: string;
  status: "pass" | "fail" | "skipped" | "running";
  exitCode?: number | string;
  output?: string;
}

export interface Recap {
  stopReason: StopReason;
  filesChanged: number;
  toolCalls: number;
  failedCalls: number;
  checks?: { passed: number; total: number };
  unfinished: string[];
}

export interface Progress {
  contract?: Contract;
  done: string[];
  current?: string;
  decisions: string[];
  deadEnds: string[];
  blocked: string[];
  checkpoints?: string[];
  updatedAt?: string;
}

export interface Attachment {
  name: string;
  path: string;
  kind: "image" | "document" | "text" | "other";
  size: number;
}

export interface RunStatus {
  step: number;
  contextTokens: number;
  contextWindow: number;
  usage: Usage;
  cachedTokens: number;
}

export interface PlanStep {
  text: string;
  status: "pending" | "in_progress" | "done";
}

export interface FileRef {
  path: string;
  name: string;
  action: "created" | "modified";
  size: number;
  rel?: string;
  exists?: boolean;
}

export interface RepoLink {
  name: string;
  url: string;
  path: string;
  connector?: string;
  connectedAt: string;
}

export interface RepoStatus extends RepoLink {
  scope: "project" | "chat";
  exists: boolean;
  branch?: string;
  dirty?: number;
  ahead?: number;
  behind?: number;
  upstream?: string;
  active?: boolean;
  error?: string;
}

export interface GithubState {
  connected: boolean;
  account?: string;
  state: string;
  error?: string;
}

export interface GithubRepo {
  full_name: string;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  default_branch: string;
  html_url: string;
  pushed_at: string;
  fork: boolean;
  archived: boolean;
}

export interface ChatSummary {
  id: string;
  title: string;
  projectId?: string;
  model?: string;
  updatedAt: string;
  /** Set while the chat is working on the server: "waiting" means it needs an approval. */
  status?: "running" | "waiting";
}

export interface Chat extends ChatSummary {
  turns: Turn[];
  repos?: RepoLink[];
  activeRepo?: string;
  running?: boolean;
  progress?: Progress;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  updatedAt: string;
  chatCount?: number;
  taskCount?: number;
  repos?: RepoLink[];
}

export interface ProjectDetail extends Project {
  /** Absolute path of the project's folder on this computer. */
  folder: string;
  instructions: string;
  files: string[];
  chats: ChatSummary[];
  tasks: Task[];
}

export interface Task {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  projectId?: string;
  model?: string;
  enabled: boolean;
  lastRun?: string;
  lastStatus: "ok" | "error" | "running" | "never";
  lastChatId?: string;
  nextRun?: string | null;
  scheduleText?: string;
}

export interface GateResult {
  baseline: number;
  candidate: number;
  delta: number;
  targetedBaseline: number;
  targetedCandidate: number;
  heldOutBaseline: number;
  heldOutCandidate: number;
  regressions: string[];
  passed: boolean;
  notes: string[];
  model: string;
}

export interface Proposal {
  id: string;
  kind: "memory" | "skill" | "prompt" | "profile" | "strategy" | "extension" | "ui";
  changes?: { path: string; before: string | null; after: string | null }[];
  title: string;
  reason: string;
  diff: string;
  source: "agent" | "reflector" | "user";
  gate?: GateResult;
  status: "pending" | "accepted" | "rejected" | "failed" | "rolled_back";
  createdAt: string;
  decidedAt?: string;
}

export interface Job {
  id: string;
  kind: string;
  title: string;
  status: "running" | "done" | "error";
  log: string[];
  result?: any;
  startedAt: string;
}

export interface ModelInfo {
  ref: string;
  label: string;
  provider: string;
  contextWindow?: number;
  tools?: boolean;
}

export interface Profile {
  id: string;
  contextWindow: number;
  contextWindowSet?: boolean;
  nativeTools: boolean;
  strategy: string;
  fewShot: number;
  temperature?: number;
  escalateTo?: string;
}

export interface Config {
  providers: { name: string; baseUrl: string; apiKeyEnv?: string }[];
  defaults: { chatModel: string; taskModel: string; reflectorModel: string; judgeModel: string; effort?: Effort };
  budgets: { dailyUsd: { chat: number; tasks: number; evolve: number } };
  approval: { autoAccept: { memory: boolean; skill: boolean }; yolo?: boolean; yoloTasks?: boolean; allowCommands?: string[]; taskCommands?: string[] };
  agent?: { shortSteps?: number; maxUsdPerRun?: number; maxMinutes?: number; longSteps?: number; longMinutes?: number; maxUsdPerLongRun?: number; reviewAfterErrors?: number; gitCheckpoints?: boolean; lazyTools?: boolean };
  evolve: { samplesPerCase: number; maxAttempts: number; heldOutFraction: number };
  killSwitch: boolean;
  hasOpenRouterKey: boolean;
  hasMiniMaxKey?: boolean;
}

export interface AppState {
  config: Config;
  projects: Project[];
  chats: ChatSummary[];
  pendingProposals: number;
  spend: { chat: number; tasks: number; evolve: number };
  strategies: { name: string; description: string }[];
  skills: { name: string; description: string }[];
  extensions: { name: string; ok: boolean; error?: string; tools: string[] }[];
  mcp: { name: string; tools: string[]; error?: string }[];
  homePath: string;
  workspacePath?: string;
  github?: GithubState;
}

export interface EvalSummary {
  id: string;
  model: string;
  startedAt: string;
  score: number;
  heldOutScore: number;
  cases: { id: string; score: number; heldOut: boolean; notes: string[] }[];
}

export type AgentEvent =
  | { type: "run_start"; runId: string; model: string; strategy: string; at?: number }
  | { type: "token"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; result: string; ms: number }
  | { type: "approval_request"; id: string; tool: string; args: unknown; reason: string }
  | { type: "approval_done"; id: string; allow: boolean; auto?: boolean }
  | { type: "idle" }
  | { type: "files"; files: FileRef[] }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "note"; text: string; reset?: boolean }
  | { type: "status"; step: number; contextTokens: number; contextWindow: number; usage: Usage; cachedTokens: number }
  | { type: "steer"; text: string }
  | { type: "contract"; contract: Contract }
  | { type: "checks"; checks: CheckResult[] }
  | { type: "error"; error: string }
  | { type: "run_end"; runId: string; content: string; status: string; usage: Usage; stopReason?: StopReason; recap?: Recap; question?: { question: string; options: string[] } }
  | { type: "step" | "message" };

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

export const api = {
  get: <T>(p: string) => req<T>("GET", p),
  post: <T>(p: string, b: unknown = {}) => req<T>("POST", p, b),
  put: <T>(p: string, b: unknown) => req<T>("PUT", p, b),
  patch: <T>(p: string, b: unknown) => req<T>("PATCH", p, b),
  del: <T>(p: string) => req<T>("DELETE", p),
};

/** Start a turn on the server. It runs in the background; follow it with followChat. */
export const sendMessage = (chatId: string, text: string, model?: string, extra: { attachments?: Attachment[]; mode?: "long" } = {}) => api.post(`/chats/${chatId}/messages`, { text, model, ...extra });

/** Steer a running chat: the agent reads this at its next step. */
export const queueMessage = (chatId: string, text: string) => api.post<{ ok: boolean; queued: number }>(`/chats/${chatId}/queue`, { text });

/** Upload a file for the next message (read in the browser, sent as base64). */
export async function uploadAttachment(chatId: string, file: File): Promise<Attachment> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const name = file.name && file.name !== "image.png" ? file.name : `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${(file.type.split("/")[1] || "png").replace("jpeg", "jpg")}`;
  return api.post<Attachment>(`/chats/${chatId}/attachments`, { name, data: btoa(bin) });
}

/** Follow a chat's current run: replays it from the start, then streams until it ends. Aborting only stops watching. */
export async function followChat(chatId: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal) {
  const res = await fetch(`/api/chats/${chatId}/stream`, { signal });
  if (!res.ok || !res.body) throw new Error(`Request failed: ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

export function subscribe(onEvent: (e: any) => void) {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  return () => es.close();
}

export const modelLabel = (ref?: string) => {
  if (!ref) return "";
  const i = ref.indexOf(":");
  const provider = i > 0 ? ref.slice(0, i) : "openrouter";
  const model = i > 0 ? ref.slice(i + 1) : ref;
  if (provider === "minimax") return model.replace(/^MiniMax-/, "MiniMax ").replace(/-/g, " ");
  if (provider !== "openrouter") return `${model} · ${provider}`;
  const name = model.split("/").pop()!;
  return name.replace(/^deepseek-/, "DeepSeek ").replace(/-/g, " ").replace(/\b(\w)/g, (c) => c.toUpperCase());
};

export function relTime(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso).getTime();
  const diff = (Date.now() - d) / 1000;
  const fut = diff < 0;
  const s = Math.abs(diff);
  const f = (n: number, u: string) => (fut ? `in ${n} ${u}` : `${n} ${u} ago`);
  if (s < 60) return fut ? "in under a minute" : "just now";
  if (s < 3600) return f(Math.round(s / 60), "min");
  if (s < 86400) return f(Math.round(s / 3600), "h");
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export type Effort = "auto" | "low" | "medium" | "high" | "xhigh" | "max";

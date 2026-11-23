// Shared types for the Syph harness. Messages follow the OpenAI chat format so any
// OpenAI-compatible endpoint (OpenRouter, Ollama, LM Studio, vLLM, llama.cpp) works unchanged.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  /** Images for vision models (data: URLs), sent as content parts. Never stored in history. */
  images?: string[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** The model's thinking, for providers that need it sent back with its tool calls (MiniMax). */
  reasoning_content?: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** Prompt tokens served from the provider's cache (cheaper), when it reports them. */
  cachedTokens?: number;
}

/** Why a run ended. "done": the model finished. The rest mean the work may be unfinished. */
export type StopReason = "done" | "budget" | "repeated_error" | "question" | "checks_failed";

/** Events streamed out of a run. The UI, traces and evals all consume the same stream. */
export type AgentEvent =
  | { type: "run_start"; runId: string; model: string; strategy: string; at?: number }
  | { type: "token"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; result: string; ms: number }
  | { type: "approval_request"; id: string; tool: string; args: unknown; reason: string }
  | { type: "approval_done"; id: string; allow: boolean; auto?: boolean }
  | { type: "step"; step: number; usage: Usage }
  | { type: "note"; text: string; reset?: boolean }
  | { type: "message"; message: ChatMessage }
  | { type: "files"; files: FileRef[] }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "status"; step: number; contextTokens: number; contextWindow: number; usage: Usage; cachedTokens: number }
  | { type: "steer"; text: string }
  | { type: "contract"; contract: Contract }
  | { type: "checks"; checks: CheckResult[] }
  | { type: "error"; error: string }
  | { type: "run_end"; runId: string; content: string; usage: Usage; status: "ok" | "error" | "cancelled"; stopReason?: StopReason; recap?: Recap; question?: { question: string; options: string[] } };

/** What "done" means for a task, written before the work starts. */
export interface Contract {
  goal: string;
  /** Paths (globs, relative to the workspace) the work may change. Empty: anywhere in the workspace. */
  scope: string[];
  /** Paths that must not change. */
  never: string[];
  doneWhen: { text: string; command?: string }[];
  /** Drafted but not yet approved by the user (long-task mode). */
  draft?: boolean;
  updatedAt: string;
}

/** One done-when check the harness ran itself. */
export interface CheckResult {
  text: string;
  command?: string;
  status: "pass" | "fail" | "skipped";
  exitCode?: number | string;
  output?: string;
}

/** What the run did, from facts the harness saw rather than the model's own words. */
export interface Recap {
  stopReason: StopReason;
  filesChanged: number;
  toolCalls: number;
  failedCalls: number;
  checks?: { passed: number; total: number };
  unfinished: string[];
}

export interface ModelProfile {
  /** Model reference, "provider:model", e.g. "openrouter:deepseek/deepseek-v4-pro" or "ollama:qwen3:14b". */
  id: string;
  contextWindow: number;
  /** True when the user chose this window in Settings; otherwise the model's full window is used. */
  contextWindowSet?: boolean;
  /** Whether the endpoint supports native OpenAI tool calling. When false, a text protocol is used. */
  nativeTools: boolean;
  temperature?: number;
  /** Optional file under prompts/ used instead of system.md for this model. */
  promptVariant?: string;
  /** Inference strategy name (see strategies/). */
  strategy: string;
  /** Number of retrieved few-shot examples to show; 0 disables. */
  fewShot: number;
  /** For the cascade strategy: model to escalate to. */
  escalateTo?: string;
  /** Model that checks this one's answers in verify and cascade (a separate judge). Default: the same model. */
  critic?: string;
  /** Accepts images. Unset: guessed from the model name. */
  vision?: boolean;
  costPerMTokIn?: number;
  costPerMTokOut?: number;
}

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKeyEnv?: string;
}

export interface SyphConfig {
  providers: ProviderConfig[];
  defaults: {
    chatModel: string;
    taskModel: string;
    reflectorModel: string;
    judgeModel: string;
  };
  budgets: { dailyUsd: { chat: number; tasks: number; evolve: number } };
  approval: {
    autoAccept: { memory: boolean; skill: boolean };
    /** YOLO: run every ask-first tool (shell, tasks, MCP) in chats without asking. */
    yolo?: boolean;
    /** Also auto-approve those tools in scheduled Tasks, which otherwise decline them. */
    yoloTasks?: boolean;
    /** Shell commands the user chose to always allow (exact text). */
    allowCommands?: string[];
    /** Command prefixes scheduled Tasks may run without asking, e.g. "npm test". */
    taskCommands?: string[];
  };
  evolve: { samplesPerCase: number; maxAttempts: number; heldOutFraction: number };
  killSwitch: boolean;
  mcpServers: { name: string; command: string; args?: string[]; env?: Record<string, string> }[];
  agent: {
    /** Old single step budget; no longer used (see shortSteps / longSteps). */
    maxSteps?: number;
    /** Step budget for ordinary requests. Past it, the agent is asked to plan the rest as a long task. */
    shortSteps?: number;
    /** Step cap for long tasks (0: none; they run until done). */
    longSteps?: number;
    /** Time cap for long tasks in minutes (0: none). */
    longMinutes?: number;
    /** Spend cap for one long task in USD (0: none; the daily budget still applies). */
    maxUsdPerLongRun?: number;
    /** Failed tool calls in one run that make the harness review the run and propose a fix in Evolve (0: off). */
    reviewAfterErrors?: number;
    /** Spend cap for one run, in USD (0: none). When hit, the run pauses and the user can Continue. */
    maxUsdPerRun?: number;
    /** Time cap for one run, in minutes (0: none). */
    maxMinutes?: number;
    /** Commit a linked repo after each plan step that finishes (never pushes). */
    gitCheckpoints?: boolean;
    /** Send connector and MCP tools only once the chat needs them (find_tools). */
    lazyTools?: boolean;
  };
  disabledExtensions?: string[];
  /** Connectors switched off on the Connectors page. */
  disabledConnectors?: string[];
  /** Interface changes Syph made: ones switched off, and safe mode (hide them all). */
  ui?: { disabled?: string[]; safeMode?: boolean };
  toolPermissions?: Record<string, "auto" | "ask" | "deny">;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  createdAt: string;
  updatedAt: string;
  /** Git repositories connected to (cloned into) this project. */
  repos?: RepoLink[];
}

export interface RepoLink {
  name: string;
  url: string;
  /** Absolute folder it was cloned into. */
  path: string;
  connector?: string;
  connectedAt: string;
}

export interface ChatRecord {
  id: string;
  title: string;
  projectId?: string;
  model?: string;
  /** Repositories linked to this chat only (a chat also works on its project's repos). */
  repos?: RepoLink[];
  /** Folder of the repo this chat is working on now (defaults to the last one linked). */
  activeRepo?: string;
  createdAt: string;
  updatedAt: string;
  /** Display messages: user + assistant turns with the tool calls that happened in between. */
  turns: Turn[];
  /** Raw model-facing history (includes tool messages). */
  history: ChatMessage[];
  /** Where this chat's contract and progress are kept (scheduled tasks share one across runs). */
  progressKey?: string;
  /** Connector and MCP tools this chat has loaded with find_tools. */
  loadedTools?: string[];
}

export interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
  runId?: string;
  model?: string;
  toolCalls?: { id: string; name: string; args: unknown; result?: string; ok?: boolean; ms?: number }[];
  rating?: "up" | "down";
  /** Files this answer created or changed, with their full path on disk. */
  files?: FileRef[];
  /** The step-by-step plan the agent kept for a multi-step task, as it ended. */
  plan?: PlanStep[];
  /** How long the answer took, start to finish. */
  durationMs?: number;
  /** Why the run ended, when it wasn't simply finished. */
  stopReason?: StopReason;
  /** A question the agent asked with ask_user, with answer buttons. */
  question?: { question: string; options: string[] };
  /** Done-when checks the harness ran at the end. */
  checks?: CheckResult[];
  /** Facts about the run for the end-of-turn recap. */
  recap?: Recap;
  /** Messages the user sent while this answer was being worked on. */
  steering?: string[];
  /** A review of this run's mistakes, filed in Evolve as a proposal. */
  review?: { status: "running" | "proposed" | "none"; mistakes: number; proposalId?: string; title?: string; note?: string };
  /** Files the user attached to this message (user turns). */
  attachments?: Attachment[];
  usage?: Usage;
  createdAt: string;
}

export interface Attachment {
  name: string;
  /** Absolute path where it was saved. */
  path: string;
  kind: "image" | "document" | "text" | "other";
  size: number;
}

export interface PlanStep {
  text: string;
  status: "pending" | "in_progress" | "done";
}

export interface FileRef {
  /** Absolute path on this computer. */
  path: string;
  name: string;
  action: "created" | "modified";
  size: number;
  /** Path inside the workspace or project folder, when it is in one. */
  rel?: string;
}

export interface Task {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  projectId?: string;
  model?: string;
  enabled: boolean;
  createdAt: string;
  lastRun?: string;
  lastStatus: "ok" | "error" | "running" | "never";
  lastRunId?: string;
  lastChatId?: string;
}

export type ProposalKind = "memory" | "skill" | "prompt" | "profile" | "strategy" | "extension" | "ui";

export interface FileChange {
  /** Path relative to the Syph home. */
  path: string;
  before: string | null;
  after: string | null;
}

export interface Proposal {
  id: string;
  kind: ProposalKind;
  title: string;
  reason: string;
  changes: FileChange[];
  diff: string;
  source: "agent" | "reflector" | "user";
  targetCases?: string[];
  gate?: GateResult;
  status: "pending" | "accepted" | "rejected" | "failed" | "rolled_back";
  createdAt: string;
  decidedAt?: string;
  decisionNote?: string;
}

export interface GateResult {
  model: string;
  baseline: number;
  candidate: number;
  delta: number;
  stdErr: number;
  targetedBaseline: number;
  targetedCandidate: number;
  regressions: string[];
  heldOutBaseline: number;
  heldOutCandidate: number;
  passed: boolean;
  notes: string[];
}

export type Check =
  | { type: "contains"; value: string; caseSensitive?: boolean }
  | { type: "not_contains"; value: string; caseSensitive?: boolean }
  | { type: "regex"; pattern: string; flags?: string }
  | { type: "json"; requiredKeys?: string[] }
  | { type: "tool_called"; name: string }
  | { type: "max_words"; value: number }
  | { type: "exec"; command: string; expectExit?: number }
  | { type: "judge"; rubric: string; reference?: string };

export interface EvalCase {
  id: string;
  input: string;
  projectId?: string;
  checks: Check[];
  tags?: string[];
  /** Files seeded into the workspace before the case runs. */
  files?: Record<string, string>;
  source?: { runId?: string; chatId?: string; rating?: "up" | "down" };
  createdAt: string;
}

export interface EvalRunSummary {
  id: string;
  model: string;
  startedAt: string;
  score: number;
  heldOutScore: number;
  cases: { id: string; score: number; heldOut: boolean; notes: string[] }[];
}

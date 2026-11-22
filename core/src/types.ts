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
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/** Events streamed out of a run. The UI, traces and evals all consume the same stream. */
export type AgentEvent =
  | { type: "run_start"; runId: string; model: string; strategy: string }
  | { type: "token"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; result: string; ms: number }
  | { type: "approval_request"; id: string; tool: string; args: unknown; reason: string }
  | { type: "approval_done"; id: string; allow: boolean; auto?: boolean }
  | { type: "step"; step: number; usage: Usage }
  | { type: "note"; text: string; reset?: boolean }
  | { type: "message"; message: ChatMessage }
  | { type: "files"; files: FileRef[] }
  | { type: "error"; error: string }
  | { type: "run_end"; runId: string; content: string; usage: Usage; status: "ok" | "error" | "cancelled" };

export interface ModelProfile {
  /** Model reference, "provider:model", e.g. "openrouter:deepseek/deepseek-v4-pro" or "ollama:qwen3:14b". */
  id: string;
  contextWindow: number;
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
  };
  evolve: { samplesPerCase: number; maxAttempts: number; heldOutFraction: number };
  killSwitch: boolean;
  mcpServers: { name: string; command: string; args?: string[]; env?: Record<string, string> }[];
  agent: { maxSteps: number };
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
  createdAt: string;
  updatedAt: string;
  /** Display messages: user + assistant turns with the tool calls that happened in between. */
  turns: Turn[];
  /** Raw model-facing history (includes tool messages). */
  history: ChatMessage[];
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
  createdAt: string;
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

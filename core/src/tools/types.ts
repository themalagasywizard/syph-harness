import type { z } from "zod";
import type { BrowserBridge } from "../browser.ts";
import type { Home } from "../home.ts";
import type { Contract, Proposal, TerminalEntry, UserQuestion } from "../types.ts";
import type { LinkedFolder } from "../folders.ts";
import type { Terminal } from "../terminal.ts";
import type { ProposalInput } from "../evolve/proposals.ts";

export type Permission = "auto" | "ask" | "deny";

export interface ToolContext {
  home: Home;
  /** Absolute folder the file tools work in (relative paths). */
  workspace: string;
  /** Folders on the user's computer linked to this chat, its coordinator or its project. */
  folders?: LinkedFolder[];
  /** Runs and logs terminal commands (set by Harness). */
  terminal?: Terminal;
  projectId?: string;
  chatId?: string;
  runId: string;
  signal?: AbortSignal;
  /** Ask the user to allow a risky call. Resolves false when declined or unattended. */
  approve: (tool: string, args: unknown, reason: string) => Promise<boolean>;
  propose: (input: ProposalInput) => Proposal;
  /** Hooks into the wider harness (set by Harness). */
  hooks: {
    createTask?: (t: { name: string; prompt: string; schedule: string; projectId?: string }) => { id: string };
    runSubagent?: (prompt: string) => Promise<string>;
    /** Show the user the agent's plan for a multi-step task (a live checklist in the chat). */
    plan?: (steps: { text: string; status: "pending" | "in_progress" | "done" }[]) => void;
    /** End the turn after this step's tools, showing the user a question with answer buttons or a model selector (set by the loop). */
    endTurn?: (q: UserQuestion) => void;
    /** Read and change the chat's contract (set by Harness). */
    contract?: { get: () => Contract | undefined; set: (c: Contract) => void };
    /** Record progress that must survive compaction and later sessions (set by Harness). */
    progress?: (entry: { decision?: string; deadEnd?: string; blocked?: string; done?: string }) => string;
    /** Make hidden connector or MCP tools available to this chat (set by Harness). */
    loadTools?: (names: string[]) => void;
    /** A terminal command started or ended (for the chat's command log). */
    terminal?: (e: TerminalEntry) => void;
    /** A coordinator's threads (set by Harness for coordinator chats only). */
    threads?: ThreadHooks;
    /** In-app browser bridge (set by Harness so agents can preview & inspect pages live). */
    browser?: BrowserBridge;
    /** Attach a base64 data: URL image to the next model step (e.g. live browser screenshot for visual QA). */
    attachImage?: (dataUrl: string) => void;
  };
  /** Connector and MCP tool names this chat has loaded (lazy tools). */
  loadedTools?: Set<string>;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** Raw JSON schema to advertise instead of converting `schema` (used for MCP tools). */
  jsonSchema?: Record<string, unknown>;
  permission: Permission;
  /** Optional per-call check: return a reason string to require approval for this call. */
  needsApproval?: (args: z.infer<S>, ctx: ToolContext) => string | null;
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<string> | string;
}

export function defineTool<S extends z.ZodType>(t: Tool<S>): Tool<S> {
  return t;
}

/** What a coordinator can do with its threads. Each returns text for the model. */
export interface ThreadHooks {
  start: (t: { title: string; prompt: string; model?: string; frontend?: boolean; ask_model?: boolean; model_reason?: string; long?: boolean }) => string;
  message: (threadId: string, text: string) => string;
  list: () => string;
  read: (threadId: string, lastTurns?: number) => string;
  stop: (threadId: string) => string;
  resolve: (threadId: string) => string;
}

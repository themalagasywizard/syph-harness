import type { z } from "zod";
import type { Home } from "../home.ts";
import type { Proposal } from "../types.ts";
import type { ProposalInput } from "../evolve/proposals.ts";

export type Permission = "auto" | "ask" | "deny";

export interface ToolContext {
  home: Home;
  /** Absolute folder the file tools are confined to. */
  workspace: string;
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
  };
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

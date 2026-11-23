// Assembles what the model sees: core prompt, project, memory, skills, examples. Each part
// has a token budget so a growing memory or skill list can never crowd out the conversation.
import { platform } from "node:os";
import { retrieve } from "./examples.ts";
import type { Home } from "./home.ts";
import { getProfile } from "./providers/models.ts";
import { listSkills } from "./skills.ts";
import type { ChatMessage, ModelProfile, Project } from "./types.ts";
import { estimateTokens, readJson } from "./util.ts";

export interface ContextInput {
  model: string;
  projectId?: string;
  query: string;
  extra?: string;
  /** Section listing connected apps (from the harness). */
  connectors?: string;
}

const clip = (s: string, tokens: number) => (estimateTokens(s) <= tokens ? s : s.slice(0, tokens * 4) + "\n…(trimmed)");

export function corePromptPath(home: Home, profile: ModelProfile) {
  const variant = profile.promptVariant ?? `variants/${profile.id.replace(/[^\w.-]+/g, "_")}.md`;
  return home.exists(`prompts/${variant}`) ? `prompts/${variant}` : "prompts/system.md";
}

export function buildSystemPrompt(home: Home, input: ContextInput): string {
  const profile = getProfile(home, input.model);
  // A quarter of the window, but never more than 40k tokens: a 1M-token model shouldn't pay for a huge prompt every step.
  const budget = Math.min(40_000, Math.max(2000, Math.floor(profile.contextWindow * 0.25)));
  // Stable parts first, so providers that cache prompt prefixes can reuse them turn after turn.
  // Anything that changes per request (examples, the date, progress) goes at the end.
  const parts: string[] = [];

  parts.push((home.read(corePromptPath(home, profile)) ?? "").trim());

  if (input.projectId) {
    const p = readJson<Project | null>(home.path("projects", input.projectId, "project.json"), null);
    const instr = home.read(`projects/${input.projectId}/instructions.md`)?.trim();
    if (p) parts.push(`# Project: ${p.name}\n${p.description}${instr ? `\n\n${clip(instr, budget * 0.2)}` : ""}`);
  }

  const memory = [home.read("memory/user.md"), input.projectId ? home.read(`memory/project-${input.projectId}.md`) : null]
    .filter((m): m is string => !!m && m.replace(/^#.*$/gm, "").trim().length > 0)
    .join("\n\n");
  if (memory) parts.push(`# Memory\nWhat you know about the user and this work (approved by the user):\n${clip(memory, budget * 0.25)}`);

  const skills = listSkills(home);
  if (skills.length) parts.push(`# Skills\nCall read_skill(name) before using one.\n${clip(skills.map((s) => `- ${s.name}: ${s.description}`).join("\n"), budget * 0.15)}`);

  if (input.connectors) parts.push(input.connectors);

  parts.push(`Today is ${new Date().toDateString()}. The user's computer runs ${platform()}.`);

  if (profile.fewShot > 0 && input.query) {
    const ex = retrieve(home, input.query, profile.fewShot);
    if (ex.length) parts.push(`# Examples of good answers to similar requests\n${clip(ex.map((e) => `<example>\nRequest: ${e.input}\nAnswer: ${e.output}\n</example>`).join("\n"), budget * 0.3)}`);
  }

  if (input.extra) parts.push(input.extra);
  return parts.filter(Boolean).join("\n\n");
}

/** A short stand-in for a long tool result that the model has already acted on. */
export function elideToolResult(content: string, keep = 1200, where = "") {
  if (content.length <= keep * 1.5) return content;
  return `${content.slice(0, keep)}\n…[${content.length - keep} more chars of this earlier result were dropped to save context${where}. Call the tool again if you need them.]`;
}

/**
 * Replace all but the last `keepLast` tool results with short stubs. The calls stay, so the
 * model still sees what it did; only the bulky output goes. Pure: returns a new list.
 */
export function shrinkToolResults(messages: ChatMessage[], keepLast: number, keep: number): ChatMessage[] {
  const toolIdx = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []));
  const old = new Set(toolIdx.slice(0, Math.max(0, toolIdx.length - keepLast)));
  return messages.map((m, i) => (old.has(i) && m.content ? { ...m, content: elideToolResult(m.content, keep) } : m));
}

/** Token estimate of a message list. */
export const historyTokens = (ms: ChatMessage[]) => ms.reduce((n, m) => n + estimateTokens((m.content ?? "") + JSON.stringify(m.tool_calls ?? "")), 0);

/**
 * Keep the history inside the model's window. Older turns are replaced by a summary produced
 * by `summarise`, never silently dropped. Tool-call/result pairs are kept together.
 */
export async function compactHistory(history: ChatMessage[], window: number, summarise: (text: string) => Promise<string>): Promise<ChatMessage[]> {
  const limit = Math.floor(window * 0.6);
  if (historyTokens(history) <= limit) return history;
  // Find a cut point on a user message, keeping roughly the last third of the window.
  let keepFrom = history.length;
  let tokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    tokens += historyTokens([history[i]]);
    if (tokens > window * 0.3 && history[i].role === "user") {
      keepFrom = i;
      break;
    }
  }
  if (keepFrom <= 1 || keepFrom >= history.length) keepFrom = Math.max(1, history.findLastIndex((m) => m.role === "user"));
  const old = history.slice(0, keepFrom);
  const text = old.map((m) => `${m.role}${m.name ? `(${m.name})` : ""}: ${(m.content ?? "").slice(0, 4000)}${m.tool_calls ? ` [called ${m.tool_calls.map((c) => c.function.name).join(", ")}]` : ""}`).join("\n");
  const summary = await summarise(text);
  return [{ role: "user", content: `[Summary of the earlier conversation]\n${summary}` }, { role: "assistant", content: "Understood. Continuing from there." }, ...history.slice(keepFrom)];
}

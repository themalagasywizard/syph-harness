// When a run makes many mistakes, the harness doesn't just retry: it asks the reflector to find the
// missing harness part behind them (a tool, a skill, a rule, a setting) and files ONE proposal in
// Evolve. Nothing changes until the user approves it there.
import type { Home } from "../home.ts";
import { complete } from "../providers/llm.ts";
import type { Proposal, ProposalKind, Turn } from "../types.ts";
import { extractJson } from "../util.ts";
import { HARNESS_LENS, SKILL_RULES } from "./engine.ts";
import { createProposal, kindForPath, listProposals } from "./proposals.ts";
import { listSkills } from "../skills.ts";

/** Failed calls that count as mistakes: a user saying no to an action is not one. */
export const mistakes = (turn: Pick<Turn, "toolCalls">) => (turn.toolCalls ?? []).filter((c) => c.ok === false && !/^The user declined/.test(c.result ?? ""));

export function needsReview(home: Home, turn: Turn): boolean {
  const threshold = home.config().agent.reviewAfterErrors ?? 4;
  if (threshold <= 0 || home.config().killSwitch) return false;
  return mistakes(turn).length >= threshold || turn.stopReason === "repeated_error" || turn.stopReason === "checks_failed";
}

const REVIEWER = `You review one run of an AI assistant called Syph that made too many mistakes, and propose ONE change to Syph's own files so the same kind of mistake stops happening. You see the request, every tool call with its result, and the final answer.

You may propose:
- a skill: skills/<kebab-name>/SKILL.md with frontmatter (---\\nname: <name>\\ndescription: <when to use it>\\n---) and numbered steps;
- a new tool: extensions/<kebab-name>.ts in this exact shape, with no imports:
  export default (syph) => ({ tools: [syph.defineTool({ name: "snake_name", description: "...", permission: "auto", schema: syph.z.object({ ... }), run: async (args, ctx) => "result text" })], test: async () => {} });
  Tools run in Node with the user's workspace at ctx.workspace. Use "ask" as permission for anything that changes files outside the workspace or sends data;
- a line in prompts/system.md (give the whole new file);
- a memory fact in memory/user.md (give the whole new file);
- a profile setting in profiles/<model>.json (e.g. "strategy": "verify").
Prefer a mechanism (a tool that does the fiddly part, a skill with a checking step) over a new "always do X" sentence. Never special-case this exact request.

Reply with JSON only: {"diagnosis": "...", "question": "see|do|tell", "kind": "skill|extension|prompt|memory|profile", "title": "<short imperative>", "reason": "<why this prevents the mistakes, one or two sentences>", "files": [{"path": "...", "content": "<full file>"}]}
If the mistakes were the user's environment (a missing program, no network, a wrong key) and no change to Syph would help, reply {"none": true, "diagnosis": "..."}.`;

export interface ReviewInput {
  model: string;
  runId: string;
  request: string;
  turn: Turn;
}

/** Ask the reflector for one fix. Returns the proposal, or null with the reason when there is none. */
export async function reviewRun(home: Home, input: ReviewInput): Promise<{ proposal: Proposal | null; diagnosis: string }> {
  const calls = (input.turn.toolCalls ?? []).map((c, i) => `${i + 1}. ${c.ok === false ? "FAILED " : ""}${c.name} ${JSON.stringify(c.args ?? {}).slice(0, 400)}\n   → ${(c.result ?? "").replace(/\s+/g, " ").slice(0, c.ok === false ? 600 : 200)}`).join("\n");
  const prompt = home.read("prompts/system.md") ?? "";
  // Full text of each active skill, so a fix can rewrite the one that failed rather than add another.
  const skills = listSkills(home).map((s) => `<file path="${s.path}">\n${(home.read(s.path) ?? "").slice(0, 3000)}\n</file>`).join("\n");
  const past = listProposals(home).slice(0, 8).map((p) => `- [${p.status}] ${p.title}`).join("\n");
  const cfg = home.config();
  const res = await complete(home, {
    model: cfg.defaults.reflectorModel,
    category: "evolve",
    temperature: 0.3,
    jsonMode: true,
    messages: [
      { role: "system", content: `${REVIEWER}\n\n${HARNESS_LENS}\n\n${SKILL_RULES}` },
      {
        role: "user",
        content: [
          `Model: ${input.model}\nRun: ${input.runId}\nStopped because: ${input.turn.stopReason ?? "finished"}`,
          `# Request\n${input.request.slice(0, 4000)}`,
          `# Tool calls (${(input.turn.toolCalls ?? []).length}, ${mistakes(input.turn).length} failed)\n${calls.slice(0, 20_000)}`,
          `# Final answer\n${input.turn.content.slice(0, 2000)}`,
          `# Current system prompt\n<file path="prompts/system.md">\n${prompt}\n</file>`,
          skills ? `# Current skills (rewrite one of these at its path rather than adding a near-copy)\n${skills}` : "",
          past ? `# Recent proposals (don't repeat one)\n${past}` : "",
        ].filter(Boolean).join("\n\n"),
      },
    ],
  });
  const out = extractJson<{ none?: boolean; diagnosis?: string; question?: string; kind?: ProposalKind; title?: string; reason?: string; files?: { path: string; content: string | null }[] }>(res.content);
  if (!out) return { proposal: null, diagnosis: "The review didn't produce a usable answer." };
  if (out.none || !out.files?.length) return { proposal: null, diagnosis: out.diagnosis ?? "No change to Syph would help." };
  // content null deletes a file; only allowed for skills (e.g. one the fix makes redundant).
  const files = out.files.filter((f) => typeof f?.path === "string" && (typeof f.content === "string" || (f.content === null && /^skills\//.test(f.path) && home.exists(f.path))) && home.isEvolvable(f.path));
  if (!files.length) return { proposal: null, diagnosis: `${out.diagnosis ?? ""} (The suggested change touched files Syph may not edit.)`.trim() };
  const proposal = createProposal(home, {
    kind: out.kind && ["skill", "extension", "prompt", "memory", "profile"].includes(out.kind) ? out.kind : kindForPath(files[0].path),
    title: out.title?.slice(0, 120) || "Fix mistakes from a run",
    reason: `${out.diagnosis ? `${out.diagnosis} ` : ""}${out.reason ?? ""} (From a run with ${mistakes(input.turn).length} failed tool calls: ${input.runId}.)`.trim(),
    files,
    source: "reflector",
  });
  return { proposal, diagnosis: out.diagnosis ?? "" };
}

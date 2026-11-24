// Long tasks, made reliable by the harness rather than the prompt:
// - a contract says what "done" means before work starts (set_contract),
// - progress lives in a file outside the context window (note_progress, plan updates),
// - the harness runs the done-when checks itself, so "done" is evidence that could come back red,
// - the agent can stop and ask instead of guessing (ask_user).
import { z } from "zod";
import type { Home } from "./home.ts";
import { runShell } from "./tools/builtin.ts";
import { defineTool, type ToolContext } from "./tools/types.ts";
import type { CheckResult, Contract, PlanStep } from "./types.ts";
import { headTail, now, readJson, writeJson, writeText } from "./util.ts";
export { globToRegExp, scopeViolation } from "./scope.ts";

export interface Progress {
  contract?: Contract;
  done: string[];
  current?: string;
  decisions: string[];
  deadEnds: string[];
  blocked: string[];
  /** Git checkpoints saved in a linked repo after finished steps. */
  checkpoints?: string[];
  updatedAt?: string;
}

const empty = (): Progress => ({ done: [], decisions: [], deadEnds: [], blocked: [] });
const safeKey = (key: string) => key.replace(/[^\w.-]+/g, "_");

/** Progress for a chat, or shared by every run of a scheduled task. */
export const progressKey = (chat: { id: string; progressKey?: string }) => chat.progressKey ?? `chat-${chat.id}`;

export function readProgress(home: Home, key: string): Progress {
  return { ...empty(), ...readJson<Partial<Progress>>(home.path("progress", `${safeKey(key)}.json`), {}) };
}

export function writeProgress(home: Home, key: string, p: Progress) {
  p.updatedAt = now();
  writeJson(home.path("progress", `${safeKey(key)}.json`), p);
  // A readable copy next to it: the user (or a fresh session) can open it.
  writeText(home.path("progress", `${safeKey(key)}.md`), renderProgress(p));
}

export function updateProgress(home: Home, key: string, change: (p: Progress) => void) {
  const p = readProgress(home, key);
  change(p);
  writeProgress(home, key, p);
  return p;
}

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/** Fold a plan update into progress: finished steps are done, the in-progress one is current. */
export function planToProgress(p: Progress, steps: PlanStep[]) {
  p.done = uniq([...p.done, ...steps.filter((s) => s.status === "done").map((s) => s.text)]);
  p.current = steps.find((s) => s.status === "in_progress")?.text ?? (steps.every((s) => s.status === "done") ? undefined : p.current);
}

export function renderProgress(p: Progress): string {
  const list = (title: string, xs: string[]) => (xs.length ? `## ${title}\n${xs.map((x) => `- ${x}`).join("\n")}\n` : "");
  const c = p.contract;
  return [
    "# Progress",
    c ? `## Contract${c.draft ? " (draft, waiting for the user)" : ""}\nGoal: ${c.goal}\n${c.scope.length ? `Scope: ${c.scope.join(", ")}\n` : ""}${c.never.length ? `Never touch: ${c.never.join(", ")}\n` : ""}Done when:\n${c.doneWhen.map((d) => `- ${d.text}${d.command ? ` (\`${d.command}\`)` : ""}`).join("\n")}\n` : "",
    list("Done", p.done),
    p.current ? `## Current\n${p.current}\n` : "",
    list("Decisions", p.decisions),
    list("Dead ends", p.deadEnds),
    list("Blocked", p.blocked),
    list("Checkpoints", (p.checkpoints ?? []).slice(-5)),
  ]
    .filter(Boolean)
    .join("\n");
}

/** The section of the system prompt that carries the contract and progress across turns and compaction. */
export function progressPrompt(p: Progress): string {
  const has = p.contract || p.done.length || p.current || p.decisions.length || p.deadEnds.length || p.blocked.length;
  if (!has) return "";
  return `${renderProgress(p).replace(/^# Progress/, "# Progress so far (saved outside the conversation; trust it over your memory of the chat)")}\nKeep to the decisions above. Don't redo what is done.`;
}

export const longTaskPrompt = `# Long tasks
For work that takes many steps (a migration, a feature, a batch of edits), first call set_contract: the goal, the paths in scope, the paths never to touch, and done_when checks (commands such as "npm test" that must pass). The harness runs those checks itself when you finish; if one fails you will see its output and must fix it. Record every decision and dead end with note_progress as soon as you make it: it is saved outside the conversation, so it survives when old messages are trimmed. If you need a fact or a decision from the user, call ask_user with 2-4 short options instead of guessing.`;

export const setContractTool = defineTool({
  name: "set_contract",
  description:
    'Write down what "done" means for a multi-step task before you start, or change it when the user agrees. done_when lists checks; give each a shell command when one can prove it (tests, a build, a lint, a script). The harness runs those commands when you finish and shows the user the results. scope and never are workspace-relative globs (e.g. "api/routes/**"); writes outside scope are refused.',
  schema: z.object({
    goal: z.string().min(3).max(500),
    scope: z.array(z.string()).max(30).default([]),
    never: z.array(z.string()).max(30).default([]),
    done_when: z.array(z.object({ text: z.string().min(2).max(300), command: z.string().max(500).optional() })).min(1).max(15),
  }),
  permission: "auto",
  run: ({ goal, scope, never, done_when }, ctx) => {
    if (!ctx.hooks.contract) return "Contracts are not available here.";
    const prev = ctx.hooks.contract.get();
    const c: Contract = { goal, scope, never, doneWhen: done_when, updatedAt: now(), ...(prev?.draft ? { draft: true } : {}) };
    ctx.hooks.contract.set(c);
    return c.draft
      ? "Contract drafted. The user reviews it before work starts: stop here and ask them to approve or change it."
      : `Contract saved: ${done_when.length} done-when check${done_when.length === 1 ? "" : "s"}${done_when.some((d) => d.command) ? ", which the harness will run when you finish" : ""}.`;
  },
});

export const noteProgressTool = defineTool({
  name: "note_progress",
  description:
    "Save progress outside the conversation so it survives trimming and later sessions: a decision you made (naming, approach), a dead end you tried and reverted, something blocked on the user, or a piece of work that is done. One short line each.",
  schema: z.object({ decision: z.string().max(300).optional(), dead_end: z.string().max(300).optional(), blocked: z.string().max(300).optional(), done: z.string().max(300).optional() }),
  permission: "auto",
  run: ({ decision, dead_end, blocked, done }, ctx) => {
    if (!ctx.hooks.progress) return "Progress notes are not available here.";
    if (!decision && !dead_end && !blocked && !done) return "Error: give at least one of decision, dead_end, blocked or done.";
    return ctx.hooks.progress({ decision, deadEnd: dead_end, blocked, done });
  },
});

export const askUserTool = defineTool({
  name: "ask_user",
  description:
    "Ask the user a question you can't answer yourself (a decision, a missing fact, a choice between approaches, or which model to use), with 2-4 short answer options they can tap — or set pick_model: true to show an interactive model selector right in the chat/thread. Your turn ends after this call; their answer comes as the next message. Don't use it for things you can find out with your tools.",
  schema: z.object({
    question: z.string().min(3).max(400),
    options: z.array(z.string().min(1).max(80)).max(4).optional(),
    pick_model: z.boolean().optional().describe("Show an interactive model selector so the user can choose which model should continue this chat/thread."),
  }),
  permission: "auto",
  run: ({ question, options, pick_model }, ctx) => {
    if (!ctx.hooks.endTurn) return "Error: you can't ask the user from here. Decide yourself and say what you assumed.";
    if (pick_model) {
      const cfg = ctx.home.config();
      const suggested = [...new Set([cfg.defaults.chatModel, cfg.defaults.frontendModel, ...(options ?? [])].filter((x): x is string => !!x && x.includes(":")))];
      ctx.hooks.endTurn({ question, options: suggested, kind: "model", recommendedModel: cfg.defaults.chatModel });
      return "Asked the user to choose a model. Stop now: their selection arrives as the next step.";
    }
    const opts = (options ?? []).filter(Boolean);
    if (opts.length < 2) return "Error: provide 2-4 options (or set pick_model: true for a model selector).";
    ctx.hooks.endTurn({ question, options: opts });
    return "Asked the user. Stop now: their answer arrives as the next message.";
  },
});

export const longTaskTools = [setContractTool, noteProgressTool, askUserTool];

/** The model loads connector and MCP tools by need, so they don't cost tokens on every step. */
export function findToolsTool(hidden: (ctx: ToolContext) => { name: string; description: string }[]) {
  return defineTool({
    name: "find_tools",
    description: "Load tools for connected apps and MCP servers (email, calendar, files, issues…). Describe what you need in a few words; matching tools become available on your next step.",
    schema: z.object({ query: z.string().min(2).max(200) }),
    permission: "auto",
    run: ({ query }, ctx) => {
      const all = hidden(ctx);
      if (!all.length) return "Every tool is already loaded.";
      const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
      const score = (t: { name: string; description: string }) => words.reduce((n, w) => n + (t.name.toLowerCase().includes(w) ? 3 : 0) + (t.description.toLowerCase().includes(w) ? 1 : 0), 0);
      const hits = all.map((t) => ({ t, n: score(t) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 12).map((x) => x.t);
      if (!hits.length) return `No tool matches "${query}". Groups available: ${[...new Set(all.map((t) => t.name.split(/__|_/)[0]))].join(", ")}. Try one of those words.`;
      ctx.hooks.loadTools?.(hits.map((t) => t.name));
      return `Loaded ${hits.length} tool${hits.length === 1 ? "" : "s"}, usable from your next step:\n${hits.map((t) => `- ${t.name}: ${t.description.split("\n")[0].slice(0, 160)}`).join("\n")}`;
    },
  });
}

/**
 * Run the contract's done-when commands. They come from the model, so each runs only when the
 * user would allow the shell anyway (YOLO, an always-allowed command) or approves it now.
 */
export async function runChecks(c: Contract, cwd: string, allow: (command: string) => Promise<boolean>, signal?: AbortSignal): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const d of c.doneWhen) {
    if (!d.command) {
      out.push({ text: d.text, status: "skipped", output: "No command: this one is up to the agent and you." });
      continue;
    }
    if (!(await allow(d.command))) {
      out.push({ text: d.text, command: d.command, status: "skipped", output: "Not run: the command wasn't approved." });
      continue;
    }
    const res = await runShell(d.command, cwd, 10 * 60_000, signal);
    const code = /^exit code: (\S+)/.exec(res)?.[1] ?? "?";
    out.push({ text: d.text, command: d.command, status: code === "0" ? "pass" : "fail", exitCode: /^\d+$/.test(code) ? Number(code) : code, output: headTail(res, 3000) });
  }
  return out;
}

/** What the model is told when checks fail: the real output, so it fixes the cause. */
export function failedChecksMessage(checks: CheckResult[]) {
  const failed = checks.filter((c) => c.status === "fail");
  return `The harness ran your done-when checks and ${failed.length} failed. The task is not done yet. Fix the cause (don't weaken the check), then finish.\n\n${failed.map((c) => `## ${c.text}\n$ ${c.command}\n${c.output}`).join("\n\n")}`;
}

export type { ToolContext };

// Evals: cases with checks, run through the same agent loop and strategy as real use.
// Scores are 0..1. About a fifth of cases are held out from the reflector to catch overfitting.
import { exec } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSystemPrompt } from "../context.ts";
import type { Home } from "../home.ts";
import { complete } from "../providers/llm.ts";
import { getProfile } from "../providers/models.ts";
import { getStrategy } from "../strategies/index.ts";
import { builtinTools } from "../tools/builtin.ts";
import { longTaskPrompt, longTaskTools } from "../longtask.ts";
import { planPrompt, updatePlanTool } from "../plan.ts";
import type { Contract } from "../types.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import { loadExtensions } from "../extensions.ts";
import { COORDINATOR_PROMPT, COORDINATOR_TOOLS, THREAD_TOOL_NAMES, threadTools } from "../tools/threads.ts";
import type { Check, EvalCase, EvalRunSummary, Proposal } from "../types.ts";
import { extractJson, hash, id, mean, now, readJson, writeJson } from "../util.ts";
import { Trace, readTrace, listRuns } from "../trace.ts";

export function listCases(home: Home): EvalCase[] {
  const dir = home.path("evals/cases");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<EvalCase | null>(join(dir, f), null))
    .filter((c): c is EvalCase => !!c && !!c.input && Array.isArray(c.checks));
}

export function isHeldOut(home: Home, caseId: string) {
  const frac = home.config().evolve.heldOutFraction;
  return parseInt(hash(caseId).slice(0, 8), 16) % 1000 < frac * 1000;
}

export const EVAL_TOOLS = ["list_files", "read_file", "write_file", "edit_file", "search_files", "read_skill", "propose_memory", "propose_skill", "update_plan", "set_contract", "note_progress"];

export interface CaseOutput {
  answer: string;
  toolsCalled: string[];
  workspace: string;
  costUsd: number;
}

/** Run one case once. The workspace is a fresh temp folder seeded with the case's files. */
export async function runCaseOnce(home: Home, model: string, c: EvalCase, extraTools: Tool[] = []): Promise<CaseOutput> {
  const workspace = mkdtempSync(join(tmpdir(), "syph-eval-"));
  for (const [p, content] of Object.entries(c.files ?? {})) {
    mkdirSync(dirname(join(workspace, p)), { recursive: true });
    writeFileSync(join(workspace, p), content);
  }
  const trace = new Trace(home, { kind: "eval", model, strategy: getProfile(home, model).strategy, input: c.input });
  const ctx: ToolContext = {
    home,
    workspace,
    runId: trace.runId,
    approve: async () => false,
    // Evals must never create real proposals.
    propose: (input) => ({ id: "eval-dry-run", kind: input.kind, title: input.title, reason: input.reason, changes: [], diff: "", source: "agent", status: "pending", createdAt: now() }) as Proposal,
    hooks: {},
  };
  // Long-task tools work in evals too, with the contract kept in memory for the case.
  let contract: Contract | undefined;
  ctx.hooks.contract = { get: () => contract, set: (c) => void (contract = c) };
  ctx.hooks.progress = () => "Saved to progress.";
  // Coordinator cases: the thread tools answer from memory, so nothing really starts.
  if (c.coordinator) {
    const started: string[] = [];
    ctx.hooks.threads = {
      start: (t) => (started.push(t.title), `Started thread th_${started.length} "${t.title}". You'll get an update when it finishes.`),
      message: (tid) => `Sent to ${tid}.`,
      list: () => (started.length ? started.map((t, i) => `- th_${i + 1} "${t}": working`).join("\n") : "No threads yet."),
      read: (tid) => `${tid}: still working, no answer yet.`,
      stop: (tid) => `Stopped ${tid}.`,
      resolve: (tid) => `Resolved ${tid}.`,
    };
  }
  const profile = getProfile(home, model);
  try {
    const result = await getStrategy(profile.strategy).run({
      home,
      model,
      request: c.input,
      messages: [
        { role: "system", content: buildSystemPrompt(home, { model, query: c.input, extra: (c.coordinator ? [COORDINATOR_PROMPT] : [planPrompt, longTaskPrompt]).filter(Boolean).join("\n\n") }) },
        { role: "user", content: c.input },
      ],
      tools: new ToolRegistry([...builtinTools, updatePlanTool, ...longTaskTools, ...(c.coordinator ? threadTools : []), ...extraTools]).pick(
        c.coordinator ? [...COORDINATOR_TOOLS, ...THREAD_TOOL_NAMES] : [...EVAL_TOOLS, ...extraTools.filter((t) => t.permission === "auto").map((t) => t.name)],
      ),
      ctx,
      category: "evolve",
      maxSteps: 8,
      emit: (e) => trace.event(e),
    });
    trace.finish({ status: "ok", output: result.content, ...result.usage });
    return { answer: result.content, toolsCalled: result.toolsCalled, workspace, costUsd: result.usage.costUsd };
  } catch (e) {
    trace.finish({ status: "error", output: String(e), promptTokens: 0, completionTokens: 0, costUsd: 0 });
    return { answer: `[error] ${(e as Error).message}`, toolsCalled: [], workspace, costUsd: 0 };
  }
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export async function scoreCheck(home: Home, check: Check, c: EvalCase, out: CaseOutput): Promise<{ score: number; note: string }> {
  const a = out.answer;
  switch (check.type) {
    case "contains": {
      const ok = check.caseSensitive ? a.includes(check.value) : a.toLowerCase().includes(check.value.toLowerCase());
      return { score: ok ? 1 : 0, note: ok ? "" : `missing "${check.value}"` };
    }
    case "not_contains": {
      const hit = check.caseSensitive ? a.includes(check.value) : a.toLowerCase().includes(check.value.toLowerCase());
      return { score: hit ? 0 : 1, note: hit ? `should not contain "${check.value}"` : "" };
    }
    case "regex": {
      const ok = new RegExp(check.pattern, check.flags).test(a.trim());
      return { score: ok ? 1 : 0, note: ok ? "" : `does not match /${check.pattern}/${check.flags ?? ""}` };
    }
    case "json": {
      const j = extractJson<Record<string, unknown>>(a);
      const pure = (() => {
        try {
          JSON.parse(a.trim().replace(/^```(?:json)?|```$/g, ""));
          return true;
        } catch {
          return false;
        }
      })();
      if (!j) return { score: 0, note: "no JSON found" };
      const missing = (check.requiredKeys ?? []).filter((k) => !(k in j));
      if (missing.length) return { score: 0.3, note: `JSON missing keys: ${missing.join(", ")}` };
      return { score: pure ? 1 : 0.6, note: pure ? "" : "JSON wrapped in extra text" };
    }
    case "tool_called": {
      const ok = out.toolsCalled.includes(check.name);
      return { score: ok ? 1 : 0, note: ok ? "" : `did not call ${check.name}` };
    }
    case "tool_not_called": {
      const ok = !out.toolsCalled.includes(check.name);
      return { score: ok ? 1 : 0, note: ok ? "" : `called ${check.name}` };
    }
    case "max_words": {
      const n = words(a);
      return { score: n <= check.value ? 1 : 0, note: n <= check.value ? "" : `${n} words (max ${check.value})` };
    }
    case "exec": {
      const code = await new Promise<number>((res) => exec(check.command, { cwd: out.workspace, timeout: 30_000, windowsHide: true }, (err) => res(err ? ((err as any).code ?? 1) : 0)));
      const ok = code === (check.expectExit ?? 0);
      return { score: ok ? 1 : 0, note: ok ? "" : `check command exited ${code}` };
    }
    case "judge": {
      const judge = home.config().defaults.judgeModel;
      const res = await complete(home, {
        model: judge,
        category: "evolve",
        temperature: 0,
        messages: [
          { role: "system", content: home.read("prompts/judge.md") ?? "Score 0-10. Reply JSON {\"score\":n,\"reason\":\"...\"}" },
          { role: "user", content: `Rubric:\n${check.rubric}\n${check.reference ? `\nReference answer:\n${check.reference}\n` : ""}\nRequest:\n${c.input}\n\nAnswer to score:\n${a}` },
        ],
      });
      const j = extractJson<{ score: number; reason: string }>(res.content);
      const s = Math.max(0, Math.min(10, Number(j?.score ?? 0))) / 10;
      return { score: s, note: s < 0.7 ? `judge ${Math.round(s * 10)}/10: ${j?.reason ?? res.content.slice(0, 160)}` : "" };
    }
  }
}

export interface CaseResult {
  id: string;
  score: number;
  heldOut: boolean;
  notes: string[];
  answers: string[];
}

export async function runCase(home: Home, model: string, c: EvalCase, samples = 1, extraTools: Tool[] = []): Promise<CaseResult> {
  const scores: number[] = [];
  const notes = new Set<string>();
  const answers: string[] = [];
  for (let i = 0; i < samples; i++) {
    const out = await runCaseOnce(home, model, c, extraTools);
    answers.push(out.answer);
    const results = await Promise.all(c.checks.map((ch) => scoreCheck(home, ch, c, out).catch((e) => ({ score: 0, note: `check error: ${(e as Error).message}` }))));
    scores.push(mean(results.map((r) => r.score)));
    results.forEach((r) => r.note && notes.add(r.note));
    rmSync(out.workspace, { recursive: true, force: true });
  }
  return { id: c.id, score: mean(scores), heldOut: isHeldOut(home, c.id), notes: [...notes], answers };
}

/** Run cases with bounded concurrency. */
export async function runSuite(
  home: Home,
  model: string,
  opts: { caseIds?: string[]; samples?: number; concurrency?: number; record?: boolean; onProgress?: (done: number, total: number, r: CaseResult) => void } = {},
): Promise<EvalRunSummary & { results: CaseResult[] }> {
  const cases = listCases(home).filter((c) => !opts.caseIds || opts.caseIds.includes(c.id));
  const results: CaseResult[] = [];
  const extraTools = (await loadExtensions(home)).extensions.flatMap((e) => e.tools);
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const c = cases[next++];
      const r = await runCase(home, model, c, opts.samples ?? 1, extraTools);
      results.push(r);
      opts.onProgress?.(results.length, cases.length, r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, cases.length) }, worker));
  const visible = results.filter((r) => !r.heldOut);
  const held = results.filter((r) => r.heldOut);
  const summary = {
    id: id("ev_"),
    model,
    startedAt: now(),
    score: mean(visible.map((r) => r.score)),
    heldOutScore: mean(held.map((r) => r.score)),
    cases: results.map(({ answers: _a, ...r }) => r),
    results,
  };
  if (opts.record !== false) writeJson(home.path("evals/results", `${summary.startedAt.replace(/[:.]/g, "-")}_${summary.id}.json`), { ...summary, results: undefined });
  return summary;
}

export function evalHistory(home: Home): EvalRunSummary[] {
  const dir = home.path("evals/results");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readJson<EvalRunSummary | null>(join(dir, f), null))
    .filter((r): r is EvalRunSummary => !!r);
}

/**
 * Turn a rated run into an eval case. A thumbs-down needs to know what a good answer must do:
 * the user's note if given, otherwise the judge model drafts the rubric. A thumbs-up becomes a
 * regression case with the answer as the reference.
 */
export async function caseFromRun(home: Home, runId: string, rating: "up" | "down", expectation?: string): Promise<EvalCase> {
  const run = listRuns(home).find((r) => r.runId === runId);
  if (!run) throw new Error(`No run ${runId}`);
  const meta = readTrace(home, runId).find((e) => e.type === "meta") as any;
  const input: string = meta?.input ?? run.input;
  let rubric = expectation;
  if (!rubric && rating === "down") {
    const res = await complete(home, {
      model: home.config().defaults.judgeModel,
      category: "evolve",
      temperature: 0,
      messages: [
        { role: "system", content: "A user rated this assistant answer as bad. Write a short rubric (2-4 criteria, one line each) that a good answer to the request must satisfy. Be specific to the request, not to this answer. Reply with the rubric only." },
        { role: "user", content: `Request:\n${input}\n\nBad answer:\n${run.output}` },
      ],
    });
    rubric = res.content.trim();
  }
  const c: EvalCase = {
    id: `mined-${runId.slice(4)}`,
    input,
    projectId: run.projectId,
    checks: rating === "down" ? [{ type: "judge", rubric: rubric! }] : [{ type: "judge", rubric: expectation ?? "As good as the reference answer: same key content and correctness, follows the request's instructions.", reference: run.output }],
    tags: ["mined", rating],
    source: { runId, chatId: run.chatId, rating },
    createdAt: now(),
  };
  writeJson(home.path("evals/cases", `${c.id}.json`), c);
  return c;
}

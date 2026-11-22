// The improvement loop: find failing cases, ask the reflector for one change, measure it in a
// shadow copy of the home, and keep it only if it wins. Then it waits for the user.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corePromptPath } from "../context.ts";
import { listCases, runSuite, type CaseResult } from "../evals/index.ts";
import { testExtension } from "../extensions.ts";
import type { Home } from "../home.ts";
import { complete } from "../providers/llm.ts";
import { getProfile, profilePath } from "../providers/models.ts";
import { listSkills } from "../skills.ts";
import type { GateResult, Proposal, ProposalKind } from "../types.ts";
import { extractJson, mean, stdErr } from "../util.ts";
import { acceptProposal, applyChanges, createProposal, kindForPath, listProposals, save } from "./proposals.ts";

export type Log = (msg: string) => void;

const PASS = 0.8;

/** Score a proposal: run the suite on the current home (baseline) and on a shadow copy with the change applied. */
export async function gate(home: Home, proposal: Proposal, model: string, opts: { baseline?: CaseResult[]; samples?: number; log?: Log } = {}): Promise<GateResult> {
  const log = opts.log ?? (() => {});
  const samples = opts.samples ?? home.config().evolve.samplesPerCase;
  const notes: string[] = [];
  const shadowDir = mkdtempSync(join(tmpdir(), "syph-shadow-"));
  try {
    const shadow = home.cloneTo(shadowDir);
    applyChanges(shadow, proposal.changes, "forward");

    for (const c of proposal.changes.filter((c) => c.path.startsWith("extensions/") && c.after)) {
      const err = await testExtension(shadow, c.path.replace(/^extensions\/|\.ts$/g, ""), c.after!);
      if (err) {
        notes.push(`Extension failed to load or test: ${err}`);
        return { model, baseline: 0, candidate: 0, delta: 0, stdErr: 0, targetedBaseline: 0, targetedCandidate: 0, regressions: [], heldOutBaseline: 0, heldOutCandidate: 0, passed: false, notes };
      }
    }

    let baseline = opts.baseline;
    if (!baseline) {
      log("Running baseline evals…");
      baseline = (await runSuite(home, model, { samples, record: false })).results;
    }
    log("Running evals with the change applied…");
    const candidate = (await runSuite(shadow, model, { samples, record: false, onProgress: (d, t) => d % 5 === 0 && log(`  ${d}/${t} cases`) })).results;

    const byId = new Map(baseline.map((r) => [r.id, r]));
    const pairs = candidate.filter((r) => byId.has(r.id)).map((r) => ({ id: r.id, b: byId.get(r.id)!.score, c: r.score, held: r.heldOut }));
    const visible = pairs.filter((p) => !p.held);
    const held = pairs.filter((p) => p.held);
    const targeted = pairs.filter((p) => proposal.targetCases?.includes(p.id));
    const deltas = visible.map((p) => p.c - p.b);
    const regressions = visible.filter((p) => p.b >= PASS && p.c < 0.5).map((p) => p.id);
    const result: GateResult = {
      model,
      baseline: mean(visible.map((p) => p.b)),
      candidate: mean(visible.map((p) => p.c)),
      delta: mean(deltas),
      stdErr: stdErr(deltas),
      targetedBaseline: mean(targeted.map((p) => p.b)),
      targetedCandidate: mean(targeted.map((p) => p.c)),
      regressions,
      heldOutBaseline: mean(held.map((p) => p.b)),
      heldOutCandidate: mean(held.map((p) => p.c)),
      passed: false,
      notes,
    };
    const targetedOk = !targeted.length || result.targetedCandidate > result.targetedBaseline;
    const overallOk = result.delta > 0;
    const heldOk = !held.length || result.heldOutCandidate >= result.heldOutBaseline - Math.max(0.05, stdErr(held.map((p) => p.c - p.b)));
    if (!targetedOk) notes.push("Targeted cases did not improve.");
    if (!overallOk) notes.push(`Overall score did not rise (${(result.delta * 100).toFixed(1)} pts).`);
    if (regressions.length) notes.push(`Regressed: ${regressions.join(", ")}.`);
    if (!heldOk) notes.push("Held-out cases got worse, which suggests overfitting.");
    result.passed = targetedOk && overallOk && !regressions.length && heldOk;
    return result;
  } finally {
    rmSync(shadowDir, { recursive: true, force: true });
  }
}

/** Everything the reflector may edit, as it stands now. */
function editableSnapshot(home: Home, model: string) {
  const profile = getProfile(home, model);
  const files: { path: string; content: string }[] = [];
  const prompt = corePromptPath(home, profile);
  files.push({ path: prompt, content: home.read(prompt) ?? "" });
  for (const s of listSkills(home)) files.push({ path: s.path, content: home.read(s.path) ?? "" });
  for (const m of home.list("memory")) files.push({ path: m, content: home.read(m) ?? "" });
  files.push({ path: profilePath(model), content: JSON.stringify(profile, null, 2) });
  return files;
}

export interface EvolveResult {
  status: "no_failures" | "proposed" | "no_improvement" | "error";
  proposal?: Proposal;
  baselineScore?: number;
  attempts: number;
  message: string;
}

/**
 * One improvement cycle for `model`. Returns a gated proposal awaiting the user, or explains why
 * none was produced. Failed attempts are kept (status "failed") so the reflector learns from them.
 */
export async function evolveOnce(home: Home, model: string, log: Log = () => {}): Promise<EvolveResult> {
  const cfg = home.config();
  const samples = cfg.evolve.samplesPerCase;
  log(`Baseline: running ${listCases(home).length} eval cases on ${model} (${samples} samples each)…`);
  const base = await runSuite(home, model, { samples, onProgress: (d, t) => d % 5 === 0 && log(`  ${d}/${t} cases`) });
  log(`Baseline score ${(base.score * 100).toFixed(1)}% (held-out ${(base.heldOutScore * 100).toFixed(1)}%).`);
  const failing = base.results.filter((r) => !r.heldOut && r.score < PASS).sort((a, b) => a.score - b.score);
  if (!failing.length) return { status: "no_failures", attempts: 0, baselineScore: base.score, message: "Every visible case passes. Add harder cases (rate answers or write cases) to keep improving." };

  const cases = new Map(listCases(home).map((c) => [c.id, c]));
  const failures = failing.slice(0, 6).map((r) => ({ id: r.id, input: cases.get(r.id)?.input, checks: cases.get(r.id)?.checks.map((c) => (c.type === "judge" ? { type: "judge", rubric: c.rubric } : c)), score: r.score, problems: r.notes, answer: r.answers[0]?.slice(0, 1500) }));
  const past = listProposals(home).filter((p) => p.source === "reflector" && p.status !== "pending").slice(0, 10).map((p) => `- [${p.status}] ${p.title}${p.gate ? ` (delta ${(p.gate.delta * 100).toFixed(1)} pts${p.gate.notes.length ? "; " + p.gate.notes.join(" ") : ""})` : ""}${p.decisionNote ? ` — user: ${p.decisionNote}` : ""}`);

  const attemptsNotes: string[] = [];
  for (let attempt = 1; attempt <= cfg.evolve.maxAttempts; attempt++) {
    log(`Reflector attempt ${attempt}/${cfg.evolve.maxAttempts}…`);
    const res = await complete(home, {
      model: cfg.defaults.reflectorModel,
      category: "evolve",
      temperature: 0.4,
      jsonMode: true,
      messages: [
        { role: "system", content: home.read("prompts/reflector.md") ?? "" },
        {
          role: "user",
          content: [
            `Target model being improved: ${model}`,
            `# Editable files\n${editableSnapshot(home, model).map((f) => `<file path="${f.path}">\n${f.content}\n</file>`).join("\n")}`,
            `# Failing eval cases\n${JSON.stringify(failures, null, 2)}`,
            past.length ? `# Earlier proposals (do not repeat failed ideas)\n${past.join("\n")}` : "",
            attemptsNotes.length ? `# Your earlier attempts this cycle failed the gate\n${attemptsNotes.join("\n")}` : "",
          ].filter(Boolean).join("\n\n"),
        },
      ],
    });
    const plan = extractJson<{ diagnosis?: string; kind?: ProposalKind; title?: string; reason?: string; files?: { path: string; content: string }[] }>(res.content);
    if (!plan?.files?.length) {
      attemptsNotes.push(`Attempt ${attempt}: reply was not valid JSON with files.`);
      continue;
    }
    // Interface changes are made in chat when the user asks, never by the eval-driven reflector.
    if (plan.files.some((f) => f.path.replace(/^\/+/, "").startsWith("ui/"))) {
      attemptsNotes.push(`Attempt ${attempt}: ui/ files are not editable here.`);
      continue;
    }
    let proposal: Proposal;
    try {
      proposal = createProposal(home, {
        kind: plan.kind ?? kindForPath(plan.files[0].path),
        title: plan.title ?? "Reflector improvement",
        reason: [plan.diagnosis, plan.reason].filter(Boolean).join(" "),
        files: plan.files,
        source: "reflector",
        targetCases: failing.map((f) => f.id),
      });
    } catch (e) {
      attemptsNotes.push(`Attempt ${attempt}: ${(e as Error).message}`);
      continue;
    }
    log(`Gating "${proposal.title}"…`);
    proposal.gate = await gate(home, proposal, model, { baseline: base.results, samples, log });
    log(`  ${proposal.gate.passed ? "Passed" : "Failed"}: ${(proposal.gate.baseline * 100).toFixed(1)}% → ${(proposal.gate.candidate * 100).toFixed(1)}%. ${proposal.gate.notes.join(" ")}`);
    if (!proposal.gate.passed) {
      proposal.status = "failed";
      save(home, proposal);
      attemptsNotes.push(`Attempt ${attempt} "${proposal.title}": ${proposal.gate.notes.join(" ")}`);
      continue;
    }
    save(home, proposal);
    const auto = cfg.approval.autoAccept;
    if ((proposal.kind === "memory" && auto.memory) || (proposal.kind === "skill" && auto.skill)) {
      acceptProposal(home, proposal.id, "Auto-accepted: evals improved with no regressions.");
      return { status: "proposed", proposal: { ...proposal, status: "accepted" }, attempts: attempt, baselineScore: base.score, message: "Change passed the gate and was auto-accepted." };
    }
    return { status: "proposed", proposal, attempts: attempt, baselineScore: base.score, message: "A change passed the gate and is waiting for your approval in Evolve." };
  }
  return { status: "no_improvement", attempts: cfg.evolve.maxAttempts, baselineScore: base.score, message: `No proposal beat the current version after ${cfg.evolve.maxAttempts} attempts.` };
}

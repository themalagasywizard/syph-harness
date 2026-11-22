// Export what Syph has learned as fine-tuning data: SFT from good answers, DPO from rated pairs.
import type { Home } from "./home.ts";
import { allExamples } from "./examples.ts";
import { listRuns, ratings } from "./trace.ts";
import { writeText, today } from "./util.ts";

export function exportDatasets(home: Home): { sft: string; dpo: string; sftCount: number; dpoCount: number } {
  const rates = ratings(home);
  const runs = listRuns(home).filter((r) => r.kind === "chat" || r.kind === "task");
  const good = new Map<string, string>();
  for (const e of allExamples(home)) good.set(e.input, e.output);
  for (const r of runs) if (rates.get(r.runId)?.rating === "up") good.set(r.input, r.output);
  const sft = [...good].map(([input, output]) => JSON.stringify({ messages: [{ role: "user", content: input }, { role: "assistant", content: output }] }));

  // DPO pairs: same input with one answer rated up and another rated down.
  const byInput = new Map<string, { up?: string; down?: string }>();
  for (const r of runs) {
    const rate = rates.get(r.runId)?.rating;
    if (!rate) continue;
    const e = byInput.get(r.input) ?? {};
    e[rate] = r.output;
    byInput.set(r.input, e);
  }
  const dpo = [...byInput].filter(([, v]) => v.up && v.down).map(([prompt, v]) => JSON.stringify({ prompt, chosen: v.up, rejected: v.down }));

  const sftPath = `exports/sft-${today()}.jsonl`;
  const dpoPath = `exports/dpo-${today()}.jsonl`;
  writeText(home.path(sftPath), sft.join("\n") + (sft.length ? "\n" : ""));
  writeText(home.path(dpoPath), dpo.join("\n") + (dpo.length ? "\n" : ""));
  return { sft: home.path(sftPath), dpo: home.path(dpoPath), sftCount: sft.length, dpoCount: dpo.length };
}

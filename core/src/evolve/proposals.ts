// Proposals are the only way Syph changes itself. Each one records the full before/after of every
// file it touches, so accepting is a write and rolling back is the reverse write.
import { createTwoFilesPatch } from "diff";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import type { Home } from "../home.ts";
import type { FileChange, Proposal, ProposalKind } from "../types.ts";
import { id, now, readJson, writeJson } from "../util.ts";

export interface ProposalInput {
  kind: ProposalKind;
  title: string;
  reason: string;
  files: { path: string; content: string | null }[];
  source: Proposal["source"];
  targetCases?: string[];
}

export function kindForPath(path: string): ProposalKind {
  if (path.startsWith("memory/")) return "memory";
  if (path.startsWith("skills/")) return "skill";
  if (path.startsWith("profiles/")) return "profile";
  if (path.startsWith("extensions/")) return "extension";
  if (path.startsWith("ui/")) return "ui";
  return "prompt";
}

export function createProposal(home: Home, input: ProposalInput): Proposal {
  if (!input.files.length) throw new Error("A proposal must change at least one file.");
  const changes: FileChange[] = input.files.map((f) => {
    const path = home.rel(f.path);
    if (!home.isEvolvable(path)) throw new Error(`"${path}" is protected or not an editable Syph file.`);
    return { path, before: home.read(path), after: f.content };
  });
  if (changes.every((c) => c.before === c.after)) throw new Error("The proposal does not change anything.");
  const proposal: Proposal = {
    id: id("pr_"),
    kind: input.kind,
    title: input.title,
    reason: input.reason,
    changes,
    diff: diffOf(changes),
    source: input.source,
    targetCases: input.targetCases,
    status: "pending",
    createdAt: now(),
  };
  save(home, proposal);
  return proposal;
}

export function diffOf(changes: FileChange[]) {
  return changes
    .map((c) => createTwoFilesPatch(c.path, c.path, c.before ?? "", c.after ?? "", "", "", { context: 3 }).split("\n").slice(2).join("\n"))
    .join("\n");
}

export const save = (home: Home, p: Proposal) => writeJson(home.path("proposals", `${p.id}.json`), p);

export function getProposal(home: Home, pid: string): Proposal | null {
  return readJson<Proposal | null>(home.path("proposals", `${pid}.json`), null);
}

export function listProposals(home: Home): Proposal[] {
  const dir = home.path("proposals");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<Proposal | null>(home.path("proposals", f), null))
    .filter((p): p is Proposal => !!p)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Write each change's `after` content. Fails without writing if a file changed since the proposal. */
export function applyChanges(home: Home, changes: FileChange[], direction: "forward" | "back" = "forward") {
  for (const c of changes) {
    const expected = direction === "forward" ? c.before : c.after;
    if (home.read(c.path) !== expected) throw new Error(`${c.path} changed since this proposal was made. Re-run it against the current version.`);
  }
  for (const c of changes) {
    const content = direction === "forward" ? c.after : c.before;
    if (content === null) {
      if (home.exists(c.path)) unlinkSync(home.path(c.path));
    } else home.write(c.path, content);
  }
}

export function acceptProposal(home: Home, pid: string, note?: string): Proposal {
  const p = getProposal(home, pid);
  if (!p) throw new Error(`No proposal ${pid}`);
  if (p.status !== "pending") throw new Error(`Proposal is already ${p.status}.`);
  applyChanges(home, p.changes, "forward");
  p.status = "accepted";
  p.decidedAt = now();
  p.decisionNote = note;
  save(home, p);
  writeJson(home.path("history", `${p.decidedAt.replace(/[:.]/g, "-")}_${p.id}.json`), { action: "accept", proposal: p.id, title: p.title, changes: p.changes.map((c) => c.path) });
  return p;
}

export function rejectProposal(home: Home, pid: string, note?: string): Proposal {
  const p = getProposal(home, pid);
  if (!p) throw new Error(`No proposal ${pid}`);
  p.status = "rejected";
  p.decidedAt = now();
  p.decisionNote = note;
  save(home, p);
  return p;
}

export function rollbackProposal(home: Home, pid: string): Proposal {
  const p = getProposal(home, pid);
  if (!p || p.status !== "accepted") throw new Error("Only accepted proposals can be rolled back.");
  applyChanges(home, p.changes, "back");
  p.status = "rolled_back";
  p.decidedAt = now();
  save(home, p);
  writeJson(home.path("history", `${p.decidedAt.replace(/[:.]/g, "-")}_${p.id}_rollback.json`), { action: "rollback", proposal: p.id, title: p.title });
  return p;
}

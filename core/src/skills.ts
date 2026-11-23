// Skills are folders with one SKILL.md. Only name + description enter the prompt; the body
// is loaded on demand with read_skill (progressive disclosure keeps context small).
//
// A skill can be switched off with `active: false` in its frontmatter: it stays on disk (and in
// Evolve's history) but the agent no longer sees it. Every change to a skill, by the user or by
// Syph, is a proposal, so editing, switching off and deleting can all be rolled back.
import { existsSync, readdirSync } from "node:fs";
import type { Home } from "./home.ts";
import type { ProposalInput } from "./evolve/proposals.ts";
import { now, parseFrontmatter, readJson, writeJson } from "./util.ts";

export interface Skill {
  name: string;
  description: string;
  path: string;
  /** Folder name under skills/. */
  dir: string;
  active: boolean;
}

export interface SkillUsage {
  uses: number;
  lastUsed?: string;
}

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Every skill on disk, active or not. */
export function listAllSkills(home: Home): Skill[] {
  const dir = home.path("skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const path = `skills/${d.name}/SKILL.md`;
      const src = home.read(path);
      if (src === null) return [];
      const { meta } = parseFrontmatter(src);
      return [{ name: meta.name || d.name, description: meta.description || "", path, dir: d.name, active: !isOff(meta.active) }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const isOff = (v: string | undefined) => !!v && /^(false|no|off|0)$/i.test(v.trim());

/** The skills the agent can see and use. */
export function listSkills(home: Home): Skill[] {
  return listAllSkills(home).filter((s) => s.active);
}

export function findSkill(home: Home, name: string, opts: { includeInactive?: boolean } = {}): Skill | null {
  const all = opts.includeInactive ? listAllSkills(home) : listSkills(home);
  return all.find((x) => x.name === name || x.dir === name) ?? null;
}

export function readSkill(home: Home, name: string): string | null {
  const s = findSkill(home, name);
  if (!s) return null;
  const { body } = parseFrontmatter(home.read(s.path) ?? "");
  const extra = skillFiles(home, s.dir).filter((p) => !p.endsWith("/SKILL.md"));
  return body.trim() + (extra.length ? `\n\nFiles in this skill: ${extra.join(", ")}` : "");
}

/** Everything in a skill's folder (home-relative paths). */
export const skillFiles = (home: Home, dir: string) => home.list(`skills/${dir}`);

export interface SkillDoc {
  meta: Record<string, string>;
  body: string;
}

export function parseSkill(src: string): SkillDoc {
  const { meta, body } = parseFrontmatter(src);
  return { meta, body: body.replace(/^\s*\n/, "") };
}

/** Write frontmatter + body. name and description come first; other keys keep their order. */
export function serializeSkill(doc: SkillDoc): string {
  const keys = ["name", "description", ...Object.keys(doc.meta).filter((k) => k !== "name" && k !== "description")];
  const lines = keys.filter((k) => doc.meta[k] !== undefined && doc.meta[k] !== "").map((k) => `${k}: ${String(doc.meta[k]).replace(/\r?\n/g, " ").trim()}`);
  return `---\n${lines.join("\n")}\n---\n${doc.body.trim()}\n`;
}

export const skillFile = (name: string, description: string, body: string) => serializeSkill({ meta: { name, description }, body });

// ----- Usage -----

const USAGE = "traces/skill-usage.json";

export function skillUsage(home: Home): Record<string, SkillUsage> {
  return readJson<Record<string, SkillUsage>>(home.path(USAGE), {});
}

export function recordSkillUse(home: Home, name: string) {
  try {
    const all = skillUsage(home);
    const u = (all[name] ??= { uses: 0 });
    u.uses++;
    u.lastUsed = now();
    writeJson(home.path(USAGE), all);
  } catch {
    /* usage is a hint, never a reason to fail a run */
  }
}

// ----- Changes (each one is a proposal input) -----

export type SkillAction =
  | { action: "edit"; name: string; description?: string; body?: string; active?: boolean }
  | { action: "activate" | "deactivate" | "delete"; name: string };

/** Turn one action on one skill into the file changes a proposal needs. Throws if it changes nothing. */
export function skillChangeFiles(home: Home, a: SkillAction): { path: string; content: string | null }[] {
  const s = findSkill(home, a.name, { includeInactive: true });
  if (!s) throw new Error(`No skill named "${a.name}".`);
  if (a.action === "delete") return skillFiles(home, s.dir).map((path) => ({ path, content: null }));
  const doc = parseSkill(home.read(s.path) ?? "");
  doc.meta.name ||= s.name;
  if (a.action === "edit") {
    if (a.description !== undefined) doc.meta.description = a.description.trim();
    if (a.body !== undefined) doc.body = a.body;
    if (a.active === false) doc.meta.active = "false";
    if (a.active === true) delete doc.meta.active;
  } else if (a.action === "deactivate") {
    if (!s.active) throw new Error(`"${s.name}" is already off.`);
    doc.meta.active = "false";
  } else {
    if (s.active) throw new Error(`"${s.name}" is already on.`);
    delete doc.meta.active;
  }
  return [{ path: s.path, content: serializeSkill(doc) }];
}

const VERB = { edit: "Edit", activate: "Turn on", deactivate: "Turn off", delete: "Delete" } as const;

/** One proposal for one or many skill actions (e.g. "delete these three duplicates"). */
export function skillProposal(home: Home, actions: SkillAction[], reason: string, source: ProposalInput["source"]): ProposalInput {
  if (!actions.length) throw new Error("No skill changes given.");
  const files = actions.flatMap((a) => skillChangeFiles(home, a));
  const names = [...new Set(actions.map((a) => a.name))];
  const verbs = [...new Set(actions.map((a) => a.action))];
  const title = verbs.length === 1 ? `${VERB[verbs[0]]} skill${names.length > 1 ? "s" : ""} ${names.join(", ")}` : `Clean up skills ${names.join(", ")}`;
  return { kind: "skill", title: title.slice(0, 120), reason, files, source };
}

// ----- Finding duplicates and dead weight -----

const STOP = new Set("a an and are as at be before by can do does for from has have if in into is it its of on or so that the then this to use used uses using when with you your it's not no only one all any each step steps skill".split(" "));

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, "")));

function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
}

/** 0..1: how much two skills are about the same thing. The description says when to use it, so it weighs most. */
export function skillSimilarity(a: { name: string; description: string; body: string }, b: { name: string; description: string; body: string }) {
  const name = jaccard(words(a.name), words(b.name));
  const desc = jaccard(words(a.description), words(b.description));
  const body = jaccard(words(a.body), words(b.body));
  return Math.min(1, 0.25 * name + 0.45 * desc + 0.3 * body + (name >= 0.5 && desc >= 0.3 ? 0.1 : 0));
}

export interface SkillInfo extends Skill {
  body: string;
  files: string[];
  usage: SkillUsage;
  /** When the skill was last changed through Evolve (or when it came with Syph). */
  changedAt?: string;
  /** Pending proposals that would change this skill. */
  pending: { id: string; title: string }[];
  /** Accepted versions so far. */
  versions: number;
  createdBy?: "agent" | "reflector" | "user" | "default";
}

/** Everything the Skills page and the audit tool need, in one pass. */
export function skillInfos(home: Home, proposals: { id: string; title: string; status: string; source: string; createdAt: string; decidedAt?: string; changes: { path: string; before: string | null }[] }[]): SkillInfo[] {
  const usage = skillUsage(home);
  return listAllSkills(home).map((s) => {
    const touching = proposals.filter((p) => p.changes.some((c) => c.path.startsWith(`skills/${s.dir}/`)));
    const accepted = touching.filter((p) => p.status === "accepted");
    const creator = [...accepted].reverse().find((p) => p.changes.some((c) => c.path === s.path && c.before === null));
    return {
      ...s,
      body: parseSkill(home.read(s.path) ?? "").body,
      files: skillFiles(home, s.dir),
      usage: usage[s.name] ?? usage[s.dir] ?? { uses: 0 },
      changedAt: accepted[0]?.decidedAt ?? accepted[0]?.createdAt,
      pending: touching.filter((p) => p.status === "pending").map((p) => ({ id: p.id, title: p.title })),
      versions: accepted.length + (creator ? 0 : 1),
      // No accepted proposal created it, so it came with Syph (or was put there by hand).
      createdBy: creator ? (creator.source as SkillInfo["createdBy"]) : "default",
    };
  });
}

export interface SkillAudit {
  duplicates: { skills: string[]; similarity: number }[];
  unused: { name: string; ageDays: number }[];
  inactive: string[];
  empty: string[];
}

export const DUPLICATE_AT = 0.45;

/** A first pass for the agent or the user: likely duplicates, skills never used, skills that say nothing. */
export function auditSkills(home: Home, infos: SkillInfo[], opts: { unusedAfterDays?: number } = {}): SkillAudit {
  const active = infos.filter((s) => s.active);
  const duplicates: SkillAudit["duplicates"] = [];
  for (let i = 0; i < active.length; i++)
    for (let j = i + 1; j < active.length; j++) {
      const sim = skillSimilarity(active[i], active[j]);
      if (sim >= DUPLICATE_AT) duplicates.push({ skills: [active[i].name, active[j].name], similarity: Math.round(sim * 100) / 100 });
    }
  duplicates.sort((a, b) => b.similarity - a.similarity);
  const after = opts.unusedAfterDays ?? 14;
  const day = 86_400_000;
  const unused = active
    .filter((s) => !s.usage.uses && s.createdBy !== "default")
    .map((s) => ({ name: s.name, ageDays: s.changedAt ? Math.floor((Date.now() - Date.parse(s.changedAt)) / day) : after }))
    .filter((s) => s.ageDays >= after);
  return {
    duplicates,
    unused,
    inactive: infos.filter((s) => !s.active).map((s) => s.name),
    empty: active.filter((s) => s.body.trim().length < 40 || !s.description.trim()).map((s) => s.name),
  };
}

/**
 * When the reflector writes a brand-new skill that covers the same job as an existing one, it should
 * have rewritten that one. Redirect the file onto the existing skill so rewrites replace instead of
 * stacking up. Returns the files to use and a note for each redirect.
 */
export function redirectDuplicateSkills(home: Home, files: { path: string; content: string | null }[]): { files: typeof files; notes: string[] } {
  const notes: string[] = [];
  const touched = new Set(files.map((f) => f.path.split("/")[1]));
  const out = files.map((f) => {
    const m = f.path.match(/^skills\/([\w-]+)\/SKILL\.md$/);
    if (!m || f.content === null || home.exists(f.path)) return f;
    const doc = parseSkill(f.content);
    const cand = { name: doc.meta.name || m[1], description: doc.meta.description || "", body: doc.body };
    let best: { s: SkillInfo | Skill; sim: number } | null = null;
    for (const s of listAllSkills(home)) {
      if (touched.has(s.dir) && s.dir !== m[1]) continue; // the proposal already deals with that one
      const sim = skillSimilarity(cand, { name: s.name, description: s.description, body: parseSkill(home.read(s.path) ?? "").body });
      if (sim >= DUPLICATE_AT && (!best || sim > best.sim)) best = { s, sim };
    }
    if (!best) return f;
    doc.meta.name = best.s.name;
    if (!best.s.active) doc.meta.active = "false";
    else delete doc.meta.active;
    notes.push(`Rewrote the existing skill "${best.s.name}" instead of adding "${cand.name}" next to it (${Math.round(best.sim * 100)}% alike).`);
    return { path: best.s.path, content: serializeSkill(doc) };
  });
  // Two files may now land on the same path; keep the last.
  const byPath = new Map(out.map((f) => [f.path, f]));
  return { files: [...byPath.values()], notes };
}

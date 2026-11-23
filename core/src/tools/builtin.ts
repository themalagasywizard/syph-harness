import { exec, execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { auditSkills, findSkill, listSkills, readSkill, recordSkillUse, SKILL_NAME, skillFile, skillFiles, skillInfos, skillProposal, type SkillAction } from "../skills.ts";
import { listProposals } from "../evolve/proposals.ts";
import { headTail, truncate } from "../util.ts";
import { scopeViolation } from "../scope.ts";
import { defineTool, type Tool, type ToolContext } from "./types.ts";

/** Refuse a write the task's contract puts out of bounds. Permissions, not prose. */
function checkScope(ctx: ToolContext, abs: string) {
  const v = scopeViolation(ctx.hooks.contract?.get(), relative(ctx.workspace, abs));
  if (v) throw new Error(v.replace(/^Error: /, ""));
}

/** Resolve a user path inside the workspace; refuse anything that escapes it. */
function inWorkspace(ctx: ToolContext, p: string) {
  const abs = resolve(ctx.workspace, p || ".");
  const rel = relative(ctx.workspace, abs);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error(`Path is outside the workspace: ${p}`);
  return abs;
}

const SKIP = new Set(["node_modules", ".git", "dist", ".venv", "__pycache__"]);

function walk(dir: string, base: string, out: string[], depth: number, max: number) {
  if (depth < 0 || out.length >= max) return;
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const rel = relative(base, full).split(sep).join("/");
    if (statSync(full).isDirectory()) {
      out.push(rel + "/");
      walk(full, base, out, depth - 1, max);
    } else out.push(rel);
    if (out.length >= max) return;
  }
}

export const listFiles = defineTool({
  name: "list_files",
  description: "List files and folders in the workspace (recursive up to a depth). Use before reading paths you have not seen.",
  schema: z.object({ path: z.string().default("."), depth: z.number().int().min(0).max(6).default(3) }),
  permission: "auto",
  run: ({ path, depth }, ctx) => {
    const abs = inWorkspace(ctx, path);
    if (!existsSync(abs)) return `No such folder: ${path}`;
    const out: string[] = [];
    walk(abs, abs, out, depth, 400);
    return out.length ? out.join("\n") : "(empty)";
  },
});

/** Lines read_file returns when no range is given: enough for most files, small enough to keep context lean. */
export const READ_DEFAULT_LINES = 400;

export const readFile = defineTool({
  name: "read_file",
  description: `Read a text file from the workspace. Without a range it returns the first ${READ_DEFAULT_LINES} lines and says how many there are; pass startLine/endLine (1-based, inclusive) for other parts.`,
  schema: z.object({ path: z.string(), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }),
  permission: "auto",
  run: ({ path, startLine, endLine }, ctx) => {
    const abs = inWorkspace(ctx, path);
    if (!existsSync(abs)) return `Error: file not found: ${path}. List its folder with list_files to see what is there.`;
    if (statSync(abs).isDirectory()) return `Error: ${path} is a folder, not a file. Use list_files on it.`;
    const text = readFileSync(abs, "utf8");
    const lines = text.split("\n");
    const from = startLine ?? 1;
    const to = Math.min(lines.length, endLine ?? (startLine ? lines.length : READ_DEFAULT_LINES));
    if (from > lines.length) return `Error: ${path} has only ${lines.length} lines; startLine ${from} is past the end.`;
    const part = lines.slice(from - 1, to).join("\n");
    // A file that itself starts with "Error" gets a header, so it isn't mistaken for a failed call.
    const whole = from === 1 && to === lines.length && !/^Error\b/.test(part);
    return truncate(whole ? part : `[${path}: lines ${from}-${to} of ${lines.length}${to < lines.length ? `; read more with startLine=${to + 1}` : ""}]\n${part}`, 40_000);
  },
});

export const writeFile = defineTool({
  name: "write_file",
  description: "Create or overwrite a file in the workspace with the given content.",
  schema: z.object({ path: z.string(), content: z.string() }),
  permission: "auto",
  run: ({ path, content }, ctx) => {
    const abs = inWorkspace(ctx, path);
    checkScope(ctx, abs);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return `Wrote ${content.length} characters to ${path}`;
  },
});

export const editFile = defineTool({
  name: "edit_file",
  description: "Replace an exact snippet in a workspace file. old_text must match exactly once; include surrounding lines to make it unique.",
  schema: z.object({ path: z.string(), old_text: z.string().min(1), new_text: z.string() }),
  permission: "auto",
  run: ({ path, old_text, new_text }, ctx) => {
    const abs = inWorkspace(ctx, path);
    if (!existsSync(abs)) return `Error: file not found: ${path}`;
    checkScope(ctx, abs);
    const src = readFileSync(abs, "utf8");
    const count = src.split(old_text).length - 1;
    if (count === 0) return "Error: old_text not found. Read the file and copy the snippet exactly.";
    if (count > 1) return `Error: old_text matches ${count} times. Include more surrounding text.`;
    writeFileSync(abs, src.replace(old_text, () => new_text));
    return `Edited ${path}`;
  },
});

export const searchFiles = defineTool({
  name: "search_files",
  description: "Search workspace files for a text or regex pattern. Returns matching lines with paths and line numbers.",
  schema: z.object({ pattern: z.string(), path: z.string().default("."), regex: z.boolean().default(false) }),
  permission: "auto",
  run: ({ pattern, path, regex }, ctx) => {
    const base = inWorkspace(ctx, path);
    const files: string[] = [];
    walk(base, base, files, 8, 3000);
    const re = regex ? new RegExp(pattern, "i") : null;
    const hits: string[] = [];
    for (const f of files) {
      if (f.endsWith("/")) continue;
      let text: string;
      try {
        text = readFileSync(join(base, f), "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue;
      text.split("\n").forEach((line, i) => {
        if (hits.length < 200 && (re ? re.test(line) : line.toLowerCase().includes(pattern.toLowerCase()))) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 200)}`);
      });
    }
    if (!hits.length) return `No matches for "${pattern}" in ${files.filter((f) => !f.endsWith("/")).length} files under ${path}.`;
    return hits.length >= 200 ? `${hits.join("\n")}\n[stopped at 200 matches: narrow the pattern or the path]` : hits.join("\n");
  },
});

const WIN = process.platform === "win32";

/** PowerShell on Windows, the default POSIX shell elsewhere. */
export function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal) {
  return new Promise<string>((res) => {
    const done = (err: any, stdout: string, stderr: string) => {
      const code = err ? (typeof err.code === "number" ? err.code : err.killed ? "timeout" : 1) : 0;
      res(`exit code: ${code}\n--- stdout ---\n${headTail(stdout, 10_000)}\n--- stderr ---\n${headTail(stderr, 4_000)}`);
    };
    const opts = { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal };
    if (WIN) execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], opts, done);
    else exec(command, opts, done);
  });
}

export const shell = defineTool({
  name: "shell",
  description: `Run a ${WIN ? "PowerShell" : "shell (sh)"} command in the workspace folder and return stdout, stderr and the exit code. Asks the user first unless YOLO mode is on.`,
  schema: z.object({ command: z.string(), timeoutSec: z.number().int().min(1).max(600).default(60) }),
  permission: "ask",
  run: ({ command, timeoutSec }, ctx) => runShell(command, ctx.workspace, timeoutSec * 1000, ctx.signal),
});

export const WEB_PAGE_CHARS = 12_000;

export const webFetch = defineTool({
  name: "web_fetch",
  description: `Fetch a web page or API URL and return its text (HTML is reduced to readable text), ${WEB_PAGE_CHARS} characters at a time. Pass offset to read further.`,
  schema: z.object({ url: z.string().url(), offset: z.number().int().min(0).default(0) }),
  permission: "auto",
  run: async ({ url, offset }, ctx) => {
    const res = await fetch(url, { signal: ctx.signal ?? AbortSignal.timeout(20_000), headers: { "user-agent": "Syph/0.1" } });
    const type = res.headers.get("content-type") ?? "";
    let text = await res.text();
    if (type.includes("html")) text = htmlToText(text);
    const part = text.slice(offset, offset + WEB_PAGE_CHARS);
    const more = offset + WEB_PAGE_CHARS < text.length ? `\n[characters ${offset}-${offset + part.length} of ${text.length}; read more with offset=${offset + WEB_PAGE_CHARS}]` : "";
    if (!res.ok) return `Error: HTTP ${res.status} from ${url}\n${part.slice(0, 2000)}`;
    return `HTTP ${res.status}\n${part || "(the page has no text)"}${more}`;
  },
});

export function htmlToText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export const readSkillTool = defineTool({
  name: "read_skill",
  description: "Load the full instructions of a skill listed in the system prompt.",
  schema: z.object({ name: z.string() }),
  permission: "auto",
  run: ({ name }, ctx) => {
    const text = readSkill(ctx.home, name);
    if (text === null) {
      const off = findSkill(ctx.home, name, { includeInactive: true });
      return off ? `The skill "${off.name}" is switched off. Work without it, or propose turning it back on with propose_skill_changes.` : `No skill named "${name}". Available: ${listSkills(ctx.home).map((s) => s.name).join(", ")}`;
    }
    recordSkillUse(ctx.home, findSkill(ctx.home, name)?.name ?? name);
    return text;
  },
});

export const proposeSkill = defineTool({
  name: "propose_skill",
  description: "Propose a new reusable skill, or a rewrite of an existing one (pass its exact name to rewrite it in place; never add a second skill for the same job). Use `replaces` to merge: the named skills are deleted in the same change. The user approves it in Evolve before it is used.",
  schema: z.object({
    name: z.string().regex(SKILL_NAME, "kebab-case"),
    description: z.string().describe("One line: when to use this skill."),
    body: z.string().describe("Numbered steps a capable model can follow."),
    reason: z.string().describe("Why this skill is worth having."),
    replaces: z.array(z.string()).optional().describe("Existing skills this one makes redundant (merged into it). They are deleted when the user accepts."),
  }),
  permission: "auto",
  run: ({ name, description, body, reason, replaces }, ctx) => {
    const existing = findSkill(ctx.home, name, { includeInactive: true });
    const path = existing?.path ?? `skills/${name}/SKILL.md`;
    const gone = [...new Set((replaces ?? []).filter((r) => r !== name && r !== existing?.dir))];
    const missing = gone.filter((r) => !findSkill(ctx.home, r, { includeInactive: true }));
    if (missing.length) return `No skill named ${missing.map((m) => `"${m}"`).join(", ")}. Call list_skills to see the exact names.`;
    const files = [{ path, content: skillFile(existing?.name ?? name, description, body) }, ...gone.flatMap((r) => skillFiles(ctx.home, findSkill(ctx.home, r, { includeInactive: true })!.dir).map((p) => ({ path: p, content: null })))];
    const title = gone.length ? `Merge ${gone.join(", ")} into skill ${name}` : `${existing ? "Update" : "Add"} skill ${name}`;
    const p = ctx.propose({ kind: "skill", title, reason, files, source: "agent" });
    return `Proposed ${gone.length ? "merging into" : "skill"} "${name}" (${p.id}). It waits for the user's approval in Evolve.`;
  },
});

export const listSkillsTool = defineTool({
  name: "list_skills",
  description: "List every skill (including switched-off ones) with how often each was used, plus a first pass at likely duplicates, unused and empty skills. Use it when asked to tidy, review or prune skills, then read the suspects with read_file (skills/<name>/SKILL.md) before proposing anything.",
  schema: z.object({}),
  permission: "auto",
  run: (_args, ctx) => {
    const infos = skillInfos(ctx.home, listProposals(ctx.home));
    if (!infos.length) return "There are no skills yet.";
    const audit = auditSkills(ctx.home, infos);
    const rows = infos.map((s) => `- ${s.name}${s.active ? "" : " [off]"}: ${s.description || "(no description)"} — used ${s.usage.uses}×${s.usage.lastUsed ? `, last ${s.usage.lastUsed.slice(0, 10)}` : ""}; ${s.versions} version${s.versions === 1 ? "" : "s"}${s.pending.length ? `; change waiting in Evolve (${s.pending.map((p) => p.id).join(", ")})` : ""}; ${s.path}`);
    const flags = [
      audit.duplicates.length ? `Likely duplicates (word overlap, check them yourself):\n${audit.duplicates.map((d) => `- ${d.skills.join(" + ")} (${Math.round(d.similarity * 100)}% alike)`).join("\n")}` : "No obvious duplicates by word overlap. Still read skills that cover nearby jobs: two skills can contradict each other with different words.",
      audit.unused.length ? `Never used:\n${audit.unused.map((u) => `- ${u.name} (${u.ageDays} days old)`).join("\n")}` : "",
      audit.empty.length ? `Too thin to help:\n${audit.empty.map((n) => `- ${n}`).join("\n")}` : "",
    ].filter(Boolean);
    return `${infos.length} skills (${infos.filter((s) => s.active).length} on).\n${rows.join("\n")}\n\n${flags.join("\n\n")}\n\nTo clean up: propose_skill with \`replaces\` to merge duplicates into one, or propose_skill_changes to edit, switch off or delete. Everything waits for the user in Evolve.`;
  },
});

const skillActionSchema = z.object({
  action: z.enum(["edit", "deactivate", "activate", "delete"]),
  name: z.string().describe("Exact skill name from list_skills."),
  description: z.string().optional().describe("edit only: the new one-line description."),
  body: z.string().optional().describe("edit only: the full new instructions (replaces the old body)."),
});

export const proposeSkillChanges = defineTool({
  name: "propose_skill_changes",
  description: "Propose editing, switching off (deactivate), switching back on (activate) or deleting one or more skills, as ONE change the user approves in Evolve. Prefer deactivate when unsure whether a skill still helps; delete duplicates and skills that contradict a better one.",
  schema: z.object({
    changes: z.array(skillActionSchema).min(1),
    reason: z.string().describe("Why: e.g. which skills duplicate or contradict each other, or why one is not useful."),
  }),
  permission: "auto",
  run: ({ changes, reason }, ctx) => {
    let input;
    try {
      input = skillProposal(ctx.home, changes as SkillAction[], reason, "agent");
    } catch (e) {
      return `${(e as Error).message} Call list_skills to see the exact names and states.`;
    }
    const p = ctx.propose(input);
    return `Proposed "${p.title}" (${p.id}). Nothing changes until the user accepts it in Evolve.`;
  },
});

export const proposeMemory = defineTool({
  name: "propose_memory",
  description: "Propose saving a lasting fact or preference about the user (or the current project). The user approves it before it is saved.",
  schema: z.object({ fact: z.string().describe("One short line, e.g. 'Prefers metric units.'"), scope: z.enum(["user", "project"]).default("user") }),
  permission: "auto",
  run: ({ fact, scope }, ctx) => {
    const path = scope === "project" && ctx.projectId ? `memory/project-${ctx.projectId}.md` : "memory/user.md";
    const before = ctx.home.read(path) ?? (scope === "project" ? "# Project memory\n\n" : "# About the user\n\n");
    const line = `- ${fact.trim().replace(/^-\s*/, "")}`;
    if (before.includes(line)) return "Already in memory.";
    const p = ctx.propose({ kind: "memory", title: `Remember: ${fact.slice(0, 60)}`, reason: "Learned in conversation.", files: [{ path, content: before.replace(/\s*$/, "\n") + line + "\n" }], source: "agent" });
    return `Proposed memory update (${p.id}). The user will approve it in Evolve; meanwhile, apply the preference in this conversation.`;
  },
});

export const createTaskTool = defineTool({
  name: "create_task",
  description: "Schedule a prompt to run automatically on a cron schedule (5 fields: minute hour day month weekday).",
  schema: z.object({ name: z.string(), prompt: z.string(), schedule: z.string() }),
  permission: "ask",
  run: (args, ctx) => {
    if (!ctx.hooks.createTask) return "Tasks are not available here.";
    const t = ctx.hooks.createTask({ ...args, projectId: ctx.projectId });
    return `Created task ${t.id} "${args.name}" (${args.schedule}).`;
  },
});

export const subagent = defineTool({
  name: "run_subagent",
  description: "Delegate a self-contained subtask to a fresh agent with the same tools. Returns its final answer. Use for independent research or work that would clutter this conversation.",
  schema: z.object({ prompt: z.string() }),
  permission: "auto",
  run: async ({ prompt }, ctx) => (ctx.hooks.runSubagent ? ctx.hooks.runSubagent(prompt) : "Sub-agents are not available here."),
});

export const builtinTools: Tool[] = [listFiles, readFile, writeFile, editFile, searchFiles, shell, webFetch, readSkillTool, listSkillsTool, proposeSkill, proposeSkillChanges, proposeMemory, createTaskTool, subagent] as Tool[];

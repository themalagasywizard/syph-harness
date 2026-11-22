import { exec, execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { listSkills, readSkill, skillFile } from "../skills.ts";
import { truncate } from "../util.ts";
import { defineTool, type Tool, type ToolContext } from "./types.ts";

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

export const readFile = defineTool({
  name: "read_file",
  description: "Read a text file from the workspace. Optionally a line range (1-based, inclusive).",
  schema: z.object({ path: z.string(), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }),
  permission: "auto",
  run: ({ path, startLine, endLine }, ctx) => {
    const abs = inWorkspace(ctx, path);
    if (!existsSync(abs)) return `Error: file not found: ${path}`;
    let text = readFileSync(abs, "utf8");
    if (startLine || endLine) {
      const lines = text.split("\n");
      text = lines.slice((startLine ?? 1) - 1, endLine ?? lines.length).join("\n");
    }
    return truncate(text, 60_000);
  },
});

export const writeFile = defineTool({
  name: "write_file",
  description: "Create or overwrite a file in the workspace with the given content.",
  schema: z.object({ path: z.string(), content: z.string() }),
  permission: "auto",
  run: ({ path, content }, ctx) => {
    const abs = inWorkspace(ctx, path);
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
    return hits.length ? hits.join("\n") : "No matches.";
  },
});

const WIN = process.platform === "win32";

/** PowerShell on Windows, the default POSIX shell elsewhere. */
export function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal) {
  return new Promise<string>((res) => {
    const done = (err: any, stdout: string, stderr: string) => {
      const code = err ? (typeof err.code === "number" ? err.code : err.killed ? "timeout" : 1) : 0;
      res(truncate(`exit code: ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`, 30_000));
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

export const webFetch = defineTool({
  name: "web_fetch",
  description: "Fetch a web page or API URL and return its text (HTML is reduced to readable text).",
  schema: z.object({ url: z.string().url() }),
  permission: "auto",
  run: async ({ url }, ctx) => {
    const res = await fetch(url, { signal: ctx.signal ?? AbortSignal.timeout(20_000), headers: { "user-agent": "Syph/0.1" } });
    const type = res.headers.get("content-type") ?? "";
    let text = await res.text();
    if (type.includes("html")) text = htmlToText(text);
    return truncate(`HTTP ${res.status}\n${text}`, 40_000);
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
  run: ({ name }, ctx) => readSkill(ctx.home, name) ?? `No skill named "${name}". Available: ${listSkills(ctx.home).map((s) => s.name).join(", ")}`,
});

export const proposeSkill = defineTool({
  name: "propose_skill",
  description: "Propose a new reusable skill (or a rewrite of an existing one). The user approves it in Evolve before it is used.",
  schema: z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case"),
    description: z.string().describe("One line: when to use this skill."),
    body: z.string().describe("Numbered steps a capable model can follow."),
    reason: z.string().describe("Why this skill is worth having."),
  }),
  permission: "auto",
  run: ({ name, description, body, reason }, ctx) => {
    const p = ctx.propose({ kind: "skill", title: `${ctx.home.exists(`skills/${name}/SKILL.md`) ? "Update" : "Add"} skill ${name}`, reason, files: [{ path: `skills/${name}/SKILL.md`, content: skillFile(name, description, body) }], source: "agent" });
    return `Proposed skill "${name}" (${p.id}). It waits for the user's approval in Evolve.`;
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

export const builtinTools: Tool[] = [listFiles, readFile, writeFile, editFile, searchFiles, shell, webFetch, readSkillTool, proposeSkill, proposeMemory, createTaskTool, subagent] as Tool[];

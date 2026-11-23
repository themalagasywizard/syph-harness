// Plain JSON files for chats, projects and tasks. Easy to inspect, back up and diff.
import { existsSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import type { Home } from "./home.ts";
import type { ChatRecord, Project, Task } from "./types.ts";
import { id, now, readJson, writeJson } from "./util.ts";

// ---------- Projects ----------

export function listProjects(home: Home): Project[] {
  const dir = home.path("projects");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((d) => readJson<Project | null>(home.path("projects", d, "project.json"), null))
    .filter((p): p is Project => !!p)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export const getProject = (home: Home, pid: string) => readJson<Project | null>(home.path("projects", pid, "project.json"), null);

const COLORS = ["#a9b8cc", "#b9abc9", "#a6c2ad", "#cbbd94", "#c9a9a6", "#9fc3c4"];

export function createProject(home: Home, input: { name: string; description?: string; instructions?: string; color?: string }): Project {
  const p: Project = {
    id: id("p_"),
    name: input.name,
    description: input.description ?? "",
    color: input.color ?? COLORS[listProjects(home).length % COLORS.length],
    createdAt: now(),
    updatedAt: now(),
  };
  writeJson(home.path("projects", p.id, "project.json"), p);
  home.write(`projects/${p.id}/instructions.md`, input.instructions ?? "");
  mkdirSync(home.path("projects", p.id, "files"), { recursive: true });
  return p;
}

export function updateProject(home: Home, pid: string, patch: Partial<Project> & { instructions?: string }) {
  const p = getProject(home, pid);
  if (!p) throw new Error(`No project ${pid}`);
  const { instructions, ...rest } = patch;
  const next = { ...p, ...rest, id: p.id, updatedAt: now() };
  writeJson(home.path("projects", pid, "project.json"), next);
  if (instructions !== undefined) home.write(`projects/${pid}/instructions.md`, instructions);
  return next;
}

export function deleteProject(home: Home, pid: string) {
  rmSync(home.path("projects", pid), { recursive: true, force: true });
}

/** Folder the file tools work in: the project's files/ folder, or the shared workspace. */
export function workspaceFor(home: Home, projectId?: string) {
  const dir = projectId ? home.path("projects", projectId, "files") : home.path("workspace");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- Chats ----------

export function listChats(home: Home): Omit<ChatRecord, "history" | "turns">[] {
  const dir = home.path("chats");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<ChatRecord | null>(home.path("chats", f), null))
    .filter((c): c is ChatRecord => !!c)
    .map(({ history: _h, turns: _t, ...rest }) => rest)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface ChatHit {
  id: string;
  title: string;
  projectId?: string;
  updatedAt: string;
  /** A short piece of the message that matched, when the match was not in the title. */
  snippet?: string;
}

/** Find chats whose title or messages contain every word of the query (case-insensitive). Newest first. */
export function searchChats(home: Home, query: string, limit = 20): ChatHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const dir = home.path("chats");
  if (!words.length || !existsSync(dir)) return [];
  const hits: ChatHit[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const c = readJson<ChatRecord | null>(home.path("chats", f), null);
    if (!c) continue;
    const texts = [c.title, ...(c.turns ?? []).map((t) => t.content ?? "")];
    const all = texts.join("\n").toLowerCase();
    if (!words.every((w) => all.includes(w))) continue;
    const hit: ChatHit = { id: c.id, title: c.title, projectId: c.projectId, updatedAt: c.updatedAt };
    if (!words.every((w) => c.title.toLowerCase().includes(w))) {
      const turn = (c.turns ?? []).find((t) => (t.content ?? "").toLowerCase().includes(words[0]));
      if (turn) hit.snippet = snippetAround(turn.content, words[0]);
    }
    hits.push(hit);
  }
  return hits.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

function snippetAround(text: string, word: string, span = 90): string {
  const flat = text.replace(/\s+/g, " ");
  const at = flat.toLowerCase().indexOf(word);
  const start = Math.max(0, at - Math.floor(span / 3));
  const end = Math.min(flat.length, start + span);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

export const getChat = (home: Home, cid: string) => readJson<ChatRecord | null>(home.path("chats", `${cid}.json`), null);
export const saveChat = (home: Home, c: ChatRecord) => writeJson(home.path("chats", `${c.id}.json`), { ...c, updatedAt: now() });

export function createChat(home: Home, input: { projectId?: string; title?: string; model?: string; progressKey?: string }): ChatRecord {
  const c: ChatRecord = { id: id("c_"), title: input.title ?? "New chat", projectId: input.projectId, model: input.model, createdAt: now(), updatedAt: now(), turns: [], history: [], ...(input.progressKey ? { progressKey: input.progressKey } : {}) };
  saveChat(home, c);
  return c;
}

export function deleteChat(home: Home, cid: string) {
  rmSync(home.path("chats", `${cid}.json`), { force: true });
}

// ---------- Tasks ----------

export const listTasks = (home: Home) => readJson<Task[]>(home.path("tasks.json"), []);
export const saveTasks = (home: Home, tasks: Task[]) => writeJson(home.path("tasks.json"), tasks);

export function upsertTask(home: Home, input: Partial<Task> & { name: string; prompt: string; schedule: string }): Task {
  const tasks = listTasks(home);
  const i = input.id ? tasks.findIndex((t) => t.id === input.id) : -1;
  const t: Task = i >= 0 ? { ...tasks[i], ...input } as Task : { enabled: true, lastStatus: "never", createdAt: now(), ...input, id: id("t_") } as Task;
  if (i >= 0) tasks[i] = t;
  else tasks.push(t);
  saveTasks(home, tasks);
  return t;
}

export function patchTask(home: Home, tid: string, patch: Partial<Task>) {
  const tasks = listTasks(home);
  const i = tasks.findIndex((t) => t.id === tid);
  if (i < 0) throw new Error(`No task ${tid}`);
  tasks[i] = { ...tasks[i], ...patch, id: tid };
  saveTasks(home, tasks);
  return tasks[i];
}

export function deleteTask(home: Home, tid: string) {
  saveTasks(home, listTasks(home).filter((t) => t.id !== tid));
}

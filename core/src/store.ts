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

export function createChat(home: Home, input: { projectId?: string; title?: string; model?: string; progressKey?: string; role?: ChatRecord["role"]; parentId?: string; threadState?: ChatRecord["threadState"]; origin?: ChatRecord["origin"] }): ChatRecord {
  // Every chat in a project is a thread of the project's coordinator.
  if (input.projectId && !input.role && getProject(home, input.projectId)) {
    input = { ...input, role: "thread", parentId: getOrCreateCoordinator(home, input.projectId).id, origin: input.origin ?? "user" };
  }
  const c: ChatRecord = {
    id: id("c_"),
    title: input.title ?? "New chat",
    projectId: input.projectId,
    model: input.model,
    createdAt: now(),
    updatedAt: now(),
    turns: [],
    history: [],
    ...(input.progressKey ? { progressKey: input.progressKey } : {}),
    ...(input.role ? { role: input.role } : {}),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.threadState ? { threadState: input.threadState } : {}),
    ...(input.role === "thread" && input.origin ? { origin: input.origin } : {}),
  };
  saveChat(home, c);
  return c;
}

export interface PhoneTurn {
  role: "user" | "assistant";
  content: string;
  model?: string;
  createdAt?: string;
  durationMs?: number;
}

/**
 * Bring in a chat the iPhone app had while it worked without the computer. The same `phoneId` always
 * lands on the same chat: a repeated sync replaces its turns, so nothing is duplicated. The model-facing
 * history is rebuilt from the turns, so the chat carries on here as if it had started here.
 */
export function importPhoneChat(home: Home, input: { phoneId: string; title?: string; projectId?: string; model?: string; turns: PhoneTurn[] }): ChatRecord {
  const phoneId = String(input.phoneId ?? "").trim();
  if (!phoneId) throw new Error("A synced chat needs its phone id.");
  const turns = (Array.isArray(input.turns) ? input.turns : [])
    .filter((t) => (t?.role === "user" || t?.role === "assistant") && typeof t.content === "string")
    .slice(-500)
    .map((t) => ({
      id: id("t_"),
      role: t.role,
      content: t.content,
      ...(t.model ? { model: String(t.model) } : {}),
      ...(typeof t.durationMs === "number" ? { durationMs: t.durationMs } : {}),
      createdAt: typeof t.createdAt === "string" ? t.createdAt : now(),
    }));
  const existing = listChats(home).find((c) => c.phoneId === phoneId);
  const projectId = input.projectId && getProject(home, input.projectId) ? input.projectId : undefined;
  const c = existing ? getChat(home, existing.id)! : createChat(home, { projectId, title: input.title, model: input.model });
  c.phoneId = phoneId;
  if (input.title) c.title = String(input.title).slice(0, 200);
  if (input.model) c.model = String(input.model);
  c.turns = turns;
  c.history = turns.map((t) => ({ role: t.role, content: t.content }));
  saveChat(home, c);
  return c;
}

export function deleteChat(home: Home, cid: string) {
  rmSync(home.path("chats", `${cid}.json`), { force: true });
}

/** Change a chat on disk without touching its history or turns (safe while it runs: the run re-reads the file when it ends). */
export function patchChat(home: Home, cid: string, fn: (c: ChatRecord) => void) {
  const c = getChat(home, cid);
  if (!c) return null;
  fn(c);
  writeJson(home.path("chats", `${cid}.json`), c);
  return c;
}

// ---------- Coordinator and threads ----------

/** The project's coordinator chat, made the first time it is asked for. */
export function getOrCreateCoordinator(home: Home, pid: string): ChatRecord {
  const p = getProject(home, pid);
  if (!p) throw Object.assign(new Error(`No project ${pid}`), { status: 404 });
  const existing = p.coordinatorChatId ? getChat(home, p.coordinatorChatId) : null;
  if (existing) return existing;
  const c = createChat(home, { projectId: pid, title: p.name, role: "coordinator" });
  writeJson(home.path("projects", pid, "project.json"), { ...p, coordinatorChatId: c.id });
  return c;
}

export type ThreadSummary = Omit<ChatRecord, "history" | "turns" | "pendingNotes" | "wakes"> & { costUsd: number; lastAnswer?: string };

/** Make a plain chat a thread of a project's coordinator (a chat moved into a project, or one from before threads). */
export function adoptIntoProject(home: Home, cid: string, pid: string) {
  const coord = getOrCreateCoordinator(home, pid);
  return patchChat(home, cid, (c) => {
    if (c.role) return;
    c.projectId = pid;
    c.role = "thread";
    c.parentId = coord.id;
    c.origin = c.origin ?? "user";
    c.threadState = c.threadState ?? "done";
  });
}

/** A coordinator's threads, newest first. */
export function listThreads(home: Home, coordinatorId: string): ThreadSummary[] {
  const dir = home.path("chats");
  if (!existsSync(dir)) return [];
  const out: ThreadSummary[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const c = readJson<ChatRecord | null>(home.path("chats", f), null);
    if (!c || c.parentId !== coordinatorId) continue;
    const { history: _h, turns, pendingNotes: _n, wakes: _w, ...rest } = c;
    const costUsd = (turns ?? []).reduce((s, t) => s + (t.usage?.costUsd ?? 0), 0);
    const lastAnswer = (turns ?? []).findLast((t) => t.role === "assistant")?.content;
    out.push({ ...rest, costUsd, ...(lastAnswer ? { lastAnswer: lastAnswer.slice(0, 400) } : {}) });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** What a project's chats cost: today (local day) and in all. */
export function projectSpend(home: Home, pid: string) {
  const dir = home.path("chats");
  const day = new Date().toDateString();
  let today = 0;
  let total = 0;
  if (!existsSync(dir)) return { today, total };
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const c = readJson<ChatRecord | null>(home.path("chats", f), null);
    if (!c || c.projectId !== pid) continue;
    for (const t of c.turns ?? []) {
      const usd = t.usage?.costUsd ?? 0;
      total += usd;
      if (new Date(t.createdAt).toDateString() === day) today += usd;
    }
  }
  return { today, total };
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

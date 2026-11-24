// Folders on the user's computer linked to a chat, a project or a coordinator. The model can read
// (and, with write access, change) files inside them, and run terminal commands in them. Nothing
// outside the workspace and these folders is reachable from the file tools.
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { Home } from "./home.ts";
import * as store from "./store.ts";
import type { ChatRecord, FolderLink } from "./types.ts";
import { now } from "./util.ts";

export type FolderScope = "project" | "chat" | "coordinator";
export type LinkedFolder = FolderLink & { scope: FolderScope };

const WIN = process.platform === "win32";
const norm = (p: string) => (WIN ? resolve(p).toLowerCase() : resolve(p));

/** True when `p` is `dir` or inside it. */
export function within(dir: string, p: string) {
  const r = relative(norm(dir), norm(p));
  return r === "" || (!!r && !r.startsWith(".." + sep) && r !== ".." && !isAbsolute(r));
}

/** The real path, following links, so a junction can't lead out of a linked folder. */
function real(p: string) {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Folders this chat can use, most specific first: its own, then (for a thread) its coordinator's,
 * then its project's. A folder linked twice keeps the first (most specific) entry.
 */
export function linkedFolders(home: Home, chat: Pick<ChatRecord, "folders" | "parentId" | "projectId"> | null, projectId?: string): LinkedFolder[] {
  const out: LinkedFolder[] = [];
  const add = (list: FolderLink[] | undefined, scope: FolderScope) => {
    for (const f of list ?? []) if (!out.some((o) => norm(o.path) === norm(f.path))) out.push({ ...f, scope });
  };
  add(chat?.folders, "chat");
  if (chat?.parentId) add(store.getChat(home, chat.parentId)?.folders, "coordinator");
  const pid = chat?.projectId ?? projectId;
  if (pid) add(store.getProject(home, pid)?.folders, "project");
  return out;
}

/** The real path of `p`, or of its nearest existing parent plus the rest (for files not made yet). */
function realish(p: string): string {
  const abs = resolve(p);
  let dir = abs;
  const rest: string[] = [];
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return abs;
    rest.unshift(basename(dir));
    dir = up;
  }
  return join(real(dir), ...rest);
}

/**
 * The linked folder that holds `abs`, if any (the innermost one when they nest). Links and
 * junctions are followed, so a link inside the folder that points elsewhere doesn't count.
 */
export function folderFor(folders: LinkedFolder[], abs: string): LinkedFolder | undefined {
  const target = realish(abs);
  const inside = folders.filter((f) => within(f.path, abs) && within(real(f.path), target));
  return inside.sort((a, b) => b.path.length - a.path.length)[0];
}

/** Why a folder can't be linked, or null when it can. */
export function linkProblem(home: Home, path: string): string | null {
  if (!path || !isAbsolute(path)) return "Give the folder's full path, for example C:\\Users\\you\\Documents\\Project.";
  const abs = resolve(path);
  if (!existsSync(abs)) return `There is no folder at ${abs}.`;
  if (!statSync(abs).isDirectory()) return `${abs} is a file. Link the folder it is in.`;
  if (parse(abs).root === abs || norm(parse(abs).root) === norm(abs)) return "Link a folder, not a whole drive.";
  // Syph's own data (keys, config, other chats) must never be reachable through a linked folder.
  if (within(abs, home.root) || within(real(abs), real(home.root))) return "That folder holds Syph's own data (keys and settings), so it can't be linked. Pick a folder inside it, such as a project's files, or another folder.";
  if (within(home.root, abs) && !within(home.path("workspace"), abs) && !/[\\/]projects[\\/][^\\/]+[\\/]files([\\/]|$)/.test(abs)) return "That is part of Syph's own data. Link your own folder instead.";
  return null;
}

type Target = { projectId?: string; chatId?: string };

function edit(home: Home, target: Target, fn: (list: FolderLink[]) => FolderLink[]) {
  if (target.chatId) {
    const c = store.getChat(home, target.chatId);
    if (!c) throw Object.assign(new Error(`No chat ${target.chatId}`), { status: 404 });
    c.folders = fn(c.folders ?? []);
    store.saveChat(home, c);
    return;
  }
  if (target.projectId) {
    const p = store.getProject(home, target.projectId);
    if (!p) throw Object.assign(new Error(`No project ${target.projectId}`), { status: 404 });
    store.updateProject(home, p.id, { folders: fn(p.folders ?? []) });
    return;
  }
  throw Object.assign(new Error("Link the folder to a chat or a project."), { status: 400 });
}

export function linkFolder(home: Home, input: Target & { path: string; access?: "read" | "write"; name?: string }): FolderLink {
  const problem = linkProblem(home, input.path);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  const abs = resolve(input.path);
  const link: FolderLink = { path: abs, name: input.name?.trim() || basename(abs) || abs, access: input.access === "read" ? "read" : "write", linkedAt: now() };
  edit(home, input, (list) => [...list.filter((f) => norm(f.path) !== norm(abs)), link]);
  return link;
}

export function unlinkFolder(home: Home, target: Target, path: string) {
  edit(home, target, (list) => list.filter((f) => norm(f.path) !== norm(path)));
}

export function setFolderAccess(home: Home, target: Target, path: string, access: "read" | "write") {
  edit(home, target, (list) => list.map((f) => (norm(f.path) === norm(path) ? { ...f, access } : f)));
}

/** The system prompt section about the chat's folders and terminal. */
export function folderPrompt(folders: LinkedFolder[], shellName: string): string {
  if (!folders.length) return `# Folders on the user's computer\nNo folder is linked. You can only reach your workspace. If the user wants you to work on files elsewhere on their computer, ask them to link the folder with the folder button under the message box (for this chat) or in the project's Settings (for the whole project).`;
  const primary = folders.find((f) => f.access === "write") ?? folders[0];
  return [
    "# Folders on the user's computer",
    "The user linked these folders. Use their full paths with the file tools (list_files, read_file, search_files, write_file, edit_file):",
    ...folders.map((f) => `- ${f.path} (${f.access === "write" ? "read and write" : "read only"}; linked to ${f.scope === "chat" ? "this chat" : f.scope === "coordinator" ? "the project's coordinator" : "the project"})`),
    `Relative paths still mean your workspace. Nothing else on the computer is reachable. Never write in a read-only folder; ask the user to allow writing if you need to.`,
    `# Terminal\nThe shell tool runs ${shellName} commands on the user's computer, in ${primary.path} unless you pass cwd (any linked folder or your workspace). The user sees each command in the chat's command log and can stop it. Depending on their settings they may be asked to allow it. Prefer the file tools for reading and editing files; use the terminal to build, test, run scripts, install packages, use git and other command-line tools. For servers and watchers pass background: true, then read their output with command_output and stop them with stop_command. Don't run destructive commands (deleting folders, formatting, force-pushing) unless the user asked for exactly that.`,
  ].join("\n");
}

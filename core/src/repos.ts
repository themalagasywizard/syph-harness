// Repositories Syph works on: cloned into the project's (or the shared) workspace and linked to a
// project, so every chat in it sees them, or to a single chat. Git runs here with the GitHub token
// passed in the environment for github.com only, so it never lands in a repository's own config.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Home } from "./home.ts";
import * as store from "./store.ts";
import { defineTool, type Tool } from "./tools/types.ts";
import type { ChatRecord, RepoLink } from "./types.ts";
import { now, truncate } from "./util.ts";
import { repoSlug } from "./connectors/github.ts";

export type RepoScope = "project" | "chat";
export type LinkedRepo = RepoLink & { scope: RepoScope };

export interface RepoStatus extends LinkedRepo {
  exists: boolean;
  branch?: string;
  /** Files with changes not yet committed. */
  dirty?: number;
  /** Commits not yet pushed, and commits on the remote not yet pulled. */
  ahead?: number;
  behind?: number;
  upstream?: string;
  active?: boolean;
  error?: string;
}

/** What the git layer needs from the harness: the GitHub sign-in and a way to tell the UI. */
export interface RepoHost {
  home: Home;
  /** The GitHub token, or null when GitHub isn't connected. */
  token(): Promise<string | null>;
  /** Who commits are made as when the repo and git have no user set (the GitHub account). */
  identity(): Promise<{ name: string; email: string } | null>;
  changed(): void;
  /** YOLO: also allow destructive git commands (force push, reset --hard, ...) without asking. */
  yolo(): boolean;
}

// ---------- Running git ----------

export class GitError extends Error {
  constructor(message: string, readonly code: number | string = 1, readonly output = "") {
    super(message);
  }
}

const GIT_MISSING = "Git isn't installed on this computer. Install it from https://git-scm.com/download/win (keep the default options), then restart Syph.";

function redactor(token: string | null) {
  if (!token) return (s: string) => s;
  const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
  return (s: string) => s.split(token).join("•••").split(b64).join("•••");
}

/** The environment git runs with: no prompts, and the token as a header for github.com only. */
export function gitEnv(token: string | null, identity?: { name: string; email: string } | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "" };
  const cfg: [string, string][] = [];
  if (token) {
    // Our header replaces any saved credential for github.com, which could belong to another account.
    cfg.push(["credential.https://github.com.helper", ""]);
    cfg.push(["http.https://github.com/.extraheader", `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`]);
  }
  env.GIT_CONFIG_COUNT = String(cfg.length);
  cfg.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  if (identity) {
    env.GIT_AUTHOR_NAME ??= identity.name;
    env.GIT_AUTHOR_EMAIL ??= identity.email;
    env.GIT_COMMITTER_NAME ??= identity.name;
    env.GIT_COMMITTER_EMAIL ??= identity.email;
  }
  return env;
}

export function git(cwd: string | undefined, args: string[], opts: { token?: string | null; identity?: { name: string; email: string } | null; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ stdout: string; stderr: string }> {
  const clean = redactor(opts.token ?? null);
  return new Promise((resolve, reject) =>
    execFile(
      "git",
      args,
      { cwd, timeout: opts.timeoutMs ?? 10 * 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal: opts.signal, env: gitEnv(opts.token ?? null, opts.identity) },
      (err, stdout, stderr) => {
        const out = clean(String(stdout ?? ""));
        const errText = clean(String(stderr ?? ""));
        if (!err) return resolve({ stdout: out, stderr: errText });
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reject(new GitError(GIT_MISSING, "ENOENT"));
        const status = typeof (err as any).code === "number" ? (err as any).code : 1;
        reject(new GitError(clean(errText.trim() || out.trim() || err.message).slice(0, 4000), status, out));
      },
    ),
  );
}

/** A git failure in words the user can act on. */
export function explainGitError(msg: string) {
  if (/could not read Username|Authentication failed|invalid credentials|403|Permission to .* denied/i.test(msg)) return `GitHub refused the sign-in. Check the token on Connectors → GitHub is valid and has the repo scope.\n${msg}`;
  if (/rejected.*fetch first|non-fast-forward/i.test(msg)) return `GitHub has newer commits. Pull first, then push again.\n${msg}`;
  if (/Not possible to fast-forward|diverged/i.test(msg)) return `This branch and GitHub have both changed. Ask Syph to merge or rebase them.\n${msg}`;
  return msg;
}

const lines = (s: string) => s.split(/\r?\n/).filter(Boolean);

/** Branch, uncommitted files and how far it is from its upstream. Never throws. */
export async function repoStatus(r: LinkedRepo): Promise<RepoStatus> {
  if (!existsSync(join(r.path, ".git"))) return { ...r, exists: false };
  try {
    const { stdout } = await git(r.path, ["status", "--porcelain=v2", "--branch"], { timeoutMs: 20_000 });
    const st: RepoStatus = { ...r, exists: true, dirty: 0 };
    for (const l of lines(stdout)) {
      if (l.startsWith("# branch.head ")) st.branch = l.slice(14) === "(detached)" ? "detached" : l.slice(14);
      else if (l.startsWith("# branch.upstream ")) st.upstream = l.slice(18);
      else if (l.startsWith("# branch.ab ")) {
        const m = /\+(\d+) -(\d+)/.exec(l);
        if (m) [st.ahead, st.behind] = [Number(m[1]), Number(m[2])];
      } else if (!l.startsWith("#")) st.dirty!++;
    }
    return st;
  } catch (e) {
    return { ...r, exists: true, error: (e as Error).message };
  }
}

// ---------- Which repos a chat works on ----------

const uniq = (rs: LinkedRepo[]) => [...new Map(rs.map((r) => [resolve(r.path), r])).values()];

/** The repos a project or chat works on: the project's, then the chat's own. */
export function linkedRepos(home: Home, target: { projectId?: string; chatId?: string }): LinkedRepo[] {
  const chat = target.chatId ? store.getChat(home, target.chatId) : null;
  const projectId = target.projectId ?? chat?.projectId;
  const project = projectId ? store.getProject(home, projectId) : null;
  return uniq([...(project?.repos ?? []).map((r) => ({ ...r, scope: "project" as const })), ...(chat?.repos ?? []).map((r) => ({ ...r, scope: "chat" as const }))]);
}

/** The repo a chat is working on now: the one picked, else the one linked last. */
export function activeRepo(home: Home, chat: Pick<ChatRecord, "id" | "projectId" | "activeRepo"> | null, projectId?: string): LinkedRepo | undefined {
  const all = linkedRepos(home, { chatId: chat?.id, projectId: projectId ?? chat?.projectId });
  return all.find((r) => chat?.activeRepo && resolve(r.path) === resolve(chat.activeRepo)) ?? [...all].sort((a, b) => b.connectedAt.localeCompare(a.connectedAt))[0];
}

/** Every repo linked anywhere (to tell a real repo folder from any other path the UI sends). */
export function allLinkedRepos(home: Home): LinkedRepo[] {
  const fromProjects = store.listProjects(home).flatMap((p) => (p.repos ?? []).map((r) => ({ ...r, scope: "project" as const })));
  const fromChats = store.listChats(home).flatMap((c) => (store.getChat(home, c.id)?.repos ?? []).map((r) => ({ ...r, scope: "chat" as const })));
  return uniq([...fromProjects, ...fromChats]);
}

export function setActiveRepo(home: Home, chatId: string, path: string | null) {
  const chat = store.getChat(home, chatId);
  if (!chat) throw Object.assign(new Error(`No chat ${chatId}`), { status: 404 });
  if (path && !linkedRepos(home, { chatId }).some((r) => resolve(r.path) === resolve(path))) throw Object.assign(new Error("That repo isn't linked to this chat or its project."), { status: 400 });
  chat.activeRepo = path ?? undefined;
  store.saveChat(home, chat);
}

function saveLink(home: Home, scope: RepoScope, target: { projectId?: string; chatId?: string }, repo: RepoLink) {
  if (scope === "project") {
    const p = target.projectId && store.getProject(home, target.projectId);
    if (!p) throw Object.assign(new Error("Pick a project to link the repo to."), { status: 400 });
    store.updateProject(home, p.id, { repos: [...(p.repos ?? []).filter((r) => resolve(r.path) !== resolve(repo.path)), repo] });
  }
  if (target.chatId) {
    const c = store.getChat(home, target.chatId);
    if (c) {
      if (scope === "chat") c.repos = [...(c.repos ?? []).filter((r) => resolve(r.path) !== resolve(repo.path)), repo];
      c.activeRepo = repo.path;
      store.saveChat(home, c);
    }
  }
}

/** Unlink a repo from a project or chat. The folder stays on disk. */
export function unlinkRepo(home: Home, target: { projectId?: string; chatId?: string }, path: string) {
  const same = (r: RepoLink) => resolve(r.path) === resolve(path);
  const chat = target.chatId ? store.getChat(home, target.chatId) : null;
  const projectId = target.projectId ?? chat?.projectId;
  const p = projectId ? store.getProject(home, projectId) : null;
  if (p?.repos?.some(same)) store.updateProject(home, p.id, { repos: p.repos.filter((r) => !same(r)) });
  if (chat) {
    chat.repos = (chat.repos ?? []).filter((r) => !same(r));
    if (chat.activeRepo && resolve(chat.activeRepo) === resolve(path)) chat.activeRepo = undefined;
    store.saveChat(home, chat);
  }
}

// ---------- Clone and link ----------

/** Turn "owner/name", a URL or an SSH remote into the https URL to clone and a folder name. */
export function parseRepo(input: string): { url: string; name: string; github: boolean } {
  const slug = repoSlug(input);
  if (slug) return { url: `https://github.com/${slug}`, name: slug.split("/")[1], github: true };
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw Object.assign(new Error(`"${input}" isn't a repository. Use owner/name or an https:// URL.`), { status: 400 });
  }
  if (u.protocol !== "https:") throw Object.assign(new Error("Only https:// repositories can be cloned."), { status: 400 });
  const name = u.pathname.split("/").filter(Boolean).pop()?.replace(/\.git$/, "") || "repo";
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, "")}`, name, github: u.hostname === "github.com" };
}

const sameRemote = (a: string, b: string) => a.trim().replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase() === b.trim().replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();

/**
 * Clone a repository (or reuse a clone that's already there) and link it to a project or chat.
 * scope "project" needs a projectId (or a chat in a project); "chat" needs a chatId.
 */
export async function cloneAndLink(host: RepoHost, input: { repo: string; name?: string; scope?: RepoScope; projectId?: string; chatId?: string; signal?: AbortSignal }): Promise<{ repo: LinkedRepo; already: boolean }> {
  const { home } = host;
  const chat = input.chatId ? store.getChat(home, input.chatId) : null;
  const projectId = input.projectId ?? chat?.projectId;
  const scope: RepoScope = input.scope ?? (projectId ? "project" : "chat");
  if (scope === "chat" && !chat) throw Object.assign(new Error("Open a chat to link the repo to."), { status: 400 });
  const parsed = parseRepo(input.repo);
  const name = (input.name || parsed.name).replace(/[^\w.-]+/g, "-").replace(/^\.+/, "").slice(0, 80) || "repo";
  const base = store.workspaceFor(home, projectId);
  const dir = join(base, name);
  const token = parsed.github ? await host.token() : null;
  let already = false;
  if (existsSync(dir) && readdirSync(dir).length) {
    if (!existsSync(join(dir, ".git"))) throw Object.assign(new Error(`${dir} already exists and isn't a git repository. Pick another name.`), { status: 409 });
    const origin = await git(dir, ["remote", "get-url", "origin"]).then((r) => r.stdout.trim()).catch(() => "");
    if (origin && !sameRemote(origin, parsed.url)) throw Object.assign(new Error(`${dir} is a clone of ${origin}, not ${parsed.url}. Pick another name.`), { status: 409 });
    already = true;
  } else {
    mkdirSync(base, { recursive: true });
    try {
      try {
        await git(base, ["clone", "--", parsed.url, dir], { token, timeoutMs: 30 * 60_000, signal: input.signal });
      } catch (e) {
        // A token GitHub rejects (expired, revoked) still lets public repos clone without it.
        if (!token || !/401|Authentication failed|could not read Username|invalid credentials/i.test((e as Error).message)) throw e;
        await git(base, ["clone", "--", parsed.url, dir], { token: null, timeoutMs: 30 * 60_000, signal: input.signal });
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (/not found|could not read Username|Authentication failed|403/i.test(msg) && parsed.github && !token) throw new GitError(`Couldn't clone ${parsed.url}. If it's private, connect GitHub on the Connectors page first.\n${msg}`);
      throw e;
    }
  }
  const repo: RepoLink = { name, url: parsed.url, path: dir, connector: parsed.github ? "github" : undefined, connectedAt: now() };
  saveLink(home, scope, { projectId, chatId: input.chatId }, repo);
  host.changed();
  return { repo: { ...repo, scope }, already };
}

// ---------- The git tool ----------

/** Subcommands the git tool runs. Anything that only reads, plus the everyday ones that change a repo. */
const SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "blame", "shortlog", "describe", "rev-parse", "rev-list", "ls-files", "ls-remote", "grep", "reflog", "whatchanged", "cat-file",
  "add", "rm", "mv", "restore", "commit", "reset", "revert", "cherry-pick", "merge", "rebase", "stash", "checkout", "switch", "branch", "tag",
  "fetch", "pull", "push", "remote", "clean", "config", "init", "submodule", "lfs", "worktree", "notes", "apply", "am", "format-patch", "bisect", "range-diff",
]);

/** Options that would let git run other programs. */
const UNSAFE_ARG = /^(--upload-pack|--receive-pack|--exec(=|$)|--ext-diff|--textconv|--template)/;

/** Subcommand forms that run programs (rebase --exec, bisect run, submodule foreach). */
function runsPrograms(cmd: string, rest: string[]) {
  if (cmd === "rebase" && rest.some((a) => a === "-x" || a.startsWith("--exec"))) return true;
  if (cmd === "bisect" && rest[0] === "run") return true;
  if (cmd === "submodule" && rest.includes("foreach")) return true;
  return false;
}

function destructive(args: string[]): string | null {
  const [cmd, ...rest] = args;
  const has = (...flags: string[]) => rest.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)));
  if (cmd === "push" && (has("--force", "-f", "--force-with-lease", "--force-if-includes", "--mirror", "--delete", "-d", "--prune") || rest.some((a) => /^\+|^:/.test(a)))) return "force-push or delete on the remote";
  if (cmd === "reset" && has("--hard", "--merge", "--keep")) return "throw away changes with reset --hard";
  if (cmd === "clean") return "delete untracked files";
  if (cmd === "branch" && has("-D", "--delete", "-d") && (has("-D") || has("--force", "-f"))) return "delete a branch that isn't merged";
  if (cmd === "stash" && ["drop", "clear"].includes(rest[0])) return "delete stashed changes";
  if (cmd === "checkout" && (rest.includes("--") || rest.includes(".") || has("--force", "-f"))) return "throw away uncommitted changes";
  if (cmd === "restore" && (!has("--staged", "-S") || has("--worktree", "-W"))) return "throw away uncommitted changes";
  if (cmd === "tag" && has("-d", "--delete")) return "delete a tag";
  if (cmd === "worktree" && rest[0] === "remove") return "remove a worktree";
  return null;
}

function configAllowed(rest: string[]) {
  // Reading config is fine; writing it is limited to identity and harmless settings.
  if (rest.some((a) => ["--get", "--get-all", "--list", "-l", "--get-regexp", "--show-origin"].includes(a))) return true;
  const key = rest.find((a) => !a.startsWith("-"));
  return !!key && /^(user\.(name|email)|pull\.rebase|push\.autoSetupRemote|init\.defaultBranch|branch\.[\w./-]+\.(remote|merge)|core\.autocrlf)$/i.test(key);
}

function noHooksDir(home: Home) {
  const dir = home.path(".cache", "no-git-hooks");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The tools that clone repos, run git in them and list them. */
export function repoTools(host: RepoHost): Tool[] {
  const pickRepo = (ctx: { chatId?: string; projectId?: string }, which?: string): LinkedRepo => {
    const all = linkedRepos(host.home, ctx);
    if (!all.length) throw new Error("No repository is linked to this chat or project yet. Clone one with github_clone (or ask the user to link one from the chat bar).");
    if (!which) {
      const chat = ctx.chatId ? store.getChat(host.home, ctx.chatId) : null;
      return activeRepo(host.home, chat, ctx.projectId)!;
    }
    const w = which.trim().toLowerCase();
    const found = all.find((r) => r.name.toLowerCase() === w || resolve(r.path).toLowerCase() === resolve(which).toLowerCase() || r.url.toLowerCase().endsWith(`/${w}`) || r.url.toLowerCase() === w);
    if (!found) throw new Error(`No linked repo called "${which}". Linked: ${all.map((r) => r.name).join(", ")}.`);
    return found;
  };

  const clone = defineTool({
    name: "github_clone",
    description: "Clone a repository (owner/name or an https URL) and link it to this project, or to this chat when it has no project, so you can work on it with the file tools and git. Reuses the clone if it's already there. Private GitHub repos use the user's GitHub sign-in.",
    schema: z.object({
      repo: z.string().describe("owner/name, or https://github.com/owner/name"),
      name: z.string().optional().describe("Folder name (default: the repo's name)"),
      scope: z.enum(["project", "chat"]).optional().describe("Link it to the whole project (default when in one) or only this chat"),
    }),
    permission: "auto",
    run: async ({ repo, name, scope }, ctx) => {
      const r = await cloneAndLink(host, { repo, name, scope, projectId: ctx.projectId, chatId: ctx.chatId, signal: ctx.signal });
      const st = await repoStatus(r.repo);
      return `${r.already ? "Already cloned" : "Cloned"} ${r.repo.url} into ${r.repo.path} and linked it to this ${r.repo.scope}. Branch ${st.branch ?? "?"}. The file tools reach it as ${r.repo.name}/ and the git tool runs in it.`;
    },
  });

  const list = defineTool({
    name: "list_repos",
    description: "List the repositories linked to this chat and its project: folder, branch, uncommitted changes and commits ahead/behind the remote. The active one is the one the user is working on.",
    schema: z.object({}),
    permission: "auto",
    run: async (_a, ctx) => {
      const all = linkedRepos(host.home, ctx);
      if (!all.length) return "No repositories linked. Use github_clone to clone and link one.";
      const active = activeRepo(host.home, ctx.chatId ? store.getChat(host.home, ctx.chatId) : null, ctx.projectId);
      const rows = await Promise.all(all.map(repoStatus));
      return rows.map((s) => `- ${s.name}${active && resolve(active.path) === resolve(s.path) ? " (active)" : ""} · ${s.url}\n  folder ${s.path} · linked to this ${s.scope}\n  ${!s.exists ? "folder missing: clone it again with github_clone" : s.error ? `error: ${s.error}` : `branch ${s.branch}${s.upstream ? ` → ${s.upstream}` : " (no upstream)"} · ${s.dirty} uncommitted · ${s.ahead ?? 0} ahead, ${s.behind ?? 0} behind`}`).join("\n");
    },
  });

  const gitTool = defineTool({
    name: "git",
    description: `Run git in a linked repository (default: the active one), signed in to GitHub. Pass args as a list, e.g. ["status"], ["pull"], ["add","-A"], ["commit","-m","Fix login"], ["push","origin","main"], ["switch","-c","feature/x"], ["log","--oneline","-10"], ["diff","--stat"]. You handle the repo yourself: pull before you start, commit with clear messages, and push when the work is done (to main unless the user wants a branch or pull request). Force-pushes, reset --hard, clean and other commands that throw work away ask the user first.`,
    schema: z.object({
      args: z.array(z.string()).min(1).describe('git arguments, e.g. ["commit","-m","message"]'),
      repo: z.string().optional().describe("Linked repo name or folder (default: the active repo)"),
    }),
    permission: "auto",
    needsApproval: ({ args }) => {
      if (host.yolo()) return null;
      const why = destructive(args);
      return why ? `Syph wants to ${why}: git ${args.join(" ")}` : null;
    },
    run: async ({ args, repo }, ctx) => {
      const [cmd, ...rest] = args;
      if (!SUBCOMMANDS.has(cmd)) throw new Error(`git ${cmd} isn't available here. Start args with a subcommand such as status, diff, add, commit, pull, push, switch, branch, merge or log.`);
      if (rest.some((a) => UNSAFE_ARG.test(a)) || runsPrograms(cmd, rest)) throw new Error("That option runs other programs, so it isn't allowed in the git tool. Use shell for it (the user approves it).");
      if (cmd === "config" && !configAllowed(rest)) throw new Error("The git tool only reads config, or sets user.name, user.email and a few pull/push/branch settings.");
      const r = pickRepo(ctx, repo);
      if (!existsSync(join(r.path, ".git"))) throw new Error(`${r.path} isn't there any more. Clone it again with github_clone.`);
      const token = r.connector === "github" || r.url.startsWith("https://github.com/") ? await host.token() : null;
      // Commits need an author: use the repo's or git's own setting, else the GitHub account.
      let identity: { name: string; email: string } | null = null;
      if (["commit", "merge", "rebase", "revert", "cherry-pick", "am", "stash", "pull", "tag"].includes(cmd)) {
        const email = await git(r.path, ["config", "user.email"]).then((x) => x.stdout.trim()).catch(() => "");
        if (!email) identity = (await host.identity()) ?? { name: "Syph", email: "syph@localhost" };
      }
      // Keep commands that open an editor or pager from waiting forever.
      const final = cmd === "commit" && !rest.some((a) => /^(-m|--message|-F|--file|--no-edit|-C|--reuse-message|--fixup)/.test(a)) ? [cmd, "--no-edit", ...rest] : cmd === "merge" && !rest.some((a) => /^(-m|--no-edit|--edit|--abort|--continue)/.test(a)) ? [cmd, "--no-edit", ...rest] : args;
      const env = ["-c", "core.pager=cat", "-c", "core.editor=true", "-c", "sequence.editor=true", "-c", "color.ui=false"];
      // Hooks are programs too: they run only in YOLO mode, like shell commands do.
      if (!host.yolo()) env.push("-c", `core.hooksPath=${noHooksDir(host.home)}`);
      try {
        const out = await git(r.path, [...env, ...final], { token, identity, signal: ctx.signal });
        const text = [out.stdout.trim(), out.stderr.trim()].filter(Boolean).join("\n");
        if (["commit", "pull", "push", "checkout", "switch", "merge", "rebase", "reset", "fetch", "branch", "stash"].includes(cmd)) host.changed();
        return `${r.name}$ git ${args.join(" ")}\n${truncate(text || "(done, no output)", 50_000)}`;
      } catch (e) {
        const err = e as GitError;
        if (err.code === "ENOENT") throw err;
        host.changed();
        const hint = /could not read Username|Authentication failed|403|Permission to .* denied/i.test(err.message) ? "\n(GitHub refused the sign-in. Ask the user to check the GitHub token on the Connectors page has the repo scope.)" : /rejected.*fetch first|non-fast-forward/i.test(err.message) ? "\n(The remote has new commits. Pull first, then push again.)" : "";
        throw new Error(`git ${args.join(" ")} failed in ${r.name} (exit ${err.code}):\n${truncate(err.message, 20_000)}${hint}`);
      }
    },
  });

  return [clone, list, gitTool];
}

/** For the system prompt: which repos this chat works on. */
export async function repoPrompt(home: Home, chat: ChatRecord | null, projectId?: string): Promise<string> {
  const all = linkedRepos(home, { chatId: chat?.id, projectId });
  if (!all.length) return "# Repositories\nNo repository is linked yet. When the user wants to work on code from GitHub, clone it with github_clone (it links the repo here), or list theirs with github_repos.";
  const active = activeRepo(home, chat, projectId);
  const rows = await Promise.all(all.map(repoStatus));
  return [
    "# Repositories",
    "Linked to this chat (the active one is what the user is working on):",
    ...rows.map((s) => `- ${s.name}${active && resolve(active.path) === resolve(s.path) ? " (active)" : ""}: ${s.url}, cloned at ${s.path}${s.exists ? `, branch ${s.branch ?? "?"}, ${s.dirty ?? 0} uncommitted, ${s.ahead ?? 0} ahead / ${s.behind ?? 0} behind` : " (folder missing)"}.`),
    "Work on them yourself: the file tools reach each one as <name>/, and the git tool runs git in it, signed in to GitHub. Pull first, commit with clear messages, and push when the work is done, to main unless the user asked for a branch or a pull request (github_pr_create). Use github_api for issues, reviews, Actions and anything else on GitHub.",
  ].join("\n");
}

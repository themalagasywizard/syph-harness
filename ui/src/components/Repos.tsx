// Repositories in the interface: link one to a project or chat, see which one a chat works on
// (branch, uncommitted changes, ahead/behind), pull it, open it, unlink it.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, ExternalLink, FolderGit2, FolderOpen, GitBranch, Github, Loader2, Lock, Plus, RefreshCw, Search, Unlink, Upload, X } from "lucide-react";
import { useApp } from "../App";
import { api, relTime, type GithubRepo, type RepoStatus } from "../api";
import { revealFile } from "./FilePreview";

const same = (a?: string, b?: string) => !!a && !!b && a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

/** The repos linked to a chat (and its project) or a project, kept fresh as git runs. */
export function useRepos(target: { chatId?: string; projectId?: string }) {
  const { state } = useApp();
  const [repos, setRepos] = useState<RepoStatus[]>([]);
  const key = `${target.chatId ?? ""}|${target.projectId ?? ""}`;
  const reload = async () => {
    if (!target.chatId && !target.projectId) return setRepos([]);
    const q = new URLSearchParams();
    if (target.chatId) q.set("chatId", target.chatId);
    if (target.projectId) q.set("projectId", target.projectId);
    setRepos(await api.get<RepoStatus[]>(`/repos?${q}`).catch(() => []));
  };
  // `state` changes whenever the server says chats changed, which git commands and links do.
  useEffect(() => {
    reload();
  }, [key, state]);
  return { repos, reload, active: repos.find((r) => r.active) };
}

/** Close a menu when the user clicks anywhere else. */
export function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, [open]);
  return ref;
}

export function RepoState({ r, compact }: { r: RepoStatus; compact?: boolean }) {
  if (!r.exists) return <span className="repo-state bad">folder missing</span>;
  if (r.error) return <span className="repo-state bad" title={r.error}>git error</span>;
  return (
    <span className="repo-state">
      <span className="br"><GitBranch size={12} /> {r.branch ?? "?"}</span>
      {!!r.dirty && <span className="dirty" title={`${r.dirty} file${r.dirty === 1 ? "" : "s"} changed, not committed`}>● {r.dirty}{compact ? "" : " changed"}</span>}
      {!!r.ahead && <span className="ab" title={`${r.ahead} commit${r.ahead === 1 ? "" : "s"} not pushed`}><ArrowUp size={11} />{r.ahead}</span>}
      {!!r.behind && <span className="ab" title={`${r.behind} commit${r.behind === 1 ? "" : "s"} to pull`}><ArrowDown size={11} />{r.behind}</span>}
      {!compact && !r.dirty && !r.ahead && !r.behind && r.upstream && <span className="clean">up to date</span>}
    </span>
  );
}

/** Pick one of the user's GitHub repos (or paste owner/name or a URL) and link it. */
export function RepoLinkModal({ projectId, chatId, ensureChat, onClose, onLinked }: { projectId?: string; chatId?: string; ensureChat?: () => Promise<string>; onClose: () => void; onLinked?: (r: RepoStatus) => void }) {
  const { state, go } = useApp();
  const gh = state?.github;
  const project = state?.projects.find((p) => p.id === projectId);
  const [all, setAll] = useState<GithubRepo[] | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"project" | "chat">(projectId ? "project" : "chat");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const { repos: linked } = useRepos({ chatId, projectId });

  useEffect(() => {
    if (!gh?.connected) return setAll([]);
    api.get<GithubRepo[]>("/github/repos").then(setAll).catch((e) => (setLoadError((e as Error).message), setAll([])));
  }, [gh?.connected]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (all ?? []).filter((r) => !t || r.full_name.toLowerCase().includes(t) || r.description.toLowerCase().includes(t)).slice(0, 200);
  }, [all, q]);
  const typed = q.trim();
  const looksLikeRepo = /^[\w.-]+\/[\w.-]+$/.test(typed) || /^https:\/\/\S+$/.test(typed) || /^git@github\.com:/.test(typed);
  const exact = shown.some((r) => r.full_name.toLowerCase() === typed.toLowerCase().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""));

  const link = async (repo: string) => {
    setBusy(repo);
    setError(undefined);
    try {
      const cid = scope === "chat" ? chatId ?? (await ensureChat?.()) : chatId;
      const r = await api.post<{ repo: RepoStatus; already: boolean }>("/repos/link", { repo, scope, projectId, chatId: cid });
      onLinked?.(r.repo);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  };
  const isLinked = (r: GithubRepo) => linked.some((l) => l.url.toLowerCase() === `https://github.com/${r.full_name}`.toLowerCase());

  return (
    <div className="scrim" onClick={() => !busy && onClose()}>
      <div className="modal repo-modal" onClick={(e) => e.stopPropagation()}>
        <div className="repo-modal-head">
          <h3>Link a repository</h3>
          <button className="icon-btn" onClick={onClose} disabled={!!busy} aria-label="Close"><X size={18} /></button>
        </div>
        {!gh?.connected && (
          <div className="banner repo-connect">
            <Github size={16} />
            <span>Connect GitHub to pick from your repositories and push to private ones. Public repos work without it.</span>
            <button className="btn tonal sm" onClick={() => { onClose(); go({ kind: "connectors" }); }}>Connect GitHub</button>
          </div>
        )}
        <div className="repo-search">
          <Search size={16} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={gh?.connected ? "Search your repos, or paste owner/name or a URL" : "owner/name or https://github.com/owner/name"} onKeyDown={(e) => e.key === "Enter" && looksLikeRepo && !busy && link(typed)} />
          {all === null && <Loader2 size={16} className="spin" />}
        </div>
        <div className="repo-list">
          {looksLikeRepo && !exact && (
            <button className="repo-pick" disabled={!!busy} onClick={() => link(typed)}>
              <Plus size={16} />
              <span className="rp-main"><span className="rp-name">Clone {typed}</span></span>
              {busy === typed && <Loader2 size={15} className="spin" />}
            </button>
          )}
          {shown.map((r) => (
            <button key={r.full_name} className="repo-pick" disabled={!!busy} onClick={() => link(r.full_name)}>
              {r.private ? <Lock size={15} /> : <FolderGit2 size={15} />}
              <span className="rp-main">
                <span className="rp-name">{r.full_name}{r.archived && <span className="kind">archived</span>}{r.fork && <span className="kind">fork</span>}</span>
                {r.description && <span className="rp-desc ellipsis">{r.description}</span>}
              </span>
              <span className="rp-meta">{busy === r.full_name ? <Loader2 size={15} className="spin" /> : isLinked(r) ? <span className="kind ok">linked</span> : relTime(r.pushed_at)}</span>
            </button>
          ))}
          {gh?.connected && all && !shown.length && !looksLikeRepo && <div className="hint" style={{ padding: 14 }}>{loadError ?? (q ? `No repos match "${q}".` : "No repositories on this account.")}</div>}
        </div>
        {busy && <div className="hint repo-busy"><Loader2 size={14} className="spin" /> Cloning {busy}… big repos can take a minute.</div>}
        {error && <div className="banner bad">{error}</div>}
        <div className="repo-scope">
          <span className="hint">Link to</span>
          {projectId && (
            <button className={`seg ${scope === "project" ? "on" : ""}`} onClick={() => setScope("project")} disabled={!!busy}>
              The whole project{project ? ` (${project.name})` : ""}
            </button>
          )}
          <button className={`seg ${scope === "chat" ? "on" : ""}`} onClick={() => setScope("chat")} disabled={!!busy || (!chatId && !ensureChat)}>
            This chat only
          </button>
        </div>
      </div>
    </div>
  );
}

/** The repo pill in the chat bar: which repos this chat works on, switch, link, unlink. */
export function RepoComposerMenu({ chatId, projectId, ensureChat, iconOnly }: { chatId?: string; projectId?: string; ensureChat: () => Promise<string>; iconOnly?: boolean }) {
  const { state, go } = useApp();
  const { repos, active, reload } = useRepos({ chatId, projectId });
  const [open, setOpen] = useState(false);
  const [linking, setLinking] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const gh = state?.github;
  const choose = async (r: RepoStatus) => {
    if (chatId) await api.put(`/chats/${chatId}/active-repo`, { path: r.path });
    setOpen(false);
    reload();
  };
  const unlink = async (r: RepoStatus) => {
    const where = r.scope === "project" ? "this project (every chat in it)" : "this chat";
    if (!confirm(`Unlink ${r.name} from ${where}? The folder stays on your computer.`)) return;
    await api.post("/repos/unlink", { path: r.path, chatId, projectId: r.scope === "project" ? projectId : undefined });
    reload();
  };
  return (
    <div className="model-menu" ref={ref}>
      {iconOnly ? (
        <button className={`icon-btn sm gh-btn ${gh?.connected ? "connected" : ""} ${open ? "on" : ""}`} onClick={() => setOpen((o) => !o)} aria-label="Repositories" title={gh?.connected ? `GitHub connected${gh.account ? ` as ${gh.account}` : ""}. Repositories for this chat` : "Link a repository or connect GitHub"}>
          <Github size={17} />
          {gh?.connected && <span className="gh-dot" />}
        </button>
      ) : (
        <button className={`pill ${active ? "on" : ""}`} onClick={() => setOpen((o) => !o)} title={active ? `Working on ${active.name} (${active.path})` : "Link a repository to this chat"}>
          <FolderGit2 size={15} /> <span className="ellipsis pill-label">{active?.name ?? "Repo"}</span>
        </button>
      )}
      {open && (
        <div className="menu repo-menu" style={{ left: 0 }}>
          {!!repos.length && <div className="grp">Working on</div>}
          {repos.map((r) => (
            <div key={r.path} className={`repo-item ${r.active ? "active" : ""}`}>
              <button onClick={() => choose(r)} title={r.path}>
                <FolderGit2 size={15} />
                <span className="ri-text">
                  <span className="ellipsis">{r.name}</span>
                  <span className="ri-sub"><RepoState r={r} compact /> · {r.scope === "project" ? "project" : "this chat"}</span>
                </span>
                {r.active && <Check size={14} />}
              </button>
              <button className="icon-btn sm" title="Show folder" onClick={() => revealFile(r.path)}><FolderOpen size={14} /></button>
              <button className="icon-btn sm" title="Unlink" onClick={() => unlink(r)}><Unlink size={14} /></button>
            </div>
          ))}
          {!!repos.length && <div className="sep" />}
          <button onClick={() => { setOpen(false); setLinking(true); }}><Plus size={15} /> Link a {gh?.connected ? "GitHub " : ""}repo…</button>
          {!gh?.connected && <button onClick={() => { setOpen(false); go({ kind: "connectors" }); }}><Github size={15} /> Connect GitHub</button>}
          {gh?.connected && <div className="hint menu-foot"><Github size={12} /> {gh.account ?? "GitHub connected"}</div>}
        </div>
      )}
      {linking && <RepoLinkModal projectId={projectId} chatId={chatId} ensureChat={ensureChat} onClose={() => setLinking(false)} onLinked={() => reload()} />}
    </div>
  );
}

/** The chat's active repo at the top of the chat: name, branch, changes; pull or open it. */
export function ActiveRepoChip({ chatId, projectId }: { chatId?: string; projectId?: string }) {
  const { active, reload } = useRepos({ chatId, projectId });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const ref = useOutside(open, () => setOpen(false));
  if (!active) return null;
  const run = async (what: "pull" | "push") => {
    setBusy(true);
    setMsg(undefined);
    try {
      const r = await api.post<{ output: string }>(`/repos/${what}`, { path: active.path });
      setMsg(r.output.split("\n").slice(-2).join(" ") || (what === "pull" ? "Up to date." : "Pushed."));
    } catch (e) {
      setMsg((e as Error).message);
    }
    setBusy(false);
    reload();
  };
  return (
    <div className="model-menu" ref={ref}>
      <button className="pill repo-chip" onClick={() => setOpen((o) => !o)} title={`${active.url}\n${active.path}`}>
        <FolderGit2 size={15} /> <b className="ellipsis">{active.name}</b> <RepoState r={active} compact />
      </button>
      {open && (
        <div className="menu repo-menu" style={{ right: 0, left: "auto", top: 40, bottom: "auto" }}>
          <div className="repo-card">
            <div className="rc-name"><FolderGit2 size={16} /> {active.name}</div>
            <RepoState r={active} />
            <code className="rc-path" title={active.path}>{active.path}</code>
          </div>
          <button onClick={() => run("pull")} disabled={busy}>{busy ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} Pull latest{active.behind ? ` (${active.behind} new)` : ""}</button>
          {(!!active.ahead || !active.upstream) && <button onClick={() => run("push")} disabled={busy}><Upload size={15} /> Push {active.ahead ? `${active.ahead} commit${active.ahead === 1 ? "" : "s"}` : "branch"}</button>}
          <button onClick={() => revealFile(active.path)}><FolderOpen size={15} /> Show folder</button>
          <a className="menu-link" href={active.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Open on GitHub</a>
          {msg && <div className="hint menu-foot">{msg}</div>}
        </div>
      )}
    </div>
  );
}

/** A project's repos on its page: status, pull, show, unlink, and Link repo. */
export function ProjectRepos({ projectId }: { projectId: string }) {
  const { repos, reload } = useRepos({ projectId });
  const [linking, setLinking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const pull = async (r: RepoStatus, what: "pull" | "push" = "pull") => {
    setBusy(r.path);
    try {
      const out = await api.post<{ output: string }>(`/repos/${what}`, { path: r.path });
      setMsg((m) => ({ ...m, [r.path]: out.output.split("\n").slice(-1)[0] || (what === "pull" ? "Up to date." : "Pushed.") }));
    } catch (e) {
      setMsg((m) => ({ ...m, [r.path]: (e as Error).message }));
    }
    setBusy(null);
    reload();
  };
  const unlink = async (r: RepoStatus) => {
    if (!confirm(`Unlink ${r.name} from this project? The folder stays on your computer.`)) return;
    await api.post("/repos/unlink", { path: r.path, projectId });
    reload();
  };
  const own = repos.filter((r) => r.scope === "project");
  return (
    <div className="proj-repos">
      <div className="proj-repos-head">
        <FolderGit2 size={16} /> <span className="hint">Repositories</span>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={() => setLinking(true)}><Plus size={14} /> Link repo</button>
      </div>
      {!own.length && <div className="hint" style={{ padding: "2px 2px 8px" }}>No repos yet. Link one and every chat in this project can work on it, pull, commit and push.</div>}
      {own.map((r) => (
        <div key={r.path} className="repo-row">
          <FolderGit2 size={16} />
          <a href={r.url} target="_blank" rel="noreferrer" className="name">{r.name}</a>
          <RepoState r={r} />
          <code className="hint ellipsis" title={r.path}>{msg[r.path] ?? r.path}</code>
          <button className="btn ghost sm" disabled={busy === r.path} onClick={() => pull(r)}>{busy === r.path ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Pull</button>
          {!!r.ahead && <button className="btn ghost sm" disabled={busy === r.path} onClick={() => pull(r, "push")}><Upload size={14} /> Push</button>}
          <button className="btn ghost sm" onClick={() => revealFile(r.path)}><FolderOpen size={14} /> Show</button>
          <button className="icon-btn sm" title="Unlink" onClick={() => unlink(r)}><Unlink size={14} /></button>
        </div>
      ))}
      {linking && <RepoLinkModal projectId={projectId} onClose={() => setLinking(false)} onLinked={() => reload()} />}
    </div>
  );
}

export { same as samePath };

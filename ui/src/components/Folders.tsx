// Folders on this computer in the interface: link one to a chat or a project (threads use their
// project's and coordinator's folders), choose read-only or read and write, show it, unlink it.
import { useEffect, useState } from "react";
import { Eye, Folder, FolderOpen, FolderPlus, Loader2, Lock, PenLine, Plus, Unlink, X } from "lucide-react";
import { api, type FolderLink } from "../api";
import { useApp } from "../App";
import { revealFile } from "./FilePreview";
import { useOutside } from "./Repos";

const scopeLabel = (f: FolderLink) => (f.scope === "chat" ? "this chat" : f.scope === "coordinator" ? "coordinator" : "project");

/** The folders a chat (with its coordinator and project) or a project can use, kept fresh. */
export function useFolders(target: { chatId?: string; projectId?: string }) {
  const { state } = useApp();
  const [folders, setFolders] = useState<FolderLink[]>([]);
  const key = `${target.chatId ?? ""}|${target.projectId ?? ""}`;
  const reload = async () => {
    if (!target.chatId && !target.projectId) return setFolders([]);
    const q = new URLSearchParams();
    if (target.chatId) q.set("chatId", target.chatId);
    if (target.projectId) q.set("projectId", target.projectId);
    setFolders(await api.get<FolderLink[]>(`/folders?${q}`).catch(() => []));
  };
  // `state` changes whenever the server says chats changed, which linking does.
  useEffect(() => {
    reload();
  }, [key, state]);
  return { folders, reload };
}

/** Pick a folder (the system picker in the desktop app, or a typed path) and link it. */
export function FolderLinkModal({ projectId, chatId, ensureChat, onClose, onLinked, projectOnly }: { projectId?: string; chatId?: string; ensureChat?: () => Promise<string>; onClose: () => void; onLinked?: () => void; projectOnly?: boolean }) {
  const { state } = useApp();
  const project = state?.projects.find((p) => p.id === projectId);
  const [path, setPath] = useState("");
  const [access, setAccess] = useState<"write" | "read">("write");
  const [scope, setScope] = useState<"project" | "chat">(projectOnly || (projectId && !chatId && !ensureChat) ? "project" : "chat");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [canPick, setCanPick] = useState(true);
  const [error, setError] = useState<string>();

  const pick = async () => {
    setPicking(true);
    setError(undefined);
    try {
      const r = await api.post<{ supported: boolean; path: string | null }>("/folders/pick", {});
      if (!r.supported) setCanPick(false);
      if (r.path) setPath(r.path);
    } catch (e) {
      setError((e as Error).message);
    }
    setPicking(false);
  };

  const link = async () => {
    if (!path.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const cid = scope === "chat" ? chatId ?? (await ensureChat?.()) : undefined;
      await api.post("/folders/link", { path: path.trim(), access, ...(scope === "project" ? { projectId } : { chatId: cid }) });
      onLinked?.();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="scrim" onClick={() => !busy && onClose()}>
      <div className="modal repo-modal folder-modal" onClick={(e) => e.stopPropagation()}>
        <div className="repo-modal-head">
          <h3>Link a folder</h3>
          <button className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close"><X size={18} /></button>
        </div>
        <p className="hint">Syph can read the files in this folder and, if you allow it, change them and run terminal commands there. Nothing else on your computer is reachable.</p>
        <div className="folder-path">
          <Folder size={16} />
          <input autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder={navigator.userAgent.includes("Windows") ? "C:\\Users\\you\\Documents\\My project" : "/Users/you/Documents/My project"} onKeyDown={(e) => e.key === "Enter" && link()} spellCheck={false} />
          {canPick && <button className="btn tonal sm" onClick={pick} disabled={picking || busy}>{picking ? <Loader2 size={14} className="spin" /> : <FolderOpen size={14} />} Browse…</button>}
        </div>
        <div className="repo-scope">
          <span className="hint">Syph may</span>
          <button className={`seg ${access === "write" ? "on" : ""}`} onClick={() => setAccess("write")} disabled={busy}><PenLine size={13} /> Read, write and run commands</button>
          <button className={`seg ${access === "read" ? "on" : ""}`} onClick={() => setAccess("read")} disabled={busy}><Eye size={13} /> Only read</button>
        </div>
        {!projectOnly && (
          <div className="repo-scope">
            <span className="hint">Link to</span>
            {projectId && (
              <button className={`seg ${scope === "project" ? "on" : ""}`} onClick={() => setScope("project")} disabled={busy}>
                The whole project{project ? ` (${project.name})` : ""}
              </button>
            )}
            <button className={`seg ${scope === "chat" ? "on" : ""}`} onClick={() => setScope("chat")} disabled={busy || (!chatId && !ensureChat)}>
              This chat{projectId ? " and its threads" : ""}
            </button>
          </div>
        )}
        {error && <div className="banner bad">{error}</div>}
        <div className="folder-actions">
          <button className="btn ghost sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary sm" onClick={link} disabled={busy || !path.trim()}>{busy ? <Loader2 size={14} className="spin" /> : <FolderPlus size={14} />} Link folder</button>
        </div>
      </div>
    </div>
  );
}

/** One linked folder: name, path, access, show, unlink. */
function FolderRow({ f, chatId, projectId, reload, compact }: { f: FolderLink; chatId?: string; projectId?: string; reload: () => void; compact?: boolean }) {
  const { state } = useApp();
  const owner = f.scope === "chat" ? { chatId } : f.scope === "project" ? { projectId } : { chatId: state?.chats.find((c) => c.id === chatId)?.parentId };
  const unlink = async () => {
    const where = f.scope === "chat" ? "this chat" : f.scope === "project" ? "this project (every chat and thread in it)" : "the project's coordinator and its threads";
    if (!confirm(`Unlink ${f.name} from ${where}? Syph won't reach it any more. The folder stays on your computer.`)) return;
    await api.post("/folders/unlink", { path: f.path, ...owner });
    reload();
  };
  const toggle = async () => {
    await api.post("/folders/access", { path: f.path, access: f.access === "write" ? "read" : "write", ...owner });
    reload();
  };
  return (
    <div className={`folder-row ${compact ? "compact" : ""}`}>
      <Folder size={15} />
      <span className="fr-text">
        <span className="ellipsis fr-name">{f.name}{!f.exists && <span className="kind bad">missing</span>}</span>
        <code className="fr-path ellipsis" title={f.path}>{f.path}</code>
      </span>
      <button className={`kind fr-access ${f.access}`} onClick={toggle} title={f.access === "write" ? "Syph can read, change files and run commands here. Click to make it read-only." : "Syph can only read here. Click to allow writing and commands."}>
        {f.access === "write" ? <><PenLine size={11} /> read & write</> : <><Lock size={11} /> read only</>}
      </button>
      {compact && <span className="hint fr-scope">{scopeLabel(f)}</span>}
      <button className="icon-btn sm" title="Show folder" onClick={() => revealFile(f.path)}><FolderOpen size={14} /></button>
      <button className="icon-btn sm" title="Unlink" onClick={unlink}><Unlink size={14} /></button>
    </div>
  );
}

/** The folder button under the message box: the chat's folders, and Link a folder. */
export function FolderComposerMenu({ chatId, projectId, ensureChat }: { chatId?: string; projectId?: string; ensureChat: () => Promise<string> }) {
  const { folders, reload } = useFolders({ chatId, projectId });
  const [open, setOpen] = useState(false);
  const [linking, setLinking] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  return (
    <div className="model-menu" ref={ref}>
      <button className={`icon-btn sm folder-btn ${folders.length ? "connected" : ""} ${open ? "on" : ""}`} onClick={() => setOpen((o) => !o)} aria-label="Folders" title={folders.length ? `${folders.length} folder${folders.length === 1 ? "" : "s"} on this computer linked` : "Link a folder on this computer"}>
        <Folder size={17} />
        {!!folders.length && <span className="gh-dot" />}
      </button>
      {open && (
        <div className="menu repo-menu folder-menu" style={{ left: 0 }}>
          {!!folders.length && <div className="grp">Folders Syph can use</div>}
          {folders.map((f) => <FolderRow key={f.path} f={f} chatId={chatId} projectId={projectId} reload={reload} compact />)}
          {!folders.length && <div className="hint menu-foot">No folder linked. Syph only sees its own workspace.</div>}
          <div className="sep" />
          <button onClick={() => { setOpen(false); setLinking(true); }}><Plus size={15} /> Link a folder…</button>
        </div>
      )}
      {linking && <FolderLinkModal projectId={projectId} chatId={chatId} ensureChat={ensureChat} onClose={() => setLinking(false)} onLinked={reload} />}
    </div>
  );
}

/** A project's folders on its Settings page. Every chat and thread in the project can use them. */
export function ProjectFolders({ projectId }: { projectId: string }) {
  const { folders, reload } = useFolders({ projectId });
  const [linking, setLinking] = useState(false);
  return (
    <div className="proj-repos">
      <div className="proj-repos-head">
        <Folder size={16} /> <span className="hint">Folders on this computer</span>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={() => setLinking(true)}><Plus size={14} /> Link folder</button>
      </div>
      {!folders.length && <div className="hint" style={{ padding: "2px 2px 8px" }}>No folders yet. Link one and the coordinator and every thread in this project can read it, and with write access change files and run commands in it.</div>}
      {folders.map((f) => <FolderRow key={f.path} f={f} projectId={projectId} reload={reload} />)}
      {linking && <FolderLinkModal projectId={projectId} projectOnly onClose={() => setLinking(false)} onLinked={reload} />}
    </div>
  );
}

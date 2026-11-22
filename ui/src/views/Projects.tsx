import { useEffect, useState } from "react";
import { ArrowLeft, Clock, Eye, FolderClosed, FolderOpen, MessageSquare, Plus, Trash2 } from "lucide-react";
import { useApp } from "../App";
import { api, relTime, type Project, type ProjectDetail } from "../api";
import { FileIcon, FileActions, revealFile } from "../components/FilePreview";
import { Slot } from "../ext";
import { ProjectRepos } from "../components/Repos";

export function ProjectsView({ projectId }: { projectId?: string }) {
  const { state, go, refresh } = useApp();
  const [creating, setCreating] = useState(false);
  if (projectId) return <ProjectDetailView id={projectId} />;
  const projects = state?.projects ?? [];

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h2>Projects</h2>
            <p>Each project has its own instructions, files, memory and tasks.</p>
          </div>
          <div className="spacer" />
          <button className="btn primary" onClick={() => setCreating(true)}><Plus size={18} /> New project</button>
        </div>
        {projects.length === 0 && <div className="empty card">No projects yet. A project keeps related chats, files and scheduled tasks together, with its own instructions.</div>}
        <div className="grid">
          {projects.map((p) => (
            <button key={p.id} className="card click" onClick={() => go({ kind: "projects", projectId: p.id })}>
              <div className="proj-ic" style={{ background: `color-mix(in srgb, ${p.color} 20%, transparent)`, color: p.color }}><FolderClosed size={20} /></div>
              <h3>{p.name}</h3>
              <p>{p.description || "No description"}</p>
              <div className="meta">
                <span><MessageSquare size={13} /> {p.chatCount ?? 0}</span>
                <span><Clock size={13} /> {p.taskCount ?? 0}</span>
                <span style={{ marginLeft: "auto" }}>{relTime(p.updatedAt)}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
      {creating && (
        <NewProject
          close={() => setCreating(false)}
          created={async (p) => {
            setCreating(false);
            await refresh();
            go({ kind: "projects", projectId: p.id });
          }}
        />
      )}
    </div>
  );
}

function NewProject({ close, created }: { close: () => void; created: (p: Project) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const save = async () => name.trim() && created(await api.post<Project>("/projects", { name: name.trim(), description, instructions }));
  return (
    <div className="scrim" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New project</h3>
        <div className="field"><label>Name</label><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label>Description</label><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        <div className="field"><label>Instructions</label><textarea className="input" value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Added to the system prompt for every chat and task in this project." /></div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={!name.trim()}>Create</button>
        </div>
      </div>
    </div>
  );
}

function ProjectDetailView({ id }: { id: string }) {
  const { go, refresh, tick, state, showFile } = useApp();
  const [p, setP] = useState<ProjectDetail | null>(null);
  const [tab, setTab] = useState<"chats" | "instructions" | "files" | "tasks">("chats");
  const [instructions, setInstructions] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get<ProjectDetail>(`/projects/${id}`).then((d) => {
      setP(d);
      setInstructions(d.instructions);
    }).catch(() => go({ kind: "projects" }));
  }, [id, tick, state]);

  if (!p) return null;
  const sep = p.folder.includes("\\") ? "\\" : "/";
  const abs = (rel: string) => p.folder + sep + rel.split("/").join(sep);
  const save = async () => {
    await api.put(`/projects/${id}`, { instructions });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  const remove = async () => {
    if (!confirm(`Delete project "${p.name}" and its files? Chats are kept.`)) return;
    await api.del(`/projects/${id}`);
    await refresh();
    go({ kind: "projects" });
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <button className="icon-btn" onClick={() => go({ kind: "projects" })} aria-label="Back"><ArrowLeft size={20} /></button>
          <div className="proj-ic" style={{ background: `color-mix(in srgb, ${p.color} 20%, transparent)`, color: p.color }}><FolderClosed size={20} /></div>
          <div style={{ minWidth: 0 }}>
            <h2>{p.name}</h2>
            <p>{p.description}</p>
          </div>
          <div className="spacer" />
          <Slot name="project.header" ctx={{ projectId: id }} variant="btn" />
          <button className="icon-btn" onClick={remove} aria-label="Delete project"><Trash2 size={18} /></button>
          <button className="btn primary" onClick={() => go({ kind: "chat", projectId: id })}><Plus size={18} /> New chat</button>
        </div>

        <div className="proj-folder">
          <FolderOpen size={16} />
          <span className="hint">Folder</span>
          <code title={p.folder}>{p.folder}</code>
          <button className="btn ghost sm" onClick={() => revealFile(p.folder)}>Open folder</button>
        </div>
        <ProjectRepos projectId={id} />

        <div className="tabs">
          {(["chats", "instructions", "files", "tasks"] as const).map((t) => (
            <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
          ))}
        </div>

        {tab === "chats" && (
          <div className="list">
            {p.chats.length === 0 && <div className="empty">No chats yet.</div>}
            {p.chats.map((c) => (
              <button key={c.id} className="row" style={{ gridTemplateColumns: "1fr auto", width: "100%", textAlign: "left" }} onClick={() => go({ kind: "chat", chatId: c.id })}>
                <span className="name ellipsis">{c.title}</span>
                <span className="sub">{relTime(c.updatedAt)}</span>
              </button>
            ))}
          </div>
        )}

        {tab === "instructions" && (
          <div style={{ maxWidth: 720 }}>
            <div className="field">
              <label>Project instructions</label>
              <textarea className="input" value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={10} />
              <span className="hint">Added to the system prompt for every chat and task in this project. Syph may propose edits in Evolve.</span>
            </div>
            <button className="btn primary sm" onClick={save}>{saved ? "Saved" : "Save"}</button>
          </div>
        )}

        {tab === "files" && (
          <>
            <p className="hint" style={{ marginTop: -8, marginBottom: 14 }}>Syph's file tools work inside this project's folder. Drop files there to share them. Click a file to preview it.</p>
            <div className="list">
              {p.files.length === 0 && <div className="empty">No files yet.</div>}
              {p.files.slice(0, 500).map((f) => (
                <div key={f} className="row file-row" style={{ gridTemplateColumns: "20px 1fr auto" }} onClick={() => showFile(abs(f))} role="button" tabIndex={0}>
                  <span style={{ color: "var(--muted)", display: "flex" }}><FileIcon name={f} size={16} /></span>
                  <span className="cron ellipsis" title={abs(f)}>{f}</span>
                  <span className="file-btns" onClick={(e) => e.stopPropagation()}>
                    <button className="btn ghost sm" onClick={() => showFile(abs(f))}><Eye size={14} /></button>
                    <FileActions path={abs(f)} compact />
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === "tasks" && (
          <div className="list">
            {p.tasks.length === 0 && <div className="empty">No tasks in this project. Create one in Tasks.</div>}
            {p.tasks.map((t) => (
              <div key={t.id} className="row" style={{ gridTemplateColumns: "1fr 160px 160px" }}>
                <span className="name">{t.name}</span>
                <span className="cron">{t.schedule}</span>
                <span className="stat"><span className={`status-dot ${t.lastStatus}`} /> {t.lastRun ? relTime(t.lastRun) : "Never run"}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

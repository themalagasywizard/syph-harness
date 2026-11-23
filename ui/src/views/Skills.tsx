import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Copy, Dna, Plus, Search, Sparkles, Trash2, X } from "lucide-react";
import { useApp } from "../App";
import { Toggle } from "../components/Toggle";
import { api, relTime, type Proposal, type SkillAudit, type SkillInfo } from "../api";

const TIDY_PROMPT = "Review my skills: find duplicates, skills that contradict each other and ones that aren't useful, then propose merging, switching off or deleting them.";
const BY = { agent: "Syph, from a chat", reflector: "Evolve", user: "you", default: "Syph's defaults" } as const;

type Filter = "all" | "on" | "off";

/** A snackbar with Undo: every change here is a proposal, so undo is a rollback. */
function useUndo(reload: () => void) {
  const [toast, setToast] = useState<{ text: string; id: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = (text: string, p: Proposal) => {
    clearTimeout(timer.current);
    setToast({ text, id: p.id });
    timer.current = setTimeout(() => setToast(null), 8000);
  };
  const undo = async () => {
    if (!toast) return;
    setToast(null);
    try {
      await api.post(`/proposals/${toast.id}/rollback`);
    } catch (e) {
      alert((e as Error).message);
    }
    reload();
  };
  const el = toast && (
    <div className="snackbar" role="status">
      <span>{toast.text}</span>
      <button className="link-btn" onClick={undo}>Undo</button>
      <button className="icon-btn sm" aria-label="Dismiss" onClick={() => setToast(null)}><X size={14} /></button>
    </div>
  );
  return { show, el };
}

export function SkillsView({ name }: { name?: string }) {
  const { go, tick, refresh } = useApp();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [audit, setAudit] = useState<SkillAudit | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<SkillInfo | "new" | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = () =>
    api.get<{ skills: SkillInfo[]; audit: SkillAudit }>("/skills").then((r) => {
      setSkills(r.skills);
      setAudit(r.audit);
      setLoaded(true);
    });
  const reload = () => {
    load();
    refresh();
  };
  const { show, el: snackbar } = useUndo(reload);
  useEffect(() => void load(), [tick]);
  // #/skills/<name> opens that skill.
  useEffect(() => {
    if (name && loaded) {
      const s = skills.find((x) => x.name === name || x.dir === name);
      if (s) setEditing(s);
    }
  }, [name, loaded]);

  const setActive = async (s: SkillInfo, active: boolean) => {
    setSkills((all) => all.map((x) => (x.name === s.name ? { ...x, active } : x)));
    try {
      const p = await api.put<Proposal>(`/skills/${encodeURIComponent(s.dir)}`, { active });
      show(`${active ? "Turned on" : "Turned off"} ${s.name}.`, p);
    } catch (e) {
      alert((e as Error).message);
    }
    reload();
  };

  const counts = { all: skills.length, on: skills.filter((s) => s.active).length, off: skills.filter((s) => !s.active).length };
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => (filter === "all" || (filter === "on") === s.active) && (!q || `${s.name} ${s.description} ${s.body}`.toLowerCase().includes(q)));
  }, [skills, filter, query]);
  const flagged = audit && audit.duplicates.length + audit.unused.length + audit.empty.length > 0;
  const byName = (n: string) => skills.find((s) => s.name === n);
  const ask = (draft: string) => go({ kind: "chat", draft, send: true });

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h2>Skills</h2>
            <p>Step-by-step instructions Syph loads when a job calls for one. Switch off what doesn't help, edit or delete it. Every change is kept in Evolve, so you can undo it.</p>
          </div>
          <div className="spacer" />
          <button className="btn tonal" onClick={() => ask(TIDY_PROMPT)} title="Syph reviews every skill and proposes merges and removals for you to approve in Evolve"><Sparkles size={18} /> Ask Syph to tidy</button>
          <button className="btn primary" onClick={() => setEditing("new")}><Plus size={18} /> New skill</button>
        </div>

        {flagged && (
          <div className="skill-audit card">
            <h3>Worth a look</h3>
            {audit!.duplicates.map((d) => (
              <div key={d.skills.join("+")} className="audit-row">
                <Copy size={15} />
                <span className="grow">
                  {d.skills.map((n, i) => (
                    <span key={n}>{i > 0 && " and "}<button className="link-btn" onClick={() => byName(n) && setEditing(byName(n)!)}>{n}</button></span>
                  ))}{" "}
                  look alike ({Math.round(d.similarity * 100)}% overlap).
                </span>
                <button className="btn ghost sm" onClick={() => ask(`Compare the skills ${d.skills.join(" and ")}. If they do the same job or contradict each other, propose merging them into one skill (propose_skill with replaces) and keep the better steps.`)}>Ask Syph to merge</button>
              </div>
            ))}
            {audit!.unused.map((u) => (
              <div key={u.name} className="audit-row">
                <BookOpen size={15} />
                <span className="grow"><button className="link-btn" onClick={() => byName(u.name) && setEditing(byName(u.name)!)}>{u.name}</button> hasn't been used in {u.ageDays} days.</span>
                <button className="btn ghost sm" onClick={() => byName(u.name) && setActive(byName(u.name)!, false)}>Turn off</button>
              </div>
            ))}
            {audit!.empty.map((n) => (
              <div key={n} className="audit-row">
                <BookOpen size={15} />
                <span className="grow"><button className="link-btn" onClick={() => byName(n) && setEditing(byName(n)!)}>{n}</button> is too short to help.</span>
              </div>
            ))}
          </div>
        )}

        <div className="skills-bar">
          <div className="tabs">
            {(["all", "on", "off"] as const).map((f) => (
              <button key={f} className={`tab ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>{f === "all" ? "All" : f === "on" ? "On" : "Off"} ({counts[f]})</button>
            ))}
          </div>
          <label className="skills-search">
            <Search size={15} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search skills" aria-label="Search skills" />
          </label>
        </div>

        {loaded && shown.length === 0 ? (
          <div className="empty card">{skills.length ? "No skills match." : "No skills yet. Syph proposes them as it learns, or you can write one."}</div>
        ) : (
          <div className="list skills-list">
            {shown.map((s) => (
              <div key={s.dir} className={`skill-row ${s.active ? "" : "off"}`} onClick={() => setEditing(s)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setEditing(s)}>
                <div className="skill-main">
                  <div className="name">
                    {s.name}
                    {!s.active && <span className="kind">Off</span>}
                    {s.pending.length > 0 && <span className="kind pending" title={s.pending.map((p) => p.title).join("\n")}>Change waiting</span>}
                  </div>
                  <div className="sub">{s.description || "No description"}</div>
                  <div className="skill-meta">
                    <span>{s.usage.uses ? `Used ${s.usage.uses}×${s.usage.lastUsed ? `, last ${relTime(s.usage.lastUsed)}` : ""}` : "Not used yet"}</span>
                    {s.versions > 1 && <span>{s.versions} versions</span>}
                    {s.changedAt && <span>Changed {relTime(s.changedAt)}</span>}
                    {s.createdBy && <span>Made by {BY[s.createdBy]}</span>}
                  </div>
                </div>
                <span onClick={(e) => e.stopPropagation()}><Toggle on={s.active} onChange={(v) => setActive(s, v)} label={`${s.active ? "Turn off" : "Turn on"} ${s.name}`} /></span>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <SkillModal
          skill={editing === "new" ? null : editing}
          close={() => {
            setEditing(null);
            if (name) go({ kind: "skills" });
          }}
          done={(text, p) => {
            setEditing(null);
            if (name) go({ kind: "skills" });
            if (text && p) show(text, p);
            reload();
          }}
        />
      )}
      {snackbar}
    </div>
  );
}

function SkillModal({ skill, close, done }: { skill: SkillInfo | null; close: () => void; done: (text?: string, p?: Proposal) => void }) {
  const { go } = useApp();
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [body, setBody] = useState(skill?.body ?? "");
  const [active, setActive] = useState(skill?.active ?? true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const changed = !skill || description !== skill.description || body.trim() !== skill.body.trim() || active !== skill.active;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };
  const save = () =>
    run(async () => {
      if (!skill) {
        const p = await api.post<Proposal>("/skills", { name, description, body });
        return done(`Added ${p.title.replace(/^Add skill /, "")}.`, p);
      }
      if (!changed) return done();
      const edited = description !== skill.description || body.trim() !== skill.body.trim();
      const p = await api.put<Proposal>(`/skills/${encodeURIComponent(skill.dir)}`, edited ? { description, body, active } : { active });
      done(`Saved ${skill.name}.`, p);
    });
  const remove = () =>
    run(async () => {
      const p = await api.del<Proposal>(`/skills/${encodeURIComponent(skill!.dir)}`);
      done(`Deleted ${skill!.name}.`, p);
    });

  return (
    <div className="scrim" onClick={close}>
      <div className="modal skill-modal" onClick={(e) => e.stopPropagation()}>
        <div className="skill-modal-head">
          <h3>{skill ? skill.name : "New skill"}</h3>
          {skill && (
            <label className="skill-onoff">
              <span>{active ? "On" : "Off"}</span>
              <Toggle on={active} onChange={setActive} label={active ? "Turn off" : "Turn on"} />
            </label>
          )}
        </div>
        {skill?.pending.length ? (
          <div className="banner warn-note">
            Syph has a change to this skill waiting in Evolve ({skill.pending[0].title}). If you save here, that proposal will need to be made again. <button className="link-btn" onClick={() => go({ kind: "evolve" })}>Open Evolve</button>
          </div>
        ) : null}
        {!skill && (
          <div className="field">
            <label>Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-"))} placeholder="weekly-report" autoFocus />
          </div>
        )}
        <div className="field">
          <label>When to use it</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Use when the user asks for the weekly report." />
          <span className="hint">This line is all Syph sees until it opens the skill, so say when it applies.</span>
        </div>
        <div className="field">
          <label>Steps</label>
          <textarea className="input skill-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder={"1. …\n2. …\n3. Check the result with a tool before saying it's done."} spellCheck={false} />
        </div>
        {skill && skill.files.length > 1 && <div className="hint">Also in this skill's folder: {skill.files.filter((f) => !f.endsWith("/SKILL.md")).map((f) => f.split("/").slice(2).join("/")).join(", ")}</div>}
        {skill && (
          <div className="hint">
            {skill.versions} version{skill.versions === 1 ? "" : "s"}
            {skill.createdBy ? ` · made by ${BY[skill.createdBy]}` : ""} · <button className="link-btn" onClick={() => go({ kind: "evolve" })}><Dna size={12} style={{ verticalAlign: -1 }} /> History in Evolve</button>
          </div>
        )}
        {err && <div className="error-text" style={{ marginTop: 10 }}>{err}</div>}
        <div className="modal-foot">
          {skill &&
            (confirmDelete ? (
              <span className="confirm-del">
                Delete {skill.name}?
                <button className="btn ghost sm" onClick={() => setConfirmDelete(false)}>Keep</button>
                <button className="btn sm danger-solid" disabled={busy} onClick={remove}><Trash2 size={14} /> Delete</button>
              </span>
            ) : (
              <button className="btn ghost danger" style={{ marginRight: "auto" }} onClick={() => setConfirmDelete(true)}><Trash2 size={16} /> Delete</button>
            ))}
          {!confirmDelete && (
            <>
              <button className="btn ghost" onClick={close}>Cancel</button>
              <button className="btn primary" disabled={busy || !changed || (!skill && (!name || !description.trim()))} onClick={save}>{skill ? "Save" : "Add skill"}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

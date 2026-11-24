import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, CircleCheck, Circle, Flag, Loader2, MessageSquare, Play, Plus, Trash2 } from "lucide-react";
import { Toggle } from "../components/Toggle";
import { ModelPicker } from "../components/ModelPicker";
import { describeCron } from "../cron";
import { useApp } from "../App";
import { api, relTime, type OngoingContract, type Task } from "../api";

const readOpen = () => {
  try {
    return localStorage.getItem("syph.contractsOpen") !== "0";
  } catch {
    return true;
  }
};

/** Long tasks with an approved contract: what they promise and how far they've got. Folds away. */
function OngoingContracts() {
  const { tick, go } = useApp();
  const [items, setItems] = useState<OngoingContract[]>([]);
  const [open, setOpen] = useState(readOpen);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    const load = () => api.get<OngoingContract[]>("/contracts").then(setItems).catch(() => {});
    load();
    const i = setInterval(load, 15_000);
    return () => clearInterval(i);
  }, [tick]);
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem("syph.contractsOpen", o ? "0" : "1");
      } catch {}
      return !o;
    });
  };
  if (!items.length) return null;
  return (
    <div className="ongoing">
      <button className="ongoing-head" onClick={toggle} aria-expanded={open}>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <Flag size={15} /> <span>Ongoing contracts</span> <span className="count">{items.length}</span>
        {items.some((x) => x.running) && <span className="hint">{items.filter((x) => x.running).length} running</span>}
      </button>
      {open && (
        <div className="list">
          {items.map((x) => {
            const c = x.progress.contract!;
            const isOpen = expanded === x.chatId;
            return (
              <div key={x.chatId} className="ongoing-item">
                <div className="ongoing-row" onClick={() => setExpanded(isOpen ? null : x.chatId)}>
                  {x.running ? <Loader2 size={15} className="spin" /> : <Flag size={15} />}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="name ellipsis">{c.goal || x.title}</div>
                    <div className="sub ellipsis">
                      {x.running ? "Running" : "Idle"} · {x.progress.done.length} step{x.progress.done.length === 1 ? "" : "s"} done
                      {x.progress.current ? ` · now: ${x.progress.current}` : ""}
                      {x.progress.updatedAt ? ` · ${relTime(x.progress.updatedAt)}` : ""}
                    </div>
                  </div>
                  <button className="icon-btn sm" title="Open the chat" onClick={(e) => { e.stopPropagation(); go({ kind: "chat", chatId: x.chatId }); }}><MessageSquare size={14} /></button>
                </div>
                {isOpen && (
                  <div className="ongoing-body">
                    {c.doneWhen.length > 0 && (
                      <>
                        <div className="hint">Done when</div>
                        <ul>{c.doneWhen.map((d) => <li key={d.text}><Circle size={12} /> {d.text}</li>)}</ul>
                      </>
                    )}
                    {x.progress.done.length > 0 && (
                      <>
                        <div className="hint">Done so far</div>
                        <ul>{x.progress.done.slice(-6).map((d, i) => <li key={i}><CircleCheck size={12} /> {d}</li>)}</ul>
                      </>
                    )}
                    {x.progress.blocked.length > 0 && <div className="hint bad">Blocked: {x.progress.blocked[x.progress.blocked.length - 1]}</div>}
                    {c.scope.length > 0 && <div className="hint">Scope: {c.scope.join(", ")}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const presets = [
  ["Every 30 min", "*/30 * * * *"],
  ["Hourly", "0 * * * *"],
  ["Daily 8:00", "0 8 * * *"],
  ["Weekdays 8:00", "0 8 * * 1-5"],
  ["Sundays 18:00", "0 18 * * 0"],
] as const;

export function TasksView() {
  const { state, tick, go } = useApp();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [editing, setEditing] = useState<Partial<Task> | null>(null);
  const load = () => api.get<Task[]>("/tasks").then(setTasks);
  useEffect(() => {
    load();
    const i = setInterval(load, 30_000);
    return () => clearInterval(i);
  }, [tick]);

  const setEnabled = async (id: string, enabled: boolean) => {
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, enabled } : t)));
    await api.patch(`/tasks/${id}`, { enabled });
    load();
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h2>Tasks</h2>
            <p>Prompts that run on a schedule while Syph is open. Each run is saved as a chat and can become an eval.</p>
          </div>
          <div className="spacer" />
          <button className="btn primary" onClick={() => setEditing({ name: "", prompt: "", schedule: "0 8 * * *", enabled: true })}><Plus size={18} /> New task</button>
        </div>

        <OngoingContracts />

        {tasks.length === 0 ? (
          <div className="empty card">No tasks yet. A task runs a prompt on a schedule, for example a morning digest of a project's notes.</div>
        ) : (
          <div className="list">
            <div className="row head">
              <span>Task</span><span>Schedule</span><span>Last run</span><span>Next run</span><span />
            </div>
            {tasks.map((t) => {
              const proj = state?.projects.find((p) => p.id === t.projectId);
              return (
                <div key={t.id} className="row" style={{ opacity: t.enabled ? 1 : 0.55, cursor: "pointer" }} onClick={() => setEditing(t)}>
                  <div style={{ minWidth: 0 }}>
                    <div className="name">{t.name}</div>
                    <div className="sub">{proj ? `${proj.name} · ` : ""}{(t.model ?? state?.config.defaults.taskModel ?? "").replace(/^openrouter:/, "")}</div>
                  </div>
                  <div>
                    <div className="cron">{t.schedule}</div>
                    <div className="cron-h">{t.scheduleText ?? describeCron(t.schedule)}</div>
                  </div>
                  <span className="stat">
                    <span className={`status-dot ${t.lastStatus}`} />
                    {t.lastStatus === "running" ? "Running…" : t.lastRun ? relTime(t.lastRun) : "Never"}
                    {t.lastChatId && <button className="icon-btn sm" title="Open result" onClick={(e) => { e.stopPropagation(); go({ kind: "chat", chatId: t.lastChatId }); }}><MessageSquare size={14} /></button>}
                  </span>
                  <span className="sub">{t.enabled ? relTime(t.nextRun) || "—" : "Paused"}</span>
                  <span onClick={(e) => e.stopPropagation()}><Toggle on={t.enabled} onChange={(v) => setEnabled(t.id, v)} label={`Enable ${t.name}`} /></span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {editing && <TaskModal task={editing} close={() => setEditing(null)} saved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function TaskModal({ task, close, saved }: { task: Partial<Task>; close: () => void; saved: () => void }) {
  const { state } = useApp();
  const [t, setT] = useState(task);
  const [err, setErr] = useState<string>();
  const set = <K extends keyof Task>(k: K, v: Task[K] | undefined) => setT((x) => ({ ...x, [k]: v }));
  const desc = describeCron(t.schedule ?? "");
  const save = async () => {
    if (!t.name?.trim() || !t.prompt?.trim()) return setErr("Give the task a name and a prompt.");
    if (desc.startsWith("Invalid")) return setErr(desc);
    await api.post("/tasks", t);
    saved();
  };
  const runNow = async () => {
    await api.post(`/tasks/${t.id}/run`);
    saved();
  };
  const remove = async () => {
    await api.del(`/tasks/${t.id}`);
    saved();
  };
  return (
    <div className="scrim" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{task.id ? "Edit task" : "New task"}</h3>
        <div className="field"><label>Name</label><input className="input" value={t.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="Morning digest" /></div>
        <div className="field"><label>Prompt</label><textarea className="input" value={t.prompt ?? ""} onChange={(e) => set("prompt", e.target.value)} placeholder="What should Syph do each time?" /></div>
        <div className="field">
          <label>Schedule</label>
          <input className="input cron" value={t.schedule ?? ""} onChange={(e) => set("schedule", e.target.value)} />
          <span className="hint">{desc}</span>
          <div className="presets">{presets.map(([l, c]) => <button key={c} onClick={() => set("schedule", c)}>{l}</button>)}</div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label>Project</label>
            <select className="input" value={t.projectId ?? ""} onChange={(e) => set("projectId", e.target.value || undefined)}>
              <option value="">None</option>
              {state?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Model</label>
            <ModelPicker value={t.model ?? state?.config.defaults.taskModel} onChange={(m) => set("model", m)} compact={false} up={false} align="left" />
          </div>
        </div>
        {t.projectId && <p className="hint" style={{ marginTop: -4 }}>Each run is a thread of the project's coordinator, which posts a short summary when it ends.</p>}
        {err && <div className="error-text">{err}</div>}
        <div className="modal-foot">
          {task.id && (
            <>
              <button className="icon-btn" onClick={remove} aria-label="Delete task"><Trash2 size={18} /></button>
              <button className="btn ghost" style={{ marginRight: "auto" }} onClick={runNow}><Play size={16} /> Run now</button>
            </>
          )}
          <button className="btn ghost" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

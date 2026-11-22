import { useEffect, useState } from "react";
import { MessageSquare, Play, Plus, Trash2 } from "lucide-react";
import { Toggle } from "../components/Toggle";
import { ModelPicker } from "../components/ModelPicker";
import { describeCron } from "../cron";
import { useApp } from "../App";
import { api, relTime, type Task } from "../api";

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

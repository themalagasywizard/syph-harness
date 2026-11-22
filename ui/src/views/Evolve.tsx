import { useEffect, useMemo, useState } from "react";
import { Check, FlaskConical, Gauge, RotateCcw, Sparkles, TrendingUp, X } from "lucide-react";
import { useApp } from "../App";
import { ModelPicker } from "../components/ModelPicker";
import { api, relTime, type EvalSummary, type Job, type Proposal } from "../api";

function Spark({ data }: { data: number[] }) {
  if (data.length < 2) return <div className="spark-empty">Run evals twice to see a trend.</div>;
  const w = 300, h = 64, min = Math.min(...data) - 0.02, max = Math.max(...data) + 0.02;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / (max - min || 1)) * h]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label="Eval score trend">
      <path d={`${line} L${w},${h} L0,${h} Z`} fill="var(--accent)" fillOpacity="0.08" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Diff({ text }: { text: string }) {
  return (
    <pre className="diff">
      {text.split("\n").filter((l) => !/^(---|\+\+\+|=+$|Index:)/.test(l)).map((l, i) => (
        <div key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : ""}>{l || " "}</div>
      ))}
    </pre>
  );
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function GateLine({ p }: { p: Proposal }) {
  const g = p.gate;
  if (!g) return <span className="delta none">Not measured yet</span>;
  const d = Math.round(g.delta * 1000) / 10;
  return (
    <span className={`delta ${g.passed ? "" : "bad"}`} title={g.notes.join(" ")}>
      <TrendingUp size={14} /> {pct(g.baseline)} → {pct(g.candidate)} ({d >= 0 ? "+" : ""}{d} pts){g.regressions.length ? `, ${g.regressions.length} regressed` : ""}{g.passed ? "" : " · did not pass"}
    </span>
  );
}

function JobLog({ job }: { job: Job }) {
  return (
    <div className="job">
      <div className="job-head">
        <span className={`status-dot ${job.status === "running" ? "running" : job.status === "done" ? "ok" : "error"}`} />
        <span className="name">{job.title}</span>
        <span className="sub" style={{ marginLeft: "auto" }}>{job.status === "running" ? "Running…" : job.status === "done" ? "Done" : "Failed"}</span>
      </div>
      <pre className="job-log">{job.log.slice(-14).join("\n") || "Starting…"}</pre>
    </div>
  );
}

export function EvolveView() {
  const { state, jobs, tick, refresh } = useApp();
  const [items, setItems] = useState<Proposal[]>([]);
  const [evals, setEvals] = useState<{ cases: { id: string; heldOut: boolean }[]; history: EvalSummary[] }>({ cases: [], history: [] });
  const [filter, setFilter] = useState<"pending" | "history">("pending");
  const [model, setModel] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    api.get<Proposal[]>("/proposals").then(setItems);
    api.get<typeof evals>("/evals").then(setEvals);
  };
  useEffect(load, [tick]);
  useEffect(() => {
    if (!model && state) setModel(state.config.defaults.chatModel);
  }, [state, model]);
  const jobList = useMemo(() => Object.values(jobs).sort((a, b) => b.startedAt.localeCompare(a.startedAt)), [jobs]);
  const running = jobList.find((j) => j.status === "running");
  useEffect(() => {
    if (jobList[0]?.status !== "running") load();
  }, [jobList[0]?.status]);

  const decide = async (id: string, decision: string) => {
    setBusy(id);
    try {
      await api.post(`/proposals/${id}/${decision}`, { model });
    } catch (e) {
      alert((e as Error).message);
    }
    setBusy(null);
    load();
    refresh();
  };

  const history = evals.history.filter((h) => !model || h.model === model);
  const scores = history.map((e) => e.score);
  const latest = history.at(-1);
  const first = history[0];
  const accepted = items.filter((p) => p.status === "accepted").length;
  const rolledBack = items.filter((p) => p.status === "rolled_back").length;
  const shown = items.filter((p) => (filter === "pending" ? p.status === "pending" : p.status !== "pending"));

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h2>Evolve</h2>
            <p>Syph proposes changes to its own skills, memory, prompts and code. Each one is measured on evals, and nothing changes until you accept it.</p>
          </div>
        </div>

        <div className="evolve-bar">
          <span className="hint">Improving</span>
          <ModelPicker value={model} onChange={setModel} align="left" up={false} />
          <div className="spacer" />
          <button className="btn tonal" disabled={!!running} onClick={() => api.post("/evals/run", { model })}><FlaskConical size={18} /> Run evals</button>
          <button className="btn primary" disabled={!!running} onClick={() => api.post("/evolve/run", { model })}><Sparkles size={18} /> Improve now</button>
        </div>

        {jobList.slice(0, 1).map((j) => <JobLog key={j.id} job={j} />)}

        <div className="stats">
          <div className="stat-card">
            <div className="k">Eval score{history.length ? ` · last ${Math.min(history.length, 12)} runs` : ""}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <div className="v">{latest ? pct(latest.score) : "—"}</div>
              {latest && first && latest !== first && <div className="d"><TrendingUp size={13} style={{ verticalAlign: -2 }} /> {latest.score >= first.score ? "+" : ""}{Math.round((latest.score - first.score) * 100)} pts</div>}
            </div>
            <Spark data={scores.slice(-12)} />
            {latest && <div className="hint">Held-out {pct(latest.heldOutScore)} · {relTime(latest.startedAt)}</div>}
          </div>
          <div className="stat-card">
            <div className="k">Eval cases</div>
            <div className="v">{evals.cases.length}</div>
            <div className="hint">{evals.cases.filter((c) => c.heldOut).length} held out from the reflector</div>
          </div>
          <div className="stat-card">
            <div className="k">Changes accepted</div>
            <div className="v">{accepted}</div>
            <div className="hint">{rolledBack} rolled back · today ${((state?.spend.evolve ?? 0)).toFixed(2)} spent on evolve</div>
          </div>
        </div>

        <div className="tabs">
          <button className={`tab ${filter === "pending" ? "active" : ""}`} onClick={() => setFilter("pending")}>Waiting for you ({items.filter((p) => p.status === "pending").length})</button>
          <button className={`tab ${filter === "history" ? "active" : ""}`} onClick={() => setFilter("history")}>History ({items.filter((p) => p.status !== "pending").length})</button>
        </div>

        {shown.length === 0 && <div className="empty">{filter === "pending" ? "Nothing waiting. Rate answers in chat, then press Improve now." : "No decisions yet."}</div>}
        {shown.map((p) => (
          <div key={p.id} className="proposal">
            <div className="proposal-head">
              <span className="kind">{p.kind}</span>
              <span className="target">{p.title}</span>
              {p.status !== "pending" && <span className={`kind status-${p.status}`}>{p.status.replace("_", " ")}</span>}
              <span className="when">{p.source === "reflector" ? "Reflector" : p.source === "agent" ? "From a chat" : "You"} · {relTime(p.createdAt)}</span>
            </div>
            <p className="reason">{p.reason}</p>
            <Diff text={p.diff} />
            {p.gate?.notes.length ? <p className="hint" style={{ marginTop: 8 }}>{p.gate.notes.join(" ")}</p> : null}
            <div className="proposal-foot">
              <GateLine p={p} />
              {p.status === "pending" && (
                <>
                  {!p.gate && p.kind !== "ui" && <button className="btn ghost sm" disabled={!!running || busy === p.id} onClick={() => decide(p.id, "gate")}><Gauge size={16} /> Measure</button>}
                  <button className="btn ghost sm" disabled={busy === p.id} onClick={() => decide(p.id, "reject")}><X size={16} /> Reject</button>
                  <button className="btn primary sm" disabled={busy === p.id} onClick={() => decide(p.id, "accept")}><Check size={16} /> Accept</button>
                </>
              )}
              {p.status === "accepted" && <button className="btn ghost sm" disabled={busy === p.id} onClick={() => decide(p.id, "rollback")}><RotateCcw size={16} /> Roll back</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

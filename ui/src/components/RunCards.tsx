// Cards that make a long run legible: where it is (status line), what "done" means and whether
// the checks agree (contract card), what it needs from you (question and continue cards), and
// what actually happened (recap). Everything shown here comes from the harness, not the model.
import { useEffect, useState } from "react";
import { AlertTriangle, CircleCheck, CircleDashed, CircleX, FileDiff, Flag, HelpCircle, Loader2, PauseCircle, Pencil, Play, Plus, Sparkles, Trash2, X } from "lucide-react";
import { api, type CheckResult, type Contract, type Progress, type Recap, type RunStatus, type StopReason, type Turn } from "../api";

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const money = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

export function fmtElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** One quiet line under a running answer: step, context used, tokens, spend, time, current tool. */
export function StatusLine({ status, elapsed, current }: { status?: RunStatus; elapsed: number; current?: string }) {
  if (!status) return null;
  const pct = status.contextWindow ? Math.min(100, Math.round((status.contextTokens / status.contextWindow) * 100)) : 0;
  const total = status.usage.promptTokens + status.usage.completionTokens;
  return (
    <div className="run-status" aria-live="polite">
      <span>Step {status.step}</span>
      <span className="ctx" title={`${k(status.contextTokens)} of ${k(status.contextWindow)} tokens in context`}>
        <span className="ctx-bar"><span style={{ width: `${pct}%` }} className={pct > 80 ? "hot" : pct > 60 ? "warm" : ""} /></span>
        context {pct}%
      </span>
      <span>{k(total)} tokens{status.usage.cachedTokens ? ` (${k(status.usage.cachedTokens)} cached)` : ""}</span>
      <span>{money(status.usage.costUsd)}</span>
      <span>{fmtElapsed(elapsed)}</span>
      {current && <span className="ellipsis cur">{current}</span>}
    </div>
  );
}

function CheckIcon({ s }: { s: CheckResult["status"] | "pending" }) {
  if (s === "pass") return <CircleCheck size={15} className="ok" />;
  if (s === "fail") return <CircleX size={15} className="bad" />;
  if (s === "running") return <Loader2 size={15} className="spin" />;
  return <CircleDashed size={15} />;
}

/** The contract: goal, scope and the done-when checks with their real results. Drafts are edited and approved here. */
export function ContractCard({ chatId, progress, checks, live, onChanged, onStart }: { chatId: string; progress?: Progress; checks?: CheckResult[]; live?: boolean; onChanged: (p: Progress) => void; onStart: () => void }) {
  const c = progress?.contract;
  const [open, setOpen] = useState(!!c?.draft);
  const [edit, setEdit] = useState<Contract | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (c?.draft) setOpen(true);
  }, [c?.draft]);
  if (!c) return null;
  const drafting = !!c.draft && !c.doneWhen.length;
  const byText = new Map((checks ?? []).map((r) => [r.text, r]));
  const ran = (checks ?? []).filter((r) => r.status !== "skipped");
  const passed = ran.filter((r) => r.status === "pass").length;
  const save = async (patch: Partial<Contract> & { approve?: boolean; clear?: boolean }) => {
    setBusy(true);
    setError(undefined);
    try {
      const p = await api.put<Progress>(`/chats/${chatId}/contract`, patch);
      onChanged(p);
      setEdit(null);
      if (patch.approve) onStart();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const e = edit;
  return (
    <div className={`contract ${c.draft ? "draft" : ""}`}>
      <button className="contract-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Flag size={15} />
        <b>{c.draft ? "Contract draft" : "Contract"}</b>
        <span className="ellipsis goal">{c.goal}</span>
        {ran.length > 0 && <span className={`chk-sum ${passed === ran.length ? "ok" : "bad"}`}>checks {passed}/{ran.length}</span>}
        {c.draft && !drafting && <span className="kind status-pending">waiting for you</span>}
      </button>
      {open && !e && (
        <div className="contract-body">
          {drafting ? (
            <p className="hint">{live ? "Syph is looking around and drafting what “done” means…" : "No checks drafted yet. Add them, or ask Syph to draft the contract."}</p>
          ) : (
            <>
              {(c.scope.length > 0 || c.never.length > 0) && (
                <div className="scope">
                  {c.scope.length > 0 && <div><span className="hint">May change</span> {c.scope.map((s) => <code key={s}>{s}</code>)}</div>}
                  {c.never.length > 0 && <div><span className="hint">Never touch</span> {c.never.map((s) => <code key={s} className="never">{s}</code>)}</div>}
                </div>
              )}
              <div className="hint label">Done when</div>
              <ul className="checks">
                {c.doneWhen.map((d, i) => {
                  const r = byText.get(d.text);
                  return (
                    <li key={i} className={r?.status ?? "pending"}>
                      <CheckIcon s={r?.status ?? "pending"} />
                      <div>
                        <div>{d.text}</div>
                        {d.command && <code className="cmd">$ {d.command}{r?.exitCode !== undefined ? `  → exit ${r.exitCode}` : ""}</code>}
                        {r?.status === "fail" && r.output && <pre className="chk-out">{r.output.slice(-1200)}</pre>}
                        {r?.status === "skipped" && r.command && <div className="hint">{r.output}</div>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {error && <div className="banner bad">{error}</div>}
          <div className="contract-foot">
            <button className="btn ghost sm" disabled={busy || live} onClick={() => setEdit({ ...c, doneWhen: c.doneWhen.length ? c.doneWhen : [{ text: "", command: "" }] })}><Pencil size={13} /> Edit</button>
            {!c.draft && <button className="btn ghost sm" disabled={busy || live} onClick={() => save({ clear: true })}><Trash2 size={13} /> Remove</button>}
            <div className="spacer" />
            {c.draft && !drafting && <button className="btn primary sm" disabled={busy || live} onClick={() => save({ approve: true })}><Play size={13} /> Approve and start</button>}
          </div>
        </div>
      )}
      {open && e && (
        <div className="contract-body edit">
          <label className="hint">Goal</label>
          <input className="input" value={e.goal} onChange={(ev) => setEdit({ ...e, goal: ev.target.value })} />
          <label className="hint">May change (globs, comma separated; empty: anywhere)</label>
          <input className="input" value={e.scope.join(", ")} onChange={(ev) => setEdit({ ...e, scope: ev.target.value.split(",").map((x) => x.trim()) })} placeholder="src/**, tests/**" />
          <label className="hint">Never touch</label>
          <input className="input" value={e.never.join(", ")} onChange={(ev) => setEdit({ ...e, never: ev.target.value.split(",").map((x) => x.trim()) })} placeholder="db/**, .env" />
          <label className="hint">Done when</label>
          {e.doneWhen.map((d, i) => (
            <div key={i} className="dw-row">
              <input className="input" placeholder="What must be true" value={d.text} onChange={(ev) => setEdit({ ...e, doneWhen: e.doneWhen.map((x, j) => (j === i ? { ...x, text: ev.target.value } : x)) })} />
              <input className="input mono" placeholder="Command that proves it (optional)" value={d.command ?? ""} onChange={(ev) => setEdit({ ...e, doneWhen: e.doneWhen.map((x, j) => (j === i ? { ...x, command: ev.target.value } : x)) })} />
              <button className="icon-btn sm" aria-label="Remove check" onClick={() => setEdit({ ...e, doneWhen: e.doneWhen.filter((_, j) => j !== i) })}><X size={14} /></button>
            </div>
          ))}
          <button className="btn ghost sm" onClick={() => setEdit({ ...e, doneWhen: [...e.doneWhen, { text: "", command: "" }] })}><Plus size={13} /> Add a check</button>
          {error && <div className="banner bad">{error}</div>}
          <div className="contract-foot">
            <button className="btn ghost sm" onClick={() => setEdit(null)}>Cancel</button>
            <div className="spacer" />
            <button className="btn tonal sm" disabled={busy} onClick={() => save({ goal: e.goal, scope: e.scope, never: e.never, doneWhen: e.doneWhen })}>Save</button>
            {c.draft && <button className="btn primary sm" disabled={busy} onClick={() => save({ goal: e.goal, scope: e.scope, never: e.never, doneWhen: e.doneWhen, approve: true })}><Play size={13} /> Approve and start</button>}
          </div>
        </div>
      )}
    </div>
  );
}

/** The agent asked something it can't find out itself: answer with one tap. */
export function QuestionCard({ question, onAnswer, disabled }: { question: { question: string; options: string[] }; onAnswer: (a: string) => void; disabled?: boolean }) {
  return (
    <div className="ask-card">
      <div className="ask-q"><HelpCircle size={16} /> <span>{question.question}</span></div>
      <div className="ask-opts">
        {question.options.map((o) => (
          <button key={o} className="btn tonal sm" disabled={disabled} onClick={() => onAnswer(o)}>{o}</button>
        ))}
      </div>
      <div className="hint">Or type your own answer below.</div>
    </div>
  );
}

const STOP_COPY: Partial<Record<StopReason, { title: string; text: string; action: string; message: string }>> = {
  budget: { title: "Paused at the run budget", text: "Progress is saved. Continue to pick up where it stopped.", action: "Continue", message: "Continue from where you stopped. Check the progress notes first." },
  repeated_error: { title: "Stopped: the same error came back", text: "Another identical attempt wouldn't help. Answer what it needs, or let it try a different way.", action: "Try a different approach", message: "Try a different approach to the error you hit. Don't repeat the same fix." },
  checks_failed: { title: "Checks still failing", text: "Syph tried to fix them and stopped. See the contract above for the output.", action: "Keep fixing", message: "The done-when checks are still failing. Keep fixing the cause." },
};

/** When a run ends early, say why and offer the one obvious next step. */
export function StopCard({ reason, onContinue, disabled }: { reason?: StopReason; onContinue: (message: string) => void; disabled?: boolean }) {
  const copy = reason ? STOP_COPY[reason] : undefined;
  if (!copy) return null;
  return (
    <div className={`stop-card ${reason}`}>
      {reason === "budget" ? <PauseCircle size={17} /> : <AlertTriangle size={17} />}
      <div className="sc-text"><b>{copy.title}</b><span className="hint">{copy.text}</span></div>
      <button className="btn primary sm" disabled={disabled} onClick={() => onContinue(copy.message)}><Play size={13} /> {copy.action}</button>
    </div>
  );
}

/** Facts about the run, so "done" never rests on the answer's own word. */
export function RecapLine({ recap, review }: { recap?: Recap; review?: Turn["review"] }) {
  if (!recap || (!recap.toolCalls && !recap.filesChanged && !recap.checks)) return null;
  const bits: React.ReactNode[] = [];
  if (recap.filesChanged) bits.push(<span key="f">{recap.filesChanged} file{recap.filesChanged === 1 ? "" : "s"} changed</span>);
  if (recap.toolCalls) bits.push(<span key="t">{recap.toolCalls} tool call{recap.toolCalls === 1 ? "" : "s"}{recap.failedCalls ? <span className="bad"> ({recap.failedCalls} failed)</span> : null}</span>);
  if (recap.checks) bits.push(<span key="c" className={recap.checks.passed === recap.checks.total ? "ok" : "bad"}>checks {recap.checks.passed}/{recap.checks.total} passed</span>);
  return (
    <div className="recap">
      <div className="recap-facts">{bits}</div>
      {recap.unfinished.length > 0 && (
        <div className="recap-left"><span className="hint">Not finished:</span> {recap.unfinished.slice(0, 4).join(" · ")}{recap.unfinished.length > 4 ? ` · +${recap.unfinished.length - 4} more` : ""}</div>
      )}
      {review && (
        <div className={`review-line ${review.status}`}>
          {review.status === "running" ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
          {review.status === "running" && <span>{review.mistakes} tool calls failed in this run. Syph is working out what it was missing so it can propose a fix…</span>}
          {review.status === "proposed" && <span>{review.mistakes} tool calls failed, so Syph proposed a fix: <a href="#/evolve">{review.title ?? "see Evolve"}</a>. It waits for your approval in Evolve.</span>}
          {review.status === "none" && <span>{review.mistakes} tool calls failed. Syph reviewed them and found nothing to change in itself{review.note ? `: ${review.note}` : "."}</span>}
        </div>
      )}
    </div>
  );
}

/** A file edit as a small diff: removed lines, then added ones. */
export function EditDiff({ args }: { args: Record<string, unknown> }) {
  const lines = (s: unknown) => (typeof s === "string" ? s.split("\n") : []);
  const isWrite = typeof args.content === "string";
  const del = isWrite ? [] : lines(args.old_text);
  const add = isWrite ? lines(args.content) : lines(args.new_text);
  const cap = 60;
  return (
    <div className="diff">
      <div className="diff-head"><FileDiff size={13} /> {String(args.path ?? "")} <span className="hint">{isWrite ? `${add.length} lines written` : `−${del.length} +${add.length}`}</span></div>
      <pre>
        {del.slice(0, cap).map((l, i) => <div key={`d${i}`} className="del">- {l}</div>)}
        {add.slice(0, cap).map((l, i) => <div key={`a${i}`} className="add">+ {l}</div>)}
        {(del.length > cap || add.length > cap) && <div className="hint">… {Math.max(del.length, add.length) - cap} more lines</div>}
      </pre>
    </div>
  );
}

// Project threads in the interface: the rail beside a coordinator chat, the update cards it
// receives, and the way back from a thread to its coordinator.
import { useEffect, useState } from "react";
import { ArrowLeft, CheckCheck, CircleDot, ExternalLink, FileText, GitBranch, PanelRightClose, PanelRightOpen, RotateCcw, Square } from "lucide-react";
import { useApp } from "../App";
import { api, relTime, subscribe, THREAD_STATE, usd, type ProjectThreads, type ThreadState, type ThreadSummary, type ThreadUpdate } from "../api";

/** A project's coordinator and threads, kept fresh from the server's event feed. */
export function useProjectThreads(projectId?: string) {
  const [data, setData] = useState<ProjectThreads | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => api.get<ProjectThreads>(`/projects/${projectId}/threads`).then((d) => alive && setData(d)).catch(() => {});
    load();
    // Many events can arrive at once (a run's start, its card, the wake-up): load once for a burst.
    const off = subscribe((e) => {
      if (e.type !== "threads" && e.type !== "chats") return;
      clearTimeout(timer);
      timer = setTimeout(load, 150);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      off();
    };
  }, [projectId]);
  return data;
}

export function StateBadge({ state, live }: { state?: ThreadState; live?: "running" | "waiting" }) {
  const s: ThreadState = live === "waiting" ? "blocked" : live === "running" && state !== "blocked" ? "working" : state ?? "done";
  const info = THREAD_STATE[s];
  return (
    <span className={`thread-state ${info.tone}`}>
      <span className="ts-dot" />
      {info.label}
    </span>
  );
}

const resolveThread = (id: string, resolved = true) => api.post(`/threads/${id}/resolve`, { resolved });
const stopThread = (id: string) => api.post(`/threads/${id}/stop`, {});

/** The card a coordinator chat shows when one of its threads finishes or needs the user. */
export function ThreadUpdateCard({ update, current }: { update: ThreadUpdate; current?: ThreadSummary }) {
  const { go } = useApp();
  const state = update.state;
  const info = THREAD_STATE[state];
  const resolved = current?.resolved;
  return (
    <div className={`msg thread-card-msg`}>
      <div className={`thread-card ${info.tone}`}>
        <div className="tc-head">
          <GitBranch size={15} className="tc-ic" />
          <button className="tc-title link-btn" onClick={() => go({ kind: "chat", chatId: update.threadId })} title="Open this thread">{update.title}</button>
          <StateBadge state={state} />
        </div>
        <p className="tc-summary">{update.summary}</p>
        {update.needs && update.needs !== update.summary && <p className="tc-needs">{update.needs}</p>}
        <div className="tc-foot">
          {!!update.filesChanged && <span><FileText size={13} /> {update.filesChanged} file{update.filesChanged === 1 ? "" : "s"}</span>}
          {update.recap?.checks && <span>Checks {update.recap.checks.passed}/{update.recap.checks.total}</span>}
          {update.costUsd !== undefined && <span>{usd(update.costUsd)}</span>}
          <span className="spacer" />
          {(state === "review_ready" || state === "done") && !resolved && current && <button className="btn ghost sm" onClick={() => resolveThread(update.threadId)}><CheckCheck size={14} /> Resolve</button>}
          {resolved && <span className="hint">Resolved</span>}
          <button className="btn sm" onClick={() => go({ kind: "chat", chatId: update.threadId })}><ExternalLink size={14} /> Open thread</button>
        </div>
      </div>
    </div>
  );
}

/** The list of threads beside a coordinator chat. */
export function ThreadRail({ projectId, open, setOpen }: { projectId: string; open: boolean; setOpen: (o: boolean) => void }) {
  const { go } = useApp();
  const data = useProjectThreads(projectId);
  const [showResolved, setShowResolved] = useState(false);
  const threads = data?.threads ?? [];
  const active = threads.filter((t) => !t.resolved);
  const shown = showResolved ? threads : active;
  const needs = active.filter((t) => t.threadState === "blocked" || t.status === "waiting").length;
  if (!open)
    return (
      <button className="thread-rail-toggle" onClick={() => setOpen(true)} title="Show threads">
        <PanelRightOpen size={17} />
        {active.length > 0 && <span className="badge">{active.length}</span>}
        {needs > 0 && <span className="live-dot waiting" />}
      </button>
    );
  return (
    <aside className="thread-rail">
      <div className="tr-head">
        <span className="tr-title">Threads</span>
        <span className="hint">{active.length} active</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Hide threads"><PanelRightClose size={17} /></button>
      </div>
      {!threads.length && <p className="hint tr-empty">When you ask for real work, the coordinator starts a thread for it. Threads show up here, and you can open any of them to talk to its agent.</p>}
      <div className="tr-list">
        {shown.map((t) => (
          <div key={t.id} className={`tr-row ${t.resolved ? "resolved" : ""}`} role="button" tabIndex={0} onClick={() => go({ kind: "chat", chatId: t.id })} onKeyDown={(e) => e.key === "Enter" && go({ kind: "chat", chatId: t.id })}>
            <div className="tr-top">
              <span className="tr-name ellipsis" title={t.title}>{t.title}</span>
              <StateBadge state={t.threadState} live={t.status} />
            </div>
            {t.summary && <p className="tr-sum">{t.summary}</p>}
            <div className="tr-meta">
              <span>{relTime(t.updatedAt)}</span>
              <span>{usd(t.costUsd)}</span>
              <span className="spacer" />
              {(t.status || t.threadState === "queued") && (
                <button className="icon-btn sm" title="Stop" onClick={(e) => { e.stopPropagation(); stopThread(t.id); }}><Square size={13} /></button>
              )}
              {!t.status && !t.resolved && t.threadState !== "queued" && (
                <button className="icon-btn sm" title="Resolve" onClick={(e) => { e.stopPropagation(); resolveThread(t.id); }}><CheckCheck size={14} /></button>
              )}
              {t.resolved && (
                <button className="icon-btn sm" title="Reopen" onClick={(e) => { e.stopPropagation(); resolveThread(t.id, false); }}><RotateCcw size={13} /></button>
              )}
            </div>
          </div>
        ))}
      </div>
      {threads.length > active.length && (
        <button className="link-btn tr-more" onClick={() => setShowResolved((s) => !s)}>{showResolved ? "Hide resolved" : `Show ${threads.length - active.length} resolved`}</button>
      )}
    </aside>
  );
}

/** At the top of a thread: back to the coordinator, and where the thread is. */
export function ThreadCrumb({ parentId, projectName, state, live }: { parentId: string; projectName?: string; state?: ThreadState; live?: "running" | "waiting" }) {
  const { go } = useApp();
  return (
    <div className="thread-crumb">
      <button className="pill" onClick={() => go({ kind: "chat", chatId: parentId })} title="Back to the project's coordinator">
        <ArrowLeft size={15} /> <span className="ellipsis pill-label">{projectName ?? "Coordinator"}</span>
      </button>
      <StateBadge state={state} live={live} />
    </div>
  );
}

/** The line shown in place of a coordinator's automatic turn (it reacts to a thread update). */
export function AutoTurnLine() {
  return (
    <div className="auto-turn"><CircleDot size={12} /> Following up on the thread update</div>
  );
}

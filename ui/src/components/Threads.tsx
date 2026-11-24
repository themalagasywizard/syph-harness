// Project threads in the interface: the rail beside a coordinator chat, the update cards it
// receives, and the way back from a thread to its coordinator.
import { useEffect, useState } from "react";
import { ArrowLeft, CheckCheck, CircleDot, ExternalLink, FileText, GitBranch, PanelRightClose, PanelRightOpen, RotateCcw, Square, Trash2 } from "lucide-react";
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
export const deleteThread = (id: string) => api.del(`/threads/${id}`);

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

/** Header button (placed right after dark mode) to collapse or expand the coordinator's threads rail. */
export function ThreadRailToggle({ open, onToggle, activeCount, needsCount }: { open: boolean; onToggle: () => void; activeCount: number; needsCount: number }) {
  return (
    <button
      className={`icon-btn thread-toggle ${open ? "on" : ""}`}
      onClick={onToggle}
      aria-label={open ? "Hide threads" : "Show threads"}
      title={open ? "Hide threads" : activeCount > 0 ? `Show threads (${activeCount} active)` : "Show threads"}
    >
      {open ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
      {!open && activeCount > 0 && <span className="tt-badge">{activeCount > 9 ? "9+" : activeCount}</span>}
      {!open && needsCount > 0 && <span className="tt-dot" />}
    </button>
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
  if (!open) return null;
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
              <button
                className="icon-btn sm tr-del"
                title="Delete thread"
                aria-label={`Delete thread ${t.title}`}
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!confirm(`Delete thread "${t.title}"?`)) return;
                  await deleteThread(t.id);
                }}
              >
                <Trash2 size={13} />
              </button>
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

/** At the top of a thread: back to the coordinator, where the thread is, and a delete action. */
export function ThreadCrumb({ parentId, threadId, title, projectName, state, live }: { parentId: string; threadId?: string; title?: string; projectName?: string; state?: ThreadState; live?: "running" | "waiting" }) {
  const { go, refresh } = useApp();
  const remove = async () => {
    if (!threadId) return;
    if (!confirm(`Delete thread "${title || "this thread"}"?`)) return;
    await deleteThread(threadId);
    await refresh();
    go({ kind: "chat", chatId: parentId });
  };
  return (
    <div className="thread-crumb">
      <button className="pill" onClick={() => go({ kind: "chat", chatId: parentId })} title="Back to the project's coordinator">
        <ArrowLeft size={15} /> <span className="ellipsis pill-label">{projectName ?? "Coordinator"}</span>
      </button>
      <StateBadge state={state} live={live} />
      {threadId && (
        <button className="icon-btn sm tr-del" onClick={remove} title="Delete this thread" aria-label="Delete this thread">
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

/** The line shown in place of a coordinator's automatic turn (it reacts to a thread update). */
export function AutoTurnLine() {
  return (
    <div className="auto-turn"><CircleDot size={12} /> Following up on the thread update</div>
  );
}

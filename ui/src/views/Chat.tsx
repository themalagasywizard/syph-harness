import { useEffect, useRef, useState } from "react";
import { ArrowUp, AtSign, Plus, Settings, Check, ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot, Clock, Code2, Copy, CornerDownRight, Files, Flag, FlaskConical, FolderClosed, Image as ImageIcon, Lightbulb, LayoutTemplate, ListChecks, Loader2, Moon, Paperclip, Pencil, RotateCcw, ShieldQuestion, Slash, Sparkles, Square, Sun, ThumbsDown, ThumbsUp, Undo2, Wrench, X, Zap } from "lucide-react";
import { Markdown } from "../components/Markdown";
import { Mark } from "../components/Logo";
import { CellLoader } from "../components/CellLoader";
import { ModelPicker } from "../components/ModelPicker";
import { UsageBar } from "../components/UsageBar";
import { useApp } from "../App";
import { api, followChat, modelLabel, queueMessage, sendMessage, uploadAttachment, type AgentEvent, type Attachment, type Chat, type CheckResult, type FileRef, type PlanStep, type Progress, type Proposal, type RunStatus, type ToolCallView, type Turn } from "../api";
import { ContractCard, CreditsCard, EditDiff, QuestionCard, RecapLine, StatusLine, StopCard } from "../components/RunCards";
import { ActiveRepoChip, RepoComposerMenu, useOutside } from "../components/Repos";
import { FolderComposerMenu } from "../components/Folders";
import { CommandApproval, TerminalPill } from "../components/Terminal";
import { FileCard, FileIcon } from "../components/FilePreview";
import { ExtIcon, Slot, type UiExtension } from "../ext";
import { AutoTurnLine, ThreadCrumb, ThreadRail, ThreadUpdateCard, useProjectThreads } from "../components/Threads";

const suggestions = [
  { text: "Turn what we did today into a reusable skill", icon: <Lightbulb size={18} /> },
  { text: "Schedule a daily summary of my research notes", icon: <Clock size={18} /> },
  { text: "Review your system prompt and suggest one improvement", icon: <Sparkles size={18} /> },
  { text: "Write a script that checks if my Ollama server is up", icon: <Code2 size={18} /> },
];

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Long outputs show their first lines until asked for the rest. */
function ToolOutput({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const lines = text.split("\n");
  const long = lines.length > 40;
  return (
    <>
      <pre className="tool-body">{long && !all ? lines.slice(0, 40).join("\n") : text}</pre>
      {long && <button className="show-all" onClick={() => setAll((a) => !a)}>{all ? "Show less" : `Show all ${lines.length} lines`}</button>}
    </>
  );
}

function ToolBlock({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const isEdit = (call.name === "edit_file" || call.name === "write_file") && !!call.args && typeof call.args === "object";
  const args = call.args && typeof call.args === "object" ? Object.entries(call.args as Record<string, unknown>).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ") : String(call.args ?? "");
  const status = call.ok === undefined ? "running" : call.ok ? "ok" : "error";
  return (
    <div className="tool">
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className={`status-dot ${status}`} />
        <span className="n">{call.name}</span>
        <span className="a">{args}</span>
        {call.ms != null && <span className="ms">{call.ms}ms</span>}
      </button>
      {open && isEdit && <EditDiff args={call.args as Record<string, unknown>} />}
      {open && (call.result === undefined ? <pre className="tool-body">…</pre> : <ToolOutput text={call.result} />)}
    </div>
  );
}

/** A short name for a call: git shows its command, other tools their name. */
function callLabel(c: ToolCallView) {
  const a = (c.args ?? {}) as Record<string, any>;
  if (c.name === "git" && Array.isArray(a.args)) return `git ${a.args.join(" ")}`.slice(0, 60);
  if (c.name === "github_clone" && a.repo) return `clone ${a.repo}`;
  if ((c.name === "read_file" || c.name === "write_file" || c.name === "edit_file") && a.path) return `${c.name} ${a.path}`.slice(0, 60);
  return c.name;
}

export function fmtDuration(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Seconds since `start`, ticking while it runs. */
function useElapsed(start?: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!start) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [start]);
  return start ? now - start : 0;
}

/** Every tool call of an answer, folded into one line: how many, which, and how long it took. */
function ToolGroup({ calls, live, startedAt, durationMs }: { calls: ToolCallView[]; live?: boolean; startedAt?: number; durationMs?: number }) {
  const [open, setOpen] = useState(false);
  const elapsed = useElapsed(live ? startedAt : undefined);
  const visible = calls.filter((c) => c.name !== "update_plan" && c.name !== "ask_user");
  if (!visible.length) return null;
  const running = live ? visible.find((c) => c.ok === undefined) : undefined;
  const failed = visible.filter((c) => c.ok === false).length;
  const toolMs = visible.reduce((n, c) => n + (c.ms ?? 0), 0);
  const ms = live && startedAt ? elapsed : durationMs ?? toolMs;
  const counts = new Map<string, number>();
  for (const c of visible) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  const names = [...counts].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(", ");
  return (
    <div className={`tool-group ${open ? "open" : ""}`}>
      <button className="tg-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {running ? <Loader2 size={14} className="spin" /> : <Wrench size={14} />}
        <span className="tg-title">{running ? <>Running <code>{callLabel(running)}</code></> : <>Used {visible.length} tool{visible.length === 1 ? "" : "s"}</>}</span>
        <span className="tg-meta">
          {running && <span>{visible.length} call{visible.length === 1 ? "" : "s"}</span>}
          <span>{fmtDuration(ms)}</span>
          {failed > 0 && <span className="bad">{failed} failed</span>}
        </span>
        {!open && !running && <span className="tg-names ellipsis">{names}</span>}
      </button>
      {open && <div className="tools">{visible.map((t) => <ToolBlock key={t.id} call={t} />)}</div>}
    </div>
  );
}

/** The agent's plan for a multi-step task, as a checklist that ticks off as it works. */
function PlanCard({ steps, live }: { steps: PlanStep[]; live?: boolean }) {
  const done = steps.filter((s) => s.status === "done").length;
  return (
    <div className={`plan ${done === steps.length ? "complete" : ""}`}>
      <div className="plan-head">
        <ListChecks size={16} /> <b>Plan</b>
        <span className="hint">{done} of {steps.length} done</span>
        <span className="plan-bar"><span style={{ width: `${(done / steps.length) * 100}%` }} /></span>
      </div>
      <ul>
        {steps.map((s, i) => (
          <li key={i} className={s.status}>
            {s.status === "done" ? <CircleCheck size={16} /> : s.status === "in_progress" ? (live ? <Loader2 size={16} className="spin" /> : <CircleDot size={16} />) : <Circle size={16} />}
            <span>{s.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SLOT_WORDS: Record<string, string> = { "chat.composer": "next to the message box", "chat.header": "at the top of every chat", "chat.empty": "on the new-chat screen", "project.header": "on project pages", sidebar: "in the sidebar" };

/** An interface change Syph proposed in this chat: what it adds, and Approve / Reject right here. */
function UiProposalCard({ id }: { id: string }) {
  const { tick } = useApp();
  const [p, setP] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    api.get<Proposal>(`/proposals/${id}`).then(setP).catch(() => setP(null));
  }, [id, tick]);
  if (!p) return null;
  const change = p.changes?.[0];
  let spec: UiExtension | null = null;
  try {
    spec = change?.after ? JSON.parse(change.after) : null;
  } catch {
    /* shown as removal */
  }
  const decide = async (d: "accept" | "reject" | "rollback") => {
    setBusy(true);
    setError(undefined);
    try {
      setP(await api.post<Proposal>(`/proposals/${id}/${d}`));
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div className={`ui-proposal ${p.status}`}>
      <div className="uip-head"><LayoutTemplate size={16} /> <b>{p.title}</b> <span className={`kind status-${p.status}`}>{p.status === "pending" ? "waiting for you" : p.status === "accepted" ? "live" : p.status.replace("_", " ")}</span></div>
      <p className="hint">{p.reason}</p>
      {spec ? (
        <ul className="uip-els">
          {spec.elements.map((el) => (
            <li key={el.id}>
              <span className="pill ext static"><ExtIcon name={el.icon} /> {el.label}</span>
              <span className="hint">{el.type === "page" ? "a page in the sidebar" : `a button ${SLOT_WORDS[el.slot] ?? el.slot}`}{el.type === "button" && el.when?.connector ? `, shown when ${el.when.connector} is connected` : ""}</span>
            </li>
          ))}
        </ul>
      ) : <p className="hint">Removes {change?.path.replace(/^ui\/|\.json$/g, "")} from the interface.</p>}
      {error && <div className="banner bad">{error}</div>}
      <div className="uip-foot">
        {p.status === "pending" && (
          <>
            <a className="hint" href="#/evolve">See the full change in Evolve</a>
            <div className="spacer" />
            <button className="btn ghost sm" disabled={busy} onClick={() => decide("reject")}>Reject</button>
            <button className="btn primary sm" disabled={busy} onClick={() => decide("accept")}>Approve</button>
          </>
        )}
        {p.status === "accepted" && (
          <>
            <span className="hint">It's in the app now. Switch it off any time in Settings → Interface.</span>
            <div className="spacer" />
            <button className="btn ghost sm" disabled={busy} onClick={() => decide("rollback")}><Undo2 size={14} /> Undo</button>
          </>
        )}
      </div>
    </div>
  );
}

function AttachmentChips({ items, uploading = 0, onRemove }: { items: Attachment[]; uploading?: number; onRemove?: (a: Attachment) => void }) {
  const { showFile } = useApp();
  return (
    <div className="att-chips">
      {items.map((a) => (
        <span key={a.path} className="att-chip" title={a.path}>
          <button className="att-open" onClick={() => showFile(a.path)}>{a.kind === "image" ? <ImageIcon size={14} /> : <FileIcon name={a.name} size={14} />} <span className="ellipsis">{a.name}</span></button>
          {onRemove && <button className="att-x" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a)}><X size={12} /></button>}
        </span>
      ))}
      {uploading > 0 && <span className="att-chip"><Loader2 size={14} className="spin" /> Uploading {uploading}…</span>}
    </div>
  );
}

function FileList({ files }: { files: FileRef[] }) {
  const { showFile } = useApp();
  return <div className="files">{files.map((f) => <FileCard key={f.path} f={f} onPreview={showFile} />)}</div>;
}

interface Approval {
  id: string;
  tool: string;
  args: unknown;
  reason?: string;
}

type Answer = boolean | "always" | "session";

function AssistantTurn({ turn, chatId, streaming, approval, onApprove, note, startedAt, status, last, settle, busy, onSend, onRetry }: { turn: Turn; chatId?: string; streaming?: boolean; approval?: Approval | null; onApprove?: (allow: Answer) => void; note?: string; startedAt?: number; status?: RunStatus; last?: boolean; settle?: boolean; busy?: boolean; onSend?: (text: string) => void; onRetry?: () => void }) {
  const elapsed = useElapsed(streaming ? startedAt : undefined);
  const running = streaming ? turn.toolCalls?.find((c) => c.ok === undefined) : undefined;
  const [rating, setRating] = useState(turn.rating);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<null | "open" | "saved">(null);
  const [expectation, setExpectation] = useState("");
  const rate = async (r: "up" | "down") => {
    const next = rating === r ? null : r;
    setRating(next ?? undefined);
    if (chatId) await api.post(`/chats/${chatId}/rate`, { turnId: turn.id, rating: next });
    if (next === "down") setFeedback("open");
  };
  const toEval = async () => {
    if (!turn.runId) return;
    await api.post(`/runs/${turn.runId}/eval`, { rating: rating ?? "down", expectation: expectation.trim() || undefined });
    setFeedback("saved");
  };
  return (
    <div className="msg assistant">
      <div className="avatar">
        {streaming ? (
          <CellLoader size={30} beat={turn.content.length} state={approval ? "idle" : turn.content && !turn.toolCalls?.some((c) => c.ok === undefined) ? "streaming" : "loading"} />
        ) : last ? (
          <CellLoader size={30} state="idle" birth={false} settle={settle} />
        ) : (
          <Mark size={18} />
        )}
      </div>
      <div className="body">
        {!!turn.plan?.length && <PlanCard steps={turn.plan} live={streaming} />}
        {!!turn.toolCalls?.length && <ToolGroup calls={turn.toolCalls} live={streaming} startedAt={startedAt} durationMs={turn.durationMs} />}
        {turn.toolCalls?.filter((t) => t.name === "propose_ui_change" && t.ok).map((t) => /\((pr_\w+)\)/.exec(t.result ?? "")?.[1]).filter(Boolean).map((pid) => <UiProposalCard key={pid} id={pid!} />)}
        {!!turn.files?.length && <FileList files={turn.files} />}
        {note && <div className="note">{note}</div>}
        {approval?.tool === "shell" && <CommandApproval args={(approval.args ?? {}) as any} reason={approval.reason} onAnswer={(a) => onApprove?.(a)} />}
        {approval && approval.tool !== "shell" && (
          <div className="approval">
            <ShieldQuestion size={18} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="name">Allow <code>{approval.tool}</code>?</div>
              <pre className="approval-args">{JSON.stringify(approval.args, null, 2)}</pre>
            </div>
            <button className="btn ghost sm" onClick={() => onApprove?.(false)}>Deny</button>
            <button className="btn tonal sm" onClick={() => onApprove?.("always")} title={approval.tool === "shell" ? "Run this exact command without asking from now on" : `Let ${approval.tool} run without asking from now on`}>Always allow</button>
            <button className="btn primary sm" onClick={() => onApprove?.(true)}>Allow</button>
          </div>
        )}
        {!!turn.steering?.length && (
          <div className="steering">
            {turn.steering.map((t, i) => <div key={i} className="steer"><CornerDownRight size={13} /> <span>You, while it worked: {t}</span></div>)}
          </div>
        )}
        {turn.failure?.kind === "credits" && !streaming ? (
          <CreditsCard failure={turn.failure} onRetry={last ? onRetry : undefined} disabled={busy} />
        ) : turn.question && !streaming ? (
          <QuestionCard question={turn.question} onAnswer={(a) => onSend?.(a)} disabled={!last || busy} />
        ) : turn.content ? (
          <Markdown text={turn.content} />
        ) : (
          streaming && !approval && <div className="thinking"><span /><span /><span /></div>
        )}
        {streaming && turn.content && <span className="caret" />}
        {streaming && <StatusLine status={status} elapsed={elapsed} current={running ? callLabel(running) : undefined} />}
        {!streaming && <RecapLine recap={turn.recap} review={turn.review} />}
        {!streaming && last && <StopCard reason={turn.stopReason} onContinue={(m) => onSend?.(m)} disabled={busy} />}
        {!streaming && (
          <div className="msg-actions">
            <button className="icon-btn sm" aria-label="Good response" onClick={() => rate("up")} style={rating === "up" ? { color: "var(--text)" } : undefined}><ThumbsUp size={16} fill={rating === "up" ? "currentColor" : "none"} /></button>
            <button className="icon-btn sm" aria-label="Bad response" onClick={() => rate("down")} style={rating === "down" ? { color: "var(--text)" } : undefined}><ThumbsDown size={16} fill={rating === "down" ? "currentColor" : "none"} /></button>
            <button className="icon-btn sm" aria-label="Copy" onClick={() => { navigator.clipboard.writeText(turn.content); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>
            {turn.runId && rating && feedback !== "open" && feedback !== "saved" && <button className="icon-btn sm" title="Turn into eval case" onClick={() => setFeedback("open")}><FlaskConical size={16} /></button>}
            {last && onRetry && !busy && !turn.failure && <button className="icon-btn sm" aria-label="Retry" title="Send the last message again" onClick={onRetry}><RotateCcw size={16} /></button>}
            {turn.model && <span className="model-tag">{turn.model.replace(/^openrouter:/, "")}</span>}
          </div>
        )}
        {feedback === "open" && (
          <div className="feedback">
            <input className="input" placeholder={rating === "up" ? "Optional: what made this good?" : "What should a good answer do? (optional, Syph drafts it if blank)"} value={expectation} onChange={(e) => setExpectation(e.target.value)} onKeyDown={(e) => e.key === "Enter" && toEval()} />
            <button className="btn tonal sm" onClick={toEval}><FlaskConical size={14} /> Turn into eval</button>
            <button className="btn ghost sm" onClick={() => setFeedback(null)}>Skip</button>
          </div>
        )}
        {feedback === "saved" && <div className="hint" style={{ marginTop: 6 }}>Saved as an eval case. Evolve will use it to measure future changes.</div>}
      </div>
    </div>
  );
}

export function ChatView({ chatId, projectId: initialProject, draft: initialDraft, autoSend }: { chatId?: string; projectId?: string; draft?: string; autoSend?: boolean }) {
  const { state, go, refresh, theme, setTheme, showFile } = useApp();
  const [filesOpen, setFilesOpen] = useState(false);
  const [chat, setChat] = useState<Chat | null>(null);
  const [cid, setCid] = useState(chatId);
  const [draft, setDraft] = useState(initialDraft ?? "");
  const [model, setModel] = useState<string | undefined>();
  const [projectId, setProjectId] = useState<string | undefined>(initialProject);
  const [menu, setMenu] = useState(false);
  const [live, setLive] = useState<Turn | null>(null);
  /** When a reply has just finished, its logo springs back into shape instead of appearing still. */
  const [settling, setSettling] = useState(false);
  /** Bumped when a reply ends, so the usage bar re-reads what is left. */
  const [usageBump, setUsageBump] = useState(0);
  useEffect(() => {
    if (!settling) return;
    const id = setTimeout(() => setSettling(false), 2500);
    return () => clearTimeout(id);
  }, [settling]);
  const [liveStart, setLiveStart] = useState<number>();
  const [note, setNote] = useState<string>();
  const [approval, setApproval] = useState<Approval | null>(null);
  const [pendingUser, setPendingUser] = useState<Turn | null>(null);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<RunStatus>();
  const [progress, setProgress] = useState<Progress>();
  const [contractOpen, setContractOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const addRef = useOutside(addOpen, () => setAddOpen(false));
  const [liveChecks, setLiveChecks] = useState<CheckResult[]>();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [mention, setMention] = useState<{ kind: "/" | "@"; query: string; start: number } | null>(null);
  const [wsFiles, setWsFiles] = useState<string[]>([]);
  const [queued, setQueued] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  // Watching a run, not owning it: leaving this view only stops watching. The run carries on on the server.
  const watchRef = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const project = state?.projects.find((p) => p.id === projectId);
  const yolo = !!state?.config.approval.yolo;
  const role = chat?.role;
  const [railOpen, setRailOpenState] = useState(() => {
    try {
      return localStorage.getItem("syph.threadRail") !== "closed";
    } catch {
      return true;
    }
  });
  const setRailOpen = (o: boolean) => {
    setRailOpenState(o);
    try {
      localStorage.setItem("syph.threadRail", o ? "open" : "closed");
    } catch {
      /* private mode */
    }
  };
  const threadData = useProjectThreads(role === "coordinator" ? projectId : undefined);
  const threadById = new Map((threadData?.threads ?? []).map((t) => [t.id, t]));
  const summary = state?.chats.find((c) => c.id === cid);

  useEffect(() => () => watchRef.current?.abort(), []);
  useEffect(() => {
    if (initialDraft) textarea.current?.focus();
  }, []);
  // A button Syph added ("Connect repo" on a project page, say) can open a new chat that sends at once.
  const autoSent = useRef(false);
  useEffect(() => {
    if (autoSend && initialDraft && state && !autoSent.current) {
      autoSent.current = true;
      history.replaceState(null, "", location.pathname + location.search + location.hash.replace(/[?&]send=1/, ""));
      send(initialDraft);
    }
  }, [state]);

  useEffect(() => {
    if (!chatId) return;
    api.get<Chat>(`/chats/${chatId}`).then((c) => {
      setChat(c);
      setProgress(c.progress);
      setProjectId(c.projectId);
      setModel(c.model);
      if (c.running) follow(chatId);
    }).catch(() => go({ kind: "chat" }));
  }, [chatId]);

  useEffect(() => {
    if (!model && state) setModel(state.config.defaults.chatModel);
  }, [state, model]);

  // A mistake review finishes in the background: pick up its result when the app says chats changed.
  const { tick } = useApp();
  useEffect(() => {
    if (!cid || live || !chat?.turns.some((t) => t.review?.status === "running")) return;
    api.get<Chat>(`/chats/${cid}`).then((c) => !c.running && setChat(c)).catch(() => {});
  }, [tick]);

  // Syph writes to coordinators and threads on its own (update cards, wake-ups, messages from the
  // coordinator): pick those up, and follow a run that started without this window.
  const seenUpdate = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!cid || !role || !summary || watchRef.current || pendingUser) return;
    if (summary.status && !live) {
      follow(cid);
      return;
    }
    if (live || summary.updatedAt === seenUpdate.current) return;
    seenUpdate.current = summary.updatedAt;
    if (chat && summary.updatedAt === chat.updatedAt) return;
    api.get<Chat>(`/chats/${cid}`).then((c) => {
      if (watchRef.current) return;
      setChat(c);
      setProgress(c.progress);
      if (c.running) follow(cid);
    }).catch(() => {});
  }, [summary?.updatedAt, summary?.status, role]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [chat?.turns.length, live?.content, live?.toolCalls?.length, approval]);

  useEffect(() => {
    const t = textarea.current;
    if (t) {
      t.style.height = "auto";
      t.style.height = Math.min(200, t.scrollHeight) + "px";
    }
  }, [draft]);

  /** Show the chat's current run, replayed from its start, until it ends. */
  const follow = async (id: string) => {
    watchRef.current?.abort();
    const ac = new AbortController();
    watchRef.current = ac;
    setLive({ id: "live", role: "assistant", content: "", toolCalls: [], createdAt: new Date().toISOString() });
    setLiveStart(Date.now());
    setNote(undefined);
    setApproval(null);
    setStatus(undefined);
    setLiveChecks(undefined);
    let wrote = false;
    const onEvent = (e: AgentEvent) => {
      if (e.type === "token") wrote = true;
      setLive((t) => {
        if (!t) return t;
        switch (e.type) {
          case "run_start": return { ...t, model: e.model };
          case "plan": return { ...t, plan: e.steps };
          case "token": return { ...t, content: t.content + e.text };
          case "tool_call": return { ...t, toolCalls: [...(t.toolCalls ?? []), { id: e.id, name: e.name, args: e.args }] };
          case "tool_result": return { ...t, toolCalls: t.toolCalls?.map((c) => (c.id === e.id ? { ...c, ok: e.ok, result: e.result, ms: e.ms } : c)) };
          case "note": return e.reset ? { ...t, content: "" } : t;
          case "files": {
            const all = new Map((t.files ?? []).map((f) => [f.path, f]));
            for (const f of e.files) all.set(f.path, { ...f, action: all.get(f.path)?.action === "created" ? "created" : f.action });
            return { ...t, files: [...all.values()] };
          }
          case "message": return t.content && (e as any).message?.tool_calls?.length ? { ...t, content: "" } : t;
          case "steer": return { ...t, steering: [...(t.steering ?? []), e.text] };
          case "checks": return { ...t, checks: e.checks };
          default: return t;
        }
      });
      if (e.type === "run_start" && e.at) setLiveStart(e.at);
      if (e.type === "status") setStatus({ step: e.step, contextTokens: e.contextTokens, contextWindow: e.contextWindow, usage: e.usage, cachedTokens: e.cachedTokens });
      if (e.type === "steer") setQueued((q) => q.slice(1));
      if (e.type === "checks") setLiveChecks(e.checks);
      if (e.type === "contract") setProgress((p) => ({ done: [], decisions: [], deadEnds: [], blocked: [], ...p, contract: e.contract }));
      if (e.type === "note" && e.text) setNote(e.text);
      if (e.type === "approval_request") setApproval({ id: e.id, tool: e.tool, args: e.args, reason: e.reason });
      if (e.type === "approval_done" || e.type === "tool_result") setApproval((a) => (a && (e.type !== "approval_done" || a.id === e.id) ? null : a));
    };
    try {
      await followChat(id, onEvent, ac.signal);
    } catch {
      /* stopped watching, or the connection dropped: the saved chat below is the source of truth */
    }
    if (ac.signal.aborted) return;
    const fresh = await api.get<Chat>(`/chats/${id}`).catch(() => null);
    if (fresh) {
      setChat(fresh);
      setProgress(fresh.progress);
    }
    setLive(null);
    setUsageBump((n) => n + 1);
    setSettling(wrote);
    setStatus(undefined);
    setQueued([]);
    setPendingUser(null);
    setApproval(null);
    setNote(undefined);
    watchRef.current = null;
    refresh();
    if (fresh?.running) follow(id);
  };

  const send = async (text = draft) => {
    // While it works, a message steers the run: the agent reads it at its next step.
    if (live && cid) {
      if (!text.trim()) return;
      setDraft("");
      setQueued((q) => [...q, text.trim()]);
      try {
        await queueMessage(cid, text.trim());
      } catch (e) {
        setQueued((q) => q.filter((x) => x !== text.trim()));
        setDraft(text);
        setError((e as Error).message);
      }
      return;
    }
    const files = attachments;
    if ((!text.trim() && !files.length) || live || uploading) return;
    setError(undefined);
    setDraft("");
    setAttachments([]);
    let id = cid;
    try {
      const fresh = !id;
      if (!id) {
        const c = await api.post<Chat>("/chats", { projectId, model });
        id = c.id;
        setCid(id);
      } else if (chat && (chat.projectId !== projectId || chat.model !== model)) {
        await api.patch(`/chats/${id}`, { projectId, model });
      }
      setPendingUser({ id: "pending", role: "user", content: text, attachments: files, createdAt: new Date().toISOString() });
      await sendMessage(id, text, model, { attachments: files.length ? files : undefined });
      refresh();
      // A new chat gets its own address, so "New chat" starts another one while this keeps running.
      if (fresh) return go({ kind: "chat", chatId: id });
      const c = await api.get<Chat>(`/chats/${id}`);
      setChat(c);
      setPendingUser(null);
      follow(id);
    } catch (e) {
      setPendingUser(null);
      setDraft(text);
      setAttachments(files);
      setError((e as Error).message);
    }
  };

  /** Files dropped, pasted or picked: saved to the chat's uploads/ folder, sent with the next message. */
  const addFiles = async (list: FileList | File[]) => {
    const picked = [...list].filter((f) => f.size > 0);
    if (!picked.length) return;
    setError(undefined);
    let id: string;
    try {
      id = await ensureChat();
    } catch (e) {
      return setError((e as Error).message);
    }
    setUploading((n) => n + picked.length);
    for (const f of picked) {
      try {
        const a = await uploadAttachment(id, f);
        setAttachments((xs) => [...xs, a]);
      } catch (e) {
        setError(`${f.name}: ${(e as Error).message}`);
      }
      setUploading((n) => n - 1);
    }
  };

  // "/" offers skills, "@" offers workspace files, at the start of a word.
  const onDraft = (value: string, caret: number) => {
    setDraft(value);
    const m = /(^|\s)([/@])([\w./-]*)$/.exec(value.slice(0, caret));
    if (!m || (m[2] === "/" && m.index + m[1].length !== 0)) return setMention(null);
    const kind = m[2] as "/" | "@";
    setMention({ kind, query: m[3].toLowerCase(), start: m.index + m[1].length });
    if (kind === "@" && !wsFiles.length) api.get<string[]>(`/workspace-files${projectId ? `?projectId=${projectId}` : ""}`).then(setWsFiles).catch(() => {});
  };
  const mentionItems = !mention
    ? []
    : mention.kind === "/"
      ? (state?.skills ?? []).filter((sk) => sk.name.toLowerCase().includes(mention.query)).slice(0, 8).map((sk) => ({ label: sk.name, hint: sk.description, insert: `Use the ${sk.name} skill: ` }))
      : wsFiles.filter((f) => f.toLowerCase().includes(mention.query)).slice(0, 8).map((f) => ({ label: f, hint: "", insert: `${f} ` }));
  const pickMention = (insert: string) => {
    if (!mention) return;
    const t = textarea.current;
    const caret = t?.selectionStart ?? draft.length;
    const next = draft.slice(0, mention.start) + insert + draft.slice(caret);
    setDraft(next);
    setMention(null);
    requestAnimationFrame(() => {
      t?.focus();
      const pos = mention.start + insert.length;
      t?.setSelectionRange(pos, pos);
    });
  };

  /** Linking a repo to "this chat" before the first message: make the chat now, without leaving the page. */
  const ensureChat = async () => {
    if (cid) return cid;
    const c = await api.post<Chat>("/chats", { projectId, model });
    setCid(c.id);
    setChat(c);
    history.replaceState(null, "", `#/chat/${c.id}`);
    refresh();
    return c.id;
  };

  const stop = () => cid && api.post(`/chats/${cid}/stop`);
  const toggleYolo = async () => {
    await api.put("/settings", { approval: { yolo: !yolo } });
    refresh();
  };

  const answer = async (allow: Answer) => {
    if (!approval) return;
    await api.post(`/approvals/${approval.id}`, allow === "always" ? { allow: true, always: true } : allow === "session" ? { allow: true, session: true } : { allow });
    setApproval(null);
    if (allow === "always" || allow === "session") refresh();
  };

  const turns = [...(chat?.turns ?? []), ...(pendingUser ? [pendingUser] : [])];
  const lastAssistant = turns.findLastIndex((t) => t.role === "assistant" && !t.threadUpdate);
  const lastUserIdx = turns.findLastIndex((t) => t.role === "user" && !t.auto);
  const lastChecks = liveChecks ?? turns.findLast((t) => t.checks?.length)?.checks;
  const retry = () => {
    const u = turns[lastUserIdx];
    if (u) send(u.content || "Please try again.");
  };
  const chatFiles = [...new Map([...turns, ...(live ? [live] : [])].flatMap((t) => t.files ?? []).map((f) => [f.path, f])).values()].reverse();
  const slotCtx = { projectId, chatId: cid, send: (t: string) => (live ? setDraft(t) : send(t)), setDraft: (t: string) => { setDraft(t); textarea.current?.focus(); } };
  const empty = !turns.length && !live;
  const noKey = state && !state.config.hasOpenRouterKey && (model ?? "").startsWith("openrouter:");
  const noMiniMaxKey = state && !state.config.hasMiniMaxKey && (model ?? "").startsWith("minimax:");

  const body = (
    <>
      <div className="topbar">
        {role === "thread" && chat?.parentId && <ThreadCrumb parentId={chat.parentId} projectName={project?.name} state={chat.threadState} live={summary?.status} />}
        <span className="title ellipsis">{role === "coordinator" ? <>{project?.name ?? chat?.title} <span className="hint coord-tag">Coordinator</span></> : chat?.title && chat.title !== "New chat" ? chat.title : ""}</span>
        <div className="spacer" />
        {role ? (
          <button className="pill" onClick={() => projectId && go({ kind: "projects", projectId })} title="Project settings: instructions, files, repos, tasks and threads">
            <Settings size={15} /> <span className="pill-label">Settings</span>
          </button>
        ) : (
        <div className="model-menu">
          <button className={`pill ${project ? "on" : ""}`} onClick={() => setMenu((m) => !m)} title="The project this chat belongs to">
            <FolderClosed size={15} /> <span className="ellipsis pill-label">{project?.name ?? "No project"}</span>
          </button>
          {menu && (
            <div className="menu" style={{ right: 0, left: "auto", top: 40, bottom: "auto" }}>
              <button onClick={() => { setProjectId(undefined); setMenu(false); }}>No project {!project && <Check size={14} className="id" />}</button>
              {state?.projects.map((p) => (
                <button key={p.id} onClick={() => { setProjectId(p.id); setMenu(false); }}>
                  <span className="status-dot" style={{ background: p.color }} /> {p.name}
                  {p.id === projectId && <Check size={14} className="id" />}
                </button>
              ))}
              {!state?.projects.length && <div className="hint" style={{ padding: 10 }}>No projects yet.</div>}
            </div>
          )}
        </div>
        )}
        <ActiveRepoChip chatId={cid} projectId={projectId} />
        <TerminalPill chatId={cid} live={!!live} />
        <button className={`pill yolo ${yolo ? "on" : ""}`} onClick={toggleYolo} title={yolo ? "YOLO is on: shell (PowerShell) and other ask-first tools run without asking. Click to turn off." : "Turn on YOLO: run shell (PowerShell) and other ask-first tools without asking."}>
          <Zap size={15} fill={yolo ? "currentColor" : "none"} /> <span className="yolo-text">{yolo ? "YOLO on" : "Ask first"}</span>
        </button>
        <Slot name="chat.header" ctx={slotCtx} />
        {cid && progress?.contract && !progress.contract.draft && (
          <div className="model-menu">
            <button className={`pill ${contractOpen ? "on" : ""}`} onClick={() => setContractOpen((o) => !o)} aria-expanded={contractOpen} title="The contract this long task works to"><Flag size={15} /> Contract</button>
            {contractOpen && (
              <div className="menu contract-menu" style={{ right: 0 }}>
                <ContractCard chatId={cid} progress={progress} checks={lastChecks} live={!!live} onChanged={setProgress} onStart={() => send("The contract is approved. Start the work, and keep to it.")} startOpen />
              </div>
            )}
          </div>
        )}
        {chatFiles.length > 0 && (
          <div className="model-menu">
            <button className="pill" onClick={() => setFilesOpen((o) => !o)} title="Files this chat created or changed"><Files size={15} /> {chatFiles.length} file{chatFiles.length === 1 ? "" : "s"}</button>
            {filesOpen && (
              <div className="menu files-menu" style={{ right: 0 }}>
                {chatFiles.map((f) => (
                  <button key={f.path} onClick={() => { showFile(f.path); setFilesOpen(false); }} title={f.path}>
                    <FileIcon name={f.name} size={16} />
                    <span className="fm-text"><span className="ellipsis">{f.name}</span><span className="fm-path">{f.path}</span></span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button className="icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle theme">{theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}</button>
      </div>

      <div className="chat-scroll" ref={scroller}>
        <div className="chat-col">
          {empty ? (
            <div className="hero">
              <div className="mark"><Mark size={36} /></div>
              <h1>{greeting()}.</h1>
              <h1 className="s">{role === "coordinator" ? `What should ${project?.name ?? "this project"} work on?` : "What should we work on?"}</h1>
              {role === "coordinator" && <p className="hint coord-hero">Ask for anything. Quick questions are answered here; real work goes to its own thread, which you'll see on the right and can open at any time.</p>}
              <div className="chips">
                <Slot name="chat.empty" ctx={slotCtx} variant="chip" />
                {suggestions.map((s) => (
                  <button key={s.text} className="chip" onClick={() => send(s.text)}>
                    <p>{s.text}</p>
                    <span className="ic">{s.icon}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {turns.map((t, i) =>
                t.threadUpdate ? (
                  <ThreadUpdateCard key={t.id} update={t.threadUpdate} current={threadById.get(t.threadUpdate.threadId)} />
                ) : t.auto ? (
                  <AutoTurnLine key={t.id} />
                ) : t.role === "user" ? (
                  <div key={t.id} className="msg user">
                    <div className="user-col">
                      {!!t.attachments?.length && <AttachmentChips items={t.attachments} />}
                      {t.content && <div className="bubble">{t.content}</div>}
                      {i === lastUserIdx && !live && t.id !== "pending" && t.content && (
                        <button className="edit-msg" title="Put this message back in the box to edit and send again" onClick={() => { setDraft(t.content); textarea.current?.focus(); }}><Pencil size={12} /> Edit</button>
                      )}
                    </div>
                  </div>
                ) : (
                  <AssistantTurn key={t.id} turn={t} chatId={chat?.id} last={i === lastAssistant && i > lastUserIdx} settle={settling && i === lastAssistant} busy={!!live} onSend={(m) => send(m)} onRetry={retry} />
                ),
              )}
              {live && <AssistantTurn turn={live} streaming approval={approval} onApprove={answer} note={note} startedAt={liveStart} status={status} />}
              {cid && progress?.contract?.draft && !live && (
                <div className="msg contract-msg"><ContractCard chatId={cid} progress={progress} checks={lastChecks} onChanged={setProgress} onStart={() => send("The contract is approved. Start the work, and keep to it.")} /></div>
              )}
              {queued.length > 0 && (
                <div className="queued">{queued.map((q, i) => <div key={i} className="steer"><Clock size={13} /> <span>Queued for the next step: {q}</span></div>)}</div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="composer-wrap">
        {error && <div className="banner bad">{error}</div>}
        {noKey && <div className="banner">Add your OpenRouter key in <a href="#/settings">Settings</a> to chat with {model?.replace("openrouter:", "")}.</div>}
        {noMiniMaxKey && <div className="banner">Add your MiniMax key in <a href="#/settings">Settings</a> to chat with {modelLabel(model)}.</div>}
        <div
          className={`composer ${dragging ? "dragging" : ""}`}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            setDragging(false);
            addFiles(e.dataTransfer.files);
          }}
        >
          {mention && mentionItems.length > 0 && (
            <div className="menu mention-menu">
              <div className="grp">{mention.kind === "/" ? "Skills" : "Files"}</div>
              {mentionItems.map((m) => (
                <button key={m.label} onMouseDown={(e) => { e.preventDefault(); pickMention(m.insert); }}>
                  {mention.kind === "/" ? <Slash size={14} /> : <AtSign size={14} />}
                  <span className="ellipsis">{m.label}</span>
                  {m.hint && <span className="id">{m.hint}</span>}
                </button>
              ))}
            </div>
          )}
          {(attachments.length > 0 || uploading > 0) && (
            <AttachmentChips items={attachments} uploading={uploading} onRemove={(a) => setAttachments((xs) => xs.filter((x) => x.path !== a.path))} />
          )}
          <textarea
            ref={textarea}
            rows={1}
            placeholder={live ? "Add a note for Syph while it works…" : project ? `Message Syph in ${project.name}` : "Message Syph"}
            value={draft}
            onChange={(e) => onDraft(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onPaste={(e) => {
              const pasted = [...e.clipboardData.items].filter((it) => it.kind === "file").map((it) => it.getAsFile()).filter((f): f is File => !!f);
              if (pasted.length) {
                e.preventDefault();
                addFiles(pasted);
              }
            }}
            onKeyDown={(e) => {
              if (mention && mentionItems.length && (e.key === "Enter" || e.key === "Tab")) {
                e.preventDefault();
                return pickMention(mentionItems[0].insert);
              }
              if (e.key === "Escape" && mention) return setMention(null);
              if (e.key === "ArrowUp" && !draft && lastUserIdx >= 0) {
                e.preventDefault();
                return setDraft(turns[lastUserIdx].content);
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-row">
            <div className="model-menu" ref={addRef}>
              <button className={`icon-btn sm attach ${addOpen ? "on" : ""}`} onClick={() => setAddOpen((o) => !o)} aria-label="Add images or files" aria-expanded={addOpen} title="Add images or files (or drop or paste them)"><Plus size={18} /></button>
              {addOpen && (
                <div className="menu add-menu" style={{ left: 0 }}>
                  <button onClick={() => { setAddOpen(false); imageInput.current?.click(); }}><ImageIcon size={16} /> Images</button>
                  <button onClick={() => { setAddOpen(false); fileInput.current?.click(); }}><Paperclip size={16} /> Files <span className="id">PDF, docs, sheets, code…</span></button>
                </div>
              )}
            </div>
            <input ref={imageInput} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
            <FolderComposerMenu chatId={cid} projectId={projectId} ensureChat={ensureChat} />
            <RepoComposerMenu chatId={cid} projectId={projectId} ensureChat={ensureChat} iconOnly />
            <Slot name="chat.composer" ctx={slotCtx} />
            <div className="spacer" />
            <UsageBar model={model ?? state?.config.defaults.chatModel} bump={usageBump} />
            <ModelPicker value={model} onChange={setModel} effort />
            {live && draft.trim() && <button className="send ready" onClick={() => send()} aria-label="Send to the running task" title="Syph reads it at its next step"><CornerDownRight size={18} /></button>}
            {live ? (
              <button className="send ready" onClick={stop} aria-label="Stop"><Square size={14} fill="currentColor" /></button>
            ) : (
              <button className={`send ${draft.trim() || attachments.length ? "ready" : ""}`} onClick={() => send()} disabled={uploading > 0} aria-label="Send"><ArrowUp size={20} /></button>
            )}
          </div>
        </div>
      </div>
    </>
  );
  if (role !== "coordinator" || !projectId) return body;
  return (
    <div className="chat-with-rail">
      <div className="chat-pane">{body}</div>
      <ThreadRail projectId={projectId} open={railOpen} setOpen={setRailOpen} />
    </div>
  );
}

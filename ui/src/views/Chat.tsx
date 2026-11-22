import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot, Clock, Code2, Copy, Files, FlaskConical, FolderClosed, Lightbulb, LayoutTemplate, ListChecks, Loader2, Moon, ShieldQuestion, Sparkles, Square, Sun, ThumbsDown, ThumbsUp, Undo2, Wrench, Zap } from "lucide-react";
import { Markdown } from "../components/Markdown";
import { Mark } from "../components/Logo";
import { CellLoader } from "../components/CellLoader";
import { ModelPicker } from "../components/ModelPicker";
import { useApp } from "../App";
import { api, followChat, sendMessage, type AgentEvent, type Chat, type FileRef, type PlanStep, type Proposal, type ToolCallView, type Turn } from "../api";
import { ActiveRepoChip, RepoComposerMenu } from "../components/Repos";
import { FileCard, FileIcon } from "../components/FilePreview";
import { ExtIcon, Slot, type UiExtension } from "../ext";

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

function ToolBlock({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);
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
      {open && <pre className="tool-body">{call.result ?? "…"}</pre>}
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
  const visible = calls.filter((c) => c.name !== "update_plan");
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

function FileList({ files }: { files: FileRef[] }) {
  const { showFile } = useApp();
  return <div className="files">{files.map((f) => <FileCard key={f.path} f={f} onPreview={showFile} />)}</div>;
}

interface Approval {
  id: string;
  tool: string;
  args: unknown;
}

function AssistantTurn({ turn, chatId, streaming, approval, onApprove, note, startedAt }: { turn: Turn; chatId?: string; streaming?: boolean; approval?: Approval | null; onApprove?: (allow: boolean) => void; note?: string; startedAt?: number }) {
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
          <CellLoader size={30} state={approval ? "idle" : turn.content && !turn.toolCalls?.some((c) => c.ok === undefined) ? "streaming" : "loading"} />
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
        {approval && (
          <div className="approval">
            <ShieldQuestion size={18} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="name">Allow <code>{approval.tool}</code>?</div>
              <pre className="approval-args">{JSON.stringify(approval.args, null, 2)}</pre>
            </div>
            <button className="btn ghost sm" onClick={() => onApprove?.(false)}>Deny</button>
            <button className="btn primary sm" onClick={() => onApprove?.(true)}>Allow</button>
          </div>
        )}
        {turn.content ? <Markdown text={turn.content} /> : streaming && !approval && <div className="thinking"><span /><span /><span /></div>}
        {streaming && turn.content && <span className="caret" />}
        {!streaming && (
          <div className="msg-actions">
            <button className="icon-btn sm" aria-label="Good response" onClick={() => rate("up")} style={rating === "up" ? { color: "var(--text)" } : undefined}><ThumbsUp size={16} fill={rating === "up" ? "currentColor" : "none"} /></button>
            <button className="icon-btn sm" aria-label="Bad response" onClick={() => rate("down")} style={rating === "down" ? { color: "var(--text)" } : undefined}><ThumbsDown size={16} fill={rating === "down" ? "currentColor" : "none"} /></button>
            <button className="icon-btn sm" aria-label="Copy" onClick={() => { navigator.clipboard.writeText(turn.content); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>
            {turn.runId && rating && feedback !== "open" && feedback !== "saved" && <button className="icon-btn sm" title="Turn into eval case" onClick={() => setFeedback("open")}><FlaskConical size={16} /></button>}
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
  const [liveStart, setLiveStart] = useState<number>();
  const [note, setNote] = useState<string>();
  const [approval, setApproval] = useState<Approval | null>(null);
  const [pendingUser, setPendingUser] = useState<Turn | null>(null);
  const [error, setError] = useState<string>();
  // Watching a run, not owning it: leaving this view only stops watching. The run carries on on the server.
  const watchRef = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const project = state?.projects.find((p) => p.id === projectId);
  const yolo = !!state?.config.approval.yolo;

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
      setProjectId(c.projectId);
      setModel(c.model);
      if (c.running) follow(chatId);
    }).catch(() => go({ kind: "chat" }));
  }, [chatId]);

  useEffect(() => {
    if (!model && state) setModel(state.config.defaults.chatModel);
  }, [state, model]);

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
    const onEvent = (e: AgentEvent) => {
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
          default: return t;
        }
      });
      if (e.type === "run_start" && e.at) setLiveStart(e.at);
      if (e.type === "note" && e.text) setNote(e.text);
      if (e.type === "approval_request") setApproval({ id: e.id, tool: e.tool, args: e.args });
      if (e.type === "approval_done" || e.type === "tool_result") setApproval((a) => (a && (e.type !== "approval_done" || a.id === e.id) ? null : a));
    };
    try {
      await followChat(id, onEvent, ac.signal);
    } catch {
      /* stopped watching, or the connection dropped: the saved chat below is the source of truth */
    }
    if (ac.signal.aborted) return;
    const fresh = await api.get<Chat>(`/chats/${id}`).catch(() => null);
    if (fresh) setChat(fresh);
    setLive(null);
    setPendingUser(null);
    setApproval(null);
    setNote(undefined);
    watchRef.current = null;
    refresh();
    if (fresh?.running) follow(id);
  };

  const send = async (text = draft) => {
    if (!text.trim() || live) return;
    setError(undefined);
    setDraft("");
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
      setPendingUser({ id: "pending", role: "user", content: text, createdAt: new Date().toISOString() });
      await sendMessage(id, text, model);
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
      setError((e as Error).message);
    }
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

  const answer = async (allow: boolean) => {
    if (!approval) return;
    await api.post(`/approvals/${approval.id}`, { allow });
    setApproval(null);
  };

  const turns = [...(chat?.turns ?? []), ...(pendingUser ? [pendingUser] : [])];
  const chatFiles = [...new Map([...turns, ...(live ? [live] : [])].flatMap((t) => t.files ?? []).map((f) => [f.path, f])).values()].reverse();
  const slotCtx = { projectId, chatId: cid, send: (t: string) => (live ? setDraft(t) : send(t)), setDraft: (t: string) => { setDraft(t); textarea.current?.focus(); } };
  const empty = !turns.length && !live;
  const noKey = state && !state.config.hasOpenRouterKey && (model ?? "").startsWith("openrouter:");

  return (
    <>
      <div className="topbar">
        <span className="title ellipsis">{chat?.title && chat.title !== "New chat" ? chat.title : ""}</span>
        <div className="spacer" />
        <ActiveRepoChip chatId={cid} projectId={projectId} />
        <Slot name="chat.header" ctx={slotCtx} />
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
              <h1 className="s">What should we work on?</h1>
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
              {turns.map((t) => (t.role === "user" ? <div key={t.id} className="msg user"><div className="bubble">{t.content}</div></div> : <AssistantTurn key={t.id} turn={t} chatId={chat?.id} />))}
              {live && <AssistantTurn turn={live} streaming approval={approval} onApprove={answer} note={note} startedAt={liveStart} />}
            </>
          )}
        </div>
      </div>

      <div className="composer-wrap">
        {error && <div className="banner bad">{error}</div>}
        {noKey && <div className="banner">Add your OpenRouter key in <a href="#/settings">Settings</a> to chat with {model?.replace("openrouter:", "")}.</div>}
        <div className="composer">
          <textarea
            ref={textarea}
            rows={1}
            placeholder={project ? `Message Syph in ${project.name}` : "Message Syph"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-row">
            <div className="model-menu">
              <button className={`pill ${project ? "on" : ""}`} onClick={() => setMenu((m) => !m)}>
                <FolderClosed size={15} /> {project?.name ?? "No project"}
              </button>
              {menu && (
                <div className="menu" style={{ left: 0 }}>
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
            <RepoComposerMenu chatId={cid} projectId={projectId} ensureChat={ensureChat} />
            <button className={`pill yolo ${yolo ? "on" : ""}`} onClick={toggleYolo} title={yolo ? "YOLO is on: shell (PowerShell) and other ask-first tools run without asking. Click to turn off." : "Turn on YOLO: run shell (PowerShell) and other ask-first tools without asking."}>
              <Zap size={15} fill={yolo ? "currentColor" : "none"} /> {yolo ? "YOLO on" : "Ask first"}
            </button>
            <Slot name="chat.composer" ctx={slotCtx} />
            <div className="spacer" />
            <ModelPicker value={model} onChange={setModel} />
            {live ? (
              <button className="send ready" onClick={stop} aria-label="Stop"><Square size={14} fill="currentColor" /></button>
            ) : (
              <button className={`send ${draft.trim() ? "ready" : ""}`} onClick={() => send()} aria-label="Send"><ArrowUp size={20} /></button>
            )}
          </div>
        </div>
        <div className="disclaimer">{live ? "This chat keeps running if you switch chats or pages. " : ""}Syph runs locally. Changes to its own skills, memory or prompts wait for your approval in Evolve.</div>
      </div>
    </>
  );
}

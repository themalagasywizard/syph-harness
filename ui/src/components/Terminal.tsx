// The chat's command log: every terminal command Syph ran, where, how it ended, its output, and a
// Stop button for the ones still running. Also shows (and takes back) how commands are allowed.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Loader2, Square, SquareTerminal, X } from "lucide-react";
import { api, onServerEvent, relTime, type TerminalEntry, type TerminalState } from "../api";
import { useOutside } from "./Repos";

export function useTerminal(chatId?: string) {
  const [t, setT] = useState<TerminalState | null>(null);
  const reload = async () => {
    if (!chatId) return setT(null);
    setT(await api.get<TerminalState>(`/chats/${chatId}/terminal`).catch(() => null));
  };
  useEffect(() => {
    reload();
    if (!chatId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Server events come at most once a second per running command; batch them.
    const off = onServerEvent((e) => {
      if ((e.type === "terminal" && e.chatId === chatId) || e.type === "chats") {
        clearTimeout(timer);
        timer = setTimeout(reload, 150);
      }
    });
    return () => (off(), clearTimeout(timer));
  }, [chatId]);
  return { t, reload };
}

const statusText = (e: TerminalEntry) =>
  e.status === "running" ? (e.background ? "running in background" : "running") : e.status === "done" ? "exit 0" : e.status === "failed" ? `exit ${e.exitCode ?? "?"}` : e.status === "timeout" ? "timed out" : "stopped";

function duration(e: TerminalEntry) {
  const ms = (e.endedAt ? Date.parse(e.endedAt) : Date.now()) - Date.parse(e.startedAt);
  if (!(ms >= 0)) return "";
  return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function EntryRow({ e, onStop, startOpen }: { e: TerminalEntry; onStop: (id: string) => void; startOpen?: boolean }) {
  const [open, setOpen] = useState(!!startOpen);
  const out = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (open && out.current) out.current.scrollTop = out.current.scrollHeight;
  }, [open, e.output]);
  return (
    <div className={`term-entry ${e.status}`}>
      <div className="te-head">
        <button className="te-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <code className="te-cmd ellipsis" title={e.command}>{e.shell === "cmd" ? "cmd> " : e.shell === "powershell" ? "PS> " : "$ "}{e.command}</code>
        </button>
        <span className={`te-status ${e.status}`}>{e.status === "running" && <Loader2 size={12} className="spin" />}{statusText(e)}</span>
        {e.status === "running" && <button className="btn ghost sm te-stop" onClick={() => onStop(e.id)} title="Stop this command and everything it started"><Square size={11} fill="currentColor" /> Stop</button>}
      </div>
      <div className="te-meta hint"><span className="ellipsis" title={e.cwd}>{e.cwd}</span> · {relTime(e.startedAt)}{duration(e) ? ` · ${duration(e)}` : ""}</div>
      {open && <pre ref={out} className="te-out">{e.output || "(no output)"}</pre>}
    </div>
  );
}

/** The Terminal pill in the chat's top bar, with the command log under it. */
export function TerminalPill({ chatId, live }: { chatId?: string; live?: boolean }) {
  const { t, reload } = useTerminal(chatId);
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  // While something runs, refresh the output now and then (the server sends at most one event a second).
  const running = t?.entries.filter((e) => e.status === "running") ?? [];
  useEffect(() => {
    if (!running.length || !open) return;
    const i = setInterval(reload, 1500);
    return () => clearInterval(i);
  }, [running.length, open]);
  useEffect(() => {
    if (!live) reload();
  }, [live]);
  if (!chatId || !t || (!t.entries.length && !t.session)) return null;
  const stop = async (id: string) => {
    await api.post(`/terminal/${id}/stop`, {});
    reload();
  };
  const endSession = async () => {
    await api.del(`/chats/${chatId}/terminal/session`);
    reload();
  };
  const list = [...t.entries].reverse().slice(0, 60);
  return (
    <div className="model-menu" ref={ref}>
      <button className={`pill term-pill ${running.length ? "busy" : ""} ${open ? "on" : ""}`} onClick={() => setOpen((o) => !o)} title="Commands Syph ran in the terminal">
        <SquareTerminal size={15} /> <span className="pill-label">{running.length ? `${running.length} running` : `${t.entries.length} command${t.entries.length === 1 ? "" : "s"}`}</span>
      </button>
      {open && (
        <div className="menu term-menu" style={{ right: 0, left: "auto", top: 40, bottom: "auto" }}>
          <div className="term-head">
            <SquareTerminal size={15} /> <b>Command log</b>
            <div className="spacer" />
            {running.length > 1 && <button className="btn ghost sm" onClick={() => running.forEach((e) => stop(e.id))}><Square size={11} fill="currentColor" /> Stop all</button>}
            <button className="icon-btn sm" onClick={() => setOpen(false)} aria-label="Close"><X size={15} /></button>
          </div>
          <div className="term-perm hint">
            {t.yolo ? <>YOLO is on: commands run without asking.</> : t.mode === "auto" ? <>Commands in folders with write access run without asking (Settings → Approvals).</> : t.session ? <><Check size={12} /> Commands are allowed for this chat until Syph restarts. <button className="link-btn" onClick={endSession}>Ask again</button></> : <>Syph asks before each command. Read-only folders always ask.</>}
          </div>
          <div className="term-list">
            {list.map((e, i) => <EntryRow key={e.id} e={e} onStop={stop} startOpen={i === 0 && e.status === "running"} />)}
            {!list.length && <div className="hint" style={{ padding: 12 }}>No commands yet.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/** The question card for a terminal command: what, where, and the four answers. */
export function CommandApproval({ args, reason, onAnswer }: { args: { command?: string; cwd?: string; background?: boolean; shell?: string }; reason?: string; onAnswer: (a: boolean | "always" | "session") => void }) {
  const where = /in (.+?)( \(a read-only folder\))?\.$/.exec(reason ?? "");
  const readOnly = !!where?.[2];
  return (
    <div className="approval cmd-approval">
      <SquareTerminal size={18} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="name">Run this command{args.background ? " in the background" : ""}?</div>
        <pre className="cmd-line">{args.shell === "cmd" ? "cmd> " : navigator.userAgent.includes("Windows") ? "PS> " : "$ "}{args.command}</pre>
        <div className="hint ellipsis" title={where?.[1]}>in {where?.[1] ?? args.cwd ?? "the workspace"}{readOnly ? " · read-only folder" : ""}</div>
        <div className="cmd-actions">
          <button className="btn ghost sm" onClick={() => onAnswer(false)}>Deny</button>
          <div className="spacer" />
          {!readOnly && <button className="btn tonal sm" onClick={() => onAnswer("session")} title="Run this and the chat's next commands in writable folders without asking, until Syph restarts">Allow for this chat</button>}
          <button className="btn tonal sm" onClick={() => onAnswer("always")} title="Run this exact command without asking from now on">Always allow this command</button>
          <button className="btn primary sm" onClick={() => onAnswer(true)}>Allow once</button>
        </div>
      </div>
    </div>
  );
}

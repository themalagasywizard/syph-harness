// Interface changes Syph made to itself: buttons and pages declared in ~/.syph/ui/*.json, drawn here
// by the app's own components. Each one is fenced by an error boundary, so a bad one can't take the
// app down, and safe mode (?safe=1, Settings, or the tray) hides them all.
import { Component, createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2, X, BookOpen, Bookmark, Bot, Box, Bug, Calendar, ChartBar, Clipboard, Cloud, Code, Database, DollarSign, Download, FilePlus, FileText, Folder, FolderGit, FolderOpen, GitBranch, GitPullRequest, Github, Globe, Image, LayoutDashboard, Link, List, Mail, MessageSquare, Play, Plug, Plus, Presentation, RefreshCw, Rocket, Search, Send, ShoppingCart, Sparkles, SquareCheck, Star, Table, Terminal, Upload, Users, Wrench, Zap } from "lucide-react";
import { api } from "./api";
import { useApp } from "./App";

export type UiAction =
  | { type: "prompt"; text: string; newChat?: boolean }
  | { type: "draft"; text: string }
  | { type: "link"; url: string }
  | { type: "picker"; title: string; source: unknown; label: string; detail?: string; empty?: string; then: UiAction }
  | { type: "form"; title: string; fields: { key: string; label: string; placeholder?: string; required?: boolean; multiline?: boolean }[]; submit?: string; then: UiAction }
  | { type: "clone_repo"; connector?: string; url: string; name?: string; hosts: string[]; then?: UiAction };

export interface UiButton { id: string; slot: string; type: "button"; label: string; icon?: string; tooltip?: string; when?: { connector?: string; project?: boolean }; action: UiAction }
export interface UiPage { id: string; slot: "sidebar"; type: "page"; label: string; icon?: string; html: string }
export interface UiExtension { id: string; name: string; description: string; elements: (UiButton | UiPage)[] }
export interface UiItem { id: string; file: string; enabled: boolean; spec?: UiExtension; error?: string }

const ICONS: Record<string, React.ComponentType<{ size?: number }>> = { "github": Github, "git-branch": GitBranch, "git-pull-request": GitPullRequest, "folder-git": FolderGit, "folder": Folder, "folder-open": FolderOpen, "file-text": FileText, "file-plus": FilePlus, "plug": Plug, "link": Link, "rocket": Rocket, "sparkles": Sparkles, "search": Search, "play": Play, "zap": Zap, "database": Database, "cloud": Cloud, "mail": Mail, "calendar": Calendar, "terminal": Terminal, "wrench": Wrench, "star": Star, "bookmark": Bookmark, "globe": Globe, "download": Download, "upload": Upload, "refresh-cw": RefreshCw, "plus": Plus, "list": List, "layout-dashboard": LayoutDashboard, "bot": Bot, "code": Code, "box": Box, "bar-chart": ChartBar, "presentation": Presentation, "table": Table, "image": Image, "message-square": MessageSquare, "send": Send, "clipboard": Clipboard, "check-square": SquareCheck, "bug": Bug, "book-open": BookOpen, "users": Users, "shopping-cart": ShoppingCart, "dollar-sign": DollarSign };

export function ExtIcon({ name, size = 15 }: { name?: string; size?: number }) {
  const C = ICONS[name ?? ""] ?? Sparkles;
  return <C size={size} />;
}

export const safeFromUrl = () => new URLSearchParams(location.search).has("safe");

/** Where a button sits, and what it can do there. */
export interface SlotCtx {
  projectId?: string;
  chatId?: string;
  send?: (text: string) => void;
  setDraft?: (text: string) => void;
}

interface ExtState {
  items: UiItem[];
  safe: boolean;
  safeUrl: boolean;
  reload: () => void;
  run: (ext: string, el: UiButton, ctx: SlotCtx) => void;
  ready: Set<string>;
}

const ExtCtx = createContext<ExtState>({ items: [], safe: true, safeUrl: false, reload: () => {}, run: () => {}, ready: new Set() });
export const useExt = () => useContext(ExtCtx);

const fill = (t: string, vars: Record<string, unknown>, url = false) => {
  const whole = /^\{[\w.]+\}$/.test(t);
  return t.replace(/\{([\w.]+)\}/g, (_, k: string) => {
    const v = vars[k];
    const s = v === undefined || v === null ? "" : String(v);
    return url && !whole ? encodeURIComponent(s).replace(/%2F/gi, "/") : s;
  });
};

type Modal =
  | { kind: "picker"; ext: string; el: UiButton; step: number; action: Extract<UiAction, { type: "picker" }>; vars: Record<string, unknown>; ctx: SlotCtx }
  | { kind: "form"; ext: string; el: UiButton; step: number; action: Extract<UiAction, { type: "form" }>; vars: Record<string, unknown>; ctx: SlotCtx }
  | { kind: "busy"; text: string; error?: string; done?: string; path?: string };

export function ExtProvider({ children, tick }: { children: ReactNode; tick: number }) {
  const { state, go } = useApp();
  const [items, setItems] = useState<UiItem[]>([]);
  const [safeMode, setSafeMode] = useState(false);
  const [ready, setReady] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<Modal | null>(null);
  const safeUrl = safeFromUrl();

  const reload = useCallback(() => {
    api.get<{ safeMode: boolean; items: UiItem[] }>("/ui").then((r) => { setItems(r.items); setSafeMode(r.safeMode); }).catch(() => {});
    api.get<{ id: string; enabled: boolean; state: string }[]>("/connectors").then((cs) => setReady(new Set(cs.filter((c) => c.enabled && c.state === "ready").map((c) => c.id)))).catch(() => {});
  }, []);
  useEffect(reload, [tick, reload]);

  const exec = useCallback(async (ext: string, el: UiButton, action: UiAction | undefined, step: number, vars: Record<string, unknown>, ctx: SlotCtx) => {
    if (!action) return setModal(null);
    switch (action.type) {
      case "prompt": {
        setModal(null);
        const text = fill(action.text, vars);
        if (ctx.send && !action.newChat) return ctx.send(text);
        return go({ kind: "chat", projectId: ctx.projectId, draft: text, send: true });
      }
      case "draft": {
        setModal(null);
        const text = fill(action.text, vars);
        return ctx.setDraft ? ctx.setDraft(text) : go({ kind: "chat", projectId: ctx.projectId, draft: text });
      }
      case "link": {
        setModal(null);
        const url = fill(action.url, vars, true);
        if (url.startsWith("#/")) location.hash = url.slice(1);
        else window.open(url, "_blank", "noopener");
        return;
      }
      case "picker":
        return setModal({ kind: "picker", ext, el, step, action, vars, ctx });
      case "form":
        return setModal({ kind: "form", ext, el, step, action, vars, ctx });
      case "clone_repo": {
        const url = fill(action.url, vars, true);
        setModal({ kind: "busy", text: `Cloning ${url}…` });
        try {
          const r = await api.post<{ repo: { name: string; url: string; path: string }; already: boolean }>(`/ui/${ext}/${el.id}/clone`, { step, vars, projectId: ctx.projectId });
          const next = { ...vars, "repo.path": r.repo.path, "repo.name": r.repo.name, "repo.url": r.repo.url };
          if (action.then) return exec(ext, el, action.then, step + 1, next, ctx);
          setModal({ kind: "busy", text: "", done: `${r.already ? "Already connected" : "Connected"}: ${r.repo.name}`, path: r.repo.path });
        } catch (e) {
          setModal({ kind: "busy", text: `Cloning ${url}`, error: (e as Error).message });
        }
      }
    }
  }, [go]);

  const run = useCallback((ext: string, el: UiButton, ctx: SlotCtx) => {
    const project = state?.projects.find((p) => p.id === ctx.projectId) as any;
    const vars: Record<string, unknown> = { "project.id": ctx.projectId ?? "", "project.name": project?.name ?? "", "project.path": project?.folder ?? "", "chat.id": ctx.chatId ?? "", today: new Date().toISOString().slice(0, 10) };
    exec(ext, el, el.action, 0, vars, ctx);
  }, [exec, state]);

  const value = useMemo(() => ({ items, safe: safeMode || safeUrl, safeUrl, reload, run, ready }), [items, safeMode, safeUrl, reload, run, ready]);
  return (
    <ExtCtx.Provider value={value}>
      {children}
      {modal?.kind === "picker" && <Picker m={modal} close={() => setModal(null)} pick={(item) => exec(modal.ext, modal.el, modal.action.then, modal.step + 1, { ...modal.vars, ...item }, modal.ctx)} />}
      {modal?.kind === "form" && <Form m={modal} close={() => setModal(null)} submit={(v) => exec(modal.ext, modal.el, modal.action.then, modal.step + 1, { ...modal.vars, ...v }, modal.ctx)} />}
      {modal?.kind === "busy" && <Busy m={modal} close={() => setModal(null)} />}
    </ExtCtx.Provider>
  );
}

function Picker({ m, close, pick }: { m: Extract<Modal, { kind: "picker" }>; close: () => void; pick: (item: Record<string, unknown>) => void }) {
  const [items, setItems] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<string>();
  const [q, setQ] = useState("");
  useEffect(() => {
    api.post<{ items: Record<string, unknown>[] }>(`/ui/${m.ext}/${m.el.id}/source`, { step: m.step, vars: m.vars, projectId: m.ctx.projectId }).then((r) => setItems(r.items)).catch((e) => setError((e as Error).message));
  }, []);
  const shown = (items ?? []).map((it) => ({ it, label: fill(m.action.label, it), detail: m.action.detail ? fill(m.action.detail, it) : "" })).filter((x) => !q || `${x.label} ${x.detail}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="scrim" onClick={close}>
      <div className="modal picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head"><h3>{m.action.title}</h3><button className="icon-btn sm" onClick={close} aria-label="Close"><X size={18} /></button></div>
        <div className="picker-search"><Search size={16} /><input autoFocus className="input" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="picker-list">
          {error && <div className="banner bad">{error}</div>}
          {!items && !error && <div className="hint" style={{ padding: 16 }}><Loader2 size={14} className="spin" /> Loading…</div>}
          {items && !shown.length && <div className="hint" style={{ padding: 16 }}>{q ? "Nothing matches." : m.action.empty ?? "Nothing to show."}</div>}
          {shown.slice(0, 300).map((x, i) => (
            <button key={i} className="picker-item" onClick={() => pick(x.it)}>
              <span className="name ellipsis">{x.label || "(untitled)"}</span>
              {x.detail && <span className="hint ellipsis">{x.detail}</span>}
            </button>
          ))}
        </div>
        <div className="picker-foot hint">Added by Syph: {m.el.label}</div>
      </div>
    </div>
  );
}

function Form({ m, close, submit }: { m: Extract<Modal, { kind: "form" }>; close: () => void; submit: (v: Record<string, string>) => void }) {
  const [v, setV] = useState<Record<string, string>>({});
  const missing = m.action.fields.some((f) => f.required && !v[f.key]?.trim());
  return (
    <div className="scrim" onClick={close}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (!missing) submit(v); }}>
        <h3>{m.action.title}</h3>
        {m.action.fields.map((f, i) => (
          <div className="field" key={f.key}>
            <label>{f.label}{f.required ? "" : " (optional)"}</label>
            {f.multiline ? <textarea className="input" autoFocus={i === 0} placeholder={f.placeholder} value={v[f.key] ?? ""} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} /> : <input className="input" autoFocus={i === 0} placeholder={f.placeholder} value={v[f.key] ?? ""} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />}
          </div>
        ))}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={close}>Cancel</button>
          <button type="submit" className="btn primary" disabled={missing}>{m.action.submit ?? "Continue"}</button>
        </div>
      </form>
    </div>
  );
}

function Busy({ m, close }: { m: Extract<Modal, { kind: "busy" }>; close: () => void }) {
  return (
    <div className="scrim" onClick={m.error || m.done ? close : undefined}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {m.done ? <h3>{m.done}</h3> : <h3 style={{ display: "flex", gap: 10, alignItems: "center" }}>{!m.error && <Loader2 size={18} className="spin" />} {m.text}</h3>}
        {m.path && <p className="hint">Saved at <code>{m.path}</code></p>}
        {m.error && <div className="banner bad">{m.error}</div>}
        {(m.error || m.done) && <div className="modal-foot"><button className="btn primary" onClick={close}>OK</button></div>}
      </div>
    </div>
  );
}

class Fence extends Component<{ children: ReactNode; name: string }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  render() {
    return this.state.error ? <span className="hint" title={this.state.error}>{this.props.name} failed to load</span> : this.props.children;
  }
}

/** Buttons Syph added to this place in the app. */
export function Slot({ name, ctx, variant = "pill" }: { name: string; ctx: SlotCtx; variant?: "pill" | "btn" | "chip" | "nav" }) {
  const { items, safe, run, ready } = useExt();
  if (safe) return null;
  const els = items.flatMap((u) => (u.enabled && u.spec ? u.spec.elements.filter((e) => e.slot === name && e.type === "button").map((e) => ({ ext: u.spec!.id, el: e as UiButton })) : []));
  const visible = els.filter(({ el }) => (!el.when?.connector || ready.has(el.when.connector)) && (!el.when?.project || ctx.projectId));
  if (!visible.length) return null;
  return (
    <>
      {visible.map(({ ext, el }) => (
        <Fence key={`${ext}/${el.id}`} name={el.label}>
          {variant === "chip" ? (
            <button className="chip" onClick={() => run(ext, el, ctx)} title={el.tooltip}>
              <p>{el.label}</p>
              <span className="ic"><ExtIcon name={el.icon} size={18} /></span>
            </button>
          ) : variant === "nav" ? (
            <button className="nav-item" onClick={() => run(ext, el, ctx)} title={el.tooltip ?? el.label}><ExtIcon name={el.icon} size={18} /><span className="nav-label">{el.label}</span></button>
          ) : (
            <button className={variant === "btn" ? "btn tonal" : "pill ext"} onClick={() => run(ext, el, ctx)} title={el.tooltip ?? `${el.label} (added by Syph)`}>
              <ExtIcon name={el.icon} /> {el.label}
            </button>
          )}
        </Fence>
      ))}
    </>
  );
}

/** Pages Syph added to the sidebar. */
export function useSidebarPages() {
  const { items, safe } = useExt();
  if (safe) return [];
  return items.flatMap((u) => (u.enabled && u.spec ? u.spec.elements.filter((e): e is UiPage => e.type === "page").map((p) => ({ ext: u.spec!.id, page: p })) : []));
}

export function ExtPage({ ext, id }: { ext: string; id: string }) {
  const { items, safe } = useExt();
  const { go } = useApp();
  const page = items.find((u) => u.spec?.id === ext && u.enabled)?.spec?.elements.find((e): e is UiPage => e.id === id && e.type === "page");
  useEffect(() => {
    // The page runs sandboxed with no access to Syph; it can only suggest a message.
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (d && typeof d === "object" && d.syph === "draft" && typeof d.text === "string") go({ kind: "chat", draft: d.text.slice(0, 4000) });
    };
    addEventListener("message", onMsg);
    return () => removeEventListener("message", onMsg);
  }, []);
  if (safe) return <div className="empty" style={{ margin: "auto" }}>Safe mode is on, so pages Syph added are hidden.</div>;
  if (!page) return <div className="empty" style={{ margin: "auto" }}>This page was removed or switched off.</div>;
  return (
    <div className="ext-page">
      <div className="topbar"><span className="title">{page.label}</span><span className="hint">Added by Syph</span></div>
      <iframe sandbox="allow-scripts allow-forms" srcDoc={page.html} title={page.label} />
    </div>
  );
}

/** The whole app is fenced too: if something breaks, offer safe mode instead of a blank window. */
export class AppFence extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h2>Something in Syph's window broke.</h2>
        <p className="hint">{this.state.error.message}</p>
        <p>Safe mode opens Syph without any of the interface changes it made to itself. From Settings → Interface you can switch one off or reset them all.</p>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn primary" onClick={() => { location.href = `${location.pathname}?safe=1#/settings`; }}>Open in safe mode</button>
          <button className="btn ghost" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}

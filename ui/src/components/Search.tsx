// Sidebar search: type to find chats (by title and by what was said in them), settings and
// pages, then press Enter or click to go there. Ctrl+K (Cmd+K on a Mac) jumps to the box.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Clock, Dna, FolderClosed, MessageSquare, Plug, Search, Settings, SlidersHorizontal, X } from "lucide-react";
import { useApp, type View } from "../App";
import { api } from "../api";
import { SETTINGS_SECTIONS } from "../settingsIndex";

interface ChatHit {
  id: string;
  title: string;
  projectId?: string;
  updatedAt: string;
  snippet?: string;
}

interface Result {
  key: string;
  group: "Chats" | "Settings" | "Go to";
  icon: ReactNode;
  title: string;
  sub?: string;
  view: View;
}

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (hay: string, ws: string[]) => {
  const h = hay.toLowerCase();
  return ws.every((w) => h.includes(w));
};

/** Bold the parts of `text` that match the query. */
function Hl({ text, ws }: { text: string; ws: string[] }) {
  if (!ws.length) return <>{text}</>;
  const re = new RegExp(`(${ws.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig");
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>))}</>;
}

export function useSearchShortcut(focus: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        focus();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [focus]);
}

export function SearchBox({ query, setQuery, inputRef, onKeyDown }: { query: string; setQuery: (q: string) => void; inputRef: React.RefObject<HTMLInputElement | null>; onKeyDown: (e: React.KeyboardEvent) => void }) {
  const mac = navigator.platform.toLowerCase().includes("mac");
  return (
    <label className={`side-search ${query ? "active" : ""}`}>
      <Search size={16} />
      <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} placeholder="Search" aria-label="Search chats and settings" spellCheck={false} />
      {query ? (
        <button className="ss-clear" onClick={() => { setQuery(""); inputRef.current?.focus(); }} aria-label="Clear search"><X size={14} /></button>
      ) : (
        <kbd>{mac ? "⌘K" : "Ctrl K"}</kbd>
      )}
    </label>
  );
}

export function useSearchResults(query: string) {
  const { state } = useApp();
  const [serverHits, setServerHits] = useState<{ q: string; hits: ChatHit[] }>({ q: "", hits: [] });
  const ws = useMemo(() => words(query), [query]);

  // Message text lives on the server; ask it after a short pause in typing.
  useEffect(() => {
    if (!ws.length) return;
    const q = query.trim();
    const t = setTimeout(() => {
      api.get<ChatHit[]>(`/search/chats?q=${encodeURIComponent(q)}`).then((hits) => setServerHits({ q, hits })).catch(() => {});
    }, 150);
    return () => clearTimeout(t);
  }, [query, ws.length]);

  const results = useMemo<Result[]>(() => {
    if (!ws.length) return [];
    const projectName = (id?: string) => state?.projects.find((p) => p.id === id)?.name;
    const out: Result[] = [];

    // Chats: titles match at once; message matches arrive from the server with a snippet.
    const seen = new Set<string>();
    for (const c of state?.chats ?? []) {
      if (!matches(c.title, ws)) continue;
      seen.add(c.id);
      out.push({ key: `c-${c.id}`, group: "Chats", icon: <MessageSquare size={15} />, title: c.title, sub: projectName(c.projectId), view: { kind: "chat", chatId: c.id } });
    }
    if (serverHits.q === query.trim()) {
      for (const h of serverHits.hits) {
        if (seen.has(h.id)) continue;
        out.push({ key: `c-${h.id}`, group: "Chats", icon: <MessageSquare size={15} />, title: h.title, sub: h.snippet ?? projectName(h.projectId), view: { kind: "chat", chatId: h.id } });
      }
    }
    // Keep the chat list short so settings stay in view.
    if (out.length > 8) out.length = 8;

    // Settings: a single setting by name, or a whole section by its title or related words.
    const settings: Result[] = [];
    for (const s of SETTINGS_SECTIONS) {
      if (matches(`${s.title} ${s.group} ${s.keywords ?? ""}`, ws)) {
        settings.push({ key: `s-${s.id}`, group: "Settings", icon: <SlidersHorizontal size={15} />, title: s.title, sub: s.items.slice(0, 3).join(", "), view: { kind: "settings", section: s.id } });
      }
      for (const it of s.items) {
        if (matches(it, ws)) settings.push({ key: `s-${s.id}-${it}`, group: "Settings", icon: <SlidersHorizontal size={15} />, title: it, sub: s.title, view: { kind: "settings", section: s.id, item: it } });
      }
    }
    out.push(...settings.slice(0, 8));

    // Pages and projects.
    const pages: [string, ReactNode, View][] = [
      ["Projects", <FolderClosed size={15} />, { kind: "projects" }],
      ["Tasks", <Clock size={15} />, { kind: "tasks" }],
      ["Evolve", <Dna size={15} />, { kind: "evolve" }],
      ["Connectors", <Plug size={15} />, { kind: "connectors" }],
      ["Settings", <Settings size={15} />, { kind: "settings" }],
    ];
    for (const [title, icon, view] of pages) if (matches(title, ws)) out.push({ key: `p-${title}`, group: "Go to", icon, title, view });
    for (const p of state?.projects ?? []) {
      if (matches(p.name, ws)) out.push({ key: `pr-${p.id}`, group: "Go to", icon: <span className="dot" style={{ background: p.color }} />, title: p.name, sub: "Project", view: { kind: "projects", projectId: p.id } });
    }
    return out;
  }, [ws, query, state, serverHits]);

  return { results, ws, searching: !!ws.length && serverHits.q !== query.trim() };
}

export function SearchResults({ results, ws, active, setActive, open, searching }: { results: Result[]; ws: string[]; active: number; setActive: (i: number) => void; open: (r: Result) => void; searching: boolean }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  if (!results.length) return <div className="search-results"><div className="hint sr-empty">{searching ? "Searching…" : "Nothing found."}</div></div>;
  return (
    <div className="search-results nav" ref={list} role="listbox">
      {results.map((r, i) => (
        <Fragment key={r.key}>
          {r.group !== results[i - 1]?.group && <div className="section-label">{r.group}</div>}
          <button data-i={i} role="option" aria-selected={i === active} className={`nav-item sr-item ${i === active ? "active" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => open(r)}>
            <span className="sr-icon">{r.icon}</span>
            <span className="sr-text">
              <span className="sr-title"><Hl text={r.title} ws={ws} /></span>
              {r.sub && <span className="sr-sub"><Hl text={r.sub} ws={ws} /></span>}
            </span>
          </button>
        </Fragment>
      ))}
    </div>
  );
}

export type { Result as SearchResult };

import { useCallback, useRef, useState } from "react";
import { Clock, Dna, FolderClosed, Menu, Plug, Plus, Search, Settings, Smartphone, Trash2 } from "lucide-react";
import { useApp, type View } from "../App";
import { api } from "../api";
import { Mark, Wordmark } from "./Logo";
import { ExtIcon, Slot, useSidebarPages } from "../ext";
import { shell } from "./TitleBar";
import { SearchBox, SearchResults, useSearchResults, useSearchShortcut, type SearchResult } from "./Search";

export function Sidebar({ view, collapsed, toggle }: { view: View; collapsed: boolean; toggle: () => void }) {
  const { state, go, refresh } = useApp();
  const pages = useSidebarPages();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { results, ws, searching } = useSearchResults(query);
  const focusSearch = useCallback(() => {
    if (!collapsed) return inputRef.current?.select();
    toggle();
    setTimeout(() => inputRef.current?.focus(), 220);
  }, [collapsed, toggle]);
  useSearchShortcut(focusSearch);
  const changeQuery = (q: string) => {
    setQuery(q);
    setActive(0);
  };
  const openResult = (r: SearchResult) => {
    go(r.view);
    changeQuery("");
    inputRef.current?.blur();
  };
  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      changeQuery("");
      inputRef.current?.blur();
    } else if (e.key === "ArrowDown" && results.length) {
      e.preventDefault();
      setActive((active + 1) % results.length);
    } else if (e.key === "ArrowUp" && results.length) {
      e.preventDefault();
      setActive((active - 1 + results.length) % results.length);
    } else if (e.key === "Enter" && results[active]) {
      openResult(results[active]);
    }
  };
  const searching_ = !collapsed && !!ws.length;
  const chats = state?.chats ?? [];
  const colorOf = (id?: string) => state?.projects.find((p) => p.id === id)?.color ?? "var(--faint)";
  const item = (active: boolean, onClick: () => void, icon: React.ReactNode, label: string, badge?: number) => (
    <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick} title={label}>
      {icon}
      <span className="nav-label">{label}</span>
      {!!badge && <span className="badge">{badge}</span>}
    </button>
  );

  const remove = async (id: string) => {
    await api.del(`/chats/${id}`);
    if (view.kind === "chat" && view.chatId === id) go({ kind: "chat" });
    refresh();
  };

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      {/* In the desktop app the title bar holds the toggle and the name instead. */}
      {!shell && <div className="brand">
        <button className="icon-btn" onClick={toggle} aria-label="Toggle sidebar">{collapsed ? <Mark size={20} /> : <Menu size={20} />}</button>
        {!collapsed && <Wordmark />}
      </div>}

      <button className="new-chat" onClick={() => go({ kind: "chat" })} title="New chat">
        <Plus size={20} />
        {!collapsed && <span>New chat</span>}
      </button>

      {collapsed ? (
        <button className="new-chat side-search-icon" onClick={focusSearch} title="Search (Ctrl K)" aria-label="Search"><Search size={18} /></button>
      ) : (
        <SearchBox query={query} setQuery={changeQuery} inputRef={inputRef} onKeyDown={onSearchKey} />
      )}

      {searching_ && <SearchResults results={results} ws={ws} active={active} setActive={setActive} open={openResult} searching={searching} />}

      <div className="side-main" hidden={searching_}>

      <nav className="nav">
        {item(view.kind === "projects", () => go({ kind: "projects" }), <FolderClosed size={18} />, "Projects")}
        {item(view.kind === "tasks", () => go({ kind: "tasks" }), <Clock size={18} />, "Tasks")}
        {item(view.kind === "evolve", () => go({ kind: "evolve" }), <Dna size={18} />, "Evolve", state?.pendingProposals)}
        {item(view.kind === "connectors", () => go({ kind: "connectors" }), <Plug size={18} />, "Connectors")}
        {pages.map(({ ext, page }) => <span key={`${ext}/${page.id}`}>{item(view.kind === "page" && view.ext === ext && view.id === page.id, () => go({ kind: "page", ext, id: page.id }), <ExtIcon name={page.icon} size={18} />, page.label)}</span>)}
        <Slot name="sidebar" ctx={{ projectId: view.kind === "projects" ? view.projectId : view.kind === "chat" ? view.projectId : undefined }} variant="nav" />
      </nav>

      <div className="section-label">Recent</div>
      <div className="recent nav">
        {chats.length === 0 && <div className="hint" style={{ padding: "4px 12px" }}>No chats yet.</div>}
        {chats.slice(0, 60).map((c) => (
          <div key={c.id} className={`nav-item chat-row ${view.kind === "chat" && view.chatId === c.id ? "active" : ""}`} onClick={() => go({ kind: "chat", chatId: c.id })} role="button" tabIndex={0}>
            <span className="dot" style={{ background: colorOf(c.projectId) }} />
            <span className="t">{c.title}</span>
            {c.status && <span className={`live-dot ${c.status}`} title={c.status === "waiting" ? "Waiting for your approval" : "Working"} />}
            <button className="row-del" aria-label="Delete chat" onClick={(e) => { e.stopPropagation(); remove(c.id); }}><Trash2 size={14} /></button>
          </div>
        ))}
      </div>
      </div>

      <div className="sidebar-foot nav">
        {item(false, () => go({ kind: "settings" }), <Smartphone size={18} />, "Connect phone")}
        {item(view.kind === "settings", () => go({ kind: "settings" }), <Settings size={18} />, "Settings")}
      </div>
    </aside>
  );
}

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./views/Chat";
import { ProjectsView } from "./views/Projects";
import { TasksView } from "./views/Tasks";
import { EvolveView } from "./views/Evolve";
import { SkillsView } from "./views/Skills";
import { SettingsView } from "./views/Settings";
import { ConnectorsView } from "./views/Connectors";
import { api, subscribe, type AppState, type BrowserState, type Job } from "./api";
import { FilePanel } from "./components/FilePreview";
import { BrowserPane } from "./components/BrowserPane";
import { ExtPage, ExtProvider, useExt } from "./ext";
import { TitleBar, shell } from "./components/TitleBar";

const EMPTY_BROWSER: BrowserState = {
  open: false,
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  agentActive: false,
  consoleErrors: [],
  devtoolsOpen: false,
  native: !!shell?.browser,
};

export type View =
  | { kind: "chat"; chatId?: string; projectId?: string; draft?: string; send?: boolean }
  | { kind: "page"; ext: string; id: string }
  | { kind: "projects"; projectId?: string }
  | { kind: "tasks" }
  | { kind: "evolve" }
  | { kind: "skills"; name?: string }
  | { kind: "settings"; section?: string; item?: string }
  | { kind: "connectors" };

interface Ctx {
  state: AppState | null;
  refresh: () => Promise<void>;
  go: (v: View) => void;
  jobs: Record<string, Job>;
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
  /** Bumped when something changed server-side (tasks, proposals). */
  tick: number;
  /** Open the preview panel for a file on disk. */
  showFile: (path: string | null) => void;
  shownFile: string | null;
  /** In-app browser side pane state & controls. */
  browser: BrowserState;
  openBrowser: (url?: string) => void;
  closeBrowser: () => void;
  toggleBrowser: () => void;
}

const AppCtx = createContext<Ctx>(null!);
export const useApp = () => useContext(AppCtx);

function readHash(): View {
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  const [kind, id] = path.split("/");
  const q = new URLSearchParams(query ?? "");
  if (kind === "projects") return { kind, projectId: id };
  if (kind === "page") return { kind, ext: id ?? "", id: path.split("/")[2] ?? "" };
  if (kind === "skills") return { kind, name: id ? decodeURIComponent(id) : undefined };
  if (kind === "settings") return { kind, section: id, item: q.get("item") ?? undefined };
  if (kind === "tasks" || kind === "evolve" || kind === "connectors") return { kind };
  return { kind: "chat", chatId: id, projectId: q.get("project") ?? undefined, draft: q.get("draft") ?? undefined, send: q.get("send") === "1" };
}

export default function App() {
  const [view, setView] = useState<View>(readHash);
  const [collapsed, setCollapsed] = useState(false);
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [tick, setTick] = useState(0);
  const [uiTick, setUiTick] = useState(0);
  const [shownFile, setShownFile] = useState<string | null>(null);
  const [browser, setBrowser] = useState<BrowserState>(EMPTY_BROWSER);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return (localStorage.getItem("syph.theme") as "dark" | "light") ?? "dark";
    } catch {
      return "dark";
    }
  });

  const closeBrowser = useCallback(() => {
    setBrowser((b) => ({ ...b, open: false }));
    if (shell?.browser) shell.browser.close().catch(() => {});
    else api.post("/browser/cmd", { action: "close" }).catch(() => {});
  }, []);

  const openBrowser = useCallback((url?: string) => {
    setShownFile(null);
    setBrowser((b) => ({ ...b, open: true, ...(url ? { url } : {}) }));
    if (shell?.browser) shell.browser.open(url).catch(() => {});
    else api.post("/browser/cmd", { action: "open", ...(url ? { url } : {}) }).catch(() => {});
  }, []);

  const toggleBrowser = useCallback(() => {
    setBrowser((cur) => {
      if (cur.open) {
        if (shell?.browser) shell.browser.close().catch(() => {});
        else api.post("/browser/cmd", { action: "close" }).catch(() => {});
        return { ...cur, open: false };
      }
      setShownFile(null);
      if (shell?.browser) shell.browser.open().catch(() => {});
      else api.post("/browser/cmd", { action: "open" }).catch(() => {});
      return { ...cur, open: true };
    });
  }, []);

  const showFile = useCallback((p: string | null) => {
    if (p) closeBrowser();
    setShownFile(p);
  }, [closeBrowser]);

  const refresh = useCallback(async () => {
    try {
      const next = await api.get<AppState>("/state");
      setState(next);
      if (next.browser) setBrowser((cur) => ({ ...cur, ...next.browser, open: cur.open || next.browser!.open }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    shell?.browser?.getState().then((s) => s && setBrowser((cur) => ({ ...cur, ...s }))).catch(() => {});
    const offNativeBrowser = shell?.browser?.onState((s) => {
      setBrowser((cur) => ({ ...cur, ...s }));
      if (s.open) setShownFile(null);
    });
    const onHash = () => setView(readHash());
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleBrowser();
      }
    };
    addEventListener("hashchange", onHash);
    addEventListener("keydown", onKey);
    const off = subscribe((e) => {
      if (e.type === "job") setJobs((j) => ({ ...j, [e.job.id]: e.job }));
      if (e.type === "browser" && e.state) {
        setBrowser((cur) => ({ ...cur, ...e.state }));
        if (e.state.open) setShownFile(null);
      }
      if (e.type === "chats" || e.type === "threads") {
        setTick((t) => t + 1);
        refresh();
      }
      if (e.type === "connectors") {
        setTick((t) => t + 1);
        setUiTick((t) => t + 1);
      }
      if (e.type === "ui") setUiTick((t) => t + 1);
      if (e.type === "task" || e.type === "proposal") {
        setTick((t) => t + 1);
        refresh();
      }
    });
    return () => {
      removeEventListener("hashchange", onHash);
      removeEventListener("keydown", onKey);
      offNativeBrowser?.();
      off();
    };
  }, [refresh, toggleBrowser]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // Recolour the window's own minimise / maximise / close buttons to match.
    const css = getComputedStyle(document.documentElement);
    shell?.setTitleBar({ color: css.getPropertyValue("--bg").trim(), symbolColor: css.getPropertyValue("--muted").trim() });
    try {
      localStorage.setItem("syph.theme", theme);
    } catch {
      /* private mode */
    }
  }, [theme]);

  const go = (v: View) => {
    if (v.kind === "page") {
      location.hash = `/page/${v.ext}/${v.id}`;
      return;
    }
    const id = v.kind === "chat" ? v.chatId : v.kind === "projects" ? v.projectId : v.kind === "settings" ? v.section : v.kind === "skills" ? v.name : undefined;
    const params = new URLSearchParams();
    if (v.kind === "chat" && !v.chatId && v.projectId) params.set("project", v.projectId);
    if (v.kind === "chat" && !v.chatId && v.draft) params.set("draft", v.draft);
    if (v.kind === "chat" && !v.chatId && v.draft && v.send) params.set("send", "1");
    if (v.kind === "settings" && v.item) params.set("item", v.item);
    const q = params.size ? `?${params}` : "";
    location.hash = `/${v.kind}${id ? "/" + id : ""}${q}`;
  };

  return (
    <AppCtx.Provider value={{ state, refresh, go, jobs, theme, setTheme, tick, showFile, shownFile, browser, openBrowser, closeBrowser, toggleBrowser }}>
      <ExtProvider tick={uiTick}>
      <div className={`frame ${shell ? `in-shell on-${shell.platform}` : ""}`}>
      {shell && (
        <TitleBar
          collapsed={collapsed}
          toggle={() => setCollapsed((c) => !c)}
          browserOpen={browser.open}
          browserActive={browser.agentActive || !!browser.url}
          toggleBrowser={toggleBrowser}
        />
      )}
      <div className={`app ${shownFile ? "with-panel" : ""} ${browser.open ? "with-browser" : ""}`}>
        <Sidebar view={view} collapsed={collapsed} toggle={() => setCollapsed((c) => !c)} />
        <main className="main">
          {error && !state ? (
            <div className="empty" style={{ margin: "auto" }}>
              Can't reach the Syph server ({error}). Start it with <code>npm start</code>.
            </div>
          ) : !state ? null : (
            <>
              <SafeBanner />
              {view.kind === "chat" && <ChatView key={view.chatId ?? `new-${view.projectId ?? ""}-${view.draft ?? ""}`} chatId={view.chatId} projectId={view.projectId} draft={view.draft} autoSend={view.send} />}
              {view.kind === "page" && <ExtPage ext={view.ext} id={view.id} />}
              {view.kind === "projects" && <ProjectsView projectId={view.projectId} />}
              {view.kind === "tasks" && <TasksView />}
              {view.kind === "evolve" && <EvolveView />}
              {view.kind === "skills" && <SkillsView name={view.name} />}
              {view.kind === "settings" && <SettingsView key={`${view.section ?? ""}/${view.item ?? ""}`} section={view.section} item={view.item} />}
              {view.kind === "connectors" && <ConnectorsView />}
            </>
          )}
        </main>
        {shownFile && <FilePanel path={shownFile} onClose={() => showFile(null)} />}
        {browser.open && <BrowserPane state={browser} onState={(patch) => setBrowser((cur) => ({ ...cur, ...patch }))} onClose={closeBrowser} />}
      </div>
      </div>
      </ExtProvider>
    </AppCtx.Provider>
  );
}

function SafeBanner() {
  const { safe, safeUrl, items } = useExt();
  if (!safe || !items.length) return null;
  const off = async () => {
    await api.put("/ui/safe", { on: false });
    if (safeUrl) location.href = location.pathname + location.hash;
  };
  return (
    <div className="banner safe">
      Safe mode: the {items.length} interface change{items.length === 1 ? "" : "s"} Syph made {items.length === 1 ? "is" : "are"} hidden. <button className="link-btn" onClick={off}>Turn safe mode off</button>
    </div>
  );
}

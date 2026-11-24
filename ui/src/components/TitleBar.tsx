import { ChevronLeft, ChevronRight, Globe, Menu } from "lucide-react";
import { Mark, Wordmark } from "./Logo";
import type { BrowserState } from "../api";

export interface ShellBrowser {
  getState: () => Promise<BrowserState>;
  open: (url?: string) => Promise<Record<string, unknown>>;
  close: () => Promise<Record<string, unknown>>;
  navigate: (url: string) => Promise<Record<string, unknown>>;
  back: () => Promise<Record<string, unknown>>;
  forward: () => Promise<Record<string, unknown>>;
  reload: () => Promise<Record<string, unknown>>;
  setBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
  setVisible: (visible: boolean) => void;
  toggleDevTools: () => Promise<Record<string, unknown>>;
  openExternal: () => Promise<Record<string, unknown>>;
  screenshot: () => Promise<Record<string, unknown>>;
  onState: (cb: (state: BrowserState) => void) => () => void;
}

/** Set by desktop/preload.cjs when the UI runs inside the Syph desktop app. */
export interface Shell {
  platform: string;
  setTitleBar: (colors: { color: string; symbolColor: string }) => void;
  browser?: ShellBrowser;
}
export const shell: Shell | undefined = (window as unknown as { syphShell?: Shell }).syphShell;

// The desktop window has no native title bar. This strip takes its place: you drag
// the window by it, double-click it to maximise, and the OS draws the window
// buttons over its right end (or the traffic lights over its left end on a Mac).
export function TitleBar({
  collapsed,
  toggle,
  browserOpen,
  browserActive,
  toggleBrowser,
}: {
  collapsed: boolean;
  toggle: () => void;
  browserOpen?: boolean;
  browserActive?: boolean;
  toggleBrowser?: () => void;
}) {
  return (
    <header className={`titlebar ${collapsed ? "collapsed" : ""}`}>
      <div className="titlebar-side">
        <button className="tb-btn" onClick={toggle} aria-label="Toggle sidebar" title="Toggle sidebar">
          {collapsed ? <Mark size={18} /> : <Menu size={17} />}
        </button>
        {!collapsed && <Wordmark />}
      </div>
      <div className="titlebar-main">
        <button className="tb-btn" onClick={() => history.back()} aria-label="Back" title="Back"><ChevronLeft size={17} /></button>
        <button className="tb-btn" onClick={() => history.forward()} aria-label="Forward" title="Forward"><ChevronRight size={17} /></button>
        {toggleBrowser && (
          <button
            className={`tb-pill ${browserOpen ? "active" : ""}`}
            onClick={toggleBrowser}
            title="Toggle in-app browser (Ctrl+Shift+B)"
            aria-label="Toggle in-app browser"
          >
            <Globe size={13.5} />
            <span>Browser</span>
            {browserActive && <span className="bp-live-dot" />}
          </button>
        )}
      </div>
    </header>
  );
}

import { ChevronLeft, ChevronRight, Menu } from "lucide-react";
import { Mark, Wordmark } from "./Logo";

/** Set by desktop/preload.cjs when the UI runs inside the Syph desktop app. */
export interface Shell {
  platform: string;
  setTitleBar: (colors: { color: string; symbolColor: string }) => void;
}
export const shell: Shell | undefined = (window as unknown as { syphShell?: Shell }).syphShell;

// The desktop window has no native title bar. This strip takes its place: you drag
// the window by it, double-click it to maximise, and the OS draws the window
// buttons over its right end (or the traffic lights over its left end on a Mac).
export function TitleBar({ collapsed, toggle }: { collapsed: boolean; toggle: () => void }) {
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
      </div>
    </header>
  );
}

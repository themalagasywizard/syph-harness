// In-app browser state & driver bridge.
// In Syph Desktop (Electron), commands route over IPC straight into a native sandboxed WebContentsView.
// Outside Electron (npm start / tests), it keeps live state for the UI iframe preview and offers a lightweight fetch inspect fallback.

export interface BrowserState {
  open: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  agentActive: boolean;
  consoleErrors: string[];
  devtoolsOpen: boolean;
  /** True when backed by Electron's native WebContentsView (supports full external sites, screenshots & click/type). */
  native: boolean;
}

export interface BrowserCommand {
  action: "state" | "open" | "close" | "navigate" | "back" | "forward" | "reload" | "devtools" | "external" | "screenshot" | "inspect" | "click" | "type" | "scroll";
  url?: string;
  selector?: string;
  text?: string;
  y?: number;
}

export interface BrowserDriver {
  exec: (cmd: BrowserCommand, fromAgent: boolean) => Promise<Record<string, any>>;
}

export function normalizeBrowserUrl(raw?: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s)) return `http://${s}`;
  if (/^:\d+/.test(s)) return `http://localhost${s}`;
  return `https://${s}`;
}

export function isLocalUrl(raw: string): boolean {
  try {
    const u = new URL(normalizeBrowserUrl(raw));
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export class BrowserBridge {
  private state: BrowserState = {
    open: false,
    url: "",
    title: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    agentActive: false,
    consoleErrors: [],
    devtoolsOpen: false,
    native: false,
  };
  private driver: BrowserDriver | null = null;
  private listeners = new Set<(s: BrowserState) => void>();

  getState(): BrowserState {
    return { ...this.state, consoleErrors: [...this.state.consoleErrors] };
  }

  onChange(fn: (s: BrowserState) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    const snap = this.getState();
    this.listeners.forEach((l) => l(snap));
  }

  setDriver(driver: BrowserDriver | null, native = !!driver) {
    this.driver = driver;
    this.state.native = native;
    this.emit();
  }

  /** Called when Electron pushes a live navigation/title/error update over IPC. */
  syncState(patch: Partial<BrowserState>) {
    this.state = {
      ...this.state,
      ...patch,
      consoleErrors: Array.isArray(patch.consoleErrors) ? patch.consoleErrors : this.state.consoleErrors,
    };
    this.emit();
  }

  async exec(cmd: BrowserCommand, fromAgent = false): Promise<Record<string, any>> {
    if (this.driver) {
      return this.driver.exec(cmd, fromAgent);
    }

    // Web-only fallback (when running `npm start` without Electron desktop shell).
    const action = cmd.action;
    if (action === "state") return this.getState();
    if (action === "close") {
      this.syncState({ open: false, agentActive: false });
      return { ok: true };
    }
    if (action === "open" || action === "navigate") {
      const url = normalizeBrowserUrl(cmd.url);
      this.syncState({ open: true, ...(url ? { url, title: url, consoleErrors: [] } : {}), agentActive: false });
      return { ok: true, url: this.state.url, title: this.state.title, native: false, consoleErrors: [] };
    }
    if (action === "inspect") {
      if (!this.state.url) return { ok: false, error: "No URL is open in the browser yet. Call browser_open(url) first." };
      try {
        const res = await fetch(this.state.url, { signal: AbortSignal.timeout(12_000) });
        const html = await res.text();
        const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? this.state.url;
        const headings = [...html.matchAll(/<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi)]
          .map((m) => `${m[1].toUpperCase()}: ${m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 80)}`)
          .slice(0, 18);
        const imageCount = (html.match(/<img\b/gi) ?? []).length;
        this.syncState({ title });
        return { ok: true, url: this.state.url, title, headings, imageCount, native: false, note: "Lightweight HTTP inspect (run Syph Desktop for live Chromium DOM/CSS + screenshots)." };
      } catch (e) {
        return { ok: false, error: `Could not fetch ${this.state.url}: ${(e as Error).message}` };
      }
    }
    if (action === "screenshot") {
      return { ok: false, error: "Live screenshots require Syph Desktop (Electron). The page is open in the web preview pane." };
    }
    return { ok: false, error: `Browser action "${action}" requires Syph Desktop (Electron).` };
  }
}

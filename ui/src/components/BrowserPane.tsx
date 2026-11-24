// In-App Browser side pane: renders a native Electron WebContentsView when inside Syph Desktop
// (supports localhost + any external site, live agent browsing, screenshots, DevTools), and falls
// back gracefully to a live iframe preview when running Syph in a regular browser via `npm start`.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  Code2,
  ExternalLink,
  Globe,
  Lock,
  Maximize2,
  Monitor,
  RotateCw,
  Smartphone,
  Tablet,
  X,
} from "lucide-react";
import { api, type BrowserState } from "../api";
import { shell } from "./TitleBar";

type ViewportMode = "fill" | "desktop" | "tablet" | "mobile";

const VIEWPORT_WIDTHS: Record<ViewportMode, number | null> = {
  fill: null,
  desktop: 1280,
  tablet: 768,
  mobile: 390,
};

const QUICK_PORTS = ["localhost:8765", "localhost:5173", "localhost:3000", "localhost:8000"];
const WIDTH_KEY = "syph.browserPaneWidth";

function readPaneWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(n) && n >= 360 && n <= 1200) return n;
  } catch {
    /* private mode */
  }
  return Math.min(720, Math.max(460, Math.round(window.innerWidth * 0.48)));
}

function isLocalHostUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url);
}

export function BrowserPane({
  state,
  onState,
  onClose,
}: {
  state: BrowserState;
  onState: (next: Partial<BrowserState>) => void;
  onClose: () => void;
}) {
  const [inputUrl, setInputUrl] = useState(state.url || "");
  const [editing, setEditing] = useState(false);
  const [viewport, setViewport] = useState<ViewportMode>("fill");
  const [width, setWidth] = useState<number>(readPaneWidth);
  const [dragging, setDragging] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  const [shotFlash, setShotFlash] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);

  const stageRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const isNative = !!shell?.browser;

  useEffect(() => {
    if (!editing) setInputUrl(state.url || "");
  }, [state.url, editing]);

  const runCmd = useCallback(
    async (cmd: Record<string, unknown>) => {
      if (shell?.browser) {
        const action = String(cmd.action);
        if (action === "open" || action === "navigate") return shell.browser.navigate(String(cmd.url ?? ""));
        if (action === "back") return shell.browser.back();
        if (action === "forward") return shell.browser.forward();
        if (action === "reload") return shell.browser.reload();
        if (action === "devtools") return shell.browser.toggleDevTools();
        if (action === "external") return shell.browser.openExternal();
        if (action === "screenshot") return shell.browser.screenshot();
        if (action === "close") return shell.browser.close();
      }
      const res = await api.post<Record<string, any>>("/browser/cmd", cmd);
      if (cmd.action === "navigate" || cmd.action === "open") {
        onState({ open: true, url: res.url ?? String(cmd.url ?? ""), title: res.title ?? String(cmd.url ?? "") });
      }
      return res;
    },
    [onState],
  );

  const navigate = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      setEditing(false);
      await runCmd({ action: "navigate", url: trimmed });
    },
    [runCmd],
  );

  // Sync Electron WebContentsView bounds pixel-for-pixel with the visible viewport stage.
  const syncBounds = useCallback(() => {
    if (!shell?.browser) return;
    const el = stageRef.current;
    if (!el || !state.open || !state.url || dragging) {
      shell.browser.setVisible(false);
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) {
      shell.browser.setVisible(false);
      return;
    }
    shell.browser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
  }, [state.open, state.url, dragging]);

  useEffect(() => {
    syncBounds();
    if (!shell?.browser) return;
    const el = stageRef.current;
    const ro = el ? new ResizeObserver(() => syncBounds()) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener("resize", syncBounds);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", syncBounds);
      shell?.browser?.setVisible(false);
    };
  }, [syncBounds, width, viewport, showConsole]);

  // Smooth split-pane drag resizing.
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const onMove = (ev: MouseEvent) => {
      const maxW = Math.round(window.innerWidth * 0.72);
      const next = Math.max(360, Math.min(maxW, Math.round(window.innerWidth - ev.clientX)));
      setWidth(next);
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    if (!dragging) {
      try {
        localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        /* ignore */
      }
    }
  }, [dragging, width]);

  const handleScreenshot = async () => {
    const res = (await runCmd({ action: "screenshot" })) as any;
    if (res?.ok && res.base64) {
      try {
        const bytes = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
        await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
      } catch {
        /* clipboard image write unavailable */
      }
      setShotFlash(true);
      setTimeout(() => setShotFlash(false), 1400);
    }
  };

  const handleReload = () => {
    if (isNative) runCmd({ action: "reload" });
    else setIframeKey((k) => k + 1);
  };

  const handleExternal = () => {
    if (!state.url) return;
    if (isNative) runCmd({ action: "external" });
    else window.open(state.url, "_blank", "noopener,noreferrer");
  };

  const hasUrl = !!state.url;
  const local = hasUrl && isLocalHostUrl(state.url);
  const https = hasUrl && state.url.startsWith("https://");
  const vpWidth = VIEWPORT_WIDTHS[viewport];
  const errCount = state.consoleErrors?.length ?? 0;

  return (
    <aside className={`browser-panel ${dragging ? "is-dragging" : ""}`} style={{ width }} aria-label="In-app browser">
      <div className="browser-resizer" onMouseDown={startDrag} title="Drag to resize browser" />

      {/* Architectural 2-Row Chrome */}
      <div className="browser-chrome">
        {/* Row 1: Navigation + Omnibox + Actions */}
        <div className="browser-nav-row">
          <div className="browser-nav-btns">
            <button className="bp-icon" onClick={() => runCmd({ action: "back" })} disabled={!isNative || !state.canGoBack} title="Back" aria-label="Back">
              <ArrowLeft size={14} />
            </button>
            <button className="bp-icon" onClick={() => runCmd({ action: "forward" })} disabled={!isNative || !state.canGoForward} title="Forward" aria-label="Forward">
              <ArrowRight size={14} />
            </button>
            <button className="bp-icon" onClick={handleReload} disabled={!hasUrl} title="Reload" aria-label="Reload">
              <RotateCw size={13.5} className={state.loading ? "spin" : ""} />
            </button>
          </div>

          <form
            className={`browser-omnibox ${state.loading ? "is-loading" : ""} ${editing ? "is-focused" : ""}`}
            onSubmit={(e) => {
              e.preventDefault();
              navigate(inputUrl);
              urlInputRef.current?.blur();
            }}
          >
            <span className={`bp-sec ${local ? "local" : https ? "secure" : ""}`} title={local ? "Local dev server" : https ? "HTTPS" : "Web"}>
              {local ? <span className="bp-live-dot" /> : https ? <Lock size={12} /> : <Globe size={12.5} />}
            </span>
            <input
              ref={urlInputRef}
              className="bp-url"
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder="Enter URL or localhost:port…"
              value={inputUrl}
              onFocus={(e) => {
                setEditing(true);
                e.currentTarget.select();
              }}
              onBlur={() => setEditing(false)}
              onChange={(e) => setInputUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setInputUrl(state.url || "");
                  setEditing(false);
                  e.currentTarget.blur();
                }
              }}
            />
            {state.loading && <span className="bp-progress" aria-hidden="true" />}
          </form>

          <div className="browser-nav-btns">
            {isNative && hasUrl && (
              <button className="bp-icon" onClick={handleScreenshot} title="Copy screenshot to clipboard" aria-label="Copy screenshot">
                {shotFlash ? <Check size={14} className="bp-ok-ic" /> : <Camera size={14} />}
              </button>
            )}
            {isNative && hasUrl && (
              <button className={`bp-icon ${state.devtoolsOpen ? "active" : ""}`} onClick={() => runCmd({ action: "devtools" })} title="Toggle DevTools" aria-label="DevTools">
                <Code2 size={14} />
              </button>
            )}
            {hasUrl && (
              <button className="bp-icon" onClick={handleExternal} title="Open in system browser" aria-label="Open external">
                <ExternalLink size={13.5} />
              </button>
            )}
            <button className="bp-icon" onClick={onClose} title="Close browser (Ctrl+Shift+B)" aria-label="Close browser">
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Row 2: Viewport Presets + Live Agent Status + Console Pill */}
        <div className="browser-sub-row">
          <div className="bp-vp-seg" role="radiogroup" aria-label="Viewport size">
            {(
              [
                ["fill", "Fill", Maximize2],
                ["desktop", "1280", Monitor],
                ["tablet", "768", Tablet],
                ["mobile", "390", Smartphone],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={viewport === id}
                className={`bp-vp-btn ${viewport === id ? "active" : ""}`}
                onClick={() => setViewport(id)}
                title={id === "fill" ? "Fill pane" : `${label}px width`}
              >
                <Icon size={12.5} />
                <span>{label}</span>
              </button>
            ))}
          </div>

          <div className="bp-meta">
            {state.agentActive && (
              <span className="bp-agent-pill">
                <span className="bp-live-dot" />
                <span>Agent browsing</span>
              </span>
            )}
            {errCount > 0 && (
              <button className={`bp-err-pill ${showConsole ? "active" : ""}`} onClick={() => setShowConsole((s) => !s)} title="Toggle console errors">
                <AlertCircle size={12} />
                <span>{errCount} {errCount === 1 ? "error" : "errors"}</span>
              </button>
            )}
            {!state.agentActive && state.title && hasUrl && (
              <span className="bp-title ellipsis" title={state.title}>
                {state.title}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Viewport Stage */}
      <div className={`browser-stage ${viewport !== "fill" ? "framed" : ""}`}>
        {!hasUrl ? (
          <div className="browser-empty">
            <div className="be-icon">
              <Globe size={22} />
            </div>
            <h3>In-App Browser</h3>
            <p>Preview local websites, inspect responsive layouts, or let Gemini 4 Neon open and visually QA pages live.</p>
            <div className="be-chips">
              {QUICK_PORTS.map((host) => (
                <button key={host} type="button" className="be-chip" onClick={() => navigate(`http://${host}`)}>
                  <span className="bp-live-dot" />
                  <span>{host}</span>
                </button>
              ))}
            </div>
            <span className="be-hint">
              {isNative
                ? "Isolated Chromium engine · Ctrl+Shift+B to toggle"
                : "Web preview mode · Run Syph Desktop for full external site & screenshot QA"}
            </span>
          </div>
        ) : (
          <div
            ref={stageRef}
            className={`browser-stage-inner ${viewport !== "fill" ? "device-frame" : ""}`}
            style={vpWidth ? { width: `min(100%, ${vpWidth}px)` } : undefined}
          >
            {isNative ? (
              dragging && (
                <div className="browser-drag-veil">
                  <span>{vpWidth ? `${vpWidth}px` : `${width}px`}</span>
                </div>
              )
            ) : (
              <iframe
                key={iframeKey + state.url}
                src={state.url}
                title={state.title || "In-app preview"}
                className="browser-iframe"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              />
            )}
          </div>
        )}
      </div>

      {/* Collapsible Console Error Drawer */}
      {showConsole && errCount > 0 && (
        <div className="browser-console">
          <div className="bc-head">
            <span>Console errors ({errCount})</span>
            <button className="bp-icon" onClick={() => setShowConsole(false)} aria-label="Hide console">
              <X size={13} />
            </button>
          </div>
          <div className="bc-list">
            {state.consoleErrors.map((err, i) => (
              <div key={i} className="bc-row">
                <code>{err}</code>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

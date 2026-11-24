// Syph desktop shell. It runs the same local server as `npm start` in a child
// process, opens it in a window, and keeps living in the tray when the window
// is closed, so scheduled Tasks keep running. Quit from the tray menu.
const { app, BrowserWindow, WebContentsView, Menu, Tray, ipcMain, nativeImage, nativeTheme, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const ASSETS = path.join(__dirname, "assets");
let win = null;
let tray = null;
let server = null;
let url = null;
let quitting = false;

// ---------- In-App Browser (Electron WebContentsView, isolated partition) ----------
let browserView = null;
let browserAttached = false;
let browserVisible = false;
let browserBounds = { x: 0, y: 0, width: 0, height: 0 };
const browserState = {
  open: false,
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  agentActive: false,
  consoleErrors: [],
  devtoolsOpen: false,
  native: true,
};

function normalizeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s)) return `http://${s}`;
  if (/^:\d+/.test(s)) return `http://localhost${s}`;
  return `https://${s}`;
}

function emitBrowserState() {
  const snap = { ...browserState, consoleErrors: [...browserState.consoleErrors] };
  if (win && !win.isDestroyed()) win.webContents.send("syph:browser:state", snap);
  if (server && server.connected) server.send({ type: "syph:browser:state", state: snap });
}

function syncBrowserNav() {
  if (!browserView || browserView.webContents.isDestroyed()) return;
  const wc = browserView.webContents;
  const cur = wc.getURL();
  if (cur && cur !== "about:blank") browserState.url = cur;
  browserState.title = wc.getTitle() || browserState.title;
  browserState.canGoBack = wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack();
  browserState.canGoForward = wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward();
  browserState.devtoolsOpen = wc.isDevToolsOpened();
  emitBrowserState();
}

function applyBrowserBounds() {
  if (!win || win.isDestroyed() || !browserView) return;
  const show = browserState.open && browserVisible && browserBounds.width > 20 && browserBounds.height > 20;
  if (show) {
    if (!browserAttached) {
      win.contentView.addChildView(browserView);
      browserAttached = true;
    }
    browserView.setBounds(browserBounds);
  } else if (browserAttached) {
    win.contentView.removeChildView(browserView);
    browserAttached = false;
  }
}

function ensureBrowserView() {
  if (browserView && !browserView.webContents.isDestroyed()) return browserView;
  browserView = new WebContentsView({
    webPreferences: {
      partition: "persist:syph-browser",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      plugins: true,
    },
  });
  const wc = browserView.webContents;
  wc.setBackgroundColor("#ffffff");
  wc.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) wc.loadURL(target).catch(() => {});
    return { action: "deny" };
  });
  wc.on("did-start-loading", () => {
    browserState.loading = true;
    emitBrowserState();
  });
  wc.on("did-stop-loading", () => {
    browserState.loading = false;
    syncBrowserNav();
  });
  wc.on("did-navigate", () => syncBrowserNav());
  wc.on("did-navigate-in-page", () => syncBrowserNav());
  wc.on("page-title-updated", (_e, title) => {
    browserState.title = title;
    emitBrowserState();
  });
  wc.on("did-fail-load", (_e, code, desc, validatedURL) => {
    if (code === -3) return; // aborted navigation
    browserState.loading = false;
    browserState.consoleErrors = [...browserState.consoleErrors.slice(-19), `Load failed (${code}): ${desc} — ${validatedURL}`];
    emitBrowserState();
  });
  wc.on("console-message", (_e, level, message) => {
    if (level >= 3) {
      browserState.consoleErrors = [...browserState.consoleErrors.slice(-19), String(message).slice(0, 300)];
      emitBrowserState();
    }
  });
  wc.on("devtools-opened", () => syncBrowserNav());
  wc.on("devtools-closed", () => syncBrowserNav());
  return browserView;
}

const INSPECT_JS = `(() => {
  const qs = (s) => [...document.querySelectorAll(s)];
  const imgs = qs('img');
  const brokenImages = imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src') || '(no src)').slice(0, 12);
  const headings = qs('h1,h2,h3').map((h) => h.tagName + ': ' + (h.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80)).filter(Boolean).slice(0, 20);
  const bodyCs = getComputedStyle(document.body);
  const h1 = document.querySelector('h1');
  const h1Cs = h1 ? getComputedStyle(h1) : null;
  const colors = new Set();
  for (const el of qs('body,header,nav,section,button,a,[class*="btn"],[class*="card"]').slice(0, 60)) {
    const cs = getComputedStyle(el);
    if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') colors.add(cs.backgroundColor);
    if (cs.color) colors.add(cs.color);
  }
  const interactive = qs('a[href],button,input,select,[role="tab"]').filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  }).slice(0, 28).map((el) => {
    const id = el.id ? '#' + el.id : '';
    const text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 48);
    return { tag: el.tagName.toLowerCase(), id, text };
  });
  return {
    title: document.title,
    url: location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentHeight: document.documentElement.scrollHeight,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
    fonts: { body: bodyCs.fontFamily, h1: h1Cs ? h1Cs.fontFamily : null },
    paletteSample: [...colors].slice(0, 14),
    headings,
    imageCount: imgs.length,
    brokenImages,
    interactive,
  };
})()`;

async function waitForLoad(wc, timeoutMs = 15000) {
  if (!wc.isLoading()) return;
  await new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      wc.removeListener("did-stop-loading", done);
      wc.removeListener("did-fail-load", done);
      resolve();
    };
    const t = setTimeout(done, timeoutMs);
    wc.once("did-stop-loading", done);
    wc.once("did-fail-load", done);
  });
  await new Promise((r) => setTimeout(r, 350));
}

async function handleBrowserCommand(cmd, fromAgent = false) {
  const action = cmd?.action;
  if (action === "state") return { ...browserState, consoleErrors: [...browserState.consoleErrors] };
  if (action === "close") {
    browserState.open = false;
    browserState.agentActive = false;
    browserVisible = false;
    applyBrowserBounds();
    emitBrowserState();
    return { ok: true, state: { ...browserState } };
  }

  if (fromAgent) {
    browserState.agentActive = true;
    emitBrowserState();
  }
  try {
    const view = ensureBrowserView();
    const wc = view.webContents;

    if (action === "open" || action === "navigate") {
      const target = normalizeUrl(cmd.url);
      browserState.open = true;
      if (fromAgent) show();
      emitBrowserState();
      if (target) {
        browserState.consoleErrors = [];
        browserState.url = target;
        emitBrowserState();
        try {
          await wc.loadURL(target);
        } catch (err) {
          if (!String(err).includes("ERR_ABORTED")) throw err;
        }
        await waitForLoad(wc);
        syncBrowserNav();
      }
      applyBrowserBounds();
      return { ok: true, url: browserState.url, title: browserState.title, consoleErrors: browserState.consoleErrors };
    }
    if (action === "back") {
      if (wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack()) wc.goBack();
      return { ok: true };
    }
    if (action === "forward") {
      if (wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward()) wc.goForward();
      return { ok: true };
    }
    if (action === "reload") {
      browserState.consoleErrors = [];
      wc.reload();
      return { ok: true };
    }
    if (action === "devtools") {
      if (wc.isDevToolsOpened()) wc.closeDevTools();
      else wc.openDevTools({ mode: "detach" });
      syncBrowserNav();
      return { ok: true, devtoolsOpen: wc.isDevToolsOpened() };
    }
    if (action === "external") {
      if (browserState.url) shell.openExternal(browserState.url);
      return { ok: true };
    }
    if (action === "screenshot") {
      if (!browserAttached) {
        browserState.open = true;
        browserVisible = true;
        if (browserBounds.width < 100 || browserBounds.height < 100) {
          const [w, h] = win ? win.getContentSize() : [1280, 820];
          browserBounds = { x: Math.floor(w * 0.45), y: 120, width: Math.max(480, Math.floor(w * 0.54)), height: Math.max(420, h - 130) };
        }
        applyBrowserBounds();
        await new Promise((r) => setTimeout(r, 220));
      }
      const img = await wc.capturePage();
      const png = img.toPNG();
      return { ok: true, base64: png.toString("base64"), width: img.getSize().width, height: img.getSize().height, url: browserState.url, title: browserState.title };
    }
    if (action === "inspect") {
      const data = await wc.executeJavaScript(INSPECT_JS, true);
      return { ok: true, ...data, consoleErrors: browserState.consoleErrors };
    }
    if (action === "click") {
      const sel = JSON.stringify(String(cmd.selector || ""));
      const res = await wc.executeJavaScript(`(() => {
        const el = document.querySelector(${sel});
        if (!el) return { ok: false, error: 'Element not found: ' + ${sel} };
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        el.click();
        return { ok: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 60) };
      })()`, true);
      await new Promise((r) => setTimeout(r, 250));
      syncBrowserNav();
      return res;
    }
    if (action === "type") {
      const sel = JSON.stringify(String(cmd.selector || ""));
      const txt = JSON.stringify(String(cmd.text || ""));
      const res = await wc.executeJavaScript(`(() => {
        const el = document.querySelector(${sel});
        if (!el) return { ok: false, error: 'Element not found: ' + ${sel} };
        el.focus();
        if ('value' in el) {
          el.value = ${txt};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { ok: true, tag: el.tagName.toLowerCase() };
      })()`, true);
      return res;
    }
    if (action === "scroll") {
      const y = Number(cmd.y ?? 0);
      const res = await wc.executeJavaScript(`(() => {
        window.scrollTo({ top: ${Number.isFinite(y) ? y : 0}, behavior: 'instant' });
        return { ok: true, scrollY: window.scrollY, maxScroll: document.documentElement.scrollHeight - window.innerHeight };
      })()`, true);
      return res;
    }
    return { ok: false, error: `Unknown browser action: ${action}` };
  } finally {
    if (fromAgent) {
      browserState.agentActive = false;
      emitBrowserState();
    }
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => show());

function freePort(preferred) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => {
      const t = net.createServer();
      t.listen(0, "127.0.0.1", () => {
        const { port } = t.address();
        t.close(() => resolve(port));
      });
    });
    s.listen(preferred, "127.0.0.1", () => s.close(() => resolve(preferred)));
  });
}

function waitFor(port, ms = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.end();
        resolve();
      });
      sock.once("error", () => {
        if (Date.now() - start > ms) reject(new Error("The Syph server did not start in time."));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

// Where the server code lives: the bundled copy in the packaged app, or the TypeScript source via tsx.
function serverCommand(port) {
  const args = ["serve", "--port", String(port)];
  if (app.isPackaged) {
    const appDir = path.join(__dirname, "app");
    // The folder Syph.exe sits in: a .env or .env.txt there is read for keys.
    const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
    return {
      args: [path.join(appDir, "server.mjs"), ...args],
      env: { SYPH_DEFAULTS_DIR: path.join(appDir, "defaults"), SYPH_UI_DIST: path.join(appDir, "ui"), SYPH_APP_DIR: exeDir },
      cwd: exeDir,
    };
  }
  return { args: [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(ROOT, "server", "src", "cli.ts"), ...args], env: {}, cwd: ROOT };
}

async function startServer() {
  const port = await freePort(Number(process.env.SYPH_PORT) || 7337);
  const cmd = serverCommand(port);
  const logFile = path.join(app.getPath("userData"), "server.log");
  const log = fs.createWriteStream(logFile, { flags: "a" });
  // Electron's own binary doubles as Node when ELECTRON_RUN_AS_NODE is set.
  server = spawn(process.execPath, cmd.args, {
    cwd: cmd.cwd,
    env: { ...process.env, ...cmd.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
    // The IPC channel lets the server ask for "open this file" / "show it in its folder".
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  server.on("message", (m) => {
    // The UI's "Link a folder": show the system folder picker and send back what was chosen.
    if (m && m.type === "syph:pickFolder" && typeof m.reqId === "string") {
      const opts = { title: "Link a folder to Syph", properties: ["openDirectory", "createDirectory"] };
      (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts))
        .then((r) => server && server.send({ type: "syph:picked", reqId: m.reqId, path: r.canceled ? null : r.filePaths[0] || null }))
        .catch(() => server && server.send({ type: "syph:picked", reqId: m.reqId, path: null }));
      return;
    }
    if (m && m.type === "syph:browser:req" && typeof m.reqId === "string") {
      handleBrowserCommand(m.cmd, m.fromAgent !== false)
        .then((data) => server && server.send({ type: "syph:browser:res", reqId: m.reqId, ok: data?.ok !== false, data, error: data?.error }))
        .catch((err) => server && server.send({ type: "syph:browser:res", reqId: m.reqId, ok: false, error: String(err && err.message ? err.message : err) }));
      return;
    }
    if (!m || typeof m.path !== "string" || !path.isAbsolute(m.path)) return;
    if (m.type === "syph:open") shell.openPath(m.path).then((err) => err && dialog.showErrorBox("Couldn't open the file", `${err}\n\n${m.path}`));
    if (m.type === "syph:reveal") shell.showItemInFolder(m.path);
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  server.on("exit", (code) => {
    server = null;
    if (!quitting) dialog.showErrorBox("Syph stopped", `The local server exited (code ${code}). See ${logFile}.`);
  });
  await waitFor(port);
  return `http://127.0.0.1:${port}`;
}

// The UI draws its own title bar (see TitleBar in ui/src/App.tsx). This is its height,
// and the colours of the window buttons until the UI sends the theme's own.
const TITLEBAR_HEIGHT = 40;
const dark = nativeTheme.shouldUseDarkColors;
const overlay = { color: dark ? "#0d0d0c" : "#f8f7f3", symbolColor: dark ? "#98978f" : "#6b6a63", height: TITLEBAR_HEIGHT };
const isColor = (c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);

ipcMain.on("syph:titlebar", (e, colors) => {
  if (!win || e.sender !== win.webContents || process.platform === "darwin") return;
  if (!colors || !isColor(colors.color) || !isColor(colors.symbolColor)) return;
  win.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor, height: TITLEBAR_HEIGHT });
  win.setBackgroundColor(colors.color);
});

ipcMain.handle("syph:browser:cmd", (e, cmd) => {
  if (!win || e.sender !== win.webContents) return { ok: false, error: "unauthorized" };
  return handleBrowserCommand(cmd, false);
});

ipcMain.on("syph:browser:bounds", (e, b) => {
  if (!win || e.sender !== win.webContents || !b) return;
  browserBounds = {
    x: Math.max(0, Math.round(Number(b.x) || 0)),
    y: Math.max(0, Math.round(Number(b.y) || 0)),
    width: Math.max(0, Math.round(Number(b.width) || 0)),
    height: Math.max(0, Math.round(Number(b.height) || 0)),
  };
  browserVisible = browserBounds.width > 20 && browserBounds.height > 20;
  applyBrowserBounds();
});

ipcMain.on("syph:browser:visible", (e, visible) => {
  if (!win || e.sender !== win.webContents) return;
  browserVisible = !!visible;
  applyBrowserBounds();
});

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    title: "Syph",
    icon: path.join(ASSETS, "icon.png"),
    backgroundColor: overlay.color,
    autoHideMenuBar: true,
    // No native title bar: the app's own top strip is the title bar, and Windows keeps
    // its minimise, maximise and close buttons drawn over the strip's right end.
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 16, y: 13 } } : { titleBarOverlay: overlay }),
    show: false,
    // plugins: the built-in PDF viewer, used by file previews.
    webPreferences: { contextIsolation: true, sandbox: true, plugins: true, preload: path.join(__dirname, "preload.cjs") },
  });
  win.once("ready-to-show", () => win.show());
  win.loadURL(url);
  // Links to other sites open in the normal browser, never inside Syph.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(url)) shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, target) => {
    if (!target.startsWith(url)) {
      e.preventDefault();
      shell.openExternal(target);
    }
  });
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function show() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// The portable Syph.exe unpacks to a temp folder, so start-at-login must point at the real file.
function loginItem(openAtLogin) {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE;
  return exe ? { openAtLogin, path: exe, args: ["--hidden"] } : { openAtLogin, args: ["--hidden"] };
}

function trayMenu() {
  const login = app.getLoginItemSettings(process.env.PORTABLE_EXECUTABLE_FILE ? { path: process.env.PORTABLE_EXECUTABLE_FILE, args: ["--hidden"] } : undefined).openAtLogin;
  return Menu.buildFromTemplate([
    { label: "Open Syph", click: show },
    { type: "separator" },
    {
      label: "Start at login",
      type: "checkbox",
      checked: login,
      click: (item) => app.setLoginItemSettings(loginItem(item.checked)),
    },
    { label: "Open in safe mode", click: () => { if (win) { win.loadURL(`${url}/?safe=1#/settings`); show(); } } },
    { label: "Open data folder", click: () => fetch(`${url}/api/state`).then((r) => r.json()).then((s) => shell.openPath(s.homePath)).catch(() => {}) },
    { type: "separator" },
    { label: "Quit Syph", click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  const file = process.platform === "darwin" || !nativeTheme.shouldUseDarkColors ? "tray-dark.png" : "tray.png";
  const img = nativeImage.createFromPath(path.join(ASSETS, file)).resize({ width: 16, height: 16 });
  if (process.platform === "darwin") img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip("Syph");
  tray.setContextMenu(trayMenu());
  tray.on("click", show);
}

app.whenReady().then(async () => {
  try {
    url = await startServer();
  } catch (err) {
    dialog.showErrorBox("Syph could not start", String(err && err.message ? err.message : err));
    quitting = true;
    app.quit();
    return;
  }
  createTray();
  createWindow();
  if (!process.argv.includes("--hidden")) win.once("ready-to-show", show);
  else win.removeAllListeners("ready-to-show");
});

app.on("activate", show);
app.on("before-quit", () => {
  quitting = true;
  if (server) server.kill();
});
app.on("window-all-closed", () => {
  // Stay in the tray so Tasks keep running.
});

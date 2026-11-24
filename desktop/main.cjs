// Syph desktop shell. It runs the same local server as `npm start` in a child
// process, opens it in a window, and keeps living in the tray when the window
// is closed, so scheduled Tasks keep running. Quit from the tray menu.
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, nativeTheme, shell, dialog } = require("electron");
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

// Runs in the Syph window before the page. It tells the UI it is inside the desktop
// shell (so it draws its own title bar), lets it recolour the window buttons, and
// exposes the native Electron WebContentsView in-app browser controls.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("syphShell", {
  platform: process.platform,
  setTitleBar: (colors) => ipcRenderer.send("syph:titlebar", colors),
  browser: {
    getState: () => ipcRenderer.invoke("syph:browser:cmd", { action: "state" }),
    open: (url) => ipcRenderer.invoke("syph:browser:cmd", { action: "open", url }),
    close: () => ipcRenderer.invoke("syph:browser:cmd", { action: "close" }),
    navigate: (url) => ipcRenderer.invoke("syph:browser:cmd", { action: "navigate", url }),
    back: () => ipcRenderer.invoke("syph:browser:cmd", { action: "back" }),
    forward: () => ipcRenderer.invoke("syph:browser:cmd", { action: "forward" }),
    reload: () => ipcRenderer.invoke("syph:browser:cmd", { action: "reload" }),
    setBounds: (bounds) => ipcRenderer.send("syph:browser:bounds", bounds),
    setVisible: (visible) => ipcRenderer.send("syph:browser:visible", visible),
    toggleDevTools: () => ipcRenderer.invoke("syph:browser:cmd", { action: "devtools" }),
    openExternal: () => ipcRenderer.invoke("syph:browser:cmd", { action: "external" }),
    screenshot: () => ipcRenderer.invoke("syph:browser:cmd", { action: "screenshot" }),
    onState: (cb) => {
      const fn = (_e, state) => cb(state);
      ipcRenderer.on("syph:browser:state", fn);
      return () => ipcRenderer.removeListener("syph:browser:state", fn);
    },
  },
});

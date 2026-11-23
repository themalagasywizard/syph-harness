// Runs in the Syph window before the page. It tells the UI it is inside the desktop
// shell (so it draws its own title bar) and lets it recolour the window buttons
// when the theme changes.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("syphShell", {
  platform: process.platform,
  setTitleBar: (colors) => ipcRenderer.send("syph:titlebar", colors),
});

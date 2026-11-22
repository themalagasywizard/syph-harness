// Runs the server (with reload) and the Vite UI together. Works on Windows, macOS and Linux.
import { spawn } from "node:child_process";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const kids = ["server", "ui"].map((w) => spawn(npm, ["run", "dev", "-w", w], { stdio: "inherit", shell: process.platform === "win32" }));
const stop = () => { for (const k of kids) k.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const k of kids) k.on("exit", (code) => { if (code) stop(); });

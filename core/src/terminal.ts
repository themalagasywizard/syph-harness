// Terminal commands the agent runs: PowerShell (or cmd) on Windows, sh elsewhere. Each command is
// a tracked process with a log entry the chat shows, live output, and a Stop button that kills the
// whole process tree. Stopping the run (or a timeout) kills it too.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import type { Home } from "./home.ts";
import type { TerminalEntry } from "./types.ts";
import { headTail, id, now, readJson, writeJson } from "./util.ts";

export const WIN = process.platform === "win32";
export type ShellKind = TerminalEntry["shell"];
const KEEP_OUTPUT = 16_000;
const KEEP_ENTRIES = 200;

export function defaultShell(): ShellKind {
  return WIN ? "powershell" : "sh";
}

/** The program and arguments that run `command` in the given shell. */
function launch(command: string, kind: ShellKind): { file: string; args: string[]; verbatim?: boolean } {
  if (kind === "powershell") return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${command}`] };
  if (kind === "cmd") return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`], verbatim: true };
  return { file: "/bin/sh", args: ["-c", command] };
}

/** Kill a process and everything it started. */
export function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

interface Running {
  entry: TerminalEntry;
  child: ChildProcess;
  done: Promise<TerminalEntry>;
  stop: (why: "stopped" | "timeout") => void;
}

/** Every command Syph ran, per chat (kept on disk), and the ones running now. */
export class Terminal {
  private running = new Map<string, Running>();
  private listeners = new Set<(e: TerminalEntry) => void>();
  constructor(private home: Home) {}

  private file(chatId?: string) {
    return this.home.path("terminal", `${chatId ?? "none"}.json`);
  }

  /** The chat's command log, newest last. Running commands show their output so far. */
  log(chatId?: string): TerminalEntry[] {
    const saved = readJson<TerminalEntry[]>(this.file(chatId), []);
    return saved.map((e) => this.running.get(e.id)?.entry ?? (e.status === "running" ? { ...e, status: "stopped" as const } : e));
  }

  get(entryId: string): TerminalEntry | undefined {
    return this.running.get(entryId)?.entry ?? this.findSaved(entryId);
  }

  private findSaved(entryId: string) {
    const dir = this.home.path("terminal");
    try {
      for (const f of readdirSync(dir)) {
        const e = readJson<TerminalEntry[]>(`${dir}/${f}`, []).find((x) => x.id === entryId);
        if (e) return e;
      }
    } catch {
      /* no log yet */
    }
    return undefined;
  }

  onChange(fn: (e: TerminalEntry) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private save(entry: TerminalEntry) {
    const list = readJson<TerminalEntry[]>(this.file(entry.chatId), []);
    const i = list.findIndex((e) => e.id === entry.id);
    const snap = { ...entry, output: headTail(entry.output, KEEP_OUTPUT) };
    if (i >= 0) list[i] = snap;
    else list.push(snap);
    writeJson(this.file(entry.chatId), list.slice(-KEEP_ENTRIES));
    for (const l of this.listeners) l(entry);
  }

  isRunning(entryId: string) {
    return this.running.has(entryId);
  }

  runningFor(chatId?: string) {
    return [...this.running.values()].filter((r) => r.entry.chatId === chatId).map((r) => r.entry);
  }

  /** Start a command. `done` settles when it exits, is stopped, or times out. */
  start(input: { command: string; cwd: string; shell?: ShellKind; chatId?: string; runId?: string; timeoutMs: number; signal?: AbortSignal; background?: boolean }): { entry: TerminalEntry; done: Promise<TerminalEntry> } {
    const kind = input.shell ?? defaultShell();
    const entry: TerminalEntry = { id: id("cmd_"), chatId: input.chatId, runId: input.runId, command: input.command, cwd: input.cwd, shell: kind, status: "running", startedAt: now(), output: "", ...(input.background ? { background: true } : {}) };
    const l = launch(input.command, kind);
    let child: ChildProcess;
    try {
      child = spawn(l.file, l.args, { cwd: input.cwd, windowsHide: true, detached: !WIN, stdio: ["ignore", "pipe", "pipe"], windowsVerbatimArguments: l.verbatim, env: { ...process.env, CI: process.env.CI ?? "1", NO_COLOR: "1" } });
    } catch (e) {
      entry.status = "failed";
      entry.exitCode = 1;
      entry.output = `Couldn't start ${l.file}: ${(e as Error).message}`;
      entry.endedAt = now();
      this.save(entry);
      return { entry, done: Promise.resolve(entry) };
    }
    let ended: "stopped" | "timeout" | null = null;
    let last = 0;
    const append = (b: Buffer) => {
      entry.output = (entry.output + b.toString("utf8")).slice(-KEEP_OUTPUT * 4);
      if (Date.now() - last > 1000) {
        last = Date.now();
        for (const fn of this.listeners) fn(entry);
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const stop = (why: "stopped" | "timeout") => {
      if (entry.status !== "running") return;
      ended = why;
      killTree(child);
    };
    const timer = input.timeoutMs > 0 ? setTimeout(() => stop("timeout"), input.timeoutMs) : null;
    timer?.unref?.();
    // Stopping the run stops its foreground commands. Background ones live until stopped or the app quits.
    const onAbort = () => stop("stopped");
    if (!input.background) input.signal?.addEventListener("abort", onAbort, { once: true });
    const done = new Promise<TerminalEntry>((res) => {
      const finish = (code: number | null, err?: Error) => {
        if (entry.status !== "running") return;
        if (timer) clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        this.running.delete(entry.id);
        if (err) entry.output += `\n${err.message}`;
        entry.exitCode = ended === "timeout" ? "timeout" : ended === "stopped" ? "stopped" : (code ?? 1);
        entry.status = ended ?? (code === 0 ? "done" : "failed");
        entry.endedAt = now();
        this.save(entry);
        res(entry);
      };
      child.on("error", (e) => finish(1, e));
      child.on("close", (code) => finish(code));
    });
    const r: Running = { entry, child, done, stop };
    this.running.set(entry.id, r);
    this.save(entry);
    return { entry, done };
  }

  /** The user pressed Stop, or the agent called stop_command. */
  stop(entryId: string) {
    const r = this.running.get(entryId);
    if (!r) return false;
    r.stop("stopped");
    return true;
  }

  stopAll() {
    for (const r of this.running.values()) r.stop("stopped");
  }
}


/** What the model reads back from a finished command. */
export function commandReport(e: TerminalEntry) {
  const code = e.status === "timeout" ? "timeout" : e.status === "stopped" ? "stopped by the user" : String(e.exitCode ?? "?");
  return `exit code: ${code}\ncwd: ${e.cwd}\n--- output ---\n${headTail(e.output, 14_000) || "(no output)"}`;
}

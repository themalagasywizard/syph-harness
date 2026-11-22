// Files Syph makes: which ones a run created or changed (so the chat can show them), where they
// are on disk, and a preview of each that the UI can draw without other apps.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Home } from "../home.ts";
import type { FileRef } from "../types.ts";
import { readJson, writeJson } from "../util.ts";
import { csvPreview, docxPreview, pptxPreview, xlsxPreview, type SheetPreview, type SlidesPreview } from "./office.ts";

export * from "./office.ts";

const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".cache", ".next", "dist", "build", "target", ".idea", ".vs"]);

export type Snapshot = Map<string, { mtime: number; size: number }>;

/** mtime and size of every file under `root` (bounded, skipping dependency and build folders). */
export function snapshot(root: string, max = 8000): Snapshot {
  const out: Snapshot = new Map();
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || out.size >= max) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP.has(name) || out.size >= max) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.isFile()) out.set(full, { mtime: st.mtimeMs, size: st.size });
    }
  };
  if (existsSync(root)) walk(root, 0);
  return out;
}

export function fileRef(abs: string, action: FileRef["action"], root?: string): FileRef {
  let size = 0;
  try {
    size = statSync(abs).size;
  } catch {
    /* gone already */
  }
  const rel = root ? relative(root, abs) : undefined;
  return { path: abs, name: basename(abs), action, size, rel: rel && !rel.startsWith("..") ? rel.split(sep).join("/") : undefined };
}

/** Files created or changed between two snapshots of `root`. */
export function changedFiles(root: string, before: Snapshot, after: Snapshot): FileRef[] {
  const out: FileRef[] = [];
  for (const [p, s] of after) {
    const b = before.get(p);
    if (!b) out.push(fileRef(p, "created", root));
    else if (b.mtime !== s.mtime || b.size !== s.size) out.push(fileRef(p, "modified", root));
  }
  return out.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 50);
}

const DOC_EXT = "pptx|pptm|ppsx|docx|docm|xlsx|xlsm|csv|tsv|pdf|png|jpe?g|gif|webp|svg|html?|md|txt|json|mp4|webm|mp3|wav|zip";
const WIN_PATH = new RegExp(String.raw`[A-Za-z]:\\[^"'<>|*?\r\n]+?\.(?:${DOC_EXT})\b`, "gi");
const POSIX_PATH = new RegExp(String.raw`(?:^|[\s"'=(])(\/[^"'<>|*?\r\n\s]+?\.(?:${DOC_EXT}))\b`, "gi");

/** Absolute paths outside the workspace that a command wrote to (named in its text and changed since `since`). */
export function mentionedFiles(text: string, since: number, exclude: Set<string>): FileRef[] {
  const found = new Set<string>();
  for (const m of text.matchAll(WIN_PATH)) found.add(m[0]);
  for (const m of text.matchAll(POSIX_PATH)) found.add(m[1]);
  const out: FileRef[] = [];
  for (const p of found) {
    const abs = resolve(p);
    if (exclude.has(abs)) continue;
    try {
      const st = statSync(abs);
      if (st.isFile() && st.mtimeMs >= since - 2000) out.push(fileRef(abs, st.birthtimeMs >= since - 2000 ? "created" : "modified"));
    } catch {
      /* not a real file */
    }
  }
  return out.slice(0, 20);
}

// ---------- Which files the UI may open ----------

/** Files Syph made or touched, so the UI can open them even when they are outside the workspace. */
export class FileIndex {
  constructor(private home: Home) {}
  private file() {
    return this.home.path("files-index.json");
  }
  list(): string[] {
    return readJson<string[]>(this.file(), []);
  }
  add(paths: string[]) {
    if (!paths.length) return;
    const all = [...new Set([...paths, ...this.list()])].slice(0, 3000);
    writeJson(this.file(), all);
  }
  has(p: string) {
    return this.list().includes(p);
  }
}

const within = (base: string, p: string) => {
  const r = relative(base, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/** True when the UI may preview or open `abs`: it's in a workspace or project folder, or Syph made it. Never keys or config. */
export function canAccess(home: Home, abs: string): boolean {
  const p = resolve(abs);
  if (within(home.root, p)) {
    const r = relative(home.root, p).split(sep).join("/");
    if (/^(\.env|secrets|config\.json)/.test(r)) return false;
    if (r.startsWith("workspace/") || /^projects\/[^/]+\/files\//.test(r)) return true;
  }
  return new FileIndex(home).has(p);
}

// ---------- Previews ----------

export type Preview =
  | SlidesPreview
  | { kind: "document"; html: string }
  | { kind: "sheets"; sheets: SheetPreview[] }
  | { kind: "text"; language: string; content: string; truncated?: boolean }
  | { kind: "markdown"; content: string; truncated?: boolean }
  | { kind: "html"; content: string }
  | { kind: "image" | "pdf" | "video" | "audio" }
  | { kind: "none"; reason: string };

export const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon",
  ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  ".html": "text/html", ".htm": "text/html", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".md": "text/markdown",
};

const LANG: Record<string, string> = { ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "jsx", ".py": "python", ".json": "json", ".css": "css", ".sh": "bash", ".ps1": "powershell", ".sql": "sql", ".yml": "yaml", ".yaml": "yaml", ".xml": "xml", ".rs": "rust", ".go": "go", ".java": "java", ".cs": "csharp", ".rb": "ruby", ".php": "php", ".toml": "toml", ".ini": "ini", ".bat": "batch", ".cmd": "batch" };

export function previewKind(p: string): Preview["kind"] {
  const e = extname(p).toLowerCase();
  if ([".pptx", ".pptm", ".ppsx", ".potx"].includes(e)) return "slides";
  if ([".docx", ".docm", ".dotx"].includes(e)) return "document";
  if ([".xlsx", ".xlsm", ".csv", ".tsv"].includes(e)) return "sheets";
  if ([".md", ".markdown"].includes(e)) return "markdown";
  if ([".html", ".htm"].includes(e)) return "html";
  const m = MIME[e];
  if (m?.startsWith("image/")) return "image";
  if (m === "application/pdf") return "pdf";
  if (m?.startsWith("video/")) return "video";
  if (m?.startsWith("audio/")) return "audio";
  return "text";
}

export function preview(p: string): Preview {
  const st = statSync(p);
  if (!st.isFile()) return { kind: "none", reason: "This is a folder." };
  const kind = previewKind(p);
  const e = extname(p).toLowerCase();
  if (kind === "image" || kind === "pdf" || kind === "video" || kind === "audio") return { kind };
  if ([".ppt", ".doc", ".xls"].includes(e)) return { kind: "none", reason: "This is an old Office format. Open it to see it." };
  if (kind === "slides" || kind === "document" || (kind === "sheets" && e.startsWith(".xls"))) {
    if (st.size > 150 * 1024 * 1024) return { kind: "none", reason: "This file is too big to preview. Open it instead." };
    const buf = readFileSync(p);
    if (kind === "slides") return pptxPreview(buf);
    if (kind === "document") return { kind: "document", html: docxPreview(buf) };
    return { kind: "sheets", sheets: xlsxPreview(buf) };
  }
  const limit = 2 * 1024 * 1024;
  const buf = readFileSync(p).subarray(0, limit);
  if (buf.includes(0)) return { kind: "none", reason: "No preview for this kind of file. Open it instead." };
  const text = buf.toString("utf8");
  const truncated = st.size > limit || undefined;
  if (kind === "sheets") return { kind: "sheets", sheets: [{ ...csvPreview(text), name: basename(p) }] };
  if (kind === "markdown") return { kind: "markdown", content: text, truncated };
  if (kind === "html") return { kind: "html", content: text };
  return { kind: "text", language: LANG[e] ?? "", content: text, truncated };
}

/** Programs and scripts are only ever shown in their folder, never opened from Syph. */
export const RISKY_OPEN = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|pif|lnk|hta|cpl|jar|reg|sh|app|command|url|appref-ms|msc|scf|inf)$/i;

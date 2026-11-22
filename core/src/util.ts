import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export const id = (prefix = "") => prefix + randomUUID().replace(/-/g, "").slice(0, 12);
export const now = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write: write to a temp file then rename, so a crash never leaves half a file. */
export function writeJson(path: string, value: unknown) {
  writeText(path, JSON.stringify(value, null, 2) + "\n");
}

export function writeText(path: string, text: string) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Rough token estimate. Good enough for budgeting; exact counts come back in usage. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3.8);

export function truncate(s: string, max: number) {
  return s.length <= max ? s : s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

/** Keep the start and the end of a long output (errors and summaries are usually at the end). */
export function headTail(s: string, max: number) {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${s.slice(0, head)}\n…[${s.length - max} chars elided from the middle]…\n${s.slice(-tail)}`;
}

/** Parse a "---\nkey: value\n---\nbody" frontmatter block. Flat string values only. */
export function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2] };
}

/** Extract the first JSON object or array from model text (handles ```json fences and chatter). */
export function extractJson<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.search(/[[{]/);
    if (start < 0) continue;
    for (let end = c.length; end > start; end--) {
      const ch = c[end - 1];
      if (ch !== "}" && ch !== "]") continue;
      try {
        return JSON.parse(c.slice(start, end)) as T;
      } catch {
        /* keep shrinking */
      }
    }
  }
  return null;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function stdErr(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v / xs.length);
}

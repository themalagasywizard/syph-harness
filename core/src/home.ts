// The Syph home folder holds every piece of state. Anything the agent may improve is a plain
// text file here; history (traces, proposals, eval results) is append-only and protected.
import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, readJson, readText, writeJson, writeText } from "./util.ts";
import type { SyphConfig } from "./types.ts";

export const DEFAULTS_DIR = process.env.SYPH_DEFAULTS_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../defaults");

/** Paths (relative to home, forward slashes) the agent may propose changes to. */
const EVOLVABLE = [/^prompts\/system\.md$/, /^prompts\/variants\/[\w.-]+\.md$/, /^skills\/[\w-]+\/[\w./-]+$/, /^memory\/[\w.-]+\.md$/, /^profiles\/[\w.-]+\.json$/, /^extensions\/[\w-]+\.ts$/, /^projects\/[\w-]+\/instructions\.md$/, /^ui\/[\w-]+\.json$/];

/** Never editable by the agent, even if a pattern above would match. The referee stays out of reach. */
const PROTECTED = [/^evals\//, /^prompts\/(judge|reflector)\.md$/, /^config\.json$/, /^\.env$/, /^traces\//, /^proposals\//, /^history\//, /^secrets/];

export class Home {
  readonly root: string;
  /** Where spend is recorded. Shadow homes used for evaluation share the real home's ledger. */
  readonly ledgerDir: string;
  constructor(root?: string, ledgerDir?: string) {
    this.root = resolve(root ?? process.env.SYPH_HOME ?? join(homedir(), ".syph"));
    this.ledgerDir = ledgerDir ?? join(this.root, "traces");
  }

  path(...parts: string[]) {
    return join(this.root, ...parts);
  }

  /** Normalise a home-relative path and refuse anything that escapes the home. */
  rel(p: string): string {
    const abs = resolve(this.root, p);
    const r = relative(this.root, abs);
    if (r.startsWith("..") || isAbsolute(r)) throw new Error(`Path escapes Syph home: ${p}`);
    return r.split(sep).join("/");
  }

  isEvolvable(p: string) {
    const r = this.rel(p);
    return !PROTECTED.some((re) => re.test(r)) && EVOLVABLE.some((re) => re.test(r));
  }

  read(p: string): string | null {
    return readText(this.path(this.rel(p)));
  }

  write(p: string, content: string) {
    writeText(this.path(this.rel(p)), content);
  }

  exists(p: string) {
    return existsSync(this.path(this.rel(p)));
  }

  /** List files under a home-relative directory, recursively, as home-relative paths. */
  list(dir: string): string[] {
    const base = this.path(dir);
    if (!existsSync(base)) return [];
    const out: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const full = join(d, name);
        if (statSync(full).isDirectory()) walk(full);
        else out.push(relative(this.root, full).split(sep).join("/"));
      }
    };
    walk(base);
    return out.sort();
  }

  /** Create the home from defaults on first run. Existing files are never overwritten. */
  init() {
    ensureDir(this.root);
    // Defaults are copied once. Later runs never resurrect files the user (or Syph) deleted.
    if (!existsSync(this.path(".syph-version"))) {
      cpSync(DEFAULTS_DIR, this.root, { recursive: true, force: false, errorOnExist: false });
      writeText(this.path(".syph-version"), "1\n");
    }
    for (const d of ["traces", "proposals", "history", "chats", "projects", "workspace", "examples", "evals/cases", "evals/results", "extensions", "profiles"]) ensureDir(this.path(d));
    if (!existsSync(this.path(".env"))) writeText(this.path(".env"), "# OPENROUTER_API_KEY=sk-or-...\n# MINIMAX_API_KEY=...\n# GEMINI_API_KEY=AIza...\n");
    return this;
  }

  config(): SyphConfig {
    const defaults = readJson<SyphConfig>(join(DEFAULTS_DIR, "config.json"), {} as SyphConfig);
    const user = readJson<Partial<SyphConfig>>(this.path("config.json"), {});
    const merged = deepMerge(defaults, user) as SyphConfig;
    // A saved provider list (e.g. after editing a base URL) must not hide providers added since.
    if (Array.isArray(user.providers)) {
      for (const p of defaults.providers ?? []) if (!merged.providers.some((x) => x.name === p.name)) merged.providers.push(p);
    }
    return merged;
  }

  saveConfig(patch: Partial<SyphConfig>) {
    const current = readJson<Partial<SyphConfig>>(this.path("config.json"), {});
    writeJson(this.path("config.json"), deepMerge(current, patch));
  }

  /** A key from the home .env (what Settings saves), falling back to the process environment. */
  env(name: string): string | undefined {
    return this.envFile()[name] || process.env[name] || undefined;
  }

  /** Where a key comes from: the home .env (Settings), the environment, or nowhere. */
  envSource(name: string): "settings" | "environment" | null {
    return this.envFile()[name] ? "settings" : process.env[name] ? "environment" : null;
  }

  /** Set or remove (value null) one key in the home .env, keeping the other lines. */
  setEnv(name: string, value: string | null) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`Bad variable name: ${name}`);
    if (value !== null && !/^[\x21-\x7e]+$/.test(value)) throw new Error("A key can't contain spaces or line breaks.");
    const lines = (readText(this.path(".env")) ?? "").split(/\r?\n/).filter((l) => l.trim() && !new RegExp(`^\\s*${name}\\s*=`).test(l));
    if (value !== null) lines.push(`${name}=${value}`);
    writeText(this.path(".env"), lines.join("\n") + "\n");
  }

  private envFile(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of (readText(this.path(".env")) ?? "").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  }

  /** Copy the evolvable parts of this home into another folder (for shadow evaluation). */
  cloneTo(target: string): Home {
    ensureDir(target);
    for (const d of ["prompts", "skills", "memory", "profiles", "extensions", "projects", "examples", "evals"]) {
      if (existsSync(this.path(d))) cpSync(this.path(d), join(target, d), { recursive: true });
    }
    for (const f of ["config.json", ".env"]) if (existsSync(this.path(f))) cpSync(this.path(f), join(target, f));
    for (const d of ["traces", "proposals", "workspace", "evals/results"]) ensureDir(join(target, d));
    return new Home(target, this.ledgerDir);
  }
}

function deepMerge(a: any, b: any): any {
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== "object" || typeof b !== "object" || !a || !b) return b ?? a;
  const out: any = { ...a };
  for (const k of Object.keys(b)) out[k] = k in a ? deepMerge(a[k], b[k]) : b[k];
  return out;
}

// Extensions are TypeScript files in ~/.syph/extensions that add tools or strategies at runtime.
// They are how Syph writes new code for itself without touching its core: each one is compiled,
// loaded and tested in isolation, and a broken one is skipped (and reported) rather than fatal.
//
// Shape of an extension file (no imports needed, everything comes through `syph`):
//
//   export default (syph) => ({
//     tools: [syph.defineTool({ name: "word_count", description: "...", permission: "auto",
//       schema: syph.z.object({ text: syph.z.string() }),
//       run: ({ text }) => String(text.split(/\s+/).filter(Boolean).length) })],
//     test: async () => { /* throw to fail */ },
//   });
import * as nodeModule from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Home } from "./home.ts";
import { complete } from "./providers/llm.ts";
import { registerStrategy, type Strategy } from "./strategies/index.ts";
import { runAgent } from "./loop.ts";
import { defineTool, type Tool } from "./tools/types.ts";
import { hash, writeText } from "./util.ts";

export const extensionApi = { z, defineTool, complete, runAgent };

export interface LoadedExtension {
  name: string;
  tools: Tool[];
  strategies: Strategy[];
  test?: () => Promise<void> | void;
}

export interface ExtensionReport {
  name: string;
  ok: boolean;
  error?: string;
  tools: string[];
  strategies: string[];
}

/** TypeScript to JavaScript: esbuild when installed, otherwise Node's built-in type stripping (packaged app). */
export async function compile(source: string): Promise<string> {
  try {
    const { transform } = await import("esbuild");
    return (await transform(source, { loader: "ts", format: "esm", target: "node20" })).code;
  } catch (err) {
    const strip = (nodeModule as { stripTypeScriptTypes?: (s: string, o: object) => string }).stripTypeScriptTypes;
    if (!strip || (err as Error)?.message?.includes("Transform failed")) throw err;
    return strip(source, { mode: "transform" });
  }
}

export async function loadExtensionSource(home: Home, name: string, source: string): Promise<LoadedExtension> {
  const code = await compile(source);
  const file = home.path(".cache", "extensions", `${name}-${hash(code).slice(0, 12)}.mjs`);
  if (!existsSync(file)) writeText(file, code);
  const mod = await import(pathToFileURL(file).href);
  const factory = mod.default;
  if (typeof factory !== "function") throw new Error("Extension must `export default (syph) => ({ tools, strategies, test })`.");
  const out = (await factory(extensionApi)) ?? {};
  const tools: Tool[] = out.tools ?? [];
  const strategies: Strategy[] = out.strategies ?? [];
  for (const t of tools) {
    if (!t?.name || !t.description || !t.schema || typeof t.run !== "function") throw new Error(`Tool in ${name} is missing name, description, schema or run.`);
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(t.name)) throw new Error(`Tool name "${t.name}" must be snake_case.`);
    if (!["auto", "ask", "deny"].includes(t.permission)) t.permission = "ask";
  }
  for (const s of strategies) if (!s?.name || typeof s.run !== "function") throw new Error(`Strategy in ${name} is missing name or run.`);
  return { name, tools, strategies, test: out.test };
}

export async function loadExtensions(home: Home): Promise<{ extensions: LoadedExtension[]; reports: ExtensionReport[] }> {
  const dir = home.path("extensions");
  const disabled = new Set(home.config().disabledExtensions ?? []);
  const extensions: LoadedExtension[] = [];
  const reports: ExtensionReport[] = [];
  if (!existsSync(dir)) return { extensions, reports };
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
    const name = f.replace(/\.ts$/, "");
    if (disabled.has(name)) {
      reports.push({ name, ok: false, error: "disabled", tools: [], strategies: [] });
      continue;
    }
    try {
      const ext = await loadExtensionSource(home, name, home.read(`extensions/${f}`) ?? "");
      ext.strategies.forEach(registerStrategy);
      extensions.push(ext);
      reports.push({ name, ok: true, tools: ext.tools.map((t) => t.name), strategies: ext.strategies.map((s) => s.name) });
    } catch (e) {
      reports.push({ name, ok: false, error: (e as Error).message, tools: [], strategies: [] });
    }
  }
  return { extensions, reports };
}

/** Compile, load and run an extension's own test. Used by the gate before any eval runs. */
export async function testExtension(home: Home, name: string, source: string): Promise<string | null> {
  try {
    const ext = await loadExtensionSource(home, name, source);
    await ext.test?.();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

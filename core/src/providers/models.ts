// Model references, provider resolution and per-model profiles.
import type { Home } from "../home.ts";
import type { ModelProfile, SyphConfig } from "../types.ts";
import { readJson, writeJson } from "../util.ts";

export interface ResolvedModel {
  ref: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

/** "openrouter:deepseek/deepseek-v4-pro" → provider "openrouter", model "deepseek/deepseek-v4-pro".
 *  A reference without a known provider prefix is treated as OpenRouter. */
export function parseRef(ref: string, config: SyphConfig): { provider: string; model: string } {
  const i = ref.indexOf(":");
  if (i > 0) {
    const p = ref.slice(0, i);
    if (p === "mock" || config.providers.some((x) => x.name === p)) return { provider: p, model: ref.slice(i + 1) };
  }
  return { provider: "openrouter", model: ref };
}

export function resolveModel(ref: string, home: Home): ResolvedModel {
  const config = home.config();
  const { provider, model } = parseRef(ref, config);
  if (provider === "mock") return { ref, provider, model, baseUrl: "mock://" };
  const p = config.providers.find((x) => x.name === provider);
  if (!p) throw new Error(`Unknown provider "${provider}" in model reference ${ref}`);
  const apiKey = p.apiKeyEnv ? home.env(p.apiKeyEnv) : undefined;
  if (p.apiKeyEnv && !apiKey) throw new Error(`No API key for ${provider}. Set ${p.apiKeyEnv} in ${home.path(".env")} or in Settings.`);
  return { ref: `${provider}:${model}`, provider, model, baseUrl: p.baseUrl, apiKey };
}

/**
 * MiniMax's text models (platform.minimax.io/docs/guides/text-generation). Its /models list has no
 * context sizes, so they are kept here; the list also stands in when /models can't be reached.
 */
export const MINIMAX_MODELS = [
  { id: "MiniMax-M3.1-Flash", label: "MiniMax M3.1 Flash", contextWindow: 1_000_000 },
  { id: "MiniMax-M3", label: "MiniMax M3", contextWindow: 1_000_000 },
];
export const MINIMAX_DEFAULT = "minimax:MiniMax-M3.1-Flash";

const fileFor = (ref: string) => `profiles/${ref.replace(/[^\w.-]+/g, "_")}.json`;

// Context windows the providers report, by model reference. Syph uses the whole window of the model
// you pick unless you set a smaller one for that model in Settings.
const WINDOWS = "cache/context-windows.json";
const readWindows = (home: Home) => readJson<Record<string, number>>(home.path(WINDOWS), {});
function rememberWindows(home: Home, found: Record<string, number>) {
  const clean = Object.fromEntries(Object.entries(found).filter(([, n]) => Number.isFinite(n) && n >= 1024));
  if (!Object.keys(clean).length) return;
  writeJson(home.path(WINDOWS), { ...readWindows(home), ...clean });
}
export const knownContextWindow = (home: Home, ref: string): number | undefined => readWindows(home)[ref];

/** Profile for a model: the stored file if any, otherwise sensible defaults by provider. */
export function getProfile(home: Home, ref: string): ModelProfile {
  const stored = readJson<Partial<ModelProfile> | null>(home.path(fileFor(ref)), null);
  const base = readJson<Partial<ModelProfile>>(home.path("profiles/default.json"), {});
  const local = /^(ollama|lmstudio):/.test(ref);
  const guess: ModelProfile = {
    id: ref,
    contextWindow: local ? 8192 : 128000,
    nativeTools: true,
    strategy: local ? "verify" : "direct",
    fewShot: local ? 2 : 0,
    temperature: 0.3,
  };
  const p = { ...guess, ...base, ...stored, id: ref } as ModelProfile;
  // The model's full window wins over a default or a stale saved number, unless the user chose a limit.
  const known = knownContextWindow(home, ref) ?? MINIMAX_MODELS.find((m) => `minimax:${m.id}` === ref)?.contextWindow;
  if (known && !p.contextWindowSet) p.contextWindow = known;
  return p;
}

/**
 * Look up the context window of the model about to be used, once, and remember it.
 * OpenRouter reports the model's maximum. LM Studio and Ollama report what the loaded model can
 * hold (the window it was loaded with, which is what actually fits on the request).
 */
export async function learnContextWindow(home: Home, ref: string): Promise<number | undefined> {
  const known = knownContextWindow(home, ref);
  if (known) return known;
  try {
    const { provider, model, baseUrl, apiKey } = resolveModel(ref, home);
    if (provider === "mock") return undefined;
    const root = baseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
    const t = AbortSignal.timeout(4000);
    let n: number | undefined;
    if (provider === "ollama" || /:11434/.test(baseUrl)) {
      // A loaded model reports its working window; otherwise use the most the model supports.
      const ps: any = await fetch(`${root}/api/ps`, { signal: t }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      n = ps?.models?.find((m: any) => m.name === model || m.model === model)?.context_length;
      if (!n) {
        const show: any = await fetch(`${root}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }), signal: t }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const info = show?.model_info ?? {};
        const max = Object.entries(info).find(([k]) => k.endsWith(".context_length"))?.[1] as number | undefined;
        const set = /num_ctx\s+(\d+)/.exec(show?.parameters ?? "")?.[1];
        n = set ? Number(set) : max;
      }
    } else if (provider === "lmstudio" || /:1234/.test(baseUrl)) {
      const j: any = await fetch(`${root}/api/v0/models/${encodeURIComponent(model)}`, { signal: t }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      n = j?.loaded_context_length ?? j?.max_context_length;
    } else {
      const j: any = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: t }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const found: Record<string, number> = {};
      for (const m of j?.data ?? []) if (m.context_length) found[`${provider}:${m.id}`] = m.context_length;
      rememberWindows(home, found);
      n = found[`${provider}:${model}`];
    }
    if (n) rememberWindows(home, { [ref]: Number(n) });
    return knownContextWindow(home, ref);
  } catch {
    return undefined;
  }
}

export function profilePath(ref: string) {
  return fileFor(ref);
}

export function saveProfile(home: Home, profile: ModelProfile) {
  writeJson(home.path(fileFor(profile.id)), profile);
}

export interface ModelInfo {
  ref: string;
  label: string;
  provider: string;
  contextWindow?: number;
  tools?: boolean;
}

/** List models from each configured provider. Failures (e.g. Ollama not running) are skipped. */
export async function listModels(home: Home): Promise<ModelInfo[]> {
  const config = home.config();
  const out: ModelInfo[] = [];
  await Promise.all(
    config.providers.map(async (p) => {
      try {
        const apiKey = p.apiKeyEnv ? home.env(p.apiKeyEnv) : undefined;
        const minimax = p.name === "minimax";
        if (minimax && !apiKey) return; // nothing to offer until a key is saved
        const res = await fetch(p.baseUrl.replace(/\/$/, "") + "/models", {
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          signal: AbortSignal.timeout(4000),
        }).catch(() => null);
        const json: any = res?.ok ? await res.json().catch(() => ({})) : {};
        if (minimax) {
          // Known models first, with their windows; then anything else the account lists.
          const listed = new Set<string>((json.data ?? []).map((m: any) => m.id));
          for (const m of MINIMAX_MODELS) out.push({ ref: `minimax:${m.id}`, label: m.label, provider: p.name, contextWindow: m.contextWindow, tools: true });
          for (const id of listed) if (!MINIMAX_MODELS.some((m) => m.id === id)) out.push({ ref: `minimax:${id}`, label: id, provider: p.name });
          return;
        }
        if (!res?.ok) return;
        for (const m of json.data ?? []) {
          out.push({
            ref: `${p.name}:${m.id}`,
            label: m.name ?? m.id,
            provider: p.name,
            contextWindow: m.context_length,
            tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes("tools") : undefined,
          });
        }
      } catch {
        /* provider offline */
      }
    }),
  );
  rememberWindows(home, Object.fromEntries(out.filter((m) => m.contextWindow && m.provider !== "ollama" && m.provider !== "lmstudio").map((m) => [m.ref, m.contextWindow!])));
  return out;
}

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

const fileFor = (ref: string) => `profiles/${ref.replace(/[^\w.-]+/g, "_")}.json`;

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
  return { ...guess, ...base, ...stored, id: ref } as ModelProfile;
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
        const res = await fetch(p.baseUrl.replace(/\/$/, "") + "/models", {
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) return;
        const json: any = await res.json();
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
  return out;
}

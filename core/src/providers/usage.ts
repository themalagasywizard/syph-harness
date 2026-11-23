// How much of the provider account is left: MiniMax plan windows, OpenRouter credit and key limit.
// Shown as a small bar next to the model picker and as a card in Settings.
import { join } from "node:path";
import type { Home } from "../home.ts";
import { writeJson } from "../util.ts";

export interface UsageMeter {
  /** "5-hour window", "Weekly", "Credits", "Key limit". */
  label: string;
  used: number;
  total: number;
  unit: "requests" | "usd";
  /** When this meter resets, as epoch ms, when the provider says. */
  resetsAt?: number;
}

export interface ProviderUsage {
  provider: "minimax" | "openrouter";
  meters: UsageMeter[];
  checkedAt: number;
  /** Set when nothing could be read: the bar stays hidden and Settings shows why. */
  error?: string;
}

type Fetch = typeof fetch;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** An absolute time from either an epoch (s or ms) or a countdown (s or ms). */
function resetTime(end: unknown, remains: unknown, now: number): number | undefined {
  const e = num(end);
  if (e && e > 1e9) return e > 1e12 ? e : e * 1000;
  const r = num(remains);
  if (r !== undefined && r >= 0) return now + (r > 7 * 86400 ? r : r * 1000);
  return undefined;
}

/**
 * Read MiniMax's plan "remains" answer. The format isn't documented, so this reads it loosely:
 * model_remains[] with current_interval_total_count / current_interval_usage_count for the 5-hour
 * window and current_weekly_* (or any weekly_* pair) for the week.
 */
export function parseMiniMaxRemains(json: any, model?: string, now = Date.now()): UsageMeter[] {
  const list: any[] = json?.model_remains ?? json?.data?.model_remains ?? (Array.isArray(json?.data) ? json.data : []);
  if (!Array.isArray(list) || !list.length) return [];
  const want = model?.toLowerCase();
  const entry =
    (want && list.find((m) => String(m?.model_name ?? m?.model ?? "").toLowerCase() === want)) ??
    list.find((m) => (num(m?.current_interval_total_count) ?? 0) > 0) ??
    list[0];
  const meters: UsageMeter[] = [];
  const total = num(entry?.current_interval_total_count);
  const used = num(entry?.current_interval_usage_count);
  if (total && used !== undefined) {
    meters.push({ label: "5-hour window", used, total, unit: "requests", resetsAt: resetTime(entry.end_time, entry.remains_time, now) });
  }
  const wTotal = num(entry?.current_weekly_total_count ?? entry?.weekly_total_count);
  const wUsed = num(entry?.current_weekly_usage_count ?? entry?.weekly_usage_count);
  if (wTotal && wUsed !== undefined) {
    meters.push({ label: "Weekly", used: wUsed, total: wTotal, unit: "requests", resetsAt: resetTime(entry.weekly_end_time, entry.weekly_remains_time, now) });
  }
  return meters;
}

/** Ask MiniMax how much of the plan is left. A pay-as-you-go key has no plan: no meters, no error. */
export async function miniMaxUsage(home: Home, opts: { key: string; baseUrl: string; model?: string; fetch?: Fetch }): Promise<ProviderUsage> {
  const f = opts.fetch ?? fetch;
  const origin = new URL(opts.baseUrl).origin;
  const china = /minimaxi\.com$/.test(new URL(opts.baseUrl).hostname);
  const urls = [
    `${origin}/v1/token_plan/remains`,
    china ? "https://www.minimaxi.com/v1/token_plan/remains" : "https://www.minimax.io/v1/token_plan/remains",
    `${origin}/v1/api/openplatform/coding_plan/remains`,
  ];
  let lastError = "MiniMax didn't report plan usage for this key.";
  for (const url of [...new Set(urls)]) {
    try {
      const res = await f(url, { headers: { authorization: `Bearer ${opts.key}`, "content-type": "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        lastError = `MiniMax answered ${res.status}.`;
        continue;
      }
      const json: any = await res.json().catch(() => null);
      // Kept so a change in MiniMax's format can be seen and fixed (the answer holds no key).
      writeJson(join(home.root, "usage", "minimax-last.json"), { url, at: new Date().toISOString(), json });
      const code = json?.base_resp?.status_code;
      if (code) {
        lastError = json.base_resp.status_msg ? `MiniMax: ${json.base_resp.status_msg}` : `MiniMax status ${code}.`;
        continue;
      }
      const meters = parseMiniMaxRemains(json, opts.model);
      if (meters.length) return { provider: "minimax", meters, checkedAt: Date.now() };
    } catch (e) {
      lastError = `Couldn't reach MiniMax: ${(e as Error).message}`;
    }
  }
  return { provider: "minimax", meters: [], checkedAt: Date.now(), error: lastError };
}

/** OpenRouter: the account's credit balance and, when the key has one, its own spending limit. */
export async function openRouterUsage(opts: { key: string; baseUrl?: string; fetch?: Fetch }): Promise<ProviderUsage> {
  const f = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const get = async (path: string) => {
    const res = await f(base + path, { headers: { authorization: `Bearer ${opts.key}` }, signal: AbortSignal.timeout(10_000) });
    return res.ok ? ((await res.json().catch(() => null)) as any)?.data ?? null : null;
  };
  const meters: UsageMeter[] = [];
  try {
    const [credits, key] = await Promise.all([get("/credits").catch(() => null), get("/key").catch(() => null)]);
    const total = num(credits?.total_credits);
    const used = num(credits?.total_usage);
    if (total !== undefined && used !== undefined && total > 0) meters.push({ label: "Credits", used, total, unit: "usd" });
    const limit = num(key?.limit);
    const keyUsed = num(key?.usage);
    if (limit && limit > 0) {
      const remaining = num(key?.limit_remaining);
      meters.push({ label: "Key limit", used: remaining !== undefined ? limit - remaining : keyUsed ?? 0, total: limit, unit: "usd" });
    }
  } catch (e) {
    return { provider: "openrouter", meters: [], checkedAt: Date.now(), error: `Couldn't reach OpenRouter: ${(e as Error).message}` };
  }
  return { provider: "openrouter", meters, checkedAt: Date.now(), ...(meters.length ? {} : { error: "OpenRouter didn't report a balance for this key." }) };
}

/** The meter closest to running out: what the small bar shows. */
export function tightest(meters: UsageMeter[]): UsageMeter | undefined {
  const left = (m: UsageMeter) => (m.total > 0 ? 1 - m.used / m.total : 1);
  return [...meters].sort((a, b) => left(a) - left(b))[0];
}

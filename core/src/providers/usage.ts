// How much of the provider account is left: MiniMax plan windows, OpenRouter credit and key limit.
// Shown as a small bar next to the model picker and as a card in Settings.
import { join } from "node:path";
import type { Home } from "../home.ts";
import { readJson, writeJson } from "../util.ts";

export interface UsageMeter {
  /** "5-hour window", "Weekly", "Credits", "Key limit", "Monthly credit". */
  label: string;
  used: number;
  total: number;
  unit: "requests" | "usd" | "percent";
  /** When this meter resets, as epoch ms, when the provider says. */
  resetsAt?: number;
}

export interface ProviderUsage {
  provider: "minimax" | "openrouter" | "gemini";
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
  const reports = (m: any) => (num(m?.current_interval_total_count) ?? 0) > 0 || num(m?.current_interval_remaining_percent) !== undefined;
  const entry =
    (want && list.find((m) => String(m?.model_name ?? m?.model ?? "").toLowerCase() === want)) ??
    list.find((m) => String(m?.model_name ?? "").toLowerCase() === "general") ??
    list.find(reports) ??
    list[0];
  const meters: UsageMeter[] = [];
  // Plans that count requests report totals; the current plans report only a remaining percentage
  // (with the counts at 0), so fall back to that.
  const meter = (label: string, total: unknown, used: unknown, remainingPct: unknown, resetsAt?: number) => {
    const t = num(total);
    const u = num(used);
    const pct = num(remainingPct);
    if (t && u !== undefined) meters.push({ label, used: u, total: t, unit: "requests", resetsAt });
    else if (pct !== undefined) meters.push({ label, used: Math.max(0, Math.min(100, 100 - pct)), total: 100, unit: "percent", resetsAt });
  };
  meter("5-hour window", entry?.current_interval_total_count, entry?.current_interval_usage_count, entry?.current_interval_remaining_percent, resetTime(entry?.end_time, entry?.remains_time, now));
  meter(
    "Weekly",
    entry?.current_weekly_total_count ?? entry?.weekly_total_count,
    entry?.current_weekly_usage_count ?? entry?.weekly_usage_count,
    entry?.current_weekly_remaining_percent,
    resetTime(entry?.weekly_end_time, entry?.weekly_remains_time, now),
  );
  return meters;
}

/** Ask MiniMax how much of the plan is left. A pay-as-you-go key has no plan: no meters, no error. */
export async function miniMaxUsage(home: Home, opts: { key: string; baseUrl: string; model?: string; fetch?: Fetch }): Promise<ProviderUsage> {
  const f = opts.fetch ?? fetch;
  const origin = new URL(opts.baseUrl).origin;
  const china = /minimaxi\.com$/.test(new URL(opts.baseUrl).hostname);
  // The coding-plan path on the API host is the one that answers plan keys today; the documented
  // token-plan path is the fallback.
  const urls = [
    `${origin}/v1/api/openplatform/coding_plan/remains`,
    `${origin}/v1/token_plan/remains`,
    china ? "https://www.minimaxi.com/v1/token_plan/remains" : "https://www.minimax.io/v1/token_plan/remains",
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

// ---------- Google Gemini monthly free-credit ledger (Google AI Pro $10/month) ----------

export interface GeminiMonthLedger {
  month: string; // YYYY-MM
  usedUsd: number;
  requests: number;
  images: number;
  promptTokens: number;
  completionTokens: number;
  updatedAt: string;
}

const monthKey = (now = Date.now()) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export function nextMonthResetMs(now = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
}

const geminiLedgerPath = (home: Home, now = Date.now()) => join(home.root, "usage", `gemini-${monthKey(now)}.json`);

export function readGeminiLedger(home: Home, now = Date.now()): GeminiMonthLedger {
  const m = monthKey(now);
  return readJson<GeminiMonthLedger>(geminiLedgerPath(home, now), {
    month: m,
    usedUsd: 0,
    requests: 0,
    images: 0,
    promptTokens: 0,
    completionTokens: 0,
    updatedAt: new Date(now).toISOString(),
  });
}

/** Add one Gemini completion or image-generation call to the current month's credit ledger. */
export function recordGeminiUsage(
  home: Home,
  entry: { costUsd: number; promptTokens?: number; completionTokens?: number; images?: number },
  now = Date.now(),
): GeminiMonthLedger {
  const cur = readGeminiLedger(home, now);
  const next: GeminiMonthLedger = {
    month: cur.month,
    usedUsd: Math.max(0, Number((cur.usedUsd + Math.max(0, entry.costUsd)).toFixed(6))),
    requests: cur.requests + 1,
    images: cur.images + (entry.images ?? 0),
    promptTokens: cur.promptTokens + (entry.promptTokens ?? 0),
    completionTokens: cur.completionTokens + (entry.completionTokens ?? 0),
    updatedAt: new Date(now).toISOString(),
  };
  writeJson(geminiLedgerPath(home, now), next);
  return next;
}

/** Manually sync or reset the current month's tracked Gemini spend (e.g. to match Google Cloud Billing). */
export function adjustGeminiUsage(home: Home, usedUsd: number, now = Date.now()): GeminiMonthLedger {
  const cur = readGeminiLedger(home, now);
  const next: GeminiMonthLedger = {
    ...cur,
    usedUsd: Math.max(0, Number(usedUsd.toFixed(6))),
    updatedAt: new Date(now).toISOString(),
  };
  writeJson(geminiLedgerPath(home, now), next);
  return next;
}

/** Monthly Google AI Pro credit usage meter (defaults to $10/month, resets on the 1st of next month). */
export function geminiUsage(home: Home, opts: { creditUsd?: number; now?: number } = {}): ProviderUsage {
  const now = opts.now ?? Date.now();
  const total = opts.creditUsd ?? home.config().budgets.geminiMonthlyCreditUsd ?? 10;
  const ledger = readGeminiLedger(home, now);
  const meters: UsageMeter[] = [];
  if (total > 0) {
    meters.push({
      label: "Monthly credit",
      used: ledger.usedUsd,
      total,
      unit: "usd",
      resetsAt: nextMonthResetMs(now),
    });
  }
  return {
    provider: "gemini",
    meters,
    checkedAt: now,
    ...(meters.length ? {} : { error: "Set a monthly Gemini credit limit in Settings to track balance." }),
  };
}

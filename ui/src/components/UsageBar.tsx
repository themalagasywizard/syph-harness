// How much of the provider account is left: a small bar beside the model picker, and a card in Settings.
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../api";

export interface UsageMeter {
  label: string;
  used: number;
  total: number;
  unit: "requests" | "usd" | "percent";
  resetsAt?: number;
}

export interface ProviderUsage {
  provider: "minimax" | "openrouter";
  meters: UsageMeter[];
  checkedAt: number;
  error?: string;
}

/** "minimax:MiniMax-M3.1-Flash" → the provider with a usage endpoint, and the model name it knows. */
export function usageProvider(model?: string): { provider: "minimax" | "openrouter"; model: string } | null {
  const m = /^(minimax|openrouter):(.+)$/.exec(model ?? "");
  return m ? { provider: m[1] as "minimax" | "openrouter", model: m[2] } : null;
}

const frac = (m: UsageMeter) => (m.total > 0 ? Math.min(1, Math.max(0, m.used / m.total)) : 0);
const level = (f: number) => (f >= 0.95 ? "bad" : f >= 0.8 ? "warn" : "ok");
const tightest = (ms: UsageMeter[]) => [...ms].sort((a, b) => frac(b) - frac(a))[0];

export function resetsIn(at?: number, now = Date.now()) {
  if (!at) return "";
  const s = Math.max(0, Math.round((at - now) / 1000));
  if (s < 60) return "in under a minute";
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60}m`;
  return `${new Date(at).toLocaleDateString(undefined, { weekday: "short" })} ${new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function amount(m: UsageMeter) {
  if (m.unit === "percent") return `${Math.round(Math.max(0, m.total - m.used))}% left`;
  if (m.unit === "usd") return `$${Math.max(0, m.total - m.used).toFixed(2)} left of $${m.total.toFixed(2)}`;
  return `${Math.max(0, m.total - m.used).toLocaleString()} of ${m.total.toLocaleString()} requests left`;
}

/** Fetch usage for a provider; `bump` refetches (after a reply), and it refreshes every 3 minutes. */
export function useUsage(provider?: "minimax" | "openrouter", model?: string, bump = 0) {
  const [usage, setUsage] = useState<ProviderUsage | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!provider) return setUsage(null);
    let gone = false;
    const q = new URLSearchParams({ ...(model ? { model } : {}), ...(bump || tick ? { fresh: "1" } : {}) });
    api.get<ProviderUsage>(`/usage/${provider}?${q}`).then((u) => !gone && setUsage(u)).catch(() => !gone && setUsage(null));
    return () => {
      gone = true;
    };
  }, [provider, model, bump, tick]);
  useEffect(() => {
    if (!provider) return;
    const id = setInterval(() => setTick((t) => t + 1), 180_000);
    return () => clearInterval(id);
  }, [provider]);
  return { usage, refresh: () => setTick((t) => t + 1) };
}

function Meter({ m }: { m: UsageMeter }) {
  const f = frac(m);
  return (
    <div className="usage-meter">
      <div className="um-head">
        <span>{m.label}</span>
        <span className="um-pct">{Math.round(f * 100)}% used</span>
      </div>
      <div className={`um-track ${level(f)}`}><div style={{ width: `${f * 100}%` }} /></div>
      <div className="um-foot hint">
        {amount(m)}
        {m.resetsAt ? ` · resets ${resetsIn(m.resetsAt)}` : ""}
      </div>
    </div>
  );
}

/** The bar beside the model picker. Hidden when the provider has no usage to show. */
export function UsageBar({ model, bump }: { model?: string; bump?: number }) {
  const p = usageProvider(model);
  const { usage } = useUsage(p?.provider, p?.model, bump);
  const [open, setOpen] = useState(false);
  if (!p || !usage?.meters.length) return null;
  const top = tightest(usage.meters);
  const f = frac(top);
  const name = p.provider === "minimax" ? "MiniMax plan" : "OpenRouter";
  return (
    <div className="usage-bar" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onClick={() => setOpen((o) => !o)}>
      <button className={`usage-chip ${level(f)}`} aria-label={`${name}: ${Math.round(f * 100)}% of ${top.label.toLowerCase()} used`}>
        <span className="uc-track"><span style={{ width: `${Math.max(f * 100, 3)}%` }} /></span>
        <span className="uc-pct">{Math.round(f * 100)}%</span>
      </button>
      {open && (
        <div className="usage-pop">
          <div className="up-title">{name}</div>
          {usage.meters.map((m) => <Meter key={m.label} m={m} />)}
        </div>
      )}
    </div>
  );
}

/** The card in Settings: every meter, its reset time, and a refresh. */
export function UsageCard({ provider }: { provider: "minimax" | "openrouter" }) {
  const { usage, refresh } = useUsage(provider);
  if (!usage) return null;
  return (
    <div className="usage-card">
      <div className="uc-head">
        <span className="hint">{provider === "minimax" ? "Plan usage" : "Balance"}</span>
        <button className="icon-btn sm" title="Refresh" onClick={refresh}><RefreshCw size={14} /></button>
      </div>
      {usage.meters.length ? (
        usage.meters.map((m) => <Meter key={m.label} m={m} />)
      ) : (
        <div className="hint">{usage.error ?? "Nothing to show."}</div>
      )}
      {provider === "minimax" && (
        <a className="hint" href="https://platform.minimax.io/console/usage" target="_blank" rel="noreferrer">See usage on MiniMax</a>
      )}
    </div>
  );
}

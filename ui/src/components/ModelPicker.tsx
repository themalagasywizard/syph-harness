import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, Search } from "lucide-react";
import { api, modelLabel, type Effort, type ModelInfo } from "../api";
import { useApp } from "../App";

let cache: Promise<ModelInfo[]> | null = null;
export const loadModels = () => (cache ??= api.get<ModelInfo[]>("/models").catch(() => ((cache = null), [])));
export const resetModels = () => {
  cache = null;
};

const PROVIDER_LABEL: Record<string, string> = { openrouter: "OpenRouter", minimax: "MiniMax", ollama: "Local · Ollama", lmstudio: "Local · LM Studio" };

// The models picked most recently, newest first, so the menu opens on the few you actually use.
const RECENT_KEY = "syph.recentModels";
const RECENT_MAX = 5;
function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function pushRecent(ref: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([ref, ...readRecent().filter((r) => r !== ref)].slice(0, RECENT_MAX)));
  } catch {
    /* private mode */
  }
}

const EFFORT_LABEL: Record<Effort, string> = { auto: "Auto", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/** Effort levels a model's provider understands. Local models have none. */
export function effortLevels(ref?: string): Effort[] {
  const provider = ref && ref.indexOf(":") > 0 ? ref.slice(0, ref.indexOf(":")) : "openrouter";
  if (provider === "minimax") return ["auto", "low", "medium", "high", "xhigh", "max"];
  if (provider === "openrouter") return ["auto", "low", "medium", "high"];
  return [];
}

/**
 * Model menu. It opens on the selected model and the ones picked recently, with every other model
 * behind "More models" (searchable). With `effort`, it also has an effort selector for the chosen model.
 */
export function ModelPicker({ value, onChange, align = "right", compact = true, up = true, effort = false }: { value?: string; onChange: (ref: string) => void; align?: "left" | "right"; compact?: boolean; up?: boolean; effort?: boolean }) {
  const { state, refresh } = useApp();
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [q, setQ] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setRecent(readRecent());
      if (more) loadModels().then(setModels);
    } else {
      setMore(false);
      setQ("");
    }
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    addEventListener("mousedown", close);
    return () => removeEventListener("mousedown", close);
  }, [open, more]);

  const pick = (m: string) => {
    pushRecent(m);
    onChange(m);
    setOpen(false);
  };

  const quick = useMemo(() => {
    const list = [value, ...recent].filter(Boolean) as string[];
    if (list.length < 2) list.push(state?.config.defaults.chatModel ?? "");
    return [...new Set(list.filter(Boolean))].slice(0, RECENT_MAX);
  }, [value, recent, state]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (m: ModelInfo) => !needle || m.ref.toLowerCase().includes(needle) || m.label.toLowerCase().includes(needle);
    const out: { label: string; items: { ref: string; label: string }[] }[] = [];
    const byProv = new Map<string, ModelInfo[]>();
    for (const m of models.filter(match)) byProv.set(m.provider, [...(byProv.get(m.provider) ?? []), m]);
    for (const [p, items] of byProv) out.push({ label: PROVIDER_LABEL[p] ?? p, items: items.slice(0, needle ? 60 : 40).map((m) => ({ ref: m.ref, label: m.label })) });
    if (needle && !models.some((m) => m.ref === q.trim())) out.push({ label: "Use exactly", items: [{ ref: q.trim(), label: q.trim() }] });
    return out;
  }, [models, q]);

  const levels = effort ? effortLevels(value) : [];
  const current: Effort = state?.config.defaults.effort ?? "auto";
  const shown = levels.includes(current) ? current : levels.length && current !== "auto" ? levels.at(-1)! : "auto";
  const setEffort = async (e: Effort) => {
    if (!state) return;
    await api.put("/settings", { defaults: { ...state.config.defaults, effort: e } });
    refresh();
  };

  const row = (m: { ref: string; label: string }, key: string, showId = true) => (
    <button key={key} onClick={() => pick(m.ref)}>
      <span className="ellipsis">{m.label}</span>
      <span className="id">{m.ref === value ? <Check size={14} /> : showId ? m.ref.replace(/^openrouter:/, "") : ""}</span>
    </button>
  );

  return (
    <div className="model-menu" ref={ref}>
      <button className={compact ? "pill" : "input select-like"} onClick={() => setOpen((o) => !o)} type="button">
        <span className="ellipsis">{modelLabel(value) || "Choose a model"}</span>
        {levels.length > 0 && shown !== "auto" && <span className="effort-tag">{EFFORT_LABEL[shown]}</span>}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="menu" style={{ [align]: 0, ...(up ? { bottom: 40 } : { top: 44, bottom: "auto" }) }}>
          {!more ? (
            <>
              <div className="grp">Recent</div>
              {quick.map((r) => row({ ref: r, label: modelLabel(r) }, r, false))}
              <button className="more-models" onClick={() => setMore(true)}>
                <span>More models</span> <ChevronRight size={14} style={{ marginLeft: "auto" }} />
              </button>
              {levels.length > 0 && (
                <div className="effort">
                  <div className="grp">Effort</div>
                  <div className="effort-seg" role="radiogroup" aria-label="Effort">
                    {levels.map((l) => (
                      <button key={l} role="radio" aria-checked={shown === l} className={shown === l ? "on" : ""} onClick={() => setEffort(l)} title={l === "auto" ? "Let the model decide" : `${EFFORT_LABEL[l]} effort`}>
                        {EFFORT_LABEL[l]}
                      </button>
                    ))}
                  </div>
                  <div className="effort-hint">{shown === "auto" ? "The model decides how long to think." : shown === "low" ? "Faster and cheaper, less thinking." : shown === "max" || shown === "xhigh" ? "Thinks longest. Slower and costs more." : "More thinking for harder work."}</div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="menu-search">
                <button className="icon-btn" onClick={() => setMore(false)} aria-label="Back" style={{ width: "auto", padding: 0 }}><ArrowLeft size={14} /></button>
                <Search size={14} />
                <input autoFocus placeholder="Search models, or type provider:model" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <div className="menu-scroll">
                {groups.map((g) => (
                  <div key={g.label}>
                    <div className="grp">{g.label}</div>
                    {g.items.map((m) => row(m, g.label + m.ref))}
                  </div>
                ))}
                {!models.length && <div className="hint" style={{ padding: 10 }}>Loading models… (Ollama and LM Studio show up when running)</div>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

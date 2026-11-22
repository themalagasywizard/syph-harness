import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { api, modelLabel, type ModelInfo } from "../api";
import { useApp } from "../App";

let cache: Promise<ModelInfo[]> | null = null;
export const loadModels = () => (cache ??= api.get<ModelInfo[]>("/models").catch(() => ((cache = null), [])));
export const resetModels = () => {
  cache = null;
};

const PROVIDER_LABEL: Record<string, string> = { openrouter: "OpenRouter", ollama: "Local · Ollama", lmstudio: "Local · LM Studio" };

/** Searchable model menu. Shows defaults first, then DeepSeek and local models, then search hits. */
export function ModelPicker({ value, onChange, align = "right", compact = true, up = true }: { value?: string; onChange: (ref: string) => void; align?: "left" | "right"; compact?: boolean; up?: boolean }) {
  const { state } = useApp();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) loadModels().then(setModels);
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    addEventListener("mousedown", close);
    return () => removeEventListener("mousedown", close);
  }, [open]);

  const groups = useMemo(() => {
    const d = state?.config.defaults;
    const pinned = [...new Set([d?.chatModel, d?.reflectorModel, value].filter(Boolean) as string[])];
    const needle = q.trim().toLowerCase();
    const match = (m: ModelInfo) => !needle || m.ref.toLowerCase().includes(needle) || m.label.toLowerCase().includes(needle);
    const out: { label: string; items: { ref: string; label: string }[] }[] = [];
    if (!needle) out.push({ label: "Defaults", items: pinned.map((r) => ({ ref: r, label: modelLabel(r) })) });
    const byProv = new Map<string, ModelInfo[]>();
    for (const m of models.filter(match)) {
      if (!needle && m.provider === "openrouter" && !/deepseek/.test(m.ref)) continue;
      byProv.set(m.provider, [...(byProv.get(m.provider) ?? []), m]);
    }
    for (const [p, items] of byProv) out.push({ label: PROVIDER_LABEL[p] ?? p, items: items.slice(0, needle ? 40 : 12).map((m) => ({ ref: m.ref, label: m.label })) });
    if (needle && !models.some((m) => m.ref === q.trim())) out.push({ label: "Use exactly", items: [{ ref: q.trim(), label: q.trim() }] });
    return out;
  }, [models, q, state, value]);

  return (
    <div className="model-menu" ref={ref}>
      <button className={compact ? "pill" : "input select-like"} onClick={() => setOpen((o) => !o)} type="button">
        <span className="ellipsis">{modelLabel(value) || "Choose a model"}</span> <ChevronDown size={14} />
      </button>
      {open && (
        <div className="menu" style={{ [align]: 0, ...(up ? { bottom: 40 } : { top: 44, bottom: "auto" }) }}>
          <div className="menu-search">
            <Search size={14} />
            <input autoFocus placeholder="Search models, or type provider:model" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="menu-scroll">
            {groups.map((g) => (
              <div key={g.label}>
                <div className="grp">{g.label}</div>
                {g.items.map((m) => (
                  <button key={g.label + m.ref} onClick={() => { onChange(m.ref); setOpen(false); setQ(""); }}>
                    <span className="ellipsis">{m.label}</span>
                    <span className="id">{m.ref === value ? <Check size={14} /> : m.ref.replace(/^openrouter:/, "")}</span>
                  </button>
                ))}
              </div>
            ))}
            {!models.length && <div className="hint" style={{ padding: 10 }}>Loading models… (Ollama and LM Studio show up when running)</div>}
          </div>
        </div>
      )}
    </div>
  );
}

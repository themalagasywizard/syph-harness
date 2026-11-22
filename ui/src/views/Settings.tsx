import { useEffect, useState } from "react";
import { Cloud, Cpu, Download, Plug, Server } from "lucide-react";
import { Toggle } from "../components/Toggle";
import { ModelPicker } from "../components/ModelPicker";
import { OpenRouterKey } from "../components/OpenRouterKey";
import { InterfaceSettings } from "../components/InterfaceSettings";
import { PhonePairing } from "../components/PhonePairing";
import { useApp } from "../App";
import { api, type Config, type Profile } from "../api";

export function SettingsView() {
  const { state, refresh, theme, setTheme } = useApp();
  const [profileRef, setProfileRef] = useState<string>();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [exported, setExported] = useState<string>();
  const cfg = state?.config;

  useEffect(() => {
    if (!profileRef && cfg) setProfileRef(cfg.defaults.chatModel);
  }, [cfg, profileRef]);
  useEffect(() => {
    if (profileRef) api.get<Profile>(`/profiles/${encodeURIComponent(profileRef)}`).then(setProfile);
  }, [profileRef]);

  if (!cfg || !state) return null;
  const patch = async (p: Partial<Config> | Record<string, unknown>) => {
    await api.put("/settings", p);
    refresh();
  };
  const setProvider = (name: string, baseUrl: string) => patch({ providers: cfg.providers.map((p) => (p.name === name ? { ...p, baseUrl } : p)) });
  const saveProfile = async (p: Partial<Profile>) => {
    const next = { ...profile!, ...p };
    setProfile(next);
    await api.put(`/profiles/${encodeURIComponent(profileRef!)}`, next);
  };
  const provider = (name: string) => cfg.providers.find((p) => p.name === name);

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 780 }}>
        <div className="page-head">
          <div>
            <h2>Settings</h2>
            <p>Providers, models, budgets and how much Syph may change on its own. Stored in <code>{state.homePath}</code>.</p>
          </div>
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Phone</div>
        <div style={{ marginBottom: 32 }}>
          <PhonePairing />
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Model providers</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 32 }}>
          <div className="card">
            <div className="provider">
              <div className="pi"><Cloud size={20} /></div>
              <div>
                <h3>OpenRouter</h3>
                <p>Hundreds of hosted models through one key. Used for DeepSeek by default.</p>
                <OpenRouterKey onChange={refresh} />
              </div>
              <span className={`conn ${cfg.hasOpenRouterKey ? "" : "off"}`}>{cfg.hasOpenRouterKey ? "● Key set" : "○ No key"}</span>
            </div>
          </div>
          {[["ollama", "Ollama", "Local models on this machine or your network.", <Cpu size={20} />], ["lmstudio", "OpenAI-compatible", "LM Studio, llama.cpp, vLLM or any /v1 endpoint.", <Server size={20} />]].map(([name, title, desc, icon]) => (
            <div className="card" key={name as string}>
              <div className="provider">
                <div className="pi">{icon}</div>
                <div>
                  <h3>{title}</h3>
                  <p>{desc}</p>
                  <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
                    <label>Base URL</label>
                    <input className="input cron" defaultValue={provider(name as string)?.baseUrl} onBlur={(e) => e.target.value !== provider(name as string)?.baseUrl && setProvider(name as string, e.target.value)} style={{ background: "var(--bg)" }} />
                    <span className="hint">Use models from here as <code>{name as string}:&lt;model&gt;</code>.</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Default models</div>
        <div className="list" style={{ marginBottom: 32 }}>
          {([["chatModel", "Chat", "New chats start with this model."], ["taskModel", "Tasks", "Scheduled tasks use this unless they pick one."], ["reflectorModel", "Reflector", "Proposes improvements. Use your strongest model."], ["judgeModel", "Judge", "Scores eval answers. Ideally a different family from the chat model."]] as const).map(([k, label, hint]) => (
            <div key={k} className="row" style={{ gridTemplateColumns: "1fr 280px" }}>
              <div><div className="name">{label}</div><div className="sub">{hint}</div></div>
              <ModelPicker value={cfg.defaults[k]} onChange={(m) => patch({ defaults: { ...cfg.defaults, [k]: m } })} compact={false} up={false} />
            </div>
          ))}
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Model profile</div>
        <p className="hint" style={{ marginTop: -2, marginBottom: 12 }}>How Syph runs a model. The improvement loop may propose changes to these too.</p>
        <div className="list" style={{ marginBottom: 32 }}>
          <div className="row" style={{ gridTemplateColumns: "1fr 280px" }}>
            <div className="name">Model</div>
            <ModelPicker value={profileRef} onChange={setProfileRef} compact={false} up={false} />
          </div>
          {profile && (
            <>
              <div className="row" style={{ gridTemplateColumns: "1fr 280px" }}>
                <div><div className="name">Strategy</div><div className="sub">{state.strategies.find((s) => s.name === profile.strategy)?.description}</div></div>
                <select className="input" value={profile.strategy} onChange={(e) => saveProfile({ strategy: e.target.value })}>
                  {state.strategies.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                </select>
              </div>
              {profile.strategy === "cascade" && (
                <div className="row" style={{ gridTemplateColumns: "1fr 280px" }}>
                  <div><div className="name">Escalate to</div><div className="sub">Used when a check of this model's answer fails.</div></div>
                  <ModelPicker value={profile.escalateTo} onChange={(m) => saveProfile({ escalateTo: m })} compact={false} up={false} />
                </div>
              )}
              <div className="row" style={{ gridTemplateColumns: "1fr 120px" }}>
                <div><div className="name">Few-shot examples</div><div className="sub">Good past answers shown to the model for similar requests.</div></div>
                <input className="input" type="number" min={0} max={5} value={profile.fewShot} onChange={(e) => saveProfile({ fewShot: Number(e.target.value) })} />
              </div>
              <div className="row" style={{ gridTemplateColumns: "1fr 120px" }}>
                <div><div className="name">Context window</div><div className="sub">Tokens. Older turns are summarised past 60%.</div></div>
                <input className="input" type="number" min={2048} step={1024} value={profile.contextWindow} onChange={(e) => saveProfile({ contextWindow: Number(e.target.value) })} />
              </div>
              <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
                <div><div className="name">Native tool calling</div><div className="sub">Turn off for local models that don't support tools; Syph uses a text protocol instead.</div></div>
                <Toggle on={profile.nativeTools} onChange={(v) => saveProfile({ nativeTools: v })} label="Native tool calling" />
              </div>
            </>
          )}
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Connectors</div>
        <div className="list" style={{ marginBottom: 32 }}>
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div style={{ minWidth: 0 }}><div className="name">Google Workspace and other apps</div><div className="sub wrap">Sign in to Google, add API keys, and remove connectors Syph created.</div></div>
            <a className="btn tonal sm" href="#/connectors">Open Connectors</a>
          </div>
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Tool approvals</div>
        <div className="list" style={{ marginBottom: 32 }}>
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div style={{ minWidth: 0 }}><div className="name">YOLO mode</div><div className="sub wrap">Run {navigator.userAgent.includes("Windows") ? "PowerShell" : "shell"} commands and other ask-first tools in chats without asking. Also lets any tool waiting for you run. You can flip it from the chat box too.</div></div>
            <Toggle on={!!cfg.approval.yolo} onChange={(v) => patch({ approval: { yolo: v } })} label="YOLO mode" />
          </div>
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div style={{ minWidth: 0 }}><div className="name">YOLO for scheduled Tasks</div><div className="sub wrap">Tasks run with nobody watching, so they decline ask-first tools unless this is on.</div></div>
            <Toggle on={!!cfg.approval.yoloTasks} onChange={(v) => patch({ approval: { yoloTasks: v } })} label="YOLO for scheduled Tasks" />
          </div>
        </div>

        <InterfaceSettings />

        <div className="section-label" style={{ paddingLeft: 0 }}>Self-improvement</div>
        <div className="list" style={{ marginBottom: 32 }}>
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div><div className="name">Auto-accept memory</div><div className="sub">Only when evals improve and nothing regresses.</div></div>
            <Toggle on={cfg.approval.autoAccept.memory} onChange={(v) => patch({ approval: { autoAccept: { ...cfg.approval.autoAccept, memory: v } } })} label="Auto-accept memory" />
          </div>
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div><div className="name">Auto-accept skills</div><div className="sub">Prompts, profiles and code always wait for you.</div></div>
            <Toggle on={cfg.approval.autoAccept.skill} onChange={(v) => patch({ approval: { autoAccept: { ...cfg.approval.autoAccept, skill: v } } })} label="Auto-accept skills" />
          </div>
          <div className="row" style={{ gridTemplateColumns: "1fr 120px" }}>
            <div><div className="name">Samples per eval case</div><div className="sub">More samples smooth out randomness but cost more.</div></div>
            <input className="input" type="number" min={1} max={5} value={cfg.evolve.samplesPerCase} onChange={(e) => patch({ evolve: { ...cfg.evolve, samplesPerCase: Number(e.target.value) } })} />
          </div>
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div><div className="name">Kill switch</div><div className="sub">Pause all Tasks and the improvement loop. Chat keeps working.</div></div>
            <Toggle on={cfg.killSwitch} onChange={(v) => patch({ killSwitch: v })} label="Kill switch" />
          </div>
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Daily budgets (USD)</div>
        <div className="list" style={{ marginBottom: 32 }}>
          {(["chat", "tasks", "evolve"] as const).map((k) => (
            <div key={k} className="row" style={{ gridTemplateColumns: "1fr 120px" }}>
              <div><div className="name">{k[0].toUpperCase() + k.slice(1)}</div><div className="sub">${(state.spend[k] ?? 0).toFixed(3)} spent today</div></div>
              <input className="input" type="number" min={0} step={0.5} value={cfg.budgets.dailyUsd[k]} onChange={(e) => patch({ budgets: { dailyUsd: { ...cfg.budgets.dailyUsd, [k]: Number(e.target.value) } } })} />
            </div>
          ))}
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Extensions and MCP</div>
        <div className="list" style={{ marginBottom: 32 }}>
          {state.extensions.length === 0 && state.mcp.length === 0 && <div className="empty" style={{ padding: 20 }}>No extensions yet. Syph can write them as proposals; MCP servers go in config.json under <code>mcpServers</code>.</div>}
          {state.extensions.map((x) => (
            <div key={x.name} className="row" style={{ gridTemplateColumns: "20px 1fr auto" }}>
              <Plug size={16} color="var(--muted)" />
              <div><div className="name">{x.name}</div><div className="sub">{x.ok ? `Tools: ${x.tools.join(", ") || "none"}` : x.error}</div></div>
              <span className={`conn ${x.ok ? "" : "off"}`}>{x.ok ? "● Loaded" : "○ Off"}</span>
            </div>
          ))}
          {state.mcp.map((m) => (
            <div key={m.name} className="row" style={{ gridTemplateColumns: "20px 1fr auto" }}>
              <Server size={16} color="var(--muted)" />
              <div><div className="name">MCP · {m.name}</div><div className="sub">{m.error ?? `${m.tools.length} tools`}</div></div>
              <span className={`conn ${m.error ? "off" : ""}`}>{m.error ? "○ Error" : "● Connected"}</span>
            </div>
          ))}
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Data</div>
        <div className="list" style={{ marginBottom: 32 }}>
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div><div className="name">Export training data</div><div className="sub">{exported ?? "SFT (good answers) and DPO (up vs down pairs) as JSONL, for fine-tuning a local model."}</div></div>
            <button className="btn tonal sm" onClick={async () => { const r = await api.post<{ sft: string; sftCount: number; dpoCount: number }>("/export"); setExported(`${r.sftCount} SFT and ${r.dpoCount} DPO examples written next to ${r.sft}`); }}><Download size={14} /> Export</button>
          </div>
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div className="name">Dark theme</div>
            <Toggle on={theme === "dark"} onChange={(v) => setTheme(v ? "dark" : "light")} label="Dark theme" />
          </div>
        </div>
      </div>
    </div>
  );
}

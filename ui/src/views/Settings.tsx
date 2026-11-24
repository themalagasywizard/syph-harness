import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, Cloud, Cpu, Download, Plug, Server, Zap } from "lucide-react";
import { Toggle } from "../components/Toggle";
import { ModelPicker } from "../components/ModelPicker";
import { MiniMaxKey, OpenRouterKey } from "../components/OpenRouterKey";
import { UsageCard } from "../components/UsageBar";
import { InterfaceSettings } from "../components/InterfaceSettings";
import { PhonePairing } from "../components/PhonePairing";
import { useApp } from "../App";
import { api, type Config, type Profile } from "../api";
import { useExt } from "../ext";
import { SETTINGS_SECTIONS } from "../settingsIndex";

const MINIMAX_DEFAULT = "minimax:MiniMax-M3.1-Flash";

const OPEN_KEY = "syph.settingsOpen";
function readOpen(): string[] {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]");
  } catch {
    return [];
  }
}

/** Short model name for a summary line: "openrouter:deepseek/deepseek-v4.1-flash" becomes "deepseek-v4.1-flash". */
const shortModel = (m?: string) => (m ? m.split(/[:/]/).pop() : "not set");
const onOff = (v?: boolean) => (v ? "on" : "off");

/**
 * Settings is a list of folded sections: each shows its name and a one-line summary of what's
 * set, and opens to the full controls. Which ones are open is remembered. `section` (and `item`)
 * come from the URL, so the sidebar search can open a section and point at one setting.
 */
export function SettingsView({ section, item }: { section?: string; item?: string }) {
  const { state, refresh, theme, setTheme } = useApp();
  const { items: uiItems, safe } = useExt();
  const [open, setOpenList] = useState<string[]>(() => (section ? [...new Set([...readOpen(), section])] : readOpen()));
  const setOpen = (ids: string[]) => {
    setOpenList(ids);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(ids));
    } catch {
      /* private mode */
    }
  };
  const toggle = (id: string) => setOpen(open.includes(id) ? open.filter((x) => x !== id) : [...open, id]);
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

  // Arriving from search: open the section, scroll to it, and flash the setting asked for.
  useEffect(() => {
    if (!section || !cfg) return;
    if (!open.includes(section)) setOpen([...open, section]);
    const t = setTimeout(() => {
      const sec = document.getElementById(`set-${section}`);
      if (!sec) return;
      const want = item?.toLowerCase().replace(/ (model|budget|base url)$/, "");
      const row = want ? [...sec.querySelectorAll<HTMLElement>(".row, .card")].find((r) => r.textContent?.toLowerCase().includes(want)) : undefined;
      (row ?? sec).scrollIntoView({ block: row ? "center" : "start", behavior: "smooth" });
      if (row) {
        row.classList.add("flash");
      }
    }, 80);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, item, !!cfg]);

  if (!cfg || !state) return null;
  const agent = cfg.agent ?? {};
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

  const summary: Record<string, string> = {
    providers: `OpenRouter ${cfg.hasOpenRouterKey ? "key set" : "no key"} · MiniMax ${cfg.hasMiniMaxKey ? "key set" : "no key"} · Ollama · OpenAI-compatible`,
    defaults: `Chat ${shortModel(cfg.defaults.chatModel)} · Tasks ${shortModel(cfg.defaults.taskModel)}`,
    profile: profile ? `${shortModel(profileRef)} · ${profile.strategy} · ${profile.nativeTools ? "native tools" : "text tools"}` : "How Syph runs each model",
    approvals: `YOLO ${onOff(cfg.approval.yolo)} · Terminal ${cfg.approval.terminal === "auto" ? "auto" : "asks"} · YOLO for Tasks ${onOff(cfg.approval.yoloTasks)}`,
    long: `Long tasks: ${agent.longSteps ? `${agent.longSteps} steps` : "no step cap"}, ${agent.maxUsdPerLongRun ? `$${agent.maxUsdPerLongRun}` : "no spend cap"} · Checkpoints ${onOff(agent.gitCheckpoints)}`,
    budgets: `$${(state.spend.chat ?? 0).toFixed(2)} of $${cfg.budgets.dailyUsd.chat} chat today · Tasks $${cfg.budgets.dailyUsd.tasks} · Evolve $${cfg.budgets.dailyUsd.evolve}`,
    connectors: "Google Workspace, API keys and other apps",
    extensions: `${state.extensions.length} extension${state.extensions.length === 1 ? "" : "s"} · ${state.mcp.length} MCP server${state.mcp.length === 1 ? "" : "s"}`,
    phone: "Pair the Syph iPhone app with a QR code",
    appearance: `${theme === "dark" ? "Dark" : "Light"} theme · ${uiItems.length} interface change${uiItems.length === 1 ? "" : "s"}${safe ? " · safe mode on" : ""}`,
    evolve: `Kill switch ${onOff(cfg.killSwitch)} · Auto-accept memory ${onOff(cfg.approval.autoAccept.memory)}, skills ${onOff(cfg.approval.autoAccept.skill)}`,
    data: exported ?? "Export good answers as fine-tuning data",
  };
  const bodies: Record<string, ReactNode> = {
    providers: (
<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card">
            <div className="provider">
              <div className="pi"><Cloud size={20} /></div>
              <div>
                <h3>OpenRouter</h3>
                <p>Hundreds of hosted models through one key. Used for DeepSeek by default.</p>
                <OpenRouterKey onChange={refresh} />
                {cfg.hasOpenRouterKey && <UsageCard provider="openrouter" />}
              </div>
              <span className={`conn ${cfg.hasOpenRouterKey ? "" : "off"}`}>{cfg.hasOpenRouterKey ? "● Key set" : "○ No key"}</span>
            </div>
          </div>
          <div className="card">
            <div className="provider">
              <div className="pi"><Zap size={20} /></div>
              <div>
                <h3>MiniMax</h3>
                <p>MiniMax M3.1 Flash and M3 with your MiniMax subscription or API key. Pick them as <code>minimax:MiniMax-M3.1-Flash</code>.</p>
                <MiniMaxKey onChange={refresh} />
                {cfg.hasMiniMaxKey && <UsageCard provider="minimax" />}
                {cfg.hasMiniMaxKey && (cfg.defaults.chatModel !== MINIMAX_DEFAULT || cfg.defaults.taskModel !== MINIMAX_DEFAULT) && (
                  <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => patch({ defaults: { ...cfg.defaults, chatModel: MINIMAX_DEFAULT, taskModel: MINIMAX_DEFAULT } })}>
                    Use MiniMax M3.1 Flash for chats and tasks
                  </button>
                )}
              </div>
              <span className={`conn ${cfg.hasMiniMaxKey ? "" : "off"}`}>{cfg.hasMiniMaxKey ? "● Key set" : "○ No key"}</span>
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
    ),
    defaults: (
<div className="list">
          {([["chatModel", "Chat", "New chats start with this model."], ["taskModel", "Tasks", "Scheduled tasks use this unless they pick one."], ["reflectorModel", "Reflector", "Proposes improvements. Use your strongest model."], ["judgeModel", "Judge", "Scores eval answers. Ideally a different family from the chat model."]] as const).map(([k, label, hint]) => (
            <div key={k} className="row" style={{ gridTemplateColumns: "1fr 280px" }}>
              <div><div className="name">{label}</div><div className="sub">{hint}</div></div>
              <ModelPicker value={cfg.defaults[k]} onChange={(m) => patch({ defaults: { ...cfg.defaults, [k]: m } })} compact={false} up={false} />
            </div>
          ))}
        </div>
    ),
    profile: (
      <>
        <p className="hint set-note">How Syph runs a model. The improvement loop may propose changes to these too.</p>
<div className="list">
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
                <div>
                  <div className="name">Context window</div>
                  <div className="sub">
                    {profile.contextWindowSet ? "Your limit, in tokens. " : "The model's full window, read from the provider. "}Older turns are summarised past 60%.
                    {profile.contextWindowSet && <> <button className="link-btn" style={{ color: "var(--accent)" }} onClick={() => saveProfile({ contextWindowSet: false })}>Use the model's maximum</button></>}
                  </div>
                </div>
                <input className="input" type="number" min={2048} step={1024} value={profile.contextWindow} onChange={(e) => saveProfile({ contextWindow: Number(e.target.value), contextWindowSet: true })} />
              </div>
              <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
                <div><div className="name">Native tool calling</div><div className="sub">Turn off for local models that don't support tools; Syph uses a text protocol instead.</div></div>
                <Toggle on={profile.nativeTools} onChange={(v) => saveProfile({ nativeTools: v })} label="Native tool calling" />
              </div>
            </>
          )}
        </div>
      </>
    ),
    approvals: (
<div className="list">
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div style={{ minWidth: 0 }}><div className="name">YOLO mode</div><div className="sub wrap">Run {navigator.userAgent.includes("Windows") ? "PowerShell" : "shell"} commands and other ask-first tools in chats without asking. Also lets any tool waiting for you run. You can flip it from the chat box too.</div></div>
            <Toggle on={!!cfg.approval.yolo} onChange={(v) => patch({ approval: { yolo: v } })} label="YOLO mode" />
          </div>
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div style={{ minWidth: 0 }}><div className="name">Run terminal commands without asking</div><div className="sub wrap">Commands in your workspace and in folders linked with write access run straight away; you still see each one in the chat's command log and can stop it. Off: Syph asks before each command (you can also allow a whole chat from the question). Read-only folders always ask.</div></div>
            <Toggle on={cfg.approval.terminal === "auto"} onChange={(v) => patch({ approval: { terminal: v ? "auto" : "ask" } })} label="Run terminal commands without asking" />
          </div>
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div style={{ minWidth: 0 }}><div className="name">YOLO for scheduled Tasks</div><div className="sub wrap">Tasks run with nobody watching, so they decline ask-first tools unless this is on.</div></div>
            <Toggle on={!!cfg.approval.yoloTasks} onChange={(v) => patch({ approval: { yoloTasks: v } })} label="YOLO for scheduled Tasks" />
          </div>
        </div>
    ),
    long: (
<div className="list">
          {([
            ["shortSteps", "Steps for a quick request", "Past this, Syph is asked to plan the rest. A plan of three or more steps, or an approved contract, makes it a long task.", 5, 500],
            ["maxUsdPerRun", "Spend for a quick request (USD)", "0 means no cap.", 0, 50],
            ["maxMinutes", "Minutes for a quick request", "0 means no cap.", 0, 600],
            ["longSteps", "Steps for a long task", "0 means no cap: it keeps going until the work is done, like Claude Code.", 0, 100000],
            ["longMinutes", "Minutes for a long task", "0 means no cap. Runs can go for hours.", 0, 100000],
            ["maxUsdPerLongRun", "Spend for a long task (USD)", "0 means no cap. The daily chat budget below still applies: raise it for long runs.", 0, 1000],
            ["reviewAfterErrors", "Review a run after this many failed calls", "Syph works out what it was missing and proposes a fix (a tool, a skill, a rule) in Evolve. 0 turns this off.", 0, 100],
            ["maxThreads", "Project threads at once", "How many threads the coordinators may run at the same time. More wait in a queue.", 1, 20],
            ["coordinatorWakesPerHour", "Coordinator follow-ups per hour", "How often finished threads may wake a coordinator to report. Stops two agents from pinging each other forever. 0 turns follow-ups off.", 0, 60],
          ] as const).map(([key, name, sub, min, max]) => (
            <div className="row" style={{ gridTemplateColumns: "1fr 120px" }} key={key}>
              <div><div className="name">{name}</div><div className="sub">{sub}</div></div>
              <input className="input" type="number" min={min} max={max} step={key === "maxUsdPerRun" || key === "maxUsdPerLongRun" ? 0.1 : 1} value={agent[key] ?? (key === "maxThreads" ? 3 : key === "coordinatorWakesPerHour" ? 6 : 0)} onChange={(e) => patch({ agent: { ...agent, [key]: Number(e.target.value) } })} />
            </div>
          ))}
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div style={{ minWidth: 0 }}><div className="name">Git checkpoints</div><div className="sub wrap">After each finished plan step, save the linked repo's state on a side ref (refs/syph/checkpoints). Never touches your branch, never pushes.</div></div>
            <Toggle on={!!agent.gitCheckpoints} onChange={(v) => patch({ agent: { ...agent, gitCheckpoints: v } })} label="Git checkpoints" />
          </div>
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div style={{ minWidth: 0 }}><div className="name">Load app tools on demand</div><div className="sub wrap">Connector and MCP tools are sent to the model only once a chat asks for them, which saves tokens on every step.</div></div>
            <Toggle on={!!agent.lazyTools} onChange={(v) => patch({ agent: { ...agent, lazyTools: v } })} label="Load app tools on demand" />
          </div>
          <div className="row" style={{ gridTemplateColumns: "1fr" }}>
            <div style={{ minWidth: 0 }}>
              <div className="name">Commands scheduled Tasks may run</div>
              <div className="sub wrap">One per line, matched at the start (for example <code>npm test</code>). Everything else that asks first is declined in Tasks unless YOLO for Tasks is on.</div>
              <textarea className="input mono" rows={3} style={{ marginTop: 8 }} defaultValue={(cfg.approval.taskCommands ?? []).join("\n")} onBlur={(e) => patch({ approval: { taskCommands: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) } })} />
            </div>
          </div>
          {(cfg.approval.allowCommands ?? []).length > 0 && (
            <div className="row" style={{ gridTemplateColumns: "1fr" }}>
              <div style={{ minWidth: 0 }}>
                <div className="name">Always-allowed commands</div>
                <div className="sub wrap">Chosen with “Always allow” in chat. They run without asking.</div>
                <div className="att-chips" style={{ marginTop: 8 }}>
                  {(cfg.approval.allowCommands ?? []).map((c) => (
                    <span key={c} className="att-chip"><code className="ellipsis">{c}</code><button className="att-x" aria-label={`Stop allowing ${c}`} onClick={() => patch({ approval: { allowCommands: (cfg.approval.allowCommands ?? []).filter((x) => x !== c) } })}>×</button></span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
    ),
    budgets: (
<div className="list">
          {(["chat", "tasks", "evolve"] as const).map((k) => (
            <div key={k} className="row" style={{ gridTemplateColumns: "1fr 120px" }}>
              <div><div className="name">{k[0].toUpperCase() + k.slice(1)}</div><div className="sub">${(state.spend[k] ?? 0).toFixed(3)} spent today</div></div>
              <input className="input" type="number" min={0} step={0.5} value={cfg.budgets.dailyUsd[k]} onChange={(e) => patch({ budgets: { dailyUsd: { ...cfg.budgets.dailyUsd, [k]: Number(e.target.value) } } })} />
            </div>
          ))}
        </div>
    ),
    connectors: (
<div className="list">
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div style={{ minWidth: 0 }}><div className="name">Google Workspace and other apps</div><div className="sub wrap">Sign in to Google, add API keys, and remove connectors Syph created.</div></div>
            <a className="btn tonal sm" href="#/connectors">Open Connectors</a>
          </div>
        </div>
    ),
    extensions: (
<div className="list">
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
    ),
    phone: <PhonePairing />,
    appearance: (
      <>
        <div className="list">
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div className="name">Dark theme</div>
            <Toggle on={theme === "dark"} onChange={(v) => setTheme(v ? "dark" : "light")} label="Dark theme" />
          </div>
        </div>
        <InterfaceSettings />
      </>
    ),
    evolve: (
<div className="list">
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
    ),
    data: (
<div className="list">
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div><div className="name">Export training data</div><div className="sub">{exported ?? "SFT (good answers) and DPO (up vs down pairs) as JSONL, for fine-tuning a local model."}</div></div>
            <button className="btn tonal sm" onClick={async () => { const r = await api.post<{ sft: string; sftCount: number; dpoCount: number }>("/export"); setExported(`${r.sftCount} SFT and ${r.dpoCount} DPO examples written next to ${r.sft}`); }}><Download size={14} /> Export</button>
          </div>
        </div>
    ),
  };
  const allOpen = open.length >= SETTINGS_SECTIONS.length;

  return (
    <div className="page">
      <div className="page-inner settings" style={{ maxWidth: 780 }}>
        <div className="page-head">
          <div>
            <h2>Settings</h2>
            <p>Stored in <code>{state.homePath}</code>. Open a section to change it.</p>
          </div>
          <div className="spacer" />
          <button className="btn ghost sm" onClick={() => setOpen(allOpen ? [] : SETTINGS_SECTIONS.map((s) => s.id))}>
            {allOpen ? <><ChevronsDownUp size={14} /> Fold all</> : <><ChevronsUpDown size={14} /> Open all</>}
          </button>
        </div>

        {SETTINGS_SECTIONS.map((s, i) => {
          const isOpen = open.includes(s.id);
          return (
            <div key={s.id}>
              {s.group !== SETTINGS_SECTIONS[i - 1]?.group && <div className="section-label set-group">{s.group}</div>}
              <section id={`set-${s.id}`} className={`set-sec ${isOpen ? "open" : ""}`}>
                <button className="set-head" onClick={() => toggle(s.id)} aria-expanded={isOpen}>
                  <span className="set-title">{s.title}</span>
                  <span className="set-sum ellipsis">{summary[s.id]}</span>
                  <ChevronDown size={16} className="set-chev" />
                </button>
                {isOpen && <div className="set-body">{bodies[s.id]}</div>}
              </section>
            </div>
          );
        })}
      </div>
    </div>
  );
}

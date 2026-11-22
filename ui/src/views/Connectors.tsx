import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, ExternalLink, LogOut, MessageSquarePlus, Plug, RotateCcw, Trash2 } from "lucide-react";
import { useApp } from "../App";
import { Toggle } from "../components/Toggle";
import { Markdown } from "../components/Markdown";
import { api } from "../api";

interface Field {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  help?: string;
  placeholder?: string;
  set: boolean;
  value?: string;
}
export interface Connector {
  id: string;
  name: string;
  description: string;
  icon?: string;
  auth: "none" | "apiKey" | "oauth2";
  builtin: boolean;
  createdBy?: string;
  enabled: boolean;
  state: "needs_setup" | "needs_signin" | "ready" | "error";
  error?: string;
  account?: string;
  fields: Field[];
  tools: { name: string; description: string; permission: string }[];
  setup?: string;
}

const STATE_LABEL: Record<Connector["state"], string> = { ready: "Connected", needs_setup: "Needs keys", needs_signin: "Needs sign-in", error: "Error" };

function Icon({ c }: { c: Connector }) {
  if (c.icon === "google") return <span className="g-mark" aria-hidden="true">G</span>;
  return <Plug size={20} />;
}

function ConnectorCard({ c, reload }: { c: Connector; reload: () => void }) {
  const [open, setOpen] = useState(c.state !== "ready");
  const [guide, setGuide] = useState(c.state === "needs_setup");
  const [showTools, setShowTools] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [waiting, setWaiting] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (c.state === "ready") {
      setWaiting(null);
      setGuide(false);
    }
  }, [c.state]);

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(undefined);
    try {
      await fn();
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  };

  const dirty = Object.values(values).some((v) => v.trim());
  const save = () => act("save", async () => {
    await api.put(`/connectors/${c.id}/fields`, { values });
    setValues({});
  });
  const signIn = () => act("signin", async () => {
    const { url } = await api.post<{ url: string }>(`/connectors/${c.id}/signin`);
    setWaiting(url);
    window.open(url, "_blank", "noopener");
  });
  const status = !c.enabled ? "Off" : c.state === "ready" && c.account ? `Connected · ${c.account}` : STATE_LABEL[c.state];

  return (
    <div className={`card connector ${c.enabled ? "" : "off"}`}>
      <div className="provider">
        <div className="pi"><Icon c={c} /></div>
        <div style={{ minWidth: 0 }}>
          <button className="connector-head" onClick={() => setOpen(!open)}>
            <h3>{c.name}</h3>
            <span className={`chip-state ${c.enabled ? c.state : "off"}`}>{c.state === "ready" && c.enabled && <Check size={12} />} {status}</span>
            {!c.builtin && <span className="hint">made by {c.createdBy === "agent" ? "Syph" : "you"}</span>}
            {open ? <ChevronDown size={16} className="chev" /> : <ChevronRight size={16} className="chev" />}
          </button>
          <p>{c.description}</p>
        </div>
        <Toggle on={c.enabled} onChange={(v) => act("toggle", () => api.post(`/connectors/${c.id}/enabled`, { enabled: v }))} label={`Use ${c.name}`} />
      </div>

      {open && (
        <div className="connector-body">
          {c.setup && (
            <div className="guide">
              <button className="link-btn" onClick={() => setGuide(!guide)}>
                {guide ? <ChevronDown size={14} /> : <ChevronRight size={14} />} How to set up {c.name}
              </button>
              {guide && <div className="guide-text"><Markdown text={c.setup} /></div>}
            </div>
          )}

          {c.fields.length > 0 && (
            <form className="fields" onSubmit={(e) => { e.preventDefault(); if (dirty) save(); }}>
              {c.fields.map((f) => (
                <div className="field" key={f.key}>
                  <label htmlFor={`${c.id}-${f.key}`}>{f.label}{f.required ? "" : " (optional)"}</label>
                  <input
                    id={`${c.id}-${f.key}`}
                    className="input mono"
                    type={f.secret ? "password" : "text"}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={f.set ? `${f.value} (saved)` : f.placeholder ?? ""}
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  />
                  {f.help && <span className="hint">{f.help}</span>}
                </div>
              ))}
              <div className="row-actions">
                <button className="btn tonal sm" type="submit" disabled={!dirty || !!busy}>{busy === "save" ? "Saving…" : "Save"}</button>
              </div>
            </form>
          )}

          {c.auth === "oauth2" && (
            <div className="signin">
              {c.state === "ready" || c.state === "error" ? (
                <>
                  <span className="hint">Signed in{c.account ? ` as ${c.account}` : ""}.</span>
                  <div className="spacer" />
                  <button className="btn ghost sm" disabled={!!busy} onClick={signIn}><RotateCcw size={14} /> Sign in again</button>
                  <button className="btn ghost sm" disabled={!!busy} onClick={() => act("disconnect", () => api.post(`/connectors/${c.id}/disconnect`))}><LogOut size={14} /> Disconnect</button>
                </>
              ) : (
                <>
                  <button className="btn primary" disabled={c.state === "needs_setup" || !!busy} onClick={signIn}>
                    {c.icon === "google" ? <span className="g-mark sm">G</span> : <ExternalLink size={16} />} Sign in with {c.icon === "google" ? "Google" : c.name}
                  </button>
                  {c.state === "needs_setup" && <span className="hint">Save the client ID and secret first.</span>}
                  {waiting && (
                    <span className="hint">
                      Finish signing in in your browser. Nothing opened? <a href={waiting} target="_blank" rel="noreferrer">Open the sign-in page</a>.
                    </span>
                  )}
                </>
              )}
            </div>
          )}

          {c.error && <div className="key-check bad">{c.error}</div>}
          {error && <div className="key-check bad">{error}</div>}

          <div className="connector-foot">
            {c.tools.length > 0 ? (
              <button className="link-btn" onClick={() => setShowTools(!showTools)}>
                {showTools ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {c.tools.length} tools for the agent
              </button>
            ) : (
              <span className="hint">{c.state === "ready" ? "No tools loaded." : "Tools appear once it's connected."}</span>
            )}
            <div className="spacer" />
            {confirm ? (
              <>
                <span className="hint">{c.builtin ? "Clear its keys and sign-in?" : "Delete this connector, its code and its keys?"}</span>
                <button className="btn ghost sm" onClick={() => setConfirm(false)}>Cancel</button>
                <button className="btn ghost sm danger" disabled={!!busy} onClick={() => act("remove", () => api.del(`/connectors/${c.id}`)).then(() => setConfirm(false))}><Trash2 size={14} /> {c.builtin ? "Reset" : "Delete"}</button>
              </>
            ) : (
              <button className="btn ghost sm danger" onClick={() => setConfirm(true)}><Trash2 size={14} /> {c.builtin ? "Reset" : "Remove"}</button>
            )}
          </div>
          {showTools && (
            <ul className="tool-list">
              {c.tools.map((t) => (
                <li key={t.name}>
                  <code>{t.name}</code>
                  <span className={`perm ${t.permission}`}>{t.permission === "ask" ? "asks first" : t.permission === "deny" ? "blocked" : "runs freely"}</span>
                  <span className="hint">{t.description.split(". ")[0].replace(/\.$/, "")}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function ConnectorsView() {
  const { tick, go } = useApp();
  const [items, setItems] = useState<Connector[] | null>(null);
  const load = () => api.get<Connector[]>("/connectors").then(setItems);
  useEffect(() => {
    load();
  }, [tick]);

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 820 }}>
        <div className="page-head">
          <div>
            <h2>Connectors</h2>
            <p>Apps Syph can work in for you. Reading runs freely; sending, creating or changing things asks you first unless YOLO is on. Keys and sign-ins stay on this computer.</p>
          </div>
          <div className="spacer" />
          <button className="btn primary" onClick={() => go({ kind: "chat", draft: "Create a connector for " })}><MessageSquarePlus size={18} /> Ask Syph to add one</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {items?.map((c) => <ConnectorCard key={c.id} c={c} reload={load} />)}
          {items && items.length === 1 && (
            <div className="empty" style={{ padding: "28px 0" }}>
              Need another app? Ask in chat, for example "connect my Notion" or "add a connector for the GitHub API". Syph writes it, you approve it, then add the key here.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

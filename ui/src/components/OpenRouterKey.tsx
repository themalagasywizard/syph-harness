import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../api";
import { resetModels } from "./ModelPicker";

interface KeyCheck {
  ok: boolean;
  error?: string;
  label?: string;
  usage?: number;
  limitRemaining?: number | null;
  freeTier?: boolean;
}
interface KeyStatus {
  set: boolean;
  source: "settings" | "environment" | null;
  masked: string | null;
  check?: KeyCheck;
}

const usd = (n?: number | null) => (n == null ? "" : `$${n < 10 ? n.toFixed(2) : Math.round(n)}`);

function CheckLine({ check }: { check?: KeyCheck }) {
  if (!check) return null;
  if (!check.ok) return <div className="key-check bad">{check.error}</div>;
  const parts = ["Key works"];
  if (check.usage != null) parts.push(`${usd(check.usage)} used`);
  if (check.limitRemaining != null) parts.push(`${usd(check.limitRemaining)} left on this key`);
  if (check.freeTier) parts.push("free tier");
  return (
    <div className="key-check ok">
      <Check size={14} /> {parts.join(" · ")}
    </div>
  );
}

/** Add, check, replace or remove the OpenRouter key. The server only ever returns a masked form of it. */
export function OpenRouterKey({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<"save" | "check" | "remove" | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.get<KeyStatus>("/keys/openrouter").then((s) => {
      setStatus(s);
      setEditing(!s.set);
    });
  }, []);

  const run = async (kind: "save" | "check" | "remove", fn: () => Promise<KeyStatus>) => {
    setBusy(kind);
    setError(undefined);
    try {
      const s = await fn();
      setStatus(s);
      if (kind !== "check") {
        setValue("");
        setShow(false);
        setEditing(!s.set);
        resetModels();
        onChange();
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  };

  const save = () => run("save", () => api.put<KeyStatus>("/keys/openrouter", { key: value }));
  if (!status) return null;

  return (
    <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
      <label htmlFor="openrouter-key">API key</label>
      {status.set && !editing ? (
        <>
          <div className="key-row">
            <code className="key-masked">{status.masked}</code>
            <span className="hint">{status.source === "environment" ? "From the .env next to Syph or the environment" : "Saved in Settings"}</span>
            <div className="spacer" />
            <button className="btn ghost sm" disabled={!!busy} onClick={() => run("check", () => api.post<KeyStatus>("/keys/openrouter/check"))}>
              <RefreshCw size={14} className={busy === "check" ? "spin" : ""} /> Check
            </button>
            <button className="btn ghost sm" disabled={!!busy} onClick={() => setEditing(true)}>
              Replace
            </button>
            {status.source === "settings" && (
              <button className="btn ghost sm danger" disabled={!!busy} onClick={() => run("remove", () => api.del<KeyStatus>("/keys/openrouter"))}>
                <Trash2 size={14} /> Remove
              </button>
            )}
          </div>
          <CheckLine check={status.check} />
        </>
      ) : (
        <>
          <form
            className="key-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim() && !busy) save();
            }}
          >
            <div className="key-input">
              <input id="openrouter-key" className="input" type={show ? "text" : "password"} autoComplete="off" spellCheck={false} placeholder="sk-or-v1-…" value={value} onChange={(e) => setValue(e.target.value)} />
              <button type="button" className="key-eye" aria-label={show ? "Hide key" : "Show key"} onClick={() => setShow(!show)}>
                {show ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <button className="btn tonal" type="submit" disabled={!value.trim() || !!busy}>
              {busy === "save" ? "Checking…" : "Save key"}
            </button>
            {status.set && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setEditing(false);
                  setValue("");
                  setError(undefined);
                }}
              >
                Cancel
              </button>
            )}
          </form>
          <span className="hint">
            Get one at{" "}
            <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
              openrouter.ai/keys
            </a>
            . Syph checks it with OpenRouter, then saves it to the .env in your Syph data folder, where its own file tools can't read it.
          </span>
        </>
      )}
      {error && <div className="key-check bad">{error}</div>}
    </div>
  );
}

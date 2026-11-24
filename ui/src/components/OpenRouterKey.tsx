import { useEffect, useState, type ReactNode } from "react";
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

interface KeyProvider {
  id: "openrouter" | "minimax" | "gemini";
  placeholder: string;
  link: { href: string; text: string };
  hint: ReactNode;
}

const OPENROUTER: KeyProvider = {
  id: "openrouter",
  placeholder: "sk-or-v1-…",
  link: { href: "https://openrouter.ai/keys", text: "openrouter.ai/keys" },
  hint: ". Syph checks it with OpenRouter, then saves it to the .env in your Syph data folder, where its own file tools can't read it.",
};

const MINIMAX: KeyProvider = {
  id: "minimax",
  placeholder: "Your MiniMax API key",
  link: { href: "https://platform.minimax.io/console/plan", text: "platform.minimax.io" },
  hint: ": the key on your subscription's plan page, or a pay-as-you-go API key. Syph checks it with MiniMax, saves it to the .env in your Syph data folder, and the first time makes MiniMax M3.1 Flash your chat and tasks model.",
};

const GEMINI: KeyProvider = {
  id: "gemini",
  placeholder: "AIza…",
  link: { href: "https://aistudio.google.com/apikey", text: "aistudio.google.com/apikey" },
  hint: " (linked to your Google AI Pro monthly credits). Syph checks it with Google, saves it in your .env, and routes frontend website threads & studio image generation to Gemini while keeping everyday chats on your cheap default model.",
};

/** Add, check, replace or remove the OpenRouter key. The server only ever returns a masked form of it. */
export function OpenRouterKey({ onChange }: { onChange: () => void }) {
  return <ProviderKey provider={OPENROUTER} onChange={onChange} />;
}

/** The same for the MiniMax key (pay-as-you-go or the subscription's key). */
export function MiniMaxKey({ onChange }: { onChange: () => void }) {
  return <ProviderKey provider={MINIMAX} onChange={onChange} />;
}

/** The same for the Google Gemini API key (Google AI Studio / AI Pro monthly credits). */
export function GeminiKey({ onChange }: { onChange: () => void }) {
  return <ProviderKey provider={GEMINI} onChange={onChange} />;
}

function ProviderKey({ provider, onChange }: { provider: KeyProvider; onChange: () => void }) {
  const path = `/keys/${provider.id}`;
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<"save" | "check" | "remove" | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.get<KeyStatus>(path).then((s) => {
      setStatus(s);
      setEditing(!s.set);
    });
  }, [path]);

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

  const save = () => run("save", () => api.put<KeyStatus>(path, { key: value }));
  if (!status) return null;

  return (
    <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
      <label htmlFor={`${provider.id}-key`}>API key</label>
      {status.set && !editing ? (
        <>
          <div className="key-row">
            <code className="key-masked">{status.masked}</code>
            <span className="hint">{status.source === "environment" ? "From the .env next to Syph or the environment" : "Saved in Settings"}</span>
            <div className="spacer" />
            <button className="btn ghost sm" disabled={!!busy} onClick={() => run("check", () => api.post<KeyStatus>(`${path}/check`))}>
              <RefreshCw size={14} className={busy === "check" ? "spin" : ""} /> Check
            </button>
            <button className="btn ghost sm" disabled={!!busy} onClick={() => setEditing(true)}>
              Replace
            </button>
            {status.source === "settings" && (
              <button className="btn ghost sm danger" disabled={!!busy} onClick={() => run("remove", () => api.del<KeyStatus>(path))}>
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
              <input id={`${provider.id}-key`} className="input" type={show ? "text" : "password"} autoComplete="off" spellCheck={false} placeholder={provider.placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
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
            <a href={provider.link.href} target="_blank" rel="noreferrer">
              {provider.link.text}
            </a>
            {provider.hint}
          </span>
        </>
      )}
      {error && <div className="key-check bad">{error}</div>}
    </div>
  );
}

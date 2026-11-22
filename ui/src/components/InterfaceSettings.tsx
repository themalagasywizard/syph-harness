// Settings → Interface: the buttons and pages Syph added to its own app, with on/off, remove,
// safe mode and a full reset.
import { useState } from "react";
import { MessageSquarePlus, RotateCcw, Trash2 } from "lucide-react";
import { api } from "../api";
import { useApp } from "../App";
import { ExtIcon, useExt } from "../ext";
import { Toggle } from "./Toggle";

const WHERE: Record<string, string> = { "chat.composer": "chat box", "chat.header": "chat top bar", "chat.empty": "new chat screen", "project.header": "project pages", sidebar: "sidebar" };

export function InterfaceSettings() {
  const { items, safe, safeUrl, reload } = useExt();
  const { go } = useApp();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
    setConfirm(null);
  };
  return (
    <>
      <div className="section-label" style={{ paddingLeft: 0 }}>Interface</div>
      <div className="list" style={{ marginBottom: 32 }}>
        <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
          <div style={{ minWidth: 0 }}>
            <div className="name">Safe mode</div>
            <div className="sub wrap">Hide every button and page Syph added to its own app. Use it if one misbehaves. {safeUrl ? "On for this window (opened in safe mode)." : "The tray menu also has Open in safe mode."}</div>
          </div>
          <Toggle on={safe} onChange={(v) => act(async () => { await api.put("/ui/safe", { on: v }); if (!v && safeUrl) location.href = location.pathname + location.hash; })} label="Safe mode" />
        </div>
        {items.length === 0 && <div className="empty" style={{ padding: 20 }}>Syph hasn't changed its interface yet. Ask it in chat, for example "add a Connect repo button to the chat box". You approve each change before it appears.</div>}
        {items.map((u) => (
          <div key={u.id} className="row" style={{ gridTemplateColumns: "1fr auto auto" }}>
            <div style={{ minWidth: 0 }}>
              <div className="name">{u.spec?.name ?? u.id}{u.error && <span className="kind status-failed" style={{ marginLeft: 8 }}>broken</span>}</div>
              <div className="sub wrap">
                {u.error ? `Not shown: ${u.error}` : u.spec?.elements.map((e) => <span key={e.id} className="ui-el-tag"><ExtIcon name={e.icon} size={13} /> {e.label} <span className="hint">({e.type === "page" ? "page" : WHERE[e.slot] ?? e.slot})</span></span>)}
              </div>
            </div>
            {confirm === u.id ? (
              <span style={{ display: "flex", gap: 6 }}>
                <button className="btn ghost sm" onClick={() => setConfirm(null)}>Cancel</button>
                <button className="btn ghost sm danger" onClick={() => act(() => api.del(`/ui/${u.id}`))}><Trash2 size={14} /> Remove</button>
              </span>
            ) : (
              <button className="btn ghost sm danger" onClick={() => setConfirm(u.id)}><Trash2 size={14} /></button>
            )}
            <Toggle on={u.enabled && !u.error} onChange={(v) => act(() => api.post(`/ui/${u.id}/enabled`, { enabled: v }))} label={`Show ${u.spec?.name ?? u.id}`} />
          </div>
        ))}
        <div className="row" style={{ gridTemplateColumns: "1fr auto auto" }}>
          <div className="sub wrap">{note ?? "Removed changes are kept in the history folder, and each one can be undone in Evolve."}</div>
          <button className="btn tonal sm" onClick={() => go({ kind: "chat", draft: "Add a button to the chat box that " })}><MessageSquarePlus size={14} /> Ask Syph</button>
          {confirm === "__reset" ? (
            <span style={{ display: "flex", gap: 6 }}>
              <button className="btn ghost sm" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="btn ghost sm danger" onClick={() => act(async () => { const r = await api.post<{ moved: number; backup: string | null }>("/ui/reset"); setNote(r.moved ? `Reset: ${r.moved} change${r.moved === 1 ? "" : "s"} moved to ${r.backup}.` : "Nothing to reset."); if (safeUrl) location.href = location.pathname + location.hash; })}>Reset everything</button>
            </span>
          ) : (
            <button className="btn ghost sm" disabled={!items.length} onClick={() => setConfirm("__reset")}><RotateCcw size={14} /> Reset interface</button>
          )}
        </div>
        {error && <div className="banner bad" style={{ margin: 12 }}>{error}</div>}
      </div>
    </>
  );
}

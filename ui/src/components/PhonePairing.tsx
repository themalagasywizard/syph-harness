import { useEffect, useState } from "react";
import { QrCode, RefreshCw, Smartphone, Trash2, X } from "lucide-react";
import { api, relTime } from "../api";

interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastSeen?: string;
}
interface PhoneStatus {
  listening: boolean;
  port: number | null;
  addresses: string[];
  pairing: { expiresAt: string } | null;
  devices: Device[];
}
interface Pairing {
  link: string;
  url: string;
  svg: string;
  expiresAt: string;
}

/** Show a QR code the Syph iPhone app scans to pair, and list paired phones. */
export function PhonePairing() {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());

  const load = () => api.get<PhoneStatus>("/phone").then(setStatus).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  // While a QR is showing: tick the countdown, and notice when the phone has paired.
  useEffect(() => {
    if (!pairing) return;
    const t = setInterval(async () => {
      setNow(Date.now());
      const s = await api.get<PhoneStatus>("/phone").catch(() => null);
      if (!s) return;
      setStatus(s);
      if (!s.pairing) setPairing(null);
    }, 1500);
    return () => clearInterval(t);
  }, [pairing]);

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setPairing(await api.post<Pairing>("/phone/pair"));
      setNow(Date.now());
      load();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const cancel = async () => {
    setPairing(null);
    setStatus(await api.del<PhoneStatus>("/phone/pair"));
  };
  const remove = async (id: string) => setStatus(await api.del<PhoneStatus>(`/phone/devices/${id}`));

  const left = pairing ? Math.max(0, Math.round((Date.parse(pairing.expiresAt) - now) / 1000)) : 0;

  return (
    <div className="card">
      <div className="provider">
        <div className="pi"><Smartphone size={20} /></div>
        <div style={{ minWidth: 0 }}>
          <h3>Syph on your iPhone</h3>
          <p>Scan a QR code with the Syph app to use your chats, projects, tasks and keys from your phone. Your phone and this computer need to be on the same Wi-Fi.</p>

          {pairing ? (
            <div className="pair-box">
              <div className="pair-qr" dangerouslySetInnerHTML={{ __html: pairing.svg }} aria-label="Pairing QR code" />
              <div className="pair-steps">
                <ol>
                  <li>Open Syph on your iPhone.</li>
                  <li>Tap <b>Scan QR code</b> (or point the Camera app here).</li>
                  <li>Keep this window open until your phone says it's connected.</li>
                </ol>
                <span className="hint">
                  {left > 0 ? `Code works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} more, once.` : "This code has expired."} Address: <code>{pairing.url}</code>
                </span>
                <div className="row-actions" style={{ justifyContent: "flex-start", marginTop: 12 }}>
                  <button className="btn ghost sm" onClick={start} disabled={busy}><RefreshCw size={14} /> New code</button>
                  <button className="btn ghost sm" onClick={cancel}><X size={14} /> Cancel</button>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 14 }}>
              <button className="btn primary" onClick={start} disabled={busy}><QrCode size={16} /> {busy ? "Starting…" : status?.devices.length ? "Pair another phone" : "Show QR code"}</button>
            </div>
          )}

          {error && <div className="key-check bad">{error}</div>}

          {!!status?.devices.length && (
            <div className="list" style={{ marginTop: 16 }}>
              {status.devices.map((d) => (
                <div key={d.id} className="row" style={{ gridTemplateColumns: "20px 1fr auto" }}>
                  <Smartphone size={16} color="var(--muted)" />
                  <div style={{ minWidth: 0 }}>
                    <div className="name">{d.name}</div>
                    <div className="sub">Paired {relTime(d.createdAt)}{d.lastSeen ? ` · last used ${relTime(d.lastSeen)}` : ""}</div>
                  </div>
                  <button className="btn ghost sm danger" onClick={() => remove(d.id)}><Trash2 size={14} /> Remove</button>
                </div>
              ))}
            </div>
          )}
          {status?.listening && <span className="hint" style={{ display: "block", marginTop: 10 }}>Phones connect on port {status.port}{status.addresses.length ? ` at ${status.addresses.join(", ")}` : ""}. Removing a phone cuts it off at once.</span>}
        </div>
      </div>
    </div>
  );
}

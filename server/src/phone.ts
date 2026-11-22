// Phone access: pair the Syph iPhone app by scanning a QR code, then let it use the API over the local network.
//
// - The normal server stays on 127.0.0.1. Phones get a second listener on the local network, started only
//   while pairing or once a phone is paired, on its own port.
// - Every request on that listener needs a device token (Authorization: Bearer …), except the pairing call.
// - A pairing code is random, single use, and expires after 10 minutes. The QR holds the address and the code.
// - Device tokens are stored hashed in secrets/devices.json, out of reach of Syph's file tools. Remove a phone
//   in Settings to cut it off at once.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import { hostname, networkInterfaces } from "node:os";
import { dirname } from "node:path";
import QRCode from "qrcode";
import type { Home } from "@syph/core";

export interface Device {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastSeen?: string;
}

const CODE_TTL_MS = 10 * 60_000;
const MAX_BAD_CODES = 10;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export class PhoneAccess {
  private lan: Server | null = null;
  private lanPort = 0;
  private code: { value: string; expires: number } | null = null;
  private badCodes = 0;
  private readonly file: string;

  constructor(private home: Home, private handler: RequestListener, private preferredPort: number) {
    this.file = home.path("secrets", "devices.json");
  }

  /** Start the phone listener at launch if a phone is already paired. */
  async init() {
    if (this.devices().length) await this.ensureListening().catch((e) => console.error(`Phone access: ${e.message}`));
  }

  devices(): Device[] {
    try {
      return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Device[]) : [];
    } catch {
      return [];
    }
  }

  private save(list: Device[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(list, null, 2), { mode: 0o600 });
  }

  /** What Settings shows: paired phones without their token hashes. */
  publicDevices() {
    return this.devices().map(({ tokenHash: _t, ...d }) => d);
  }

  status() {
    return {
      listening: !!this.lan,
      port: this.lanPort || null,
      addresses: lanAddresses(),
      pairing: this.code && this.code.expires > Date.now() ? { expiresAt: new Date(this.code.expires).toISOString() } : null,
      devices: this.publicDevices(),
    };
  }

  /** Make a fresh pairing code and the QR the phone scans. */
  async startPairing() {
    await this.ensureListening();
    const addresses = lanAddresses();
    if (!addresses.length) throw Object.assign(new Error("This computer isn't on a network. Connect to Wi-Fi, then try again."), { status: 409 });
    this.code = { value: randomBytes(16).toString("base64url"), expires: Date.now() + CODE_TTL_MS };
    this.badCodes = 0;
    const url = `http://${addresses[0]}:${this.lanPort}`;
    const link = `syph://pair?url=${encodeURIComponent(url)}&code=${this.code.value}&name=${encodeURIComponent(hostname().replace(/\.local$/, ""))}`;
    const svg = await QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0d0d0c", light: "#ffffff" } });
    return { link, url, svg, expiresAt: new Date(this.code.expires).toISOString(), addresses, port: this.lanPort };
  }

  cancelPairing() {
    this.code = null;
    this.stopIfUnused();
  }

  /** Called by the phone with the code from the QR. Returns its long-lived token, once. */
  pair(code: unknown, name: unknown) {
    const c = this.code;
    if (!c || c.expires < Date.now()) throw Object.assign(new Error("This pairing code has expired. Show a new QR code in Syph on your computer."), { status: 410 });
    if (typeof code !== "string" || !safeEqual(code, c.value)) {
      if (++this.badCodes >= MAX_BAD_CODES) this.code = null;
      throw Object.assign(new Error("That pairing code isn't right. Scan the QR code again."), { status: 403 });
    }
    this.code = null;
    const token = randomBytes(32).toString("base64url");
    const device: Device = {
      id: randomBytes(6).toString("hex"),
      name: (typeof name === "string" && name.trim().slice(0, 60)) || "iPhone",
      tokenHash: sha(token),
      createdAt: new Date().toISOString(),
    };
    this.save([...this.devices(), device]);
    return { token, deviceId: device.id, computer: hostname().replace(/\.local$/, "") };
  }

  removeDevice(id: string) {
    this.save(this.devices().filter((d) => d.id !== id));
    this.stopIfUnused();
  }

  /** The device behind a request's bearer token, or null. */
  authenticate(req: IncomingMessage): Device | null {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
    if (!m) return null;
    const hash = sha(m[1]);
    const list = this.devices();
    const d = list.find((x) => safeEqual(x.tokenHash, hash));
    if (d && (!d.lastSeen || Date.now() - Date.parse(d.lastSeen) > 60_000)) {
      d.lastSeen = new Date().toISOString();
      this.save(list);
    }
    return d ?? null;
  }

  private async ensureListening() {
    if (this.lan) return;
    const server = createServer((req, res) => {
      (req as IncomingMessage & { viaLan?: boolean }).viaLan = true;
      this.handler(req, res);
    });
    this.lanPort = await listenOn(server, this.preferredPort).catch(() => listenOn(server, 0));
    this.lan = server;
    console.log(`Phone access on port ${this.lanPort} (${lanAddresses().join(", ") || "no network"})`);
  }

  private stopIfUnused() {
    if (!this.lan || this.devices().length || (this.code && this.code.expires > Date.now())) return;
    this.lan.close();
    this.lan = null;
    this.lanPort = 0;
  }

  close() {
    this.lan?.close();
  }
}

function listenOn(server: Server, port: number) {
  return new Promise<number>((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once("error", onError);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", onError);
      resolve((server.address() as { port: number }).port);
    });
  });
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** This computer's private IPv4 addresses, Wi-Fi/Ethernet first. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      out.push(/^(en|eth|wl|Wi-Fi|Ethernet)/i.test(name) ? a.address : `~${a.address}`);
    }
  }
  return out.sort().map((a) => a.replace(/^~/, ""));
}

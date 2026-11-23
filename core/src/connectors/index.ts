// Connectors give the agent access to outside apps (Google Workspace, Notion, GitHub, ...).
//
// A connector is a manifest (name, the keys it needs, how it signs in) plus a tools module.
// Built-in ones live in code (see google.ts). Ones the agent writes live in the home folder:
//
//   ~/.syph/connectors/<id>/connector.json   manifest
//   ~/.syph/connectors/<id>/tools.ts         export default (syph, connector) => ({ tools, test })
//
// Keys and OAuth tokens never go in those folders: they live in ~/.syph/secrets/connectors.json,
// which neither the file tools nor the evolve loop can touch, and the UI only ever sees them masked.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { compile } from "../extensions.ts";
import type { Home } from "../home.ts";
import { defineTool, type Tool } from "../tools/types.ts";
import { hash, readJson, writeJson, writeText } from "../util.ts";
import type { ConnectorFactory, ConnectorManifest, ConnectorRuntime, ConnectorStatus } from "./types.ts";

export * from "./types.ts";

export interface BuiltinConnector {
  manifest: ConnectorManifest;
  factory: ConnectorFactory;
}

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
  token_type?: string;
}

interface Secret {
  fields: Record<string, string>;
  /** The default account's sign-in. */
  tokens?: Tokens;
  account?: string;
  /** multiAccount connectors: the other signed-in accounts. Kept apart so older files still read as one account. */
  others?: { account: string; tokens?: Tokens }[];
}

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

const SECRETS = ["secrets", "connectors.json"] as const;
const ID_RE = /^[a-z][a-z0-9_]{1,30}$/;

/** Test hook: SYPH_CONNECTOR_URL_MAP='{"https://oauth2.googleapis.com":"http://localhost:9999/oauth"}' */
function mapUrl(url: string) {
  const raw = process.env.SYPH_CONNECTOR_URL_MAP;
  if (!raw) return url;
  for (const [from, to] of Object.entries(JSON.parse(raw) as Record<string, string>)) if (url.startsWith(from)) return to + url.slice(from.length);
  return url;
}

const mask = (v: string) => (v.length > 12 ? `${v.slice(0, 4)}…${v.slice(-4)}` : "••••");

export class ConnectorError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export class Connectors {
  private loaded = new Map<string, { tools: Tool[]; error?: string }>();
  private oauthStates = new Map<string, { id: string; verifier: string; redirectUri: string; at: number }>();

  constructor(private home: Home, private builtins: BuiltinConnector[] = []) {}

  // ---------- Definitions and secrets ----------

  manifests(): ConnectorManifest[] {
    const custom: ConnectorManifest[] = [];
    const dir = this.home.path("connectors");
    if (existsSync(dir)) {
      for (const id of readdirSync(dir).sort()) {
        const m = readJson<ConnectorManifest | null>(this.home.path("connectors", id, "connector.json"), null);
        if (m && m.id === id && !this.builtins.some((b) => b.manifest.id === id)) custom.push({ ...m, builtin: false });
      }
    }
    return [...this.builtins.map((b) => ({ ...b.manifest, builtin: true })), ...custom];
  }

  manifest(id: string) {
    const m = this.manifests().find((x) => x.id === id);
    if (!m) throw new ConnectorError(`No connector called ${id}.`, 404);
    return m;
  }

  private secrets(): Record<string, Secret> {
    return readJson<Record<string, Secret>>(this.home.path(...SECRETS), {});
  }

  private secret(id: string): Secret {
    return this.secrets()[id] ?? { fields: {} };
  }

  private saveSecret(id: string, s: Secret | null) {
    const all = this.secrets();
    if (s) all[id] = s;
    else delete all[id];
    writeJson(this.home.path(...SECRETS), all);
  }

  isEnabled(id: string) {
    return !(this.home.config().disabledConnectors ?? []).includes(id);
  }

  setEnabled(id: string, on: boolean) {
    this.manifest(id);
    const off = new Set(this.home.config().disabledConnectors ?? []);
    if (on) off.delete(id);
    else off.add(id);
    this.home.saveConfig({ disabledConnectors: [...off] });
  }

  state(m: ConnectorManifest): ConnectorStatus["state"] {
    const s = this.secret(m.id);
    if (m.fields.some((f) => f.required && !s.fields[f.key])) return "needs_setup";
    if (m.auth === "oauth2" && !s.tokens?.access_token && !s.others?.some((o) => o.tokens?.access_token)) return "needs_signin";
    const err = this.loaded.get(m.id)?.error;
    return err ? "error" : "ready";
  }

  list(): ConnectorStatus[] {
    return this.manifests().map((m) => {
      const s = this.secret(m.id);
      const loaded = this.loaded.get(m.id);
      return {
        id: m.id,
        name: m.name,
        description: m.description,
        icon: m.icon,
        auth: m.auth,
        builtin: !!m.builtin,
        createdBy: m.createdBy,
        enabled: this.isEnabled(m.id),
        state: this.state(m),
        error: loaded?.error,
        account: s.account,
        multiAccount: m.auth === "oauth2" && !!m.multiAccount,
        accounts:
          m.auth === "oauth2" && (s.tokens || s.account || s.others?.length)
            ? [
                ...(s.tokens || s.account ? [{ account: s.account ?? "Signed in", default: true, signedIn: !!s.tokens?.access_token }] : []),
                ...(s.others ?? []).map((o) => ({ account: o.account, default: false, signedIn: !!o.tokens?.access_token })),
              ]
            : undefined,
        fields: m.fields.map((f) => {
          const v = s.fields[f.key];
          return { ...f, set: !!v, value: v ? (f.secret ? mask(v) : v) : undefined };
        }),
        tools: (loaded?.tools ?? []).map((t) => ({ name: t.name, description: t.description, permission: t.permission })),
        setup: m.setup,
      };
    });
  }

  /** Save the values the user typed. Empty values are left as they were; null clears a field. */
  saveFields(id: string, values: Record<string, string | null>) {
    const m = this.manifest(id);
    const s = this.secret(id);
    for (const [k, v] of Object.entries(values ?? {})) {
      if (!m.fields.some((f) => f.key === k)) continue;
      if (v === null) delete s.fields[k];
      else if (typeof v === "string" && v.trim()) {
        if (/[\r\n]/.test(v)) throw new ConnectorError(`${k} can't contain line breaks.`);
        s.fields[k] = v.trim();
      }
    }
    // A new key means the account has to be checked again.
    if (m.auth === "apiKey" && Object.keys(values ?? {}).some((k) => m.fields.some((f) => f.key === k && f.secret))) delete s.account;
    // New OAuth client details invalidate the old sign-in.
    if (m.auth === "oauth2" && Object.keys(values ?? {}).some((k) => k === (m.oauth?.clientIdField ?? "clientId"))) {
      delete s.tokens;
      delete s.others;
    }
    this.saveSecret(id, s);
  }

  // ---------- Signed-in fetch ----------

  /** Every signed-in account of a connector, the default first. */
  accounts(id: string): string[] {
    const s = this.secret(id);
    return [s.account, ...(s.others ?? []).map((o) => o.account)].filter((a): a is string => !!a);
  }

  /**
   * Find the account the agent means: the exact address, or a unique part of one ("work" for
   * ryan@work.com). Undefined means the default account.
   */
  resolveAccount(id: string, wanted?: string): string | undefined {
    const want = wanted?.trim();
    if (!want || want.toLowerCase() === "default") return undefined;
    const all = this.accounts(id);
    const exact = all.find((a) => same(a, want));
    if (exact) return exact === this.secret(id).account ? undefined : exact;
    const partial = all.filter((a) => a.toLowerCase().includes(want.toLowerCase()));
    if (partial.length === 1) return partial[0] === this.secret(id).account ? undefined : partial[0];
    const name = this.manifest(id).name;
    if (!all.length) throw new Error(`${name} has no signed-in accounts.`);
    throw new Error(`${partial.length > 1 ? `"${want}" matches more than one ${name} account` : `No ${name} account "${want}"`}. Signed-in accounts: ${all.join(", ")}.`);
  }

  /** The tokens for an account (undefined account: the default one). */
  private tokensFor(s: Secret, account?: string): Tokens | undefined {
    if (!account || same(account, s.account)) return s.tokens;
    return s.others?.find((o) => same(o.account, account))?.tokens;
  }

  private setTokens(id: string, account: string | undefined, tokens: Tokens | undefined) {
    const s = this.secret(id);
    if (!account || same(account, s.account)) s.tokens = tokens;
    else {
      const o = s.others?.find((x) => same(x.account, account));
      if (o) o.tokens = tokens;
    }
    this.saveSecret(id, s);
  }

  runtime(m: ConnectorManifest, account?: string): ConnectorRuntime {
    const get = (key: string) => this.secret(m.id).fields[key];
    const authed = async (url: string, init: RequestInit = {}, retry = true): Promise<Response> => {
      const headers = new Headers(init.headers);
      for (const [k, v] of Object.entries(m.headers ?? {})) if (!headers.has(k)) headers.set(k, v);
      let target = url;
      if (m.auth === "oauth2") {
        headers.set("authorization", `Bearer ${await this.accessToken(m, account)}`);
      } else if (m.auth === "apiKey") {
        const how = m.apiKeyAuth ?? { header: "Authorization", value: "Bearer {apiKey}" };
        const value = how.value.replace(/\{(\w+)\}/g, (_, k) => get(k) ?? "");
        if (how.header) headers.set(how.header, value);
        if (how.query) target += (target.includes("?") ? "&" : "?") + `${encodeURIComponent(how.query)}=${encodeURIComponent(value)}`;
      }
      const res = await fetch(mapUrl(target), { ...init, headers, signal: init.signal ?? AbortSignal.timeout(60_000) });
      if (res.status === 401 && retry && m.auth === "oauth2") {
        await this.refresh(m, account, true);
        return authed(url, init, false);
      }
      return res;
    };
    return {
      id: m.id,
      account,
      accounts: () => this.accounts(m.id),
      get,
      fetch: authed,
      json: async (url, init = {}) => {
        const body = init.body !== undefined && typeof init.body !== "string" && !(init.body instanceof URLSearchParams) ? JSON.stringify(init.body) : init.body;
        const headers = new Headers(init.headers);
        if (body && typeof body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
        const res = await authed(url, { ...init, body, headers });
        const text = await res.text();
        let data: any = text;
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          /* plain text */
        }
        if (!res.ok) {
          const msg = data?.error?.message ?? data?.error_description ?? data?.message ?? (typeof data === "string" ? data.slice(0, 500) : JSON.stringify(data).slice(0, 500));
          throw new Error(`${m.name} answered ${res.status}: ${msg}`);
        }
        return data;
      },
    };
  }

  /**
   * The bare token a connector signs in with, for tools such as git that need it in their own
   * form (never shown to the agent or the UI). Null when the connector has none.
   */
  async bearerToken(id: string): Promise<string | null> {
    const m = this.manifest(id);
    if (!m) throw new ConnectorError(`No connector "${id}".`, 404);
    if (m.auth === "oauth2") return this.accessToken(m);
    if (m.auth !== "apiKey") return null;
    const how = m.apiKeyAuth ?? { header: "Authorization", value: "Bearer {apiKey}" };
    const value = how.value.replace(/\{(\w+)\}/g, (_, k) => this.secret(m.id).fields[k] ?? "").trim();
    return value.replace(/^(bearer|token)\s+/i, "") || null;
  }

  private async accessToken(m: ConnectorManifest, account?: string) {
    const t = this.tokensFor(this.secret(m.id), account);
    const who = account ? `${m.name} (${account})` : m.name;
    if (!t?.access_token) throw new Error(`${who} isn't signed in. Ask the user to open Connectors and sign in.`);
    if (t.expires_at && t.expires_at < Date.now() + 60_000) return this.refresh(m, account);
    return t.access_token;
  }

  private async refresh(m: ConnectorManifest, account?: string, force = false): Promise<string> {
    const s = this.secret(m.id);
    const t = this.tokensFor(s, account);
    const who = account ? `${m.name} (${account})` : m.name;
    if (!force && t?.expires_at && t.expires_at > Date.now() + 60_000) return t.access_token;
    if (!t?.refresh_token || !m.oauth) throw new Error(`${who}'s sign-in expired. Ask the user to sign in again in Connectors.`);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: s.fields[m.oauth.clientIdField ?? "clientId"] ?? "",
    });
    const secret = s.fields[m.oauth.clientSecretField ?? "clientSecret"];
    if (secret) body.set("client_secret", secret);
    const res = await fetch(mapUrl(m.oauth.tokenUrl), { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(20_000) });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      if (data.error === "invalid_grant") {
        this.setTokens(m.id, account, undefined);
        throw new Error(`${who}'s sign-in expired or was revoked. Ask the user to sign in again in Connectors.`);
      }
      throw new Error(`Couldn't refresh ${who}'s sign-in: ${data.error_description ?? data.error ?? res.status}`);
    }
    this.setTokens(m.id, account, { ...t, access_token: data.access_token, expires_at: Date.now() + (data.expires_in ?? 3600) * 1000, refresh_token: data.refresh_token ?? t.refresh_token });
    return data.access_token;
  }

  // ---------- OAuth sign-in (authorization code with PKCE, loopback redirect) ----------

  startOAuth(id: string, redirectUri: string) {
    const m = this.manifest(id);
    if (m.auth !== "oauth2" || !m.oauth) throw new ConnectorError(`${m.name} doesn't use sign-in.`);
    const s = this.secret(id);
    const clientId = s.fields[m.oauth.clientIdField ?? "clientId"];
    if (!clientId) throw new ConnectorError(`Add the ${m.name} client ID first.`);
    const state = randomBytes(16).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    this.oauthStates.set(state, { id, verifier, redirectUri, at: Date.now() });
    const url = new URL(m.oauth.authUrl);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: m.oauth.scopes.join(" "),
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      ...(m.oauth.params ?? {}),
    }).toString();
    return mapUrl(url.toString());
  }

  hasOAuthState(state: string | null) {
    return !!state && this.oauthStates.has(state);
  }

  async finishOAuth(state: string, code: string | null, error?: string | null) {
    const pending = this.oauthStates.get(state);
    if (!pending) throw new ConnectorError("This sign-in link expired. Start again from Connectors.");
    this.oauthStates.delete(state);
    const m = this.manifest(pending.id);
    if (error || !code) throw new ConnectorError(error === "access_denied" ? "Sign-in was cancelled." : `Sign-in failed: ${error ?? "no code"}`);
    if (Date.now() - pending.at > 15 * 60_000) throw new ConnectorError("This sign-in took too long. Start again from Connectors.");
    const s = this.secret(m.id);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      client_id: s.fields[m.oauth!.clientIdField ?? "clientId"] ?? "",
      code_verifier: pending.verifier,
    });
    const secret = s.fields[m.oauth!.clientSecretField ?? "clientSecret"];
    if (secret) body.set("client_secret", secret);
    const res = await fetch(mapUrl(m.oauth!.tokenUrl), { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new ConnectorError(`${m.name} refused the sign-in: ${data.error_description ?? data.error ?? res.status}`);
    const tokens: Tokens = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in ?? 3600) * 1000, scope: data.scope, token_type: data.token_type };
    let account: string | undefined;
    if (m.oauth!.userInfoUrl) {
      try {
        const r = await fetch(mapUrl(m.oauth!.userInfoUrl), { headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json", ...(m.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
        const info: any = r.ok ? await r.json() : {};
        account = info.email ?? info.name ?? info.login ?? undefined;
      } catch {
        /* the account name is a nicety */
      }
    }
    const signedIn = s.tokens?.access_token || s.others?.length;
    if (!m.multiAccount || !signedIn || !s.account || same(account, s.account)) {
      // One account (or the default one again): this sign-in replaces the default.
      s.tokens = tokens;
      s.account = account ?? s.account;
      if (!m.multiAccount) delete s.others;
      else if (account) s.others = s.others?.filter((o) => !same(o.account, account));
    } else {
      // Another account: add it, or refresh its sign-in if it was here before.
      const name = account ?? `Account ${(s.others?.length ?? 0) + 2}`;
      s.others = [...(s.others ?? []).filter((o) => !same(o.account, name)), { account: name, tokens }];
      account = name;
    }
    this.saveSecret(m.id, s);
    await this.reload();
    return { id: m.id, name: m.name, account: account ?? s.account };
  }

  /** Make one of a multi-account connector's accounts the default. */
  async setDefaultAccount(id: string, account: string) {
    const m = this.manifest(id);
    const s = this.secret(id);
    if (same(account, s.account)) return;
    const o = s.others?.find((x) => same(x.account, account));
    if (!o) throw new ConnectorError(`No ${m.name} account "${account}".`, 404);
    const rest = s.others!.filter((x) => x !== o);
    if (s.account || s.tokens) rest.unshift({ account: s.account ?? "Signed in", tokens: s.tokens });
    s.account = o.account;
    s.tokens = o.tokens;
    s.others = rest;
    this.saveSecret(id, s);
    await this.reload();
  }

  /** Sign out. With an account, only that one (the next account becomes the default if it was it). */
  async disconnect(id: string, account?: string) {
    const m = this.manifest(id);
    const s = this.secret(id);
    const revoke = async (t?: Tokens) => {
      if (t && m.oauth?.revokeUrl) {
        await fetch(mapUrl(m.oauth.revokeUrl), { method: "POST", body: new URLSearchParams({ token: t.refresh_token ?? t.access_token }), signal: AbortSignal.timeout(10_000) }).catch(() => {});
      }
    };
    if (account && !same(account, s.account)) {
      const o = s.others?.find((x) => same(x.account, account));
      if (!o) throw new ConnectorError(`No ${m.name} account "${account}".`, 404);
      await revoke(o.tokens);
      s.others = s.others!.filter((x) => x !== o);
    } else if (account && s.others?.length) {
      await revoke(s.tokens);
      const [next, ...rest] = s.others;
      s.account = next.account;
      s.tokens = next.tokens;
      s.others = rest;
    } else {
      await revoke(s.tokens);
      for (const o of s.others ?? []) await revoke(o.tokens);
      delete s.tokens;
      delete s.account;
      delete s.others;
    }
    if (!s.others?.length) delete s.others;
    this.saveSecret(id, s);
    await this.reload();
  }

  /** Remove a connector: built-in ones are only reset; ones the agent made are deleted. */
  async remove(id: string) {
    const m = this.manifest(id);
    await this.disconnect(id).catch(() => {});
    this.saveSecret(id, null);
    if (!m.builtin) rmSync(this.home.path("connectors", id), { recursive: true, force: true });
    await this.reload();
  }

  // ---------- Tools ----------

  async reload() {
    this.loaded.clear();
    for (const m of this.manifests()) {
      this.adoptFields(m);
      if (!this.isEnabled(m.id) || this.state(m) !== "ready") continue;
      try {
        await this.checkAccount(m);
        this.loaded.set(m.id, { tools: await this.loadTools(m) });
      } catch (e) {
        this.loaded.set(m.id, { tools: [], error: (e as Error).message });
      }
    }
  }

  /**
   * A built-in connector that replaced one with the same id (say a GitHub connector Syph wrote
   * earlier) keeps the key the user already saved, even when the old one named its field differently.
   */
  private adoptFields(m: ConnectorManifest) {
    if (!m.builtin) return;
    const s = this.secret(m.id);
    const missing = m.fields.filter((f) => f.required && !s.fields[f.key]);
    const spare = Object.entries(s.fields).filter(([k]) => !m.fields.some((f) => f.key === k));
    if (missing.length !== 1 || spare.length !== 1) return;
    s.fields[missing[0].key] = spare[0][1];
    delete s.fields[spare[0][0]];
    delete s.account;
    this.saveSecret(m.id, s);
  }

  /** apiKey connectors with an accountUrl: find out who the key belongs to, and refuse a key the app rejects. */
  private async checkAccount(m: ConnectorManifest) {
    if (m.auth !== "apiKey" || !m.accountUrl || this.secret(m.id).account) return;
    let res: Response;
    try {
      res = await this.runtime(m).fetch(m.accountUrl, { signal: AbortSignal.timeout(10_000) });
    } catch {
      return; // offline: try again next time
    }
    if (res.status === 401) throw new Error(`${m.name} rejected the saved key. Paste a new one on the Connectors page.`);
    if (!res.ok) return;
    const info: any = await res.json().catch(() => ({}));
    const account = info.login ?? info.email ?? info.name ?? info.username;
    if (account) this.saveSecret(m.id, { ...this.secret(m.id), account: String(account) });
  }

  /** The account a connector is signed in as, if known. */
  account(id: string) {
    return this.secret(id).account;
  }

  tools(): Tool[] {
    return [...this.loaded.values()].flatMap((l) => l.tools);
  }

  private async factoryFor(m: ConnectorManifest): Promise<ConnectorFactory> {
    const builtin = this.builtins.find((b) => b.manifest.id === m.id);
    if (builtin) return builtin.factory;
    const source = this.home.read(`connectors/${m.id}/tools.ts`) ?? "";
    return this.compileFactory(m.id, source);
  }

  private async compileFactory(id: string, source: string): Promise<ConnectorFactory> {
    const code = await compile(source);
    const file = this.home.path(".cache", "connectors", `${id}-${hash(code).slice(0, 12)}.mjs`);
    if (!existsSync(file)) writeText(file, code);
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.default !== "function") throw new Error("tools.ts must `export default (syph, connector) => ({ tools, test })`.");
    return mod.default;
  }

  private async loadTools(m: ConnectorManifest, factory?: ConnectorFactory): Promise<Tool[]> {
    const out = (await (factory ?? (await this.factoryFor(m)))({ z, defineTool }, this.runtime(m))) ?? { tools: [] };
    const tools = out.tools ?? [];
    for (const t of tools) {
      if (!t?.name || !t.description || !t.schema || typeof t.run !== "function") throw new Error(`A tool in ${m.id} is missing name, description, schema or run.`);
      if (!m.builtin && !t.name.startsWith(`${m.id}_`)) t.name = `${m.id}_${t.name}`;
      if (!/^[a-z][a-z0-9_]{1,63}$/.test(t.name)) throw new Error(`Tool name "${t.name}" must be snake_case.`);
      if (!["auto", "ask", "deny"].includes(t.permission)) t.permission = "ask";
    }
    return m.multiAccount && m.auth === "oauth2" && !factory ? this.withAccounts(m, tools) : tools;
  }

  /**
   * Give every tool of a multi-account connector an optional `account` argument. The tools are
   * built once per account (with a runtime signed in as it) and the call goes to that copy.
   * Read-only tools also take "all" to run once per account.
   */
  private withAccounts(m: ConnectorManifest, tools: Tool[]): Tool[] {
    const all = this.accounts(m.id);
    if (all.length < 2) return tools;
    const factory = this.builtins.find((b) => b.manifest.id === m.id)?.factory;
    const perAccount = new Map<string, Promise<Tool[]>>();
    const toolsFor = (account: string) => {
      if (!perAccount.has(account)) perAccount.set(account, (async () => ((await (factory ?? (await this.factoryFor(m)))({ z, defineTool }, this.runtime(m, account))) ?? { tools: [] }).tools ?? [])());
      return perAccount.get(account)!;
    };
    const def = all[0];
    return tools.map((t) => {
      if (t.jsonSchema || !(t.schema instanceof z.ZodObject)) return t;
      const readOnly = t.permission === "auto" && !t.needsApproval;
      const accountArg = z
        .string()
        .optional()
        .describe(`Which ${m.name} account to use: ${all.join(", ")}. Leave it out for the default (${def}).${readOnly ? ' "all" runs it for every account.' : ""}`);
      const runOne = async (account: string | undefined, args: any, ctx: any) => {
        if (!account) return t.run(args, ctx);
        const copy = (await toolsFor(account)).find((x) => x.name === t.name);
        if (!copy) throw new Error(`${t.name} isn't available for ${account}.`);
        return copy.run(args, ctx);
      };
      return {
        ...t,
        schema: (t.schema as z.ZodObject<any>).extend({ account: accountArg }),
        needsApproval: t.needsApproval ? ({ account: _a, ...args }: any, ctx: any) => t.needsApproval!(args, ctx) : undefined,
        run: async ({ account, ...args }: any, ctx: any) => {
          if (readOnly && account?.trim().toLowerCase() === "all") {
            const names = this.accounts(m.id);
            const out = await Promise.all(names.map(async (a, i) => `## ${a}\n${await runOne(i === 0 ? undefined : a, args, ctx).catch((e) => `Error: ${(e as Error).message}`)}`));
            return out.join("\n\n");
          }
          const resolved = this.resolveAccount(m.id, account);
          return runOne(resolved, args, ctx);
        },
      } as Tool;
    });
  }

  /**
   * Create (or replace) a connector the agent wrote. The code is compiled and its tools are
   * checked before anything is saved; keys are added later by the user on the Connectors page.
   */
  async create(input: CreateConnectorInput) {
    const id = input.id;
    if (!ID_RE.test(id)) throw new ConnectorError("Connector id must be snake_case, 2 to 31 characters.");
    if (this.builtins.some((b) => b.manifest.id === id)) throw new ConnectorError(`${id} is built in. Pick another id.`);
    const manifest: ConnectorManifest = {
      id,
      name: input.name,
      description: input.description,
      icon: input.icon,
      auth: input.auth,
      fields: input.fields ?? [],
      oauth: input.oauth,
      apiKeyAuth: input.apiKeyAuth,
      setup: input.setup,
      createdBy: "agent",
    };
    if (manifest.auth === "oauth2") {
      if (!manifest.oauth?.authUrl || !manifest.oauth.tokenUrl) throw new ConnectorError("An oauth2 connector needs oauth.authUrl and oauth.tokenUrl.");
      for (const key of [manifest.oauth.clientIdField ?? "clientId", manifest.oauth.clientSecretField ?? "clientSecret"]) {
        if (!manifest.fields.some((f) => f.key === key)) manifest.fields.push({ key, label: key === "clientId" ? "Client ID" : "Client secret", secret: key !== "clientId", required: key === "clientId" });
      }
    }
    if (manifest.auth === "apiKey" && !manifest.fields.length) manifest.fields.push({ key: "apiKey", label: "API key", secret: true, required: true });
    // Compile and build the tools with empty credentials to catch mistakes before saving.
    const factory = await this.compileFactory(id, input.code);
    const tools = await this.loadTools({ ...manifest, builtin: false }, factory);
    if (!tools.length) throw new ConnectorError("The connector defines no tools.");
    writeJson(this.home.path("connectors", id, "connector.json"), manifest);
    writeText(this.home.path("connectors", id, "tools.ts"), input.code);
    await this.reload();
    return { manifest, tools: tools.map((t) => t.name), state: this.state(manifest) };
  }
}

export interface CreateConnectorInput {
  id: string;
  name: string;
  description: string;
  icon?: string;
  auth: ConnectorManifest["auth"];
  fields?: ConnectorManifest["fields"];
  oauth?: ConnectorManifest["oauth"];
  apiKeyAuth?: ConnectorManifest["apiKeyAuth"];
  setup?: string;
  code: string;
}

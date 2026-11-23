import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { Connectors } from "../src/connectors/index.ts";
import { googleWorkspace } from "../src/connectors/google.ts";
import { Harness } from "../src/harness.ts";
import { tempHome } from "./helpers.ts";

/** A tiny fake API: records requests, answers from a handler. */
async function fakeApi(handler: (req: { method: string; url: string; auth: string; body: string }) => { status?: number; json: unknown }) {
  const seen: { method: string; url: string; auth: string; body: string }[] = [];
  const server: Server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const r = { method: req.method!, url: req.url!, auth: String(req.headers.authorization ?? req.headers["x-api-key"] ?? ""), body };
    seen.push(r);
    const out = handler(r);
    res.writeHead(out.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(out.json));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return { base, seen, close: () => new Promise((r) => server.close(r)) };
}

test("the agent can create an API-key connector; its tools use the saved key", async () => {
  const api = await fakeApi((r) => (r.auth === "secret-123" ? { json: { items: [{ title: "Hello" }] } } : { status: 401, json: { message: "bad key" } }));
  const home = tempHome();
  const c = new Connectors(home, []);
  const code = `export default (syph, connector) => ({
    tools: [syph.defineTool({ name: "list_items", description: "List items.", permission: "auto",
      schema: syph.z.object({}), run: async () => (await connector.json("${api.base}/items")).items.map((i) => i.title).join(",") })],
  });`;
  const created = await c.create({ id: "acme", name: "Acme", description: "Acme API", auth: "apiKey", apiKeyAuth: { header: "X-Api-Key", value: "{apiKey}" }, code });
  assert.deepEqual(created.tools, ["acme_list_items"]);
  assert.equal(created.state, "needs_setup");
  assert.equal(c.tools().length, 0, "no tools until the key is added");
  c.saveFields("acme", { apiKey: "secret-123" });
  await c.reload();
  const tool = c.tools().find((t) => t.name === "acme_list_items")!;
  assert.equal(await tool.run({}, {} as any), "Hello");
  const listed = c.list().find((x) => x.id === "acme")!;
  assert.equal(listed.state, "ready");
  assert.equal(listed.fields[0].value, "••••"); // short keys are fully masked
  assert.ok(!JSON.stringify(c.list()).includes("secret-123"));
  assert.ok(!home.read("connectors/acme/connector.json")!.includes("secret-123"), "keys never go in the connector folder");
  // Broken code is refused before anything is saved.
  await assert.rejects(c.create({ id: "broken", name: "B", description: "", auth: "none", code: "export default () => ({ tools: [ { name: 'x' } ] })" }), /missing/);
  assert.equal(home.exists("connectors/broken/connector.json"), false);
  await c.remove("acme");
  assert.equal(home.exists("connectors/acme"), false);
  await api.close();
});

test("Google sign-in: PKCE code exchange, account name, token refresh, tools, disconnect", async () => {
  let token = "at1";
  const api = await fakeApi((r) => {
    if (r.url.startsWith("/token")) {
      const p = new URLSearchParams(r.body);
      if (p.get("grant_type") === "authorization_code") {
        assert.equal(p.get("code"), "good-code");
        assert.ok(p.get("code_verifier")!.length >= 43);
        assert.equal(p.get("client_secret"), "shh");
        return { json: { access_token: "at1", refresh_token: "rt1", expires_in: 3600 } };
      }
      assert.equal(p.get("refresh_token"), "rt1");
      token = "at2";
      return { json: { access_token: "at2", expires_in: 3600 } };
    }
    if (r.url.startsWith("/revoke")) return { json: {} };
    if (r.auth !== `Bearer ${token}`) return { status: 401, json: { error: { message: "expired" } } };
    if (r.url.startsWith("/userinfo")) return { json: { email: "ryan@example.com" } };
    if (r.url.startsWith("/gmail/gmail/v1/users/me/messages?")) return { json: { messages: [{ id: "m1" }] } };
    if (r.url.startsWith("/gmail/gmail/v1/users/me/messages/m1")) return { json: { id: "m1", snippet: "See you at 5", labelIds: ["UNREAD"], payload: { headers: [{ name: "From", value: "Anna <anna@x.com>" }, { name: "Subject", value: "Dinner" }, { name: "Date", value: "Sun" }] } } };
    if (r.url.startsWith("/gmail/gmail/v1/users/me/drafts")) return { json: { id: "d1" } };
    return { status: 404, json: { error: { message: `no route ${r.url}` } } };
  });
  process.env.SYPH_CONNECTOR_URL_MAP = JSON.stringify({
    "https://oauth2.googleapis.com/token": `${api.base}/token`,
    "https://oauth2.googleapis.com/revoke": `${api.base}/revoke`,
    "https://openidconnect.googleapis.com/v1/userinfo": `${api.base}/userinfo`,
    "https://gmail.googleapis.com": `${api.base}/gmail`,
  });
  try {
    const home = tempHome();
    const c = new Connectors(home, [googleWorkspace]);
    assert.equal(c.list()[0].state, "needs_setup");
    assert.throws(() => c.startOAuth("google", "http://127.0.0.1:7337/"), /client ID/);
    c.saveFields("google", { clientId: "cid.apps.googleusercontent.com", clientSecret: "shh" });
    assert.equal(c.list()[0].state, "needs_signin");
    const url = new URL(c.startOAuth("google", "http://127.0.0.1:7337/"));
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.match(url.searchParams.get("scope")!, /gmail\.modify.*drive.*documents.*spreadsheets.*presentations.*calendar/);
    const state = url.searchParams.get("state")!;
    assert.ok(c.hasOAuthState(state));
    await assert.rejects(c.finishOAuth("wrong-state", "good-code"), /expired/);
    const done = await c.finishOAuth(state, "good-code");
    assert.equal(done.account, "ryan@example.com");
    assert.equal(c.hasOAuthState(state), false, "a state works once");
    const g = c.list()[0];
    assert.equal(g.state, "ready");
    assert.ok(g.tools.some((t) => t.name === "gmail_send" && t.permission === "ask"));
    assert.ok(g.tools.some((t) => t.name === "drive_search" && t.permission === "auto"));
    // The token stops working server-side: the 401 triggers one refresh (which issues at2) and a retry.
    token = "revoked";
    const search = c.tools().find((t) => t.name === "gmail_search")!;
    const out = await search.run({ query: "is:unread", max: 5 }, {} as any);
    assert.equal(token, "at2");
    assert.ok(api.seen.some((r) => r.url.startsWith("/token") && r.body.includes("refresh_token")));
    assert.match(out, /Dinner/);
    assert.match(out, /Anna/);
    const draft = await c.tools().find((t) => t.name === "gmail_draft")!.run({ to: "anna@x.com", subject: "Re: Dinner", body: "Yes!", html: false }, {} as any);
    assert.match(draft, /Draft saved/);
    const raw = JSON.parse(api.seen.find((r) => r.url.includes("/drafts"))!.body).message.raw;
    assert.match(Buffer.from(raw, "base64url").toString(), /To: anna@x.com/);
    assert.ok(!JSON.stringify(c.list()).includes("shh"));
    await c.disconnect("google");
    assert.equal(c.list()[0].state, "needs_signin");
    assert.equal(c.tools().length, 0);
  } finally {
    delete process.env.SYPH_CONNECTOR_URL_MAP;
    await api.close();
  }
});

test("Google with several accounts: add, pick per call, search all, default, remove one", async () => {
  // Each sign-in code maps to one account; each account has its own token and mailbox.
  const accounts: Record<string, { email: string; token: string; subject: string }> = {
    "code-home": { email: "ryan@home.com", token: "tok-home", subject: "Dinner" },
    "code-work": { email: "ryan@work.com", token: "tok-work", subject: "Standup" },
  };
  const byToken = (auth: string) => Object.values(accounts).find((a) => auth === `Bearer ${a.token}`);
  const api = await fakeApi((r) => {
    if (r.url.startsWith("/token")) {
      const a = accounts[new URLSearchParams(r.body).get("code")!];
      return { json: { access_token: a.token, refresh_token: `rt-${a.token}`, expires_in: 3600 } };
    }
    if (r.url.startsWith("/revoke")) return { json: {} };
    const who = byToken(r.auth);
    if (!who) return { status: 401, json: { error: { message: "bad token" } } };
    if (r.url.startsWith("/userinfo")) return { json: { email: who.email } };
    if (r.url.startsWith("/gmail/gmail/v1/users/me/messages?")) return { json: { messages: [{ id: "m1" }] } };
    if (r.url.startsWith("/gmail/gmail/v1/users/me/messages/m1")) return { json: { id: "m1", snippet: "", payload: { headers: [{ name: "Subject", value: who.subject }] } } };
    if (r.url.startsWith("/gmail/gmail/v1/users/me/messages/send")) return { json: { id: `sent-${who.token}` } };
    return { status: 404, json: { error: { message: `no route ${r.url}` } } };
  });
  process.env.SYPH_CONNECTOR_URL_MAP = JSON.stringify({
    "https://oauth2.googleapis.com/token": `${api.base}/token`,
    "https://oauth2.googleapis.com/revoke": `${api.base}/revoke`,
    "https://openidconnect.googleapis.com/v1/userinfo": `${api.base}/userinfo`,
    "https://gmail.googleapis.com": `${api.base}/gmail`,
  });
  const signIn = async (c: Connectors, code: string) => {
    const url = new URL(c.startOAuth("google", "http://127.0.0.1:7337/"));
    assert.match(url.searchParams.get("prompt")!, /select_account/, "Google shows the account chooser");
    return c.finishOAuth(url.searchParams.get("state")!, code);
  };
  const tool = (c: Connectors, name: string) => c.tools().find((t) => t.name === name)!;
  const run = (c: Connectors, name: string, args: any) => {
    const t = tool(c, name);
    return Promise.resolve(t.run(t.schema.parse(args), {} as any));
  };
  try {
    const home = tempHome();
    const c = new Connectors(home, [googleWorkspace]);
    c.saveFields("google", { clientId: "cid.apps.googleusercontent.com", clientSecret: "shh" });
    assert.equal((await signIn(c, "code-home")).account, "ryan@home.com");
    // With one account, tools look exactly as before.
    assert.equal(Object.keys((tool(c, "gmail_search").schema as any).shape).includes("account"), false);

    assert.equal((await signIn(c, "code-work")).account, "ryan@work.com");
    let g = c.list()[0];
    assert.equal(g.account, "ryan@home.com", "the first account stays the default");
    assert.deepEqual(g.accounts, [
      { account: "ryan@home.com", default: true, signedIn: true },
      { account: "ryan@work.com", default: false, signedIn: true },
    ]);
    // Signing in with an account that's already here refreshes it, never duplicates it.
    await signIn(c, "code-work");
    assert.equal(c.list()[0].accounts!.length, 2);

    assert.match(await run(c, "gmail_search", { query: "" }), /Dinner/, "no account: the default mailbox");
    assert.match(await run(c, "gmail_search", { query: "", account: "ryan@work.com" }), /Standup/);
    assert.match(await run(c, "gmail_search", { query: "", account: "work" }), /Standup/, "a unique part of the address works");
    await assert.rejects(run(c, "gmail_search", { query: "", account: "ryan" }), /more than one.*ryan@home.com, ryan@work.com/);
    await assert.rejects(run(c, "gmail_search", { query: "", account: "nobody@x.com" }), /No Google Workspace account/);
    const both = await run(c, "gmail_search", { query: "", account: "all" });
    assert.match(both, /## ryan@home.com[\s\S]*Dinner[\s\S]*## ryan@work.com[\s\S]*Standup/);
    await assert.rejects(run(c, "gmail_send", { to: "a@x.com", body: "hi", account: "all" }), /No Google Workspace account "all"/, "all is only for reading");
    assert.match(await run(c, "gmail_send", { to: "a@x.com", body: "hi", account: "work" }), /sent-tok-work/);
    // google_api keeps asking before changes, with the account argument set aside.
    assert.equal(tool(c, "google_api").needsApproval!({ method: "GET", url: "https://x.googleapis.com", account: "work" } as any, {} as any), null);
    assert.match(String(tool(c, "google_api").needsApproval!({ method: "POST", url: "https://x.googleapis.com", account: "work" } as any, {} as any)), /changes data/);

    await c.setDefaultAccount("google", "ryan@work.com");
    g = c.list()[0];
    assert.equal(g.account, "ryan@work.com");
    assert.match(await run(c, "gmail_search", { query: "" }), /Standup/, "the new default is used without an account");

    // Removing the default promotes the next account; the tools drop the account argument.
    await c.disconnect("google", "ryan@work.com");
    g = c.list()[0];
    assert.equal(g.state, "ready");
    assert.equal(g.account, "ryan@home.com");
    assert.equal(g.accounts!.length, 1);
    assert.equal(Object.keys((tool(c, "gmail_search").schema as any).shape).includes("account"), false);
    assert.ok(!JSON.stringify(c.list()).includes("tok-"), "tokens never reach the UI");

    await signIn(c, "code-work");
    await c.disconnect("google");
    assert.equal(c.list()[0].state, "needs_signin");
    assert.equal(c.list()[0].accounts, undefined);
  } finally {
    delete process.env.SYPH_CONNECTOR_URL_MAP;
    await api.close();
  }
});

test("harness exposes connector tools and tells the agent what's connected", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  const names = h.tools().list().map((t) => t.name);
  assert.ok(names.includes("list_connectors") && names.includes("create_connector"));
  assert.ok(!names.includes("gmail_search"), "Google tools only after sign-in");
  const listed = await h.tools().get("list_connectors")!.run({}, {} as any);
  assert.match(listed, /Google Workspace \[google\]: needs keys/);
});

// Local HTTP + SSE API over the harness. Binds to 127.0.0.1 only.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { PhoneAccess } from "./phone.ts";
import { fileURLToPath } from "node:url";
import {
  Harness,
  store,
  describeCron,
  nextRunOf,
  listStrategies,
  listSkills,
  listCases,
  isHeldOut,
  getProposal,
  readTrace,
  spendToday,
  preview,
  previewKind,
  canAccess,
  FILE_MIME,
  RISKY_OPEN,
  listUi,
  resetUi,
  removeUi,
  UI_ICONS,
  UI_SLOTS,
  snapshot,
  type AgentEvent,
  MINIMAX_DEFAULT,
} from "@syph/core";

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: any) => unknown | Promise<unknown>;

const UI_DIST = process.env.SYPH_UI_DIST ?? resolve(fileURLToPath(import.meta.url), "../../../ui/dist");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };

export function createApp(h: Harness, opts: { uiDir?: string; phonePort?: number } = {}) {
  const routes: { method: string; re: RegExp; keys: string[]; fn: Handler }[] = [];
  const route = (method: string, path: string, fn: Handler) => {
    const keys: string[] = [];
    const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
    routes.push({ method, re, keys, fn });
  };
  const home = h.home;

  // ----- State -----
  route("GET", "/api/state", () => {
    const cfg = home.config();
    return {
      config: { ...cfg, hasOpenRouterKey: !!home.env("OPENROUTER_API_KEY"), hasMiniMaxKey: !!home.env("MINIMAX_API_KEY") },
      projects: store.listProjects(home).map((p) => ({ ...p, folder: store.workspaceFor(home, p.id), chatCount: store.listChats(home).filter((c) => c.projectId === p.id).length, taskCount: store.listTasks(home).filter((t) => t.projectId === p.id).length })),
      chats: (() => {
        const live = h.liveChats();
        return store.listChats(home).map((c) => (live[c.id] ? { ...c, status: live[c.id] } : c));
      })(),
      pendingProposals: h.proposals().filter((p) => p.status === "pending").length,
      spend: spendToday(home),
      strategies: listStrategies(),
      skills: listSkills(home),
      extensions: h.extensionReports,
      mcp: h.mcpStatus(),
      homePath: home.root,
      workspacePath: store.workspaceFor(home),
      github: h.githubState(),
    };
  });
  route("GET", "/api/models", () => h.models());

  // ----- Settings -----
  route("PUT", "/api/settings", async (_q, _s, _p, body) => {
    const { openRouterKey, ...patch } = body ?? {};
    if (typeof openRouterKey === "string" && openRouterKey.trim()) await saveOpenRouterKey(openRouterKey);
    if (Object.keys(patch).length) home.saveConfig(patch);
    if (patch.approval?.yolo === true) h.approveAllPending();
    return { ok: true };
  });

  // ----- OpenRouter key -----
  const KEY = "OPENROUTER_API_KEY";
  const keyStatus = () => {
    const k = home.env(KEY);
    return { set: !!k, source: home.envSource(KEY), masked: k ? maskKey(k) : null };
  };
  async function saveOpenRouterKey(raw: string) {
    const key = cleanKey(raw);
    const check = await checkOpenRouterKey(key);
    if (check.rejected) throw httpError(400, check.error!);
    home.setEnv(KEY, key);
    return { ...keyStatus(), check };
  }
  route("GET", "/api/keys/openrouter", () => keyStatus());
  route("PUT", "/api/keys/openrouter", (_q, _s, _p, body) => saveOpenRouterKey(String(body?.key ?? "")));
  route("POST", "/api/keys/openrouter/check", async () => {
    const k = home.env(KEY);
    if (!k) throw httpError(400, "No OpenRouter key saved yet.");
    return { ...keyStatus(), check: await checkOpenRouterKey(k) };
  });
  route("DELETE", "/api/keys/openrouter", () => {
    home.setEnv(KEY, null);
    return keyStatus();
  });

  // ----- MiniMax key (a pay-as-you-go key or the one that comes with a MiniMax subscription) -----
  const MM = "MINIMAX_API_KEY";
  const mmStatus = () => {
    const k = home.env(MM);
    return { set: !!k, source: home.envSource(MM), masked: k ? maskKey(k) : null };
  };
  const mmBase = () => home.config().providers.find((p) => p.name === "minimax")?.baseUrl ?? "https://api.minimax.io/v1";
  route("GET", "/api/keys/minimax", () => mmStatus());
  route("PUT", "/api/keys/minimax", async (_q, _s, _p, body) => {
    const key = cleanMiniMaxKey(String(body?.key ?? ""));
    const check = await checkMiniMaxKey(key, mmBase());
    if (check.rejected) throw httpError(400, check.error!);
    const first = !home.env(MM);
    home.setEnv(MM, key);
    // First key: make MiniMax's latest model the default for chats and tasks, as the key was added to use it.
    if (first && body?.makeDefault !== false) {
      const d = home.config().defaults;
      home.saveConfig({ defaults: { ...d, chatModel: MINIMAX_DEFAULT, taskModel: MINIMAX_DEFAULT } });
    }
    return { ...mmStatus(), check };
  });
  route("POST", "/api/keys/minimax/check", async () => {
    const k = home.env(MM);
    if (!k) throw httpError(400, "No MiniMax key saved yet.");
    return { ...mmStatus(), check: await checkMiniMaxKey(k, mmBase()) };
  });
  route("DELETE", "/api/keys/minimax", () => {
    home.setEnv(MM, null);
    return mmStatus();
  });

  route("GET", "/api/profiles/:ref", (_q, _s, p) => h.profileFresh(decodeURIComponent(p.ref)));
  route("PUT", "/api/profiles/:ref", (_q, _s, p, body) => (h.saveProfile({ ...h.profile(decodeURIComponent(p.ref)), ...body, id: decodeURIComponent(p.ref) }), { ok: true }));

  // ----- Projects -----
  route("GET", "/api/projects/:id", (_q, _s, p) => {
    const proj = store.getProject(home, p.id);
    if (!proj) throw httpError(404, "No such project");
    return { ...proj, folder: store.workspaceFor(home, p.id), instructions: home.read(`projects/${p.id}/instructions.md`) ?? "", files: [...snapshot(store.workspaceFor(home, p.id), 3000).keys()].map((f) => relative(store.workspaceFor(home, p.id), f).split(sep).join("/")).sort(), chats: store.listChats(home).filter((c) => c.projectId === p.id), tasks: store.listTasks(home).filter((t) => t.projectId === p.id) };
  });
  route("POST", "/api/projects", (_q, _s, _p, body) => store.createProject(home, body));
  route("PUT", "/api/projects/:id", (_q, _s, p, body) => store.updateProject(home, p.id, body));
  route("DELETE", "/api/projects/:id", (_q, _s, p) => (store.deleteProject(home, p.id), { ok: true }));

  // ----- Chats -----
  route("GET", "/api/chats/:id", (_q, _s, p) => {
    const c = store.getChat(home, p.id);
    if (!c) throw httpError(404, "No such chat");
    const { history: _h, ...rest } = c;
    return { ...rest, running: h.isLive(p.id), progress: h.progressOf(p.id) };
  });
  route("POST", "/api/chats", (_q, _s, _p, body) => store.createChat(home, pick(body ?? {}, ["projectId", "title", "model"])));
  route("PATCH", "/api/chats/:id", (_q, _s, p, body) => {
    const c = store.getChat(home, p.id);
    if (!c) throw httpError(404, "No such chat");
    Object.assign(c, pick(body, ["title", "projectId", "model"]));
    store.saveChat(home, c);
    return { ok: true };
  });
  route("DELETE", "/api/chats/:id", (_q, _s, p) => (h.stopChat(p.id), store.deleteChat(home, p.id), { ok: true }));
  // A message starts a run on the server and returns at once. The run keeps going whatever
  // the window does; /stream follows it (replaying from the start), /stop ends it.
  route("POST", "/api/chats/:id/messages", (_q, _s, p, body) => h.startChat(p.id, String(body?.text ?? ""), { model: body?.model, attachments: Array.isArray(body?.attachments) ? body.attachments : undefined, mode: body?.mode === "long" ? "long" : undefined }));
  // Files dropped or pasted into the message box, saved before the message is sent.
  route("POST", "/api/chats/:id/attachments", (_q, _s, p, body) => h.saveUpload(p.id, String(body?.name ?? ""), String(body?.data ?? "")));
  // A message sent while the chat works: the agent reads it at its next step.
  route("POST", "/api/chats/:id/queue", (_q, _s, p, body) => h.queueMessage(p.id, String(body?.text ?? "")));
  route("GET", "/api/search/chats", (req) => store.searchChats(home, qs(req).get("q") ?? ""));
  route("GET", "/api/contracts", () => h.ongoingContracts());
  route("GET", "/api/chats/:id/contract", (_q, _s, p) => h.progressOf(p.id));
  route("PUT", "/api/chats/:id/contract", (_q, _s, p, body) => h.updateContract(p.id, body ?? {}));
  // Files in a workspace, for @-mentions in the message box.
  route("GET", "/api/workspace-files", (req) => {
    const pid = new URL(req.url ?? "/", "http://x").searchParams.get("projectId") || undefined;
    const ws = store.workspaceFor(home, pid);
    return [...snapshot(ws, 3000).keys()].map((f) => relative(ws, f).split(sep).join("/")).filter((f) => !f.startsWith("uploads/")).sort();
  });
  route("GET", "/api/chats/:id/stream", (req, res, p) => {
    sseStart(res);
    let off: false | (() => void) = false;
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    const end = () => {
      clearInterval(ping);
      if (off) off();
      res.end();
    };
    off = h.watchChat(p.id, (e) => {
      if ((e as any).type === "closed") return end();
      sseSend(res, e);
    });
    if (!off) {
      sseSend(res, { type: "idle" });
      end();
    }
    req.on("close", () => {
      clearInterval(ping);
      if (off) off();
    });
    return SKIP;
  });
  route("POST", "/api/chats/:id/stop", (_q, _s, p) => ({ ok: h.stopChat(p.id) }));
  route("POST", "/api/chats/:id/rate", (_q, _s, p, body) => h.rate(p.id, body.turnId, body.rating ?? null, body.note));
  route("POST", "/api/approvals/:id", (_q, _s, p, body) => ({ ok: body?.always ? h.allowAlways(p.id) : h.resolveApproval(p.id, !!body?.allow) }));
  route("POST", "/api/runs/:id/eval", async (_q, _s, p, body) => h.turnIntoEval(p.id, body?.rating ?? "down", body?.expectation));
  route("GET", "/api/runs", () => h.runs().slice(-200).reverse());
  route("GET", "/api/runs/:id", (_q, _s, p) => readTrace(home, p.id));

  // ----- Tasks -----
  route("GET", "/api/tasks", () => store.listTasks(home).map((t) => ({ ...t, nextRun: t.enabled ? nextRunOf(t) : null, scheduleText: describeCron(t.schedule) })));
  route("POST", "/api/tasks", (_q, _s, _p, body) => store.upsertTask(home, pick(body, ["id", "name", "prompt", "schedule", "projectId", "model", "enabled"]) as any));
  route("PATCH", "/api/tasks/:id", (_q, _s, p, body) => store.patchTask(home, p.id, pick(body, ["name", "prompt", "schedule", "projectId", "model", "enabled"])));
  route("DELETE", "/api/tasks/:id", (_q, _s, p) => (store.deleteTask(home, p.id), { ok: true }));
  route("POST", "/api/tasks/:id/run", (_q, _s, p) => {
    h.runTask(p.id).catch(() => {});
    return { ok: true };
  });

  // ----- Evolve -----
  route("GET", "/api/proposals", () => h.proposals());
  route("GET", "/api/proposals/:id", (_q, _s, p) => getProposal(home, p.id));
  route("POST", "/api/proposals/:id/:decision", async (_q, _s, p, body) => {
    if (p.decision === "gate") return h.gateProposal(p.id, body?.model);
    if (!["accept", "reject", "rollback"].includes(p.decision)) throw httpError(400, "Unknown decision");
    return h.decide(p.id, p.decision as any, body?.note);
  });
  route("GET", "/api/evals", () => ({ cases: listCases(home).map((c) => ({ ...c, heldOut: isHeldOut(home, c.id) })), history: h.evalHistory() }));
  route("POST", "/api/evals/run", (_q, _s, _p, body) => h.runEvals(body?.model, body?.samples ?? 1));
  route("POST", "/api/evolve/run", (_q, _s, _p, body) => h.evolve(body?.model));
  route("GET", "/api/jobs", () => [...h.jobs.values()].reverse());
  route("POST", "/api/export", () => h.exportDatasets());
  route("POST", "/api/extensions/reload", async () => (await h.reloadExtensions(), h.extensionReports));

  // ----- Files Syph made: preview, open, show in folder -----
  const fileArg = (req: IncomingMessage, body?: any) => {
    const raw = body?.path ?? new URL(req.url ?? "/", "http://x").searchParams.get("path");
    if (!raw || typeof raw !== "string") throw httpError(400, "Which file? Send its path.");
    const abs = resolve(raw);
    if (!canAccess(home, abs)) throw httpError(403, "Syph only opens files in its workspace, its projects, or ones it made.");
    if (!existsSync(abs)) throw httpError(404, `That file isn't there any more: ${abs}`);
    return abs;
  };
  route("GET", "/api/files/preview", (req) => {
    const abs = fileArg(req);
    const st = statSync(abs);
    let pv;
    try {
      pv = st.isDirectory() ? { kind: "none", reason: "This is a folder." } : preview(abs);
    } catch (e) {
      pv = { kind: "none", reason: `Couldn't read it for a preview (${(e as Error).message}). Open it instead.` };
    }
    return { path: abs, name: basename(abs), folder: dirname(abs), size: st.size, modified: st.mtime.toISOString(), isDir: st.isDirectory(), kind: st.isDirectory() ? "none" : previewKind(abs), canOpen: !RISKY_OPEN.test(abs), preview: pv };
  });
  route("GET", "/api/files/raw", (req, res) => {
    const abs = fileArg(req);
    const st = statSync(abs);
    if (!st.isFile()) throw httpError(400, "Not a file.");
    const type = FILE_MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string | number> = { "content-type": type, "content-length": st.size, "cache-control": "no-store", "x-content-type-options": "nosniff" };
    // Anything but a PDF (which needs the browser's viewer) is shown without scripts or access to Syph.
    if (type !== "application/pdf") headers["content-security-policy"] = "sandbox; default-src 'none'; img-src data: blob: 'self'; media-src 'self'; style-src 'unsafe-inline'";
    res.writeHead(200, headers);
    createReadStream(abs).pipe(res);
    return SKIP;
  });
  route("POST", "/api/files/open", (req, _s, _p, body) => {
    const abs = fileArg(req, body);
    if (RISKY_OPEN.test(abs)) throw httpError(400, "Syph doesn't run programs or scripts from here. Use Show in folder.");
    desktop("open", abs);
    return { ok: true };
  });
  route("POST", "/api/files/reveal", (req, _s, _p, body) => (desktop("reveal", fileArg(req, body)), { ok: true }));
  route("GET", "/api/chats/:id/files", (_q, _s, p) => {
    const c = store.getChat(home, p.id);
    if (!c) throw httpError(404, "No such chat");
    const all = new Map<string, any>();
    for (const t of c.turns) for (const f of t.files ?? []) all.set(f.path, { ...f, turnId: t.id, exists: existsSync(f.path) });
    return [...all.values()].reverse();
  });

  // ----- GitHub and the repos linked to projects and chats -----
  const qs = (req: IncomingMessage) => new URL(req.url ?? "/", "http://x").searchParams;
  const target = (src: { get(k: string): string | null | undefined } | any) => {
    const get = (k: string) => (typeof src?.get === "function" ? src.get(k) : src?.[k]) || undefined;
    return { projectId: get("projectId") as string | undefined, chatId: get("chatId") as string | undefined };
  };
  route("GET", "/api/github", () => h.githubState());
  route("GET", "/api/github/repos", (req) => h.githubRepos(qs(req).get("q") ?? undefined));
  route("GET", "/api/repos", (req) => h.repoStatuses(target(qs(req))));
  route("POST", "/api/repos/link", async (_q, _s, _p, body) => {
    if (!body?.repo || typeof body.repo !== "string") throw httpError(400, "Which repo? Send owner/name or a URL.");
    return h.linkRepo({ repo: body.repo, name: body.name, scope: body.scope === "chat" || body.scope === "project" ? body.scope : undefined, ...target(body) });
  });
  route("POST", "/api/repos/unlink", (_q, _s, _p, body) => h.unlinkRepo(target(body), String(body?.path ?? "")));
  route("POST", "/api/repos/pull", (_q, _s, _p, body) => h.pullRepo(String(body?.path ?? "")));
  route("POST", "/api/repos/push", (_q, _s, _p, body) => h.pushRepo(String(body?.path ?? "")));
  route("PUT", "/api/chats/:id/active-repo", (_q, _s, p, body) => h.setActiveRepo(p.id, body?.path ? String(body.path) : null));

  // ----- Interface changes Syph made -----
  const uiState = () => ({ safeMode: !!home.config().ui?.safeMode, items: listUi(home), icons: UI_ICONS, slots: UI_SLOTS });
  const uiChanged = <T>(v: T) => (h.uiChanged(), v);
  route("GET", "/api/ui", () => uiState());
  route("PUT", "/api/ui/safe", (_q, _s, _p, body) => (home.saveConfig({ ui: { ...home.config().ui, safeMode: !!body?.on } }), uiChanged(uiState())));
  route("POST", "/api/ui/reset", () => {
    const r = resetUi(home);
    home.saveConfig({ ui: { disabled: [], safeMode: false } });
    return uiChanged({ ...uiState(), moved: r.moved, backup: r.backup });
  });
  route("POST", "/api/ui/:id/enabled", (_q, _s, p, body) => {
    const off = new Set(home.config().ui?.disabled ?? []);
    if (body?.enabled) off.delete(p.id);
    else off.add(p.id);
    home.saveConfig({ ui: { ...home.config().ui, disabled: [...off] } });
    return uiChanged(uiState());
  });
  route("DELETE", "/api/ui/:id", (_q, _s, p) => (removeUi(home, p.id), uiChanged(uiState())));
  route("POST", "/api/ui/:ext/:el/source", (_q, _s, p, body) => h.uiSource(p.ext, p.el, Number(body?.step ?? 0), body?.vars ?? {}, body?.projectId));
  route("POST", "/api/ui/:ext/:el/clone", (_q, _s, p, body) => h.uiClone(p.ext, p.el, Number(body?.step ?? 0), body?.vars ?? {}, body?.projectId, body?.chatId));

  // ----- Live updates -----
  route("GET", "/api/events", (req, res) => {
    sseStart(res);
    const off = h.on((e) => sseSend(res, e));
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      off();
      clearInterval(ping);
    });
    return SKIP;
  });

  // ----- Connectors -----
  const C = h.connectors;
  const changed = async <T>(v: T) => (await h.connectorsChanged(), v);
  // Google and most providers accept any port on 127.0.0.1 for desktop apps, so the
  // sign-in comes straight back to this server.
  const redirectUri = () => `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  route("GET", "/api/connectors", () => C.list());
  route("PUT", "/api/connectors/:id/fields", async (_q, _s, p, body) => (C.saveFields(p.id, body?.values ?? {}), changed(C.list().find((c) => c.id === p.id))));
  route("POST", "/api/connectors/:id/enabled", async (_q, _s, p, body) => (C.setEnabled(p.id, !!body?.enabled), changed({ ok: true })));
  route("POST", "/api/connectors/:id/signin", (_q, _s, p) => ({ url: C.startOAuth(p.id, redirectUri()) }));
  route("POST", "/api/connectors/:id/disconnect", async (_q, _s, p) => (await C.disconnect(p.id), changed({ ok: true })));
  route("DELETE", "/api/connectors/:id", async (_q, _s, p) => (await C.remove(p.id), changed({ ok: true })));

  // ----- Phone (QR pairing). Managing phones is only allowed from this computer. -----
  route("GET", "/api/phone", () => phone.status());
  route("POST", "/api/phone/pair", () => phone.startPairing());
  route("DELETE", "/api/phone/pair", () => (phone.cancelPairing(), phone.status()));
  route("DELETE", "/api/phone/devices/:id", (_q, _s, p) => (phone.removeDevice(p.id), phone.status()));
  // Called by the phone itself with the code from the QR.
  route("POST", "/api/pair", (_q, _s, _p, body) => phone.pair(body?.code, body?.name));

  const uiDir = opts.uiDir ?? UI_DIST;
  // Routes a phone may not call: managing phones, and opening things on this computer's screen.
  const PHONE_BLOCKED = /^\/api\/(phone|files\/(open|reveal)$)/;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if ((req as { viaLan?: boolean }).viaLan) {
        // The phone listener: API only, no browsers, and every call but pairing needs a paired phone's token.
        if (req.headers.origin) throw httpError(403, "Requests must come from the Syph app.");
        if (!url.pathname.startsWith("/api/") || PHONE_BLOCKED.test(url.pathname)) throw httpError(404, "Not available to phones.");
        if (!(req.method === "POST" && url.pathname === "/api/pair") && !phone.authenticate(req)) throw httpError(401, "This phone isn't paired with Syph. Scan the QR code in Settings → Phone on your computer.");
      } else {
        // Only this machine's own pages may call the API: blocks other websites (and DNS rebinding)
        // from driving Syph through the browser.
        if (!localHost(req.headers.host) || (req.headers.origin && !localOrigin(req.headers.origin))) throw httpError(403, "Requests must come from Syph itself.");
        const state = url.searchParams.get("state");
        if (url.pathname === "/" && C.hasOAuthState(state)) return finishSignIn(state!, url, res);
        if (!url.pathname.startsWith("/api/")) return serveStatic(uiDir, url.pathname, res);
      }
      const r = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!r) throw httpError(404, `No route ${req.method} ${url.pathname}`);
      const m = r.re.exec(url.pathname)!;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = req.method === "GET" ? undefined : await readBody(req);
      const out = await r.fn(req, res, params, body);
      if (out === SKIP) return;
      json(res, 200, out ?? { ok: true });
    } catch (e: any) {
      if (res.headersSent) return res.end();
      json(res, e.status ?? 500, { error: e.message ?? String(e) });
    }
  };
  const server = createServer(handle);
  const phone = new PhoneAccess(h.home, handle, opts.phonePort ?? Number(process.env.SYPH_PHONE_PORT ?? 7338));
  (server as typeof server & { phone: PhoneAccess }).phone = phone;

  async function finishSignIn(state: string, url: URL, res: ServerResponse) {
    let title = "Connected";
    let text = "You can close this tab and go back to Syph.";
    try {
      const r = await C.finishOAuth(state, url.searchParams.get("code"), url.searchParams.get("error"));
      await h.connectorsChanged();
      text = `${r.name} is connected${r.account ? ` as ${r.account}` : ""}. You can close this tab and go back to Syph.`;
    } catch (e) {
      title = "Sign-in failed";
      text = (e as Error).message;
    }
    const esc = (v: string) => v.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Syph · ${esc(title)}</title><style>body{font:16px system-ui,sans-serif;background:#0d0d0c;color:#ecebe6;display:grid;place-items:center;height:100vh;margin:0}main{max-width:420px;padding:24px;text-align:center}h1{font-weight:500;font-size:22px}p{color:#98978f;line-height:1.5}</style><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main>`);
  }

  return server as typeof server & { phone: PhoneAccess };
}

/**
 * Open a file in its app, or show it in its folder. Inside Syph.exe the desktop shell does it
 * (it uses the system's own calls); from `npm start` the server asks the OS directly.
 */
function desktop(action: "open" | "reveal", abs: string) {
  if (typeof process.send === "function") {
    process.send({ type: "syph:" + action, path: abs });
    return;
  }
  const quiet = { detached: true, stdio: "ignore" as const, windowsHide: false };
  let child;
  if (process.platform === "win32") {
    child = action === "open" ? spawn("explorer.exe", [abs], quiet) : spawn("explorer.exe", [`/select,"${abs}"`], { ...quiet, windowsVerbatimArguments: true });
  } else if (process.platform === "darwin") child = spawn("open", action === "open" ? [abs] : ["-R", abs], quiet);
  else child = spawn("xdg-open", [action === "open" ? abs : dirname(abs)], quiet);
  child.on("error", () => {});
  child.unref();
}

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);
function localHost(host?: string) {
  if (!host) return true;
  return LOCAL.has(host.replace(/:\d+$/, "").toLowerCase());
}
function localOrigin(origin: string) {
  try {
    return LOCAL.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

const SKIP = Symbol("skip");

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function pick(obj: any, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => obj && k in obj).map((k) => [k, obj[k]]));
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function sseStart(res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.flushHeaders?.();
}

function sseSend(res: ServerResponse, data: unknown) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "Body must be JSON");
  }
}

function serveStatic(dir: string, pathname: string, res: ServerResponse) {
  let file = join(dir, decodeURIComponent(pathname));
  if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, "index.html");
  if (!existsSync(file)) {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("Syph server is running. Build the UI with `npm run build -w ui`, or use the dev server on :5173.");
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

// ----- MiniMax key helpers -----

/** Accept a pasted MiniMax key with stray quotes, spaces or a leading MINIMAX_API_KEY=. */
export function cleanMiniMaxKey(raw: string) {
  const key = raw.trim().replace(/^(?:export\s+)?MINIMAX_API_KEY\s*=\s*/, "").replace(/^(?:Bearer\s+)/i, "").replace(/^["']|["']$/g, "").trim();
  if (!key) throw httpError(400, "Paste your MiniMax key first.");
  if (!/^[\x21-\x7e]+$/.test(key)) throw httpError(400, "That key has spaces or line breaks in it. Copy it again from platform.minimax.io.");
  if (key.length < 20) throw httpError(400, "That looks too short for a MiniMax key. Copy all of it from platform.minimax.io.");
  return key;
}

/** Ask MiniMax's /models with the key. A 401/403 means the key is wrong; anything else is not the key's fault. */
export async function checkMiniMaxKey(key: string, base = process.env.SYPH_MINIMAX_URL ?? "https://api.minimax.io/v1"): Promise<KeyCheck> {
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 403) return { ok: false, rejected: true, error: "MiniMax rejected this key. Check you copied all of it from platform.minimax.io (Subscription or API Keys)." };
    if (!res.ok) return { ok: false, error: `MiniMax answered ${res.status}. Try Check again later.` };
    const d: any = await res.json().catch(() => ({}));
    // MiniMax can answer 200 with an error code in base_resp (1004 and 2049 are bad keys).
    const code = d?.base_resp?.status_code;
    if (code && code !== 0) {
      if (code === 1004 || code === 2049 || /auth|key/i.test(d.base_resp.status_msg ?? "")) return { ok: false, rejected: true, error: "MiniMax rejected this key. Check you copied all of it from platform.minimax.io (Subscription or API Keys)." };
      return { ok: false, error: `MiniMax said: ${d.base_resp.status_msg ?? code}. Try Check again later.` };
    }
    const ids: string[] = (d?.data ?? []).map((m: any) => m.id);
    return { ok: true, label: ids.length ? `${ids.length} model${ids.length === 1 ? "" : "s"} available` : undefined };
  } catch {
    return { ok: false, error: "Couldn't reach MiniMax to check the key. Check your connection." };
  }
}

// ----- OpenRouter key helpers -----

/** Accept a pasted key with stray quotes, spaces or a leading OPENROUTER_API_KEY=. */
export function cleanKey(raw: string) {
  const key = raw.trim().replace(/^(?:export\s+)?OPENROUTER_API_KEY\s*=\s*/, "").replace(/^["']|["']$/g, "").trim();
  if (!key) throw httpError(400, "Paste your OpenRouter key first.");
  if (!/^[\x21-\x7e]+$/.test(key)) throw httpError(400, "That key has spaces or line breaks in it. Copy it again from openrouter.ai/keys.");
  if (!key.startsWith("sk-or-")) throw httpError(400, "OpenRouter keys start with sk-or-. Copy it again from openrouter.ai/keys.");
  return key;
}

export const maskKey = (k: string) => (k.length > 16 ? `${k.slice(0, 9)}…${k.slice(-4)}` : "••••");

export interface KeyCheck {
  ok: boolean;
  rejected?: boolean;
  error?: string;
  label?: string;
  usage?: number;
  limitRemaining?: number | null;
  freeTier?: boolean;
}

/** Ask OpenRouter about the key. A 401/403 means the key is wrong; a network error is not the key's fault. */
export async function checkOpenRouterKey(key: string, base = process.env.SYPH_OPENROUTER_URL ?? "https://openrouter.ai/api/v1"): Promise<KeyCheck> {
  try {
    const res = await fetch(`${base}/key`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 403) return { ok: false, rejected: true, error: "OpenRouter rejected this key. Check you copied all of it, or create a new one at openrouter.ai/keys." };
    if (!res.ok) return { ok: false, error: `OpenRouter answered ${res.status}. Try Check again later.` };
    const d = ((await res.json()) as any)?.data ?? {};
    return { ok: true, label: d.label, usage: d.usage, limitRemaining: d.limit_remaining ?? null, freeTier: d.is_free_tier };
  } catch {
    return { ok: false, error: "Couldn't reach OpenRouter to check the key. Check your connection." };
  }
}

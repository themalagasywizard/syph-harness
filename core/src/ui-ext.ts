// Interface extensions: Syph can add its own buttons and pages to the app (a "Connect repo" button
// in the chat box, a shortcut on a project page, a page in the sidebar). They are declarative JSON
// files in ~/.syph/ui/, drawn by the app's own components, so they work in the packaged Syph.exe
// and can never break the app's code. Every change is checked against the schema below and waits
// for the user's approval as a proposal; safe mode hides them all, and Reset removes them.
import { readdirSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { z } from "zod";
import type { Home } from "./home.ts";
import { defineTool, type Tool, type ToolContext } from "./tools/types.ts";
import { now, readJson } from "./util.ts";

export const UI_SLOTS = ["chat.composer", "chat.header", "chat.empty", "project.header", "sidebar"] as const;
export type UiSlot = (typeof UI_SLOTS)[number];

/** Icons the app can draw (lucide names). */
export const UI_ICONS = [
  "github", "git-branch", "git-pull-request", "folder-git", "folder", "folder-open", "file-text", "file-plus", "plug", "link", "rocket", "sparkles", "search", "play",
  "zap", "database", "cloud", "mail", "calendar", "terminal", "wrench", "star", "bookmark", "globe", "download", "upload", "refresh-cw", "plus", "list", "layout-dashboard",
  "bot", "code", "box", "bar-chart", "presentation", "table", "image", "message-square", "send", "clipboard", "check-square", "bug", "book-open", "users", "shopping-cart", "dollar-sign",
] as const;

export interface UiSource {
  /** Read from a connector: GET this https URL with the connector's sign-in. */
  connector?: string;
  get?: string;
  /** Or run one of Syph's read-only tools; its result is parsed as JSON (or one item per line). */
  tool?: string;
  input?: Record<string, unknown>;
  /** Dot path to the list in the response (default: the response itself, or its first list). */
  items?: string;
  /** Follow "next" links for up to this many pages (connector sources). */
  pages?: number;
}

export type UiAction =
  | { type: "prompt"; text: string; newChat?: boolean }
  | { type: "draft"; text: string }
  | { type: "link"; url: string }
  | { type: "picker"; title: string; source: UiSource; label: string; detail?: string; empty?: string; then: UiAction }
  | { type: "form"; title: string; fields: { key: string; label: string; placeholder?: string; required?: boolean; multiline?: boolean }[]; submit?: string; then: UiAction }
  | { type: "clone_repo"; connector?: string; url: string; name?: string; hosts: string[]; then?: UiAction };

export interface UiButton {
  id: string;
  slot: UiSlot;
  type: "button";
  label: string;
  icon?: string;
  tooltip?: string;
  /** Show only when this connector is connected, and/or only inside a project. */
  when?: { connector?: string; project?: boolean };
  action: UiAction;
}

export interface UiPage {
  id: string;
  slot: "sidebar";
  type: "page";
  label: string;
  icon?: string;
  /** A self-contained HTML page, shown in a sandbox. It may call parent.postMessage({ syph: "draft", text }) to start a chat. */
  html: string;
}

export interface UiExtension {
  id: string;
  name: string;
  description: string;
  elements: (UiButton | UiPage)[];
}

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, "use lowercase letters, digits and dashes");
const template = z.string().min(1).max(4000);

const sourceSchema = z.strictObject({
  connector: z.string().optional(),
  get: z.string().optional(),
  tool: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  items: z.string().optional(),
  pages: z.number().int().min(1).max(10).optional(),
});

const actionSchema: z.ZodType<UiAction> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("prompt"), text: template, newChat: z.boolean().optional() }),
    z.strictObject({ type: z.literal("draft"), text: template }),
    z.strictObject({ type: z.literal("link"), url: template }),
    z.strictObject({ type: z.literal("picker"), title: z.string().min(1).max(80), source: sourceSchema, label: template, detail: template.optional(), empty: z.string().max(200).optional(), then: actionSchema }),
    z.strictObject({
      type: z.literal("form"),
      title: z.string().min(1).max(80),
      fields: z.array(z.strictObject({ key: z.string().regex(/^[a-z][a-z0-9_]*$/i), label: z.string().min(1).max(60), placeholder: z.string().max(200).optional(), required: z.boolean().optional(), multiline: z.boolean().optional() })).min(1).max(8),
      submit: z.string().max(30).optional(),
      then: actionSchema,
    }),
    z.strictObject({ type: z.literal("clone_repo"), connector: z.string().optional(), url: template, name: template.optional(), hosts: z.array(z.string().regex(/^[a-z0-9.-]+$/i, "a host name like github.com")).min(1).max(5), then: actionSchema.optional() }),
  ]),
) as z.ZodType<UiAction>;

const buttonSchema = z.strictObject({
  id: slug,
  slot: z.enum(UI_SLOTS),
  type: z.literal("button"),
  label: z.string().min(1).max(40),
  icon: z.string().optional(),
  tooltip: z.string().max(200).optional(),
  when: z.strictObject({ connector: z.string().optional(), project: z.boolean().optional() }).optional(),
  action: actionSchema,
});
const pageSchema = z.strictObject({ id: slug, slot: z.literal("sidebar"), type: z.literal("page"), label: z.string().min(1).max(40), icon: z.string().optional(), html: z.string().min(1).max(300_000) });

export const uiExtensionSchema = z.strictObject({
  id: slug,
  name: z.string().min(1).max(60),
  description: z.string().max(400).default(""),
  elements: z.array(z.union([buttonSchema, pageSchema])).min(1).max(12),
});

/** What the checks need to know about the running app. */
export interface UiEnv {
  connectors: Set<string>;
  /** Tools a picker may read from (auto-approved, read-only). */
  readTools: Set<string>;
}

const BASE_VARS = new Set(["project.id", "project.name", "project.path", "chat.id", "today"]);
const NEVER_SOURCE = new Set(["shell", "write_file", "edit_file", "run_subagent", "create_task", "create_connector", "propose_ui_change", "propose_skill", "propose_memory"]);

function placeholders(t: string) {
  return [...t.matchAll(/\{([\w.]+)\}/g)].map((m) => m[1]);
}

/** Check an extension against the schema and the running app. Returns readable problems (empty when fine). */
export function checkUi(raw: unknown, env?: UiEnv): { spec?: UiExtension; errors: string[] } {
  const parsed = uiExtensionSchema.safeParse(raw);
  if (!parsed.success) return { errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const spec = parsed.data as UiExtension;
  const errors: string[] = [];
  const ids = new Set<string>();
  spec.elements.forEach((el, i) => {
    const at = `elements.${i}`;
    if (ids.has(el.id)) errors.push(`${at}.id: "${el.id}" is used twice`);
    ids.add(el.id);
    if (el.icon && !(UI_ICONS as readonly string[]).includes(el.icon)) errors.push(`${at}.icon: unknown icon "${el.icon}". Use one of: ${UI_ICONS.join(", ")}`);
    if (el.type === "page") return;
    if (el.when?.connector && env && !env.connectors.has(el.when.connector)) errors.push(`${at}.when.connector: no connector "${el.when.connector}" (have: ${[...env.connectors].join(", ") || "none"})`);
    let scope = new Set(BASE_VARS);
    let open = false; // after a picker any item field may be used
    let action: UiAction | undefined = el.action;
    let depth = 0;
    const tpl = (where: string, t: string | undefined) => {
      if (!t || open) return;
      for (const p of placeholders(t)) if (!scope.has(p)) errors.push(`${where}: {${p}} isn't available here (available: ${[...scope].map((s) => `{${s}}`).join(", ")}; item fields come from a picker before this step)`);
    };
    while (action) {
      const where = `${at}.action${".then".repeat(depth)}`;
      if (++depth > 5) {
        errors.push(`${where}: chain at most 5 steps`);
        break;
      }
      switch (action.type) {
        case "prompt":
        case "draft":
          tpl(`${where}.text`, action.text);
          action = undefined;
          break;
        case "link":
          if (!/^(https:\/\/|#\/)/.test(action.url)) errors.push(`${where}.url: must start with https:// or #/`);
          tpl(`${where}.url`, action.url);
          action = undefined;
          break;
        case "picker": {
          const s = action.source;
          if (!!s.connector === !!s.tool) errors.push(`${where}.source: give either connector + get, or tool`);
          if (s.connector) {
            if (!s.get || !/^https:\/\/[^/{}]+\//.test(s.get)) errors.push(`${where}.source.get: must be a full https:// URL with a fixed host, e.g. https://api.github.com/user/repos`);
            if (env && !env.connectors.has(s.connector)) errors.push(`${where}.source.connector: no connector "${s.connector}" (have: ${[...env.connectors].join(", ") || "none"})`);
            tpl(`${where}.source.get`, s.get);
          }
          if (s.tool) {
            if (NEVER_SOURCE.has(s.tool)) errors.push(`${where}.source.tool: ${s.tool} changes things, so a picker can't run it`);
            else if (env && !env.readTools.has(s.tool)) errors.push(`${where}.source.tool: "${s.tool}" isn't a read-only tool that runs without approval`);
          }
          open = true; // label, detail and every later step may use the picked item's fields
          action = action.then;
          break;
        }
        case "form":
          scope = new Set([...scope, ...action.fields.map((f) => f.key)]);
          action = action.then;
          break;
        case "clone_repo":
          if (action.connector && env && !env.connectors.has(action.connector)) errors.push(`${where}.connector: no connector "${action.connector}"`);
          if (!/^(https:\/\/|\{)/.test(action.url)) errors.push(`${where}.url: must be an https:// clone URL or a {field} holding one`);
          tpl(`${where}.url`, action.url);
          for (const v of ["repo.path", "repo.name", "repo.url"]) scope.add(v);
          action = action.then;
          break;
      }
    }
  });
  return { spec, errors };
}

// ---------- Files ----------

export interface UiItem {
  id: string;
  file: string;
  enabled: boolean;
  spec?: UiExtension;
  error?: string;
}

export function listUi(home: Home): UiItem[] {
  const dir = home.path("ui");
  if (!existsSync(dir)) return [];
  const disabled = new Set(home.config().ui?.disabled ?? []);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const id = f.replace(/\.json$/, "");
      const raw = readJson<unknown>(home.path("ui", f), undefined);
      if (raw === undefined) return { id, file: `ui/${f}`, enabled: false, error: "Not valid JSON." };
      const { spec, errors } = checkUi(raw);
      return { id, file: `ui/${f}`, enabled: !disabled.has(id), spec: errors.length ? undefined : spec, error: errors.length ? errors.join("; ") : undefined };
    });
}

export function getUi(home: Home, id: string): UiExtension | null {
  return listUi(home).find((u) => u.id === id && u.enabled)?.spec ?? null;
}

/** Move every interface change into a dated backup folder. Returns how many were moved. */
export function resetUi(home: Home) {
  const dir = home.path("ui");
  if (!existsSync(dir)) return { moved: 0, backup: null };
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (!files.length) return { moved: 0, backup: null };
  const backup = home.path("history", `ui-reset-${now().replace(/[:.]/g, "-")}`);
  mkdirSync(backup, { recursive: true });
  for (const f of files) renameSync(home.path("ui", f), `${backup}/${f}`);
  return { moved: files.length, backup };
}

export function removeUi(home: Home, id: string) {
  const file = home.path("ui", `${id}.json`);
  if (!existsSync(file)) throw Object.assign(new Error(`No interface change "${id}".`), { status: 404 });
  const backup = home.path("history", "ui-removed");
  mkdirSync(backup, { recursive: true });
  renameSync(file, `${backup}/${now().replace(/[:.]/g, "-")}_${id}.json`);
}

/** Walk an element's action chain to step `step` (0 = the button's own action). */
export function actionAt(el: UiButton, step: number): UiAction | undefined {
  let a: UiAction | undefined = el.action;
  for (let i = 0; i < step && a; i++) a = "then" in a ? a.then : undefined;
  return a;
}

/** Fill {placeholders}. In URLs values are encoded, except a placeholder that is the whole URL. */
export function fillTemplate(t: string, vars: Record<string, unknown>, url = false) {
  const whole = /^\{[\w.]+\}$/.test(t);
  return t.replace(/\{([\w.]+)\}/g, (_, k: string) => {
    const v = vars[k];
    const s = v === undefined || v === null ? "" : String(v);
    return url && !whole ? encodeURIComponent(s).replace(/%2F/gi, "/") : s;
  });
}

/** Flatten an object two levels deep into {a, b.c} scalar fields for templates. */
export function flattenItem(o: unknown, prefix = "", out: Record<string, string | number | boolean> = {}, depth = 0): Record<string, string | number | boolean> {
  if (o === null || typeof o !== "object") {
    out[prefix || "value"] = typeof o === "string" ? o.slice(0, 1000) : (o as number | boolean);
    return out;
  }
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) continue;
    if (typeof v === "object") {
      if (!Array.isArray(v) && depth < 1) flattenItem(v, key, out, depth + 1);
    } else out[key] = typeof v === "string" ? v.slice(0, 1000) : (v as number | boolean);
  }
  return out;
}

export function itemsFrom(data: unknown, path?: string): unknown[] {
  let cur: any = data;
  if (path) for (const p of path.split(".").filter(Boolean)) cur = cur?.[p];
  if (Array.isArray(cur)) return cur;
  if (!path && cur && typeof cur === "object") {
    const first = Object.values(cur).find(Array.isArray);
    if (first) return first as unknown[];
  }
  return [];
}

// ---------- Agent tools ----------

const EXAMPLE: UiExtension = {
  id: "github-repos",
  name: "Connect GitHub repo",
  description: "Pick one of your GitHub repositories and clone it into the current project.",
  elements: [
    {
      id: "connect-repo",
      slot: "chat.composer",
      type: "button",
      label: "Connect repo",
      icon: "github",
      tooltip: "Clone one of your GitHub repos into this project",
      when: { connector: "github" },
      action: {
        type: "picker",
        title: "Connect a GitHub repository",
        source: { connector: "github", get: "https://api.github.com/user/repos?per_page=100&sort=updated", pages: 3 },
        label: "{full_name}",
        detail: "{description}",
        empty: "No repositories found for this GitHub account.",
        then: {
          type: "clone_repo",
          connector: "github",
          url: "{clone_url}",
          name: "{name}",
          hosts: ["github.com"],
          then: { type: "prompt", text: "I connected the GitHub repo {full_name}. It is cloned at {repo.path}. Look around it and give me a short overview of what it contains." },
        },
      },
    },
  ],
};

export function uiAgentTools(home: Home, env: () => UiEnv): Tool[] {
  const list = defineTool({
    name: "list_ui",
    description: "List the interface changes Syph has made to its own app (buttons and pages), with their full JSON so you can update one.",
    schema: z.object({}),
    permission: "auto",
    run: () => {
      const items = listUi(home);
      if (!items.length) return "No interface changes yet. Use propose_ui_change to add one.";
      return items.map((u) => `## ${u.id} (${u.enabled ? "on" : "off"})${u.error ? `\nBroken: ${u.error}` : ""}\n${JSON.stringify(u.spec ?? readJson(home.path(u.file), null), null, 2)}`).join("\n\n");
    },
  });

  const propose = defineTool({
    name: "propose_ui_change",
    description: `Change Syph's own interface when the user asks for a button, shortcut or page (for example a "Connect repo" button after a GitHub connector exists). You send a JSON extension; it is checked against the schema and shown to the user, who approves it before it appears. Give the same id to update one, or remove: "<id>" to take one away.

Slots: ${UI_SLOTS.join(", ")} (chat.composer = buttons next to the message box; chat.header = top bar of a chat; chat.empty = suggestions on a new chat; project.header = a project's page; sidebar = a nav item).
Element: { id, slot, type: "button", label, icon?, tooltip?, when?: { connector?: "<id>", project?: true }, action } or, in the sidebar only, { id, slot: "sidebar", type: "page", label, icon?, html } (a self-contained page in a sandbox; it may call parent.postMessage({ syph: "draft", text }, "*") to start a chat).
Actions (chain with "then"):
- { type: "prompt", text, newChat? }: send a message to Syph (in this chat, or a new chat in the project).
- { type: "draft", text }: put text in the message box.
- { type: "link", url }: open an https:// page or an app route like #/connectors.
- { type: "picker", title, source, label, detail?, then }: show a searchable list. source is { connector: "<id>", get: "https://...", items?: "dot.path", pages? } (a GET with that connector's sign-in) or { tool: "<read-only tool>", input }. label/detail are templates over each item's fields, e.g. "{full_name}"; nested fields as {owner.login}.
- { type: "form", title, fields: [{ key, label, placeholder?, required?, multiline? }], then }: ask for values, used as {key}.
- { type: "clone_repo", connector?, url, name?, hosts: ["github.com"], then? }: git clone the URL into the project folder (signed in with the connector's token, sent only to the listed hosts) and connect it to the project. Then {repo.path}, {repo.name}, {repo.url} are available.
Templates may also use {project.id}, {project.name}, {project.path}, {chat.id}, {today}.
Icons: ${UI_ICONS.join(", ")}.
Use list_connectors to find connector ids. Example:
${JSON.stringify(EXAMPLE)}`,
    schema: z.object({
      spec: z.record(z.string(), z.unknown()).optional().describe("The whole extension: { id, name, description, elements: [...] }"),
      remove: z.string().optional().describe("Id of an extension to remove instead"),
      reason: z.string().describe("One line for the user: what this adds and why"),
    }),
    permission: "auto",
    run: ({ spec, remove, reason }, ctx: ToolContext) => {
      if (remove) {
        if (!home.exists(`ui/${remove}.json`)) return `Error: there is no interface change "${remove}". Use list_ui.`;
        const p = ctx.propose({ kind: "ui", title: `Interface: remove ${remove}`, reason, files: [{ path: `ui/${remove}.json`, content: null }], source: "agent" });
        return `Proposed removing "${remove}" (${p.id}). The user approves it in this chat; nothing changes until then.`;
      }
      if (!spec) return "Error: send spec (the extension JSON) or remove.";
      const { spec: ok, errors } = checkUi(spec, env());
      if (!ok || errors.length) return `Error: the interface change failed its checks. Fix these and call propose_ui_change again:\n- ${errors.join("\n- ")}`;
      const path = `ui/${ok.id}.json`;
      const exists = home.exists(path);
      const p = ctx.propose({ kind: "ui", title: `Interface: ${exists ? "update" : "add"} ${ok.name}`, reason, files: [{ path, content: JSON.stringify(ok, null, 2) + "\n" }], source: "agent" });
      return `Proposed interface change "${ok.name}" (${p.id}). It passed the checks. The user sees it in this chat with Approve and Reject, and it appears once they approve. Tell them what it adds and where.`;
    },
  });
  return [list, propose];
}

export const uiPrompt = `# Your interface
You can add buttons, shortcuts and pages to Syph's own app with propose_ui_change (for example a "Connect repo" button once a GitHub connector exists). The user approves each change; they can undo it in Evolve, switch it off in Settings, or use safe mode.`;

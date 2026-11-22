// Google Workspace: Gmail, Drive, Docs, Sheets, Slides, Calendar, Contacts and Tasks through
// one Google sign-in. Plain REST calls, no Google SDK. Reading is automatic; anything that sends,
// creates or changes something asks first (unless YOLO mode is on).
import { htmlToText } from "../tools/builtin.ts";
import { truncate } from "../util.ts";
import type { BuiltinConnector } from "./index.ts";
import type { ConnectorRuntime } from "./types.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const DOCS = "https://docs.googleapis.com/v1/documents";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const SLIDES = "https://slides.googleapis.com/v1/presentations";
const CAL = "https://www.googleapis.com/calendar/v3";
const PEOPLE = "https://people.googleapis.com/v1";
const TASKS = "https://tasks.googleapis.com/tasks/v1";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/tasks",
];

const APIS = ["gmail.googleapis.com", "drive.googleapis.com", "docs.googleapis.com", "sheets.googleapis.com", "slides.googleapis.com", "calendar-json.googleapis.com", "people.googleapis.com", "tasks.googleapis.com"];

const SETUP = `Google needs a free "OAuth client" from your own Google Cloud project before any app can sign in for you. It takes about five minutes, once.

1. Open [Google Cloud Console](https://console.cloud.google.com/projectcreate) and create a project (any name, e.g. "Syph").
2. [Turn on the Google APIs](https://console.cloud.google.com/flows/enableapi?apiid=${APIS.join(",")}) Syph uses (Gmail, Drive, Docs, Sheets, Slides, Calendar, People, Tasks) for that project.
3. Open [Google Auth platform → Branding](https://console.cloud.google.com/auth/branding), fill in an app name and your email, and choose **External**.
4. Under [Audience](https://console.cloud.google.com/auth/audience), press **Publish app** so your sign-in doesn't expire after 7 days. (Unverified is fine for your own use; Google shows a warning screen you can click through.) If you keep it in Testing, add your Google address as a test user.
5. Under [Clients](https://console.cloud.google.com/auth/clients), press **Create client**, choose **Desktop app**, and copy the **Client ID** and **Client secret** here.
6. Press **Sign in with Google** and allow access.`;

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const header = (msg: any, name: string) => msg.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
const enc = encodeURIComponent;

/** Pull readable text out of a Gmail message payload (prefers text/plain). */
function messageText(payload: any): string {
  const parts: any[] = [];
  const walk = (p: any) => {
    if (!p) return;
    parts.push(p);
    (p.parts ?? []).forEach(walk);
  };
  walk(payload);
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain) return fromB64url(plain.body.data);
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  return html ? htmlToText(fromB64url(html.body.data)) : "";
}

/** RFC 2822 message, base64url-encoded, as the Gmail API wants it. */
function mime(m: { to: string; subject: string; body: string; cc?: string; bcc?: string; inReplyTo?: string; references?: string; html?: boolean }) {
  const lines = [
    `To: ${m.to}`,
    m.cc ? `Cc: ${m.cc}` : "",
    m.bcc ? `Bcc: ${m.bcc}` : "",
    `Subject: =?UTF-8?B?${Buffer.from(m.subject, "utf8").toString("base64")}?=`,
    m.inReplyTo ? `In-Reply-To: ${m.inReplyTo}` : "",
    m.references ? `References: ${m.references}` : "",
    "MIME-Version: 1.0",
    `Content-Type: text/${m.html ? "html" : "plain"}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean);
  return b64url(`${lines.join("\r\n")}\r\n\r\n${Buffer.from(m.body, "utf8").toString("base64")}`);
}

async function replyHeaders(g: ConnectorRuntime, replyToId?: string) {
  if (!replyToId) return {};
  const orig = await g.json(`${GMAIL}/messages/${enc(replyToId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`);
  const mid = header(orig, "Message-ID");
  return { threadId: orig.threadId as string, inReplyTo: mid, references: [header(orig, "References"), mid].filter(Boolean).join(" "), subject: header(orig, "Subject") };
}

const docLink = (id: string) => `https://docs.google.com/document/d/${id}/edit`;
const sheetLink = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;
const slidesLink = (id: string) => `https://docs.google.com/presentation/d/${id}/edit`;

export const googleWorkspace: BuiltinConnector = {
  manifest: {
    id: "google",
    name: "Google Workspace",
    description: "Gmail, Drive, Docs, Sheets, Slides, Calendar, Contacts and Tasks with one Google sign-in.",
    icon: "google",
    auth: "oauth2",
    fields: [
      { key: "clientId", label: "Client ID", required: true, placeholder: "1234…apps.googleusercontent.com", help: "From Google Cloud → Clients → Desktop app." },
      { key: "clientSecret", label: "Client secret", secret: true, required: true, placeholder: "GOCSPX-…" },
    ],
    oauth: {
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revokeUrl: "https://oauth2.googleapis.com/revoke",
      userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      scopes: GOOGLE_SCOPES,
      params: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    },
    setup: SETUP,
    createdBy: "syph",
  },
  factory: ({ z, defineTool }, g) => ({
    tools: [
      // ----- Gmail -----
      defineTool({
        name: "gmail_search",
        description: "Search the user's Gmail with Gmail search syntax (e.g. 'from:anna is:unread newer_than:7d'). Returns id, date, from, subject and snippet for each message.",
        schema: z.object({ query: z.string().default(""), max: z.number().int().min(1).max(50).default(10) }),
        permission: "auto",
        run: async ({ query, max }) => {
          const list = await g.json(`${GMAIL}/messages?maxResults=${max}&q=${enc(query)}`);
          if (!list.messages?.length) return "No messages found.";
          const rows = await Promise.all(
            list.messages.map(async (m: any) => {
              const msg = await g.json(`${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
              return `- id ${m.id} · ${header(msg, "Date")}\n  From: ${header(msg, "From")}\n  Subject: ${header(msg, "Subject")}\n  ${msg.snippet ?? ""}${msg.labelIds?.includes("UNREAD") ? " (unread)" : ""}`;
            }),
          );
          return rows.join("\n");
        },
      }),
      defineTool({
        name: "gmail_read",
        description: "Read one Gmail message by id: headers and body text.",
        schema: z.object({ id: z.string() }),
        permission: "auto",
        run: async ({ id }) => {
          const msg = await g.json(`${GMAIL}/messages/${enc(id)}?format=full`);
          const files = [] as string[];
          const walk = (p: any) => {
            if (p?.filename) files.push(p.filename);
            (p?.parts ?? []).forEach(walk);
          };
          walk(msg.payload);
          return truncate(
            [`From: ${header(msg, "From")}`, `To: ${header(msg, "To")}`, header(msg, "Cc") ? `Cc: ${header(msg, "Cc")}` : "", `Date: ${header(msg, "Date")}`, `Subject: ${header(msg, "Subject")}`, `Thread: ${msg.threadId}`, files.length ? `Attachments: ${files.join(", ")}` : "", "", messageText(msg.payload)]
              .filter((l, i) => l || i > 6)
              .join("\n"),
            20_000,
          );
        },
      }),
      defineTool({
        name: "gmail_draft",
        description: "Create a Gmail draft (not sent). Use replyToId to draft a reply in the same thread.",
        schema: z.object({ to: z.string(), subject: z.string().default(""), body: z.string(), cc: z.string().optional(), bcc: z.string().optional(), replyToId: z.string().optional(), html: z.boolean().default(false) }),
        permission: "auto",
        run: async (a) => {
          const r = await replyHeaders(g, a.replyToId);
          const subject = a.subject || (r.subject ? `Re: ${r.subject.replace(/^re:\s*/i, "")}` : "");
          const d = await g.json(`${GMAIL}/drafts`, { method: "POST", body: { message: { raw: mime({ ...a, subject, ...r }), threadId: r.threadId } } });
          return `Draft saved (id ${d.id}). The user can review it in Gmail under Drafts.`;
        },
      }),
      defineTool({
        name: "gmail_send",
        description: "Send an email from the user's Gmail. Use replyToId to reply in the same thread. Prefer gmail_draft when the user hasn't clearly asked to send.",
        schema: z.object({ to: z.string(), subject: z.string().default(""), body: z.string(), cc: z.string().optional(), bcc: z.string().optional(), replyToId: z.string().optional(), html: z.boolean().default(false) }),
        permission: "ask",
        run: async (a) => {
          const r = await replyHeaders(g, a.replyToId);
          const subject = a.subject || (r.subject ? `Re: ${r.subject.replace(/^re:\s*/i, "")}` : "");
          const sent = await g.json(`${GMAIL}/messages/send`, { method: "POST", body: { raw: mime({ ...a, subject, ...r }), threadId: r.threadId } });
          return `Sent to ${a.to} (message id ${sent.id}).`;
        },
      }),
      defineTool({
        name: "gmail_modify",
        description: "Change Gmail labels on a message: e.g. mark read (remove UNREAD), archive (remove INBOX), star (add STARRED), trash (add TRASH).",
        schema: z.object({ id: z.string(), add: z.array(z.string()).default([]), remove: z.array(z.string()).default([]) }),
        permission: "ask",
        run: async ({ id, add, remove }) => {
          await g.json(`${GMAIL}/messages/${enc(id)}/modify`, { method: "POST", body: { addLabelIds: add, removeLabelIds: remove } });
          return `Updated ${id}${add.length ? `, added ${add.join(", ")}` : ""}${remove.length ? `, removed ${remove.join(", ")}` : ""}.`;
        },
      }),

      // ----- Drive -----
      defineTool({
        name: "drive_search",
        description: "Find files in Google Drive (Docs, Sheets, Slides, PDFs, ...). Plain words search names and contents; Drive query syntax (e.g. \"mimeType='application/vnd.google-apps.document'\") is passed through.",
        schema: z.object({ query: z.string().default(""), max: z.number().int().min(1).max(100).default(20) }),
        permission: "auto",
        run: async ({ query, max }) => {
          const raw = /[=<>]| in | has /.test(query);
          const q = [raw ? query : query ? `fullText contains '${query.replace(/'/g, "\\'")}'` : "", "trashed = false"].filter(Boolean).join(" and ");
          const res = await g.json(`${DRIVE}/files?pageSize=${max}&orderBy=${raw || !query ? "modifiedTime desc" : ""}&q=${enc(q)}&fields=${enc("files(id,name,mimeType,modifiedTime,webViewLink)")}&supportsAllDrives=true&includeItemsFromAllDrives=true`.replace("&orderBy=&", "&"));
          if (!res.files?.length) return "No files found.";
          return res.files.map((f: any) => `- ${f.name} · ${f.mimeType.replace("application/vnd.google-apps.", "google ")} · ${f.modifiedTime}\n  id ${f.id} · ${f.webViewLink ?? ""}`).join("\n");
        },
      }),
      defineTool({
        name: "drive_read",
        description: "Read a Drive file as text: Docs and Slides as plain text, Sheets as CSV (first sheet), text files as-is.",
        schema: z.object({ fileId: z.string() }),
        permission: "auto",
        run: async ({ fileId }) => {
          const meta = await g.json(`${DRIVE}/files/${enc(fileId)}?fields=id,name,mimeType,size,webViewLink&supportsAllDrives=true`);
          const exportAs: Record<string, string> = {
            "application/vnd.google-apps.document": "text/plain",
            "application/vnd.google-apps.presentation": "text/plain",
            "application/vnd.google-apps.spreadsheet": "text/csv",
            "application/vnd.google-apps.drawing": "image/svg+xml",
          };
          const url = exportAs[meta.mimeType] ? `${DRIVE}/files/${enc(fileId)}/export?mimeType=${enc(exportAs[meta.mimeType])}` : `${DRIVE}/files/${enc(fileId)}?alt=media&supportsAllDrives=true`;
          if (!exportAs[meta.mimeType] && !/^(text\/|application\/(json|xml|csv|javascript))/.test(meta.mimeType)) return `${meta.name} is a ${meta.mimeType} file (${meta.size ?? "?"} bytes) that can't be read as text. Link: ${meta.webViewLink}`;
          const res = await g.fetch(url);
          if (!res.ok) throw new Error(`Drive answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
          return truncate(`# ${meta.name}\n${meta.webViewLink ?? ""}\n\n${await res.text()}`, 40_000);
        },
      }),
      defineTool({
        name: "drive_upload_text",
        description: "Create a file in Google Drive from text (e.g. .md, .csv, .txt). Set convert to turn it into a Google Doc (text/markdown/html) or Sheet (csv).",
        schema: z.object({ name: z.string(), content: z.string(), mimeType: z.string().default("text/plain"), folderId: z.string().optional(), convert: z.boolean().default(false) }),
        permission: "ask",
        run: async ({ name, content, mimeType, folderId, convert }) => {
          const target = convert ? (mimeType.includes("csv") ? "application/vnd.google-apps.spreadsheet" : "application/vnd.google-apps.document") : undefined;
          const meta = { name, parents: folderId ? [folderId] : undefined, mimeType: target };
          const boundary = `syph${Date.now()}`;
          const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mimeType}; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
          const f = await g.json(`${UPLOAD}/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true`, { method: "POST", body, headers: { "content-type": `multipart/related; boundary=${boundary}` } });
          return `Created ${f.name}: ${f.webViewLink} (id ${f.id})`;
        },
      }),

      // ----- Docs -----
      defineTool({
        name: "docs_create",
        description: "Create a Google Doc with a title and plain-text content. Returns its link.",
        schema: z.object({ title: z.string(), text: z.string().default("") }),
        permission: "ask",
        run: async ({ title, text }) => {
          const doc = await g.json(DOCS, { method: "POST", body: { title } });
          if (text) await g.json(`${DOCS}/${doc.documentId}:batchUpdate`, { method: "POST", body: { requests: [{ insertText: { location: { index: 1 }, text } }] } });
          return `Created "${title}": ${docLink(doc.documentId)} (id ${doc.documentId})`;
        },
      }),
      defineTool({
        name: "docs_append",
        description: "Append plain text to the end of a Google Doc.",
        schema: z.object({ documentId: z.string(), text: z.string() }),
        permission: "ask",
        run: async ({ documentId, text }) => {
          const doc = await g.json(`${DOCS}/${enc(documentId)}?fields=body(content(endIndex))`);
          const end = Math.max(1, (doc.body?.content?.at(-1)?.endIndex ?? 2) - 1);
          await g.json(`${DOCS}/${enc(documentId)}:batchUpdate`, { method: "POST", body: { requests: [{ insertText: { location: { index: end }, text: `\n${text}` } }] } });
          return `Appended to ${docLink(documentId)}`;
        },
      }),

      // ----- Sheets -----
      defineTool({
        name: "sheets_read",
        description: "Read cells from a Google Sheet. range uses A1 notation, e.g. 'Sheet1!A1:F50' or just 'A:D'.",
        schema: z.object({ spreadsheetId: z.string(), range: z.string().default("A1:Z200") }),
        permission: "auto",
        run: async ({ spreadsheetId, range }) => {
          const r = await g.json(`${SHEETS}/${enc(spreadsheetId)}/values/${enc(range)}`);
          const rows: string[][] = r.values ?? [];
          return rows.length ? truncate(`${r.range}\n` + rows.map((row) => row.join("\t")).join("\n"), 30_000) : `${r.range} is empty.`;
        },
      }),
      defineTool({
        name: "sheets_write",
        description: "Write rows to a Google Sheet at a range (A1 notation). Set append to add rows after existing data instead of overwriting.",
        schema: z.object({ spreadsheetId: z.string(), range: z.string(), values: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))), append: z.boolean().default(false) }),
        permission: "ask",
        run: async ({ spreadsheetId, range, values, append }) => {
          const base = `${SHEETS}/${enc(spreadsheetId)}/values/${enc(range)}`;
          const r = append
            ? await g.json(`${base}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { method: "POST", body: { values } })
            : await g.json(`${base}?valueInputOption=USER_ENTERED`, { method: "PUT", body: { values } });
          return `Wrote ${values.length} row(s) to ${r.updates?.updatedRange ?? r.updatedRange ?? range}: ${sheetLink(spreadsheetId)}`;
        },
      }),
      defineTool({
        name: "sheets_create",
        description: "Create a Google Sheet, optionally with starting rows (first row as headers).",
        schema: z.object({ title: z.string(), rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))).default([]) }),
        permission: "ask",
        run: async ({ title, rows }) => {
          const s = await g.json(SHEETS, { method: "POST", body: { properties: { title } } });
          if (rows.length) await g.json(`${SHEETS}/${s.spreadsheetId}/values/A1?valueInputOption=USER_ENTERED`, { method: "PUT", body: { values: rows } });
          return `Created "${title}": ${sheetLink(s.spreadsheetId)} (id ${s.spreadsheetId})`;
        },
      }),

      // ----- Slides -----
      defineTool({
        name: "slides_create",
        description: "Create a Google Slides deck: one slide per item with a title and body text (use newlines for bullet lines).",
        schema: z.object({ title: z.string(), slides: z.array(z.object({ title: z.string(), body: z.string().default("") })).min(1).max(50) }),
        permission: "ask",
        run: async ({ title, slides }) => {
          const p = await g.json(SLIDES, { method: "POST", body: { title } });
          const requests: any[] = [];
          if (p.slides?.[0]?.objectId) requests.push({ deleteObject: { objectId: p.slides[0].objectId } });
          slides.forEach((s, i) => {
            const id = `syph_s${i}`;
            requests.push({
              createSlide: {
                objectId: id,
                insertionIndex: i,
                slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
                placeholderIdMappings: [
                  { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: `${id}_t` },
                  { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: `${id}_b` },
                ],
              },
            });
            requests.push({ insertText: { objectId: `${id}_t`, text: s.title || " " } });
            requests.push({ insertText: { objectId: `${id}_b`, text: s.body || " " } });
          });
          await g.json(`${SLIDES}/${p.presentationId}:batchUpdate`, { method: "POST", body: { requests } });
          return `Created "${title}" with ${slides.length} slides: ${slidesLink(p.presentationId)} (id ${p.presentationId})`;
        },
      }),

      // ----- Calendar -----
      defineTool({
        name: "calendar_events",
        description: "List events from the user's primary Google Calendar between two times (ISO 8601). Defaults to the next 7 days.",
        schema: z.object({ timeMin: z.string().optional(), timeMax: z.string().optional(), query: z.string().optional(), max: z.number().int().min(1).max(100).default(25) }),
        permission: "auto",
        run: async ({ timeMin, timeMax, query, max }) => {
          const min = timeMin ? new Date(timeMin) : new Date();
          const maxT = timeMax ? new Date(timeMax) : new Date(min.getTime() + 7 * 86400_000);
          const r = await g.json(`${CAL}/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=${max}&timeMin=${enc(min.toISOString())}&timeMax=${enc(maxT.toISOString())}${query ? `&q=${enc(query)}` : ""}`);
          if (!r.items?.length) return "No events in that range.";
          return r.items.map((e: any) => `- ${e.start?.dateTime ?? e.start?.date} → ${e.end?.dateTime ?? e.end?.date} · ${e.summary ?? "(no title)"}${e.location ? ` · ${e.location}` : ""}${e.attendees?.length ? ` · ${e.attendees.length} guests` : ""}\n  id ${e.id}`).join("\n");
        },
      }),
      defineTool({
        name: "calendar_create_event",
        description: "Create an event in the user's primary Google Calendar. start/end are ISO 8601 date-times (or YYYY-MM-DD for all-day). Attendees get invitations.",
        schema: z.object({ summary: z.string(), start: z.string(), end: z.string(), description: z.string().optional(), location: z.string().optional(), attendees: z.array(z.string()).default([]), timeZone: z.string().optional() }),
        permission: "ask",
        run: async (a) => {
          const when = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: v } : { dateTime: v, timeZone: a.timeZone });
          const e = await g.json(`${CAL}/calendars/primary/events?sendUpdates=${a.attendees.length ? "all" : "none"}`, {
            method: "POST",
            body: { summary: a.summary, description: a.description, location: a.location, start: when(a.start), end: when(a.end), attendees: a.attendees.map((email) => ({ email })) },
          });
          return `Created "${a.summary}": ${e.htmlLink}`;
        },
      }),

      // ----- Contacts and Tasks -----
      defineTool({
        name: "contacts_search",
        description: "Search the user's Google Contacts by name, email or phone.",
        schema: z.object({ query: z.string() }),
        permission: "auto",
        run: async ({ query }) => {
          const r = await g.json(`${PEOPLE}/people:searchContacts?pageSize=20&readMask=names,emailAddresses,phoneNumbers,organizations&query=${enc(query)}`);
          if (!r.results?.length) return "No contacts found.";
          return r.results
            .map(({ person: p }: any) => `- ${p.names?.[0]?.displayName ?? "(no name)"}${p.organizations?.[0]?.name ? ` · ${p.organizations[0].name}` : ""} · ${(p.emailAddresses ?? []).map((e: any) => e.value).join(", ")} ${(p.phoneNumbers ?? []).map((n: any) => n.value).join(", ")}`)
            .join("\n");
        },
      }),
      defineTool({
        name: "tasks_list",
        description: "List open items in the user's default Google Tasks list.",
        schema: z.object({ showCompleted: z.boolean().default(false) }),
        permission: "auto",
        run: async ({ showCompleted }) => {
          const r = await g.json(`${TASKS}/lists/@default/tasks?maxResults=100&showCompleted=${showCompleted}`);
          if (!r.items?.length) return "No tasks.";
          return r.items.map((t: any) => `- [${t.status === "completed" ? "x" : " "}] ${t.title}${t.due ? ` (due ${t.due.slice(0, 10)})` : ""} · id ${t.id}`).join("\n");
        },
      }),
      defineTool({
        name: "tasks_add",
        description: "Add an item to the user's default Google Tasks list. due is YYYY-MM-DD.",
        schema: z.object({ title: z.string(), notes: z.string().optional(), due: z.string().optional() }),
        permission: "ask",
        run: async ({ title, notes, due }) => {
          const t = await g.json(`${TASKS}/lists/@default/tasks`, { method: "POST", body: { title, notes, due: due ? `${due.slice(0, 10)}T00:00:00.000Z` : undefined } });
          return `Added "${t.title}" (id ${t.id}).`;
        },
      }),

      // ----- Anything else -----
      defineTool({
        name: "google_api",
        description: "Call any Google API with the user's Google sign-in, for things the other Google tools don't cover (labels, sharing, comments, formatting, other calendars, ...). url must be an https://*.googleapis.com URL. GET runs freely; other methods ask the user first.",
        schema: z.object({ method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"), url: z.string().url(), body: z.any().optional() }),
        permission: "auto",
        needsApproval: ({ method }) => (method === "GET" ? null : "This changes data in the user's Google account."),
        run: async ({ method, url, body }) => {
          const host = new URL(url).hostname;
          if (!url.startsWith("https://") || !(host === "googleapis.com" || host.endsWith(".googleapis.com"))) throw new Error("google_api only calls https://*.googleapis.com URLs.");
          const r = await g.json(url, { method, body });
          return truncate(typeof r === "string" ? r : JSON.stringify(r, null, 2), 30_000);
        },
      }),
    ],
  }),
};

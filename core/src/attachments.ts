// Files the user attaches to a message: saved into the workspace, then shown to the model as
// text it can read (documents, sheets, decks, code) or as images for models that can see.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { csvPreview, docxPreview, pptxPreview, xlsxPreview } from "./files/office.ts";
import { htmlToText } from "./tools/builtin.ts";
import type { Attachment, ModelProfile } from "./types.ts";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** How much of one attached document goes into the message; the agent can read the rest from disk. */
const INLINE_CHARS = 20_000;

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const DOCS = /\.(docx|xlsx|pptx|csv|tsv)$/i;
const TEXT = /\.(txt|md|markdown|json|jsonl|ya?ml|toml|ini|env|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|ps1|sql|log|csv|tsv)$/i;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };

export const attachmentKind = (name: string): Attachment["kind"] => (IMAGE.test(name) ? "image" : DOCS.test(name) ? "document" : TEXT.test(name) ? "text" : "other");

/** Save an upload into the workspace's uploads/ folder, never overwriting an earlier one. */
export function saveAttachment(workspace: string, name: string, data: Buffer): Attachment {
  if (data.length > MAX_ATTACHMENT_BYTES) throw Object.assign(new Error(`${name} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`), { status: 413 });
  const clean = basename(name).replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
  const dir = join(workspace, "uploads");
  mkdirSync(dir, { recursive: true });
  const ext = extname(clean);
  let path = join(dir, clean);
  for (let i = 2; existsSync(path); i++) path = join(dir, `${clean.slice(0, clean.length - ext.length)} (${i})${ext}`);
  writeFileSync(path, data);
  return { name: basename(path), path, kind: attachmentKind(clean), size: data.length };
}

/** Whether a model accepts images: the profile says so, or its name suggests it. */
export function canSee(profile: ModelProfile) {
  if (profile.vision !== undefined) return profile.vision;
  return /gpt-4o|gpt-4\.1|gpt-5|o3|o4|claude|gemini|vision|-vl|vl-|llava|pixtral|grok-4|llama-4|gemma-3|mistral-medium|kimi-vl|glm-4\.\dv/i.test(profile.id);
}

const textsIn = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") return out;
  if (Array.isArray(v)) v.forEach((x) => textsIn(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) k === "text" && typeof x === "string" ? out.push(x) : textsIn(x, out);
  return out;
};

/** The readable text of a document, or null when there is none to give. */
export function extractText(path: string): string | null {
  const ext = extname(path).toLowerCase();
  const buf = readFileSync(path);
  if (ext === ".docx") return htmlToText(docxPreview(buf));
  if (ext === ".xlsx") return xlsxPreview(buf, 200, 30).map((s) => `## Sheet ${s.name}\n${s.rows.map((r) => r.join("\t")).join("\n")}`).join("\n\n");
  if (ext === ".pptx") return pptxPreview(buf, 60).slides.map((s, i) => `## Slide ${i + 1}\n${textsIn(s.shapes).join(" ").replace(/\s+/g, " ").trim()}${s.notes ? `\nNotes: ${s.notes}` : ""}`).join("\n\n");
  if (ext === ".csv" || ext === ".tsv") return csvPreview(buf.toString("utf8"), 300).rows.map((r) => r.join("\t")).join("\n");
  const text = buf.toString("utf8");
  return text.includes("\u0000") ? null : ext === ".html" || ext === ".htm" ? htmlToText(text) : text;
}

/** What the model receives for the attachments: a text section, plus images when it can see. */
export function attachmentsForModel(atts: Attachment[], profile: ModelProfile): { text: string; images: string[] } {
  if (!atts.length) return { text: "", images: [] };
  const see = canSee(profile);
  const images: string[] = [];
  const parts = atts.map((a) => {
    const head = `## ${a.name}\nSaved at ${a.path} (${Math.max(1, Math.round(a.size / 1024))} KB).`;
    if (!existsSync(a.path) || !statSync(a.path).isFile()) return `${head} The file is missing now.`;
    if (a.kind === "image") {
      if (!see) return `${head} It's an image, and this model can't see images: say so if the user needs it looked at.`;
      images.push(`data:${MIME[extname(a.path).toLowerCase()] ?? "image/png"};base64,${readFileSync(a.path).toString("base64")}`);
      return `${head} The image is attached to this message.`;
    }
    let text: string | null = null;
    try {
      text = a.kind === "other" ? null : extractText(a.path);
    } catch {
      text = null;
    }
    if (!text?.trim()) return `${head} Its text can't be read here; work with the file on disk if a tool can.`;
    const clipped = text.length > INLINE_CHARS ? `${text.slice(0, INLINE_CHARS)}\n…[${text.length - INLINE_CHARS} more chars: read the file for the rest]` : text;
    return `${head}\n<file name="${a.name}">\n${clipped}\n</file>`;
  });
  return { text: `# Files the user attached\n${parts.join("\n\n")}`, images };
}

// Agent tools for operating Syph's live in-app browser (previewing localhost builds, inspecting reference sites, and visual screenshot QA).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isLocalUrl, normalizeBrowserUrl } from "../browser.ts";
import { resolvePath } from "./builtin.ts";
import { defineTool, type Tool } from "./types.ts";

export const browserOpenTool = defineTool({
  name: "browser_open",
  description:
    "Open Syph's VISIBLE in-app browser side pane and navigate to a URL. SLOW & USER-VISIBLE — use ONLY for: (1) previewing or visually QA-ing a local website/app you built (http://localhost:PORT), (2) visually inspecting a reference design/screenshot, (3) showing a page live to the user, or (4) a single JS-only page after headless web_search/web_fetch failed. NEVER use browser_open in loops for lead research, checking multiple domains, or calling APIs — use fast headless web_search, web_fetch, or shell scripts instead.",
  schema: z.object({
    url: z.string().min(1).describe("URL to open (http://localhost:PORT or https://...)."),
  }),
  permission: "auto",
  needsApproval: ({ url }) => (isLocalUrl(url) ? null : `Syph wants to open ${normalizeBrowserUrl(url)} in the in-app browser.`),
  run: async ({ url }, ctx) => {
    const b = ctx.hooks.browser;
    if (!b) return "Error: In-app browser is not available in this session.";
    const target = normalizeBrowserUrl(url);
    const res = await b.exec({ action: "open", url: target }, true);
    if (res.ok === false) return `Error opening ${target}: ${res.error ?? "unknown error"}`;
    const errs = Array.isArray(res.consoleErrors) && res.consoleErrors.length ? `\nConsole errors (${res.consoleErrors.length}):\n- ${res.consoleErrors.slice(0, 6).join("\n- ")}` : "\nConsole errors: none";
    return `Opened ${res.url || target} in the in-app browser.\nTitle: ${res.title || "(untitled)"}${errs}`;
  },
});

export const browserInspectTool = defineTool({
  name: "browser_inspect",
  description:
    "Inspect the currently open page in the in-app browser. Returns a compact, token-efficient structural & visual audit: viewport, overflow check, computed palette & fonts, headings, broken images, console errors, and clickable selectors.",
  schema: z.object({}),
  permission: "auto",
  run: async (_args, ctx) => {
    const b = ctx.hooks.browser;
    if (!b) return "Error: In-app browser is not available in this session.";
    const res = await b.exec({ action: "inspect" }, true);
    if (res.ok === false) return `Error inspecting page: ${res.error ?? "unknown error"}`;
    return JSON.stringify(res, null, 2).slice(0, 8000);
  },
});

export const browserScreenshotTool = defineTool({
  name: "browser_screenshot",
  description:
    "Capture a live PNG screenshot of the in-app browser so you can visually inspect layout, spacing, alignment, and contrast (attached directly as a vision image on your next step). Saves the PNG to disk.",
  schema: z.object({
    path: z.string().optional().describe("Optional save path inside workspace/linked folder (defaults to .syph-browser/shot-<timestamp>.png)."),
  }),
  permission: "auto",
  run: async ({ path }, ctx) => {
    const b = ctx.hooks.browser;
    if (!b) return "Error: In-app browser is not available in this session.";
    const res = await b.exec({ action: "screenshot" }, true);
    if (res.ok === false || !res.base64) return `Error capturing screenshot: ${res.error ?? "no image data"}`;
    const buf = Buffer.from(String(res.base64), "base64");
    const target = path ? resolvePath(ctx, path, "write") : join(ctx.workspace, ".syph-browser", `shot-${Date.now()}.png`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buf);
    ctx.hooks.attachImage?.(`data:image/png;base64,${res.base64}`);
    const kb = Math.max(1, Math.round(buf.length / 1024));
    return `Captured ${res.width ?? "?"}x${res.height ?? "?"} screenshot of ${res.url || "page"} (${kb} KB) -> ${target} (attached for visual inspection).`;
  },
});

export const browserInteractTool = defineTool({
  name: "browser_interact",
  description:
    "Interact with the live page in the in-app browser: click an element, type into an input, or scroll to a Y pixel offset while the user watches live.",
  schema: z.object({
    action: z.enum(["click", "type", "scroll"]),
    selector: z.string().optional().describe("CSS selector for click or type."),
    text: z.string().optional().describe("Text value for type."),
    y: z.number().optional().describe("Vertical scroll offset in pixels for scroll."),
  }),
  permission: "auto",
  run: async ({ action, selector, text, y }, ctx) => {
    const b = ctx.hooks.browser;
    if (!b) return "Error: In-app browser is not available in this session.";
    const res = await b.exec({ action, selector, text, y }, true);
    if (res.ok === false) return `Error (${action}): ${res.error ?? "failed"}`;
    return `Browser ${action} succeeded: ${JSON.stringify(res)}`;
  },
});

export const browserCloseTool = defineTool({
  name: "browser_close",
  description: "Close Syph's in-app browser side pane.",
  schema: z.object({}),
  permission: "auto",
  run: async (_args, ctx) => {
    const b = ctx.hooks.browser;
    if (!b) return "Error: In-app browser is not available in this session.";
    await b.exec({ action: "close" }, true);
    return "Closed the in-app browser.";
  },
});

export const browserTools: Tool<any>[] = [browserOpenTool, browserInspectTool, browserScreenshotTool, browserInteractTool, browserCloseTool];

// Fast headless web search using Google AI Studio Search Grounding (GEMINI_API_KEY).
// Keeps research, lead lookup, and fact checking completely headless instead of flashing the visible in-app browser.
import { z } from "zod";
import { recordGeminiUsage } from "../providers/usage.ts";
import { defineTool } from "./types.ts";

/** Tiny estimated cost per flash-lite Google Search Grounding lookup for the $10/month credit ledger. */
export const WEB_SEARCH_EST_COST_USD = 0.001;

type FetchFn = typeof fetch;

const SEARCH_MODELS = ["gemini-3.5-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"];

export interface SearchSource {
  title: string;
  url: string;
}

export interface SearchResult {
  answer: string;
  sources: SearchSource[];
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export async function searchWebGemini(
  key: string,
  opts: { query: string; focus?: string; fetch?: FetchFn; signal?: AbortSignal },
): Promise<SearchResult> {
  const f = opts.fetch ?? fetch;
  const prompt = [
    `Search the web for: ${opts.query}`,
    opts.focus ? `Focus on: ${opts.focus}` : "",
    "Return concise, verified facts directly (URLs, phone numbers, addresses, business details, dates). Cite exact sources and never invent URLs or contact details that are not in the search results.",
  ]
    .filter(Boolean)
    .join("\n");

  let lastErr = "Google search request failed.";
  for (const model of SEARCH_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
      }),
      signal: opts.signal ?? AbortSignal.timeout(25_000),
    }).catch((e) => {
      lastErr = (e as Error).message;
      return null;
    });
    if (!res) continue;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      lastErr = `HTTP ${res.status} (${model}): ${body.slice(0, 240)}`;
      // Try next model on 404/400 model-not-available; stop immediately on 401/403 key error.
      if (res.status === 401 || res.status === 403) break;
      continue;
    }
    const json: any = await res.json().catch(() => null);
    const cand = json?.candidates?.[0];
    const parts: any[] = cand?.content?.parts ?? [];
    const answer = parts
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("")
      .trim();
    const chunks: any[] = cand?.groundingMetadata?.groundingChunks ?? [];
    const seen = new Set<string>();
    const sources: SearchSource[] = [];
    for (const ch of chunks) {
      const u = String(ch?.web?.uri ?? "").trim();
      const t = String(ch?.web?.title ?? "").trim();
      if (!u || seen.has(u)) continue;
      seen.add(u);
      sources.push({ title: t || u, url: u });
    }
    const uMeta = json?.usageMetadata ?? {};
    return {
      answer: answer || "(No grounded answer returned.)",
      sources: sources.slice(0, 10),
      model,
      promptTokens: Number(uMeta.promptTokenCount ?? 0) || 0,
      completionTokens: Number(uMeta.candidatesTokenCount ?? 0) || 0,
    };
  }
  throw new Error(lastErr);
}

export const webSearchTool = defineTool({
  name: "web_search",
  description:
    "Fast headless web search powered by Google Search (no visible browser window). Always use web_search and web_fetch (or shell scripts for batch HTTP/API checks) FIRST for company research, finding websites/phone numbers/emails, checking facts, and docs — reserve browser_open strictly for localhost previews, visual UI QA, or showing a page to the user.",
  schema: z.object({
    query: z.string().min(2).max(300).describe("Search query (e.g. 'Vitrerie Montard Veauche site web téléphone')."),
    focus: z.string().max(240).optional().describe("Optional extraction hint (e.g. 'official website URL, phone number, email, whether site looks outdated')."),
  }),
  permission: "auto",
  run: async ({ query, focus }, ctx) => {
    const key = ctx.home.env("GEMINI_API_KEY");
    if (!key) {
      return "Error: web_search requires a Google Gemini API key (Settings → Google Gemini). Without it, use web_fetch on direct URLs/public APIs (e.g. recherche-entreprises.api.gouv.fr) or shell scripts instead of opening the visible browser in loops.";
    }
    const r = await searchWebGemini(key, { query, focus, signal: ctx.signal });
    const estCost = r.promptTokens || r.completionTokens
      ? (r.promptTokens / 1e6) * 0.1 + (r.completionTokens / 1e6) * 0.4 + WEB_SEARCH_EST_COST_USD
      : WEB_SEARCH_EST_COST_USD;
    recordGeminiUsage(ctx.home, { promptTokens: r.promptTokens, completionTokens: r.completionTokens, costUsd: estCost });
    const cites = r.sources.length ? `\n\nSources:\n${r.sources.map((s) => `- ${s.title}: ${s.url}`).join("\n")}` : "";
    return `${r.answer}${cites}`;
  },
});

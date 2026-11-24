// Fast headless web search powered by MiniMax (MINIMAX_API_KEY) — never touches GEMINI_API_KEY.
// Uses MiniMax Coding Plan's fast structured search endpoint first, with MiniMax-M3.1-Flash native
// web_search server tool as fallback.
import { z } from "zod";
import { defineTool } from "./types.ts";

type FetchFn = typeof fetch;

export interface SearchSource {
  title: string;
  url: string;
  snippet?: string;
  date?: string;
}

export interface SearchResult {
  answer?: string;
  sources: SearchSource[];
  related?: string[];
  via: "coding_plan" | "minimax_flash";
}

export async function searchWebMiniMax(
  key: string,
  opts: { query: string; focus?: string; baseUrl?: string; fetch?: FetchFn; signal?: AbortSignal },
): Promise<SearchResult> {
  const f = opts.fetch ?? fetch;
  const origin = new URL(opts.baseUrl || "https://api.minimax.io/v1").origin;
  const query = opts.query.trim();

  // 1) Fast structured search included with MiniMax Coding / Token Plan (~0.4s, zero extra LLM turn)
  let planErr = "";
  try {
    const res = await f(`${origin}/v1/coding_plan/search`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ q: query }),
      signal: opts.signal ?? AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const json: any = await res.json().catch(() => null);
      const code = json?.base_resp?.status_code;
      if (code === undefined || code === 0) {
        const organic: any[] = Array.isArray(json?.organic) ? json.organic : [];
        const sources: SearchSource[] = organic
          .map((o) => ({
            title: String(o?.title ?? "").trim(),
            url: String(o?.link ?? o?.url ?? "").trim(),
            snippet: String(o?.snippet ?? "").trim() || undefined,
            date: String(o?.date ?? "").trim() || undefined,
          }))
          .filter((s) => s.url || s.title)
          .slice(0, 10);
        const related: string[] = Array.isArray(json?.related_searches)
          ? json.related_searches.map((r: any) => String(r?.query ?? r ?? "").trim()).filter(Boolean).slice(0, 5)
          : [];
        if (sources.length) return { sources, related, via: "coding_plan" };
      } else {
        planErr = `${code} ${json?.base_resp?.status_msg ?? ""}`.trim();
      }
    } else {
      planErr = `HTTP ${res.status}`;
    }
  } catch (e) {
    planErr = (e as Error).message;
  }

  // 2) Fallback: MiniMax-M3.1-Flash with server-side web_search tool (Anthropic-compatible endpoint)
  const prompt = [
    `Search the web for: ${query}`,
    opts.focus ? `Focus on: ${opts.focus}` : "",
    "Return concise, verified facts directly (URLs, phone numbers, addresses, business details). Never invent URLs or contact details.",
  ]
    .filter(Boolean)
    .join("\n");

  const res2 = await f(`${origin}/anthropic/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      authorization: `Bearer ${key}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "MiniMax-M3.1-Flash",
      max_tokens: 1024,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
    signal: opts.signal ?? AbortSignal.timeout(30_000),
  });

  if (!res2.ok) {
    const body = await res2.text().catch(() => "");
    throw new Error(`MiniMax web_search failed (plan: ${planErr || "no results"}; flash: HTTP ${res2.status} ${body.slice(0, 200)})`);
  }

  const j2: any = await res2.json().catch(() => null);
  const blocks: any[] = Array.isArray(j2?.content) ? j2.content : [];
  const textParts: string[] = [];
  const seen = new Set<string>();
  const sources: SearchSource[] = [];
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") {
      textParts.push(b.text);
      for (const c of Array.isArray(b.citations) ? b.citations : []) {
        const u = String(c?.url ?? "").trim();
        if (!u || seen.has(u)) continue;
        seen.add(u);
        sources.push({ title: String(c?.title ?? u).trim(), url: u });
      }
    } else if (b?.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const item of b.content) {
        const u = String(item?.url ?? "").trim();
        if (!u || seen.has(u)) continue;
        seen.add(u);
        sources.push({ title: String(item?.title ?? u).trim(), url: u });
      }
    }
  }
  return {
    answer: textParts.join("").trim() || "(No grounded answer returned.)",
    sources: sources.slice(0, 10),
    via: "minimax_flash",
  };
}

export const webSearchTool = defineTool({
  name: "web_search",
  description:
    "Fast headless web search powered by MiniMax (MiniMax-M3.1-Flash / Coding Plan Search — no visible browser window, does not use Gemini credits). Always use web_search and web_fetch (or shell scripts for batch HTTP/API checks) FIRST for company research, finding websites/phone numbers/emails, checking facts, and docs — reserve browser_open strictly for localhost previews, visual UI QA, or showing a page to the user.",
  schema: z.object({
    query: z.string().min(2).max(300).describe("Search query (e.g. 'Vitrerie Montard Veauche site web téléphone')."),
    focus: z.string().max(240).optional().describe("Optional extraction hint (e.g. 'official website URL, phone number, email, whether site looks outdated')."),
  }),
  permission: "auto",
  run: async ({ query, focus }, ctx) => {
    const key = ctx.home.env("MINIMAX_API_KEY");
    if (!key) {
      return "Error: web_search requires a MiniMax API key (Settings → MiniMax). Without it, use web_fetch on direct URLs/public APIs or shell scripts instead of opening the visible browser in loops.";
    }
    const baseUrl = ctx.home.config().providers.find((p) => p.name === "minimax")?.baseUrl ?? "https://api.minimax.io/v1";
    const r = await searchWebMiniMax(key, { query, focus, baseUrl, signal: ctx.signal });
    if (r.via === "coding_plan") {
      const lines = r.sources.map((s, i) => `${i + 1}. ${s.title}${s.date ? ` (${s.date})` : ""}\n   ${s.url}${s.snippet ? `\n   ${s.snippet}` : ""}`);
      const rel = r.related?.length ? `\n\nRelated searches: ${r.related.join(" · ")}` : "";
      return `Search results for "${query}":\n\n${lines.join("\n\n")}${rel}`;
    }
    const cites = r.sources.length ? `\n\nSources:\n${r.sources.map((s) => `- ${s.title}: ${s.url}`).join("\n")}` : "";
    return `${r.answer ?? ""}${cites}`;
  },
});

// One client for every OpenAI-compatible /chat/completions endpoint, with streaming.
import type { ChatMessage, ToolCall } from "../types.ts";

export interface CompletionRequest {
  baseUrl: string;
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  tools?: { type: "function"; function: { name: string; description: string; parameters: unknown } }[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  /** Mark cache breakpoints (Anthropic and Gemini through OpenRouter); other providers cache on their own. */
  cache?: boolean;
  /** Provider name from config, for the few wire differences between providers (see once()). */
  provider?: string;
  /** Reasoning effort; left out when unset or "auto". */
  effort?: string;
  signal?: AbortSignal;
  onToken?: (t: string) => void;
}

/** Messages as they go on the wire: images become content parts, and cache breakpoints are marked. */
export function wireMessages(messages: ChatMessage[], cache = false, keepReasoning = false): unknown[] {
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  return messages.map((m, i) => {
    const { images, reasoning_content, ...rest } = m;
    if (keepReasoning && reasoning_content) (rest as ChatMessage).reasoning_content = reasoning_content;
    const mark = cache && (m.role === "system" || i === lastUser) && typeof m.content === "string" && m.content.length > 0;
    if (!images?.length && !mark) return rest;
    const parts: Record<string, unknown>[] = [];
    if (m.content) parts.push({ type: "text", text: m.content, ...(mark ? { cache_control: { type: "ephemeral" } } : {}) });
    for (const url of images ?? []) parts.push({ type: "image_url", image_url: { url } });
    return { ...rest, content: parts };
  });
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens read from the provider's prompt cache, when reported. */
  cachedTokens?: number;
  /** Thinking streamed separately from the answer (MiniMax reasoning_content), if any. */
  reasoning?: string;
  /** Cost reported by the provider (OpenRouter), if any. */
  costUsd?: number;
  finishReason?: string;
}

/** Lets tests and the eval harness swap the network for a scripted model. */
export type Transport = (req: CompletionRequest) => Promise<CompletionResult>;

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
  }
}

/** The provider account has run out of credit (OpenRouter 402, MiniMax "insufficient balance", …). */
export class CreditsError extends ProviderError {
  constructor(
    readonly provider: string,
    /** Tokens the remaining balance still covers, when the provider says (OpenRouter does). */
    readonly affordable?: number,
    /** Tokens the request asked for, when the provider says. */
    readonly requested?: number,
  ) {
    super(`Out of ${providerName(provider)} credits.`, 402, false);
  }
}

export function providerName(provider: string) {
  return provider === "openrouter" ? "OpenRouter" : provider === "minimax" ? "MiniMax" : provider === "gemini" ? "Google Gemini" : provider;
}

const CREDIT_TEXT = /requires more credits|can only afford|insufficient (account )?(balance|credits?|funds|quota)|out of credits|balance (is )?(not enough|insufficient)|exceeded your current quota|payment required|usage limit (exceeded|reached)|plan limit/i;

/** Turn a provider failure into a CreditsError when it is one, so the chat can say so plainly. */
export function asCreditsError(e: unknown, provider: string): CreditsError | null {
  if (e instanceof CreditsError) return e;
  if (!(e instanceof ProviderError)) return null;
  const text = e.message;
  // MiniMax reports a low balance as status 1008 in base_resp.
  if (e.status !== 402 && !CREDIT_TEXT.test(text) && !/status_code"?\s*:?\s*(1008|2056)\b/.test(text)) return null;
  const num = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : undefined;
  };
  return new CreditsError(provider, num(/can only afford (\d+)/i), num(/requested up to (\d+)/i));
}

export const httpTransport: Transport = async (req) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await once(req);
    } catch (e) {
      lastErr = e;
      if (!(e instanceof ProviderError) || !e.retryable || req.signal?.aborted) throw e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  throw lastErr;
};

async function once(req: CompletionRequest): Promise<CompletionResult> {
  const minimax = req.provider === "minimax" || /\/\/api\.minimaxi?\.(io|com)\b/.test(req.baseUrl);
  const gemini = req.provider === "gemini" || /generativelanguage\.googleapis\.com\b/.test(req.baseUrl);
  const body: Record<string, unknown> = {
    model: req.model,
    messages: wireMessages(req.messages, req.cache, minimax),
    stream: true,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    stream_options: { include_usage: true },
  };
  if (minimax) {
    // MiniMax (platform.minimax.io, OpenAI-compatible): thinking comes back in reasoning_content and
    // must be sent back with the tool calls it led to. It has no JSON mode, so JSON is asked for in the prompt.
    body.reasoning_split = true;
    if (req.effort) body.reasoning_effort = req.effort; // low, medium, high, xhigh, max
  } else if (gemini) {
    // Google AI Studio OpenAI-compatible endpoint rejects OpenRouter-only fields like top-level `usage`.
    if (req.effort) body.reasoning_effort = req.effort === "low" || req.effort === "medium" ? req.effort : "high";
    if (req.jsonMode) body.response_format = { type: "json_object" };
  } else {
    // OpenRouter takes low, medium or high and maps it onto each model's own reasoning setting.
    if (req.effort && req.provider === "openrouter") body.reasoning = { effort: req.effort === "low" || req.effort === "medium" ? req.effort : "high" };
    body.usage = { include: true }; // OpenRouter: report cost
    if (req.jsonMode) body.response_format = { type: "json_object" };
  }
  if (req.tools?.length) body.tools = req.tools;

  // A stream that goes silent for 3 minutes is dead: fail loudly instead of hanging the chat.
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poke = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), IDLE_MS);
  };
  poke();
  const signal = req.signal ? AbortSignal.any([req.signal, idle.signal]) : idle.signal;
  try {
    return await stream(req, body, signal, poke);
  } catch (e) {
    if (idle.signal.aborted && !req.signal?.aborted) throw new ProviderError(`${req.model} sent nothing for ${IDLE_MS / 60_000} minutes, so the request was stopped.`, undefined, true);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const IDLE_MS = 180_000;

async function stream(req: CompletionRequest, body: Record<string, unknown>, signal: AbortSignal, poke: () => void): Promise<CompletionResult> {
  const res = await fetch(req.baseUrl.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(req.apiKey ? { authorization: `Bearer ${req.apiKey}` } : {}),
      "x-title": "Syph",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`, res.status, res.status === 429 || res.status >= 500);
  }
  // Some providers (MiniMax) answer an error with a 200 and a plain JSON body instead of a stream.
  if (/application\/json/i.test(res.headers.get("content-type") ?? "")) {
    const text = await res.text().catch(() => "");
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const code = json?.base_resp?.status_code;
    if (json?.error || (code && code !== 0)) throw new ProviderError(json.error?.message ?? `${json.base_resp.status_msg ?? "error"} (status_code ${code})`, json.error?.code ?? (code === 1008 ? 402 : undefined), false);
    if (json?.choices) {
      const msg = json.choices[0]?.message ?? {};
      if (msg.content) req.onToken?.(msg.content);
      return { content: msg.content ?? "", toolCalls: msg.tool_calls ?? [], promptTokens: json.usage?.prompt_tokens ?? 0, completionTokens: json.usage?.completion_tokens ?? 0, finishReason: json.choices[0]?.finish_reason };
    }
    throw new ProviderError(`Unexpected reply: ${text.slice(0, 300)}`, res.status, false);
  }

  let content = "";
  let reasoning = "";
  const calls = new Map<number, ToolCall>();
  let promptTokens = 0, completionTokens = 0, cachedTokens = 0, costUsd: number | undefined, finishReason: string | undefined;

  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    poke();
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) throw new ProviderError(json.error.message ?? JSON.stringify(json.error), typeof json.error.code === "number" ? json.error.code : undefined, false);
      if (json.base_resp?.status_code) throw new ProviderError(`${json.base_resp.status_msg ?? "error"} (status_code ${json.base_resp.status_code})`, json.base_resp.status_code === 1008 ? 402 : undefined, false);
      const choice = json.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.reasoning_content === "string") reasoning += delta.reasoning_content;
      if (delta?.content) {
        content += delta.content;
        req.onToken?.(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const cur = calls.get(i) ?? { id: tc.id ?? `call_${i}`, type: "function" as const, function: { name: "", arguments: "" } };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        calls.set(i, cur);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (json.usage) {
        promptTokens = json.usage.prompt_tokens ?? promptTokens;
        completionTokens = json.usage.completion_tokens ?? completionTokens;
        cachedTokens = json.usage.prompt_tokens_details?.cached_tokens ?? cachedTokens;
        if (typeof json.usage.cost === "number") costUsd = json.usage.cost;
      }
    }
  }
  return { content, toolCalls: [...calls.values()], promptTokens, completionTokens, cachedTokens, costUsd, finishReason, ...(reasoning ? { reasoning } : {}) };
}

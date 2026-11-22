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
  signal?: AbortSignal;
  onToken?: (t: string) => void;
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  promptTokens: number;
  completionTokens: number;
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
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: true,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    stream_options: { include_usage: true },
    usage: { include: true }, // OpenRouter: report cost
  };
  if (req.tools?.length) body.tools = req.tools;
  if (req.jsonMode) body.response_format = { type: "json_object" };

  const res = await fetch(req.baseUrl.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(req.apiKey ? { authorization: `Bearer ${req.apiKey}` } : {}),
      "x-title": "Syph",
    },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`, res.status, res.status === 429 || res.status >= 500);
  }

  let content = "";
  const calls = new Map<number, ToolCall>();
  let promptTokens = 0, completionTokens = 0, costUsd: number | undefined, finishReason: string | undefined;

  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
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
      if (json.error) throw new ProviderError(json.error.message ?? JSON.stringify(json.error), json.error.code, false);
      const choice = json.choices?.[0];
      const delta = choice?.delta;
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
        if (typeof json.usage.cost === "number") costUsd = json.usage.cost;
      }
    }
  }
  return { content, toolCalls: [...calls.values()], promptTokens, completionTokens, costUsd, finishReason };
}

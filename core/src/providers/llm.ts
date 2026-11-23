// The single entry point for model calls. Handles native vs text tool calling, cost and budgets.
import { join } from "node:path";
import type { Home } from "../home.ts";
import type { ChatMessage, ToolCall } from "../types.ts";
import { readJson, today, writeJson } from "../util.ts";
import { httpTransport, type CompletionResult, type Transport } from "./client.ts";
import { getProfile, resolveModel } from "./models.ts";

export type BudgetCategory = "chat" | "tasks" | "evolve";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmCall {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  category?: BudgetCategory;
  signal?: AbortSignal;
  onToken?: (t: string) => void;
}

export interface LlmResult extends CompletionResult {
  model: string;
  costUsd: number;
}

let transportOverride: Transport | null = null;
const mockModels = new Map<string, Transport>();

/** Replace the network for every call (tests). Pass null to restore. */
export function setTransport(t: Transport | null) {
  transportOverride = t;
}

/** Register a scripted model reachable as "mock:<name>". */
export function registerMockModel(name: string, t: Transport) {
  mockModels.set(name, t);
}

export class BudgetError extends Error {}

export function spendToday(home: Home): Record<BudgetCategory, number> {
  return readJson(join(home.ledgerDir, `spend-${today()}.json`), { chat: 0, tasks: 0, evolve: 0 });
}

function addSpend(home: Home, cat: BudgetCategory, usd: number) {
  if (!usd) return;
  const s = spendToday(home);
  s[cat] = (s[cat] ?? 0) + usd;
  writeJson(join(home.ledgerDir, `spend-${today()}.json`), s);
}

export async function complete(home: Home, call: LlmCall): Promise<LlmResult> {
  const config = home.config();
  const cat = call.category ?? "chat";
  if (config.killSwitch && cat !== "chat") throw new BudgetError("Kill switch is on: background work is paused.");
  const spent = spendToday(home)[cat] ?? 0;
  const cap = config.budgets.dailyUsd[cat];
  if (cap > 0 && spent >= cap) throw new BudgetError(`Daily ${cat} budget of $${cap} reached ($${spent.toFixed(3)} spent).`);

  const resolved = resolveModel(call.model, home);
  const profile = getProfile(home, resolved.ref);
  const native = profile.nativeTools;
  // History may come from another model (the user switched mid-chat): make it valid for this one.
  let messages = normalizeHistory(call.messages);
  if (call.tools?.length && !native) messages = toTextToolMessages(messages, call.tools);
  else if (!call.tools?.length && messages.some((m) => m.role === "tool" || m.tool_calls?.length)) messages = toTextToolMessages(messages, []);

  const transport =
    transportOverride ??
    (resolved.provider === "mock"
      ? mockModels.get(resolved.model) ?? (() => Promise.reject(new Error(`No mock model "${resolved.model}"`)))
      : httpTransport);

  const res = await transport({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    model: resolved.model,
    messages,
    tools: native && call.tools?.length ? call.tools.map((t) => ({ type: "function", function: t })) : undefined,
    temperature: call.temperature ?? profile.temperature,
    maxTokens: call.maxTokens,
    jsonMode: call.jsonMode,
    provider: resolved.provider,
    cache: resolved.provider === "openrouter" && /^(anthropic|google)\//.test(resolved.model),
    signal: call.signal,
    onToken: native || !call.tools?.length ? call.onToken : textToolStreamFilter(call.onToken),
  });

  let { content, toolCalls } = res;
  if (call.tools?.length && !native) ({ content, toolCalls } = parseTextToolCalls(content));

  const costUsd =
    res.costUsd ??
    ((res.promptTokens * (profile.costPerMTokIn ?? 0) + res.completionTokens * (profile.costPerMTokOut ?? 0)) / 1e6);
  addSpend(home, cat, costUsd);
  return { ...res, content, toolCalls, costUsd, model: resolved.ref };
}

// ---------- Text tool protocol for models without native tool calling ----------

const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";

function toolPrompt(tools: ToolSpec[]) {
  const list = tools.map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`).join("\n");
  return `\n\n# Tools\nYou can call tools. To call one, write exactly:\n${OPEN}{"name": "<tool name>", "arguments": {<arguments as JSON>}}${CLOSE}\nYou may call several tools in one reply. After the calls, stop and wait: the results come back in the next message. When you have the final answer, reply normally with no tool_call tags.\n\nAvailable tools:\n${list}`;
}

/**
 * Make a conversation valid for any provider, whichever model wrote it:
 * - tool call ids are unique and use only letters, digits, _ and - (some models reuse "call_0",
 *   and strict providers reject duplicates or other characters);
 * - every tool result follows the call it answers, and every call has a result;
 * - an assistant message without tool calls has text, not null.
 */
export function normalizeHistory(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let n = 0;
  let open = new Map<string, string>(); // original id -> wire id, for the calls awaiting results
  const closeOpen = () => {
    for (const [, wid] of open) {
      const call = [...out].reverse().find((m) => m.tool_calls?.some((c) => c.id === wid))?.tool_calls?.find((c) => c.id === wid);
      out.push({ role: "tool", tool_call_id: wid, name: call?.function.name, content: "(no result recorded)" });
    }
    open = new Map();
  };
  for (const m of messages) {
    if (m.role === "tool") {
      const wid = m.tool_call_id ? open.get(m.tool_call_id) : undefined;
      if (!wid) continue; // a result with no call before it: drop it
      open.delete(m.tool_call_id!);
      out.push({ ...m, tool_call_id: wid });
      continue;
    }
    closeOpen();
    if (m.role === "assistant" && m.tool_calls?.length) {
      const calls = m.tool_calls.map((c) => {
        const wid = `call_${(c.id || "x").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24)}_${++n}`;
        open.set(c.id, wid);
        return { ...c, id: wid, function: { ...c.function, arguments: c.function.arguments || "{}" } };
      });
      out.push({ ...m, tool_calls: calls });
    } else if (m.role === "assistant" && (m.content == null || m.content === "")) {
      out.push({ ...m, content: "(no reply)" });
    } else out.push(m);
  }
  closeOpen();
  return out;
}

export function toTextToolMessages(messages: ChatMessage[], tools: ToolSpec[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const sysIdx = messages.findIndex((m) => m.role === "system");
  for (const [i, m] of messages.entries()) {
    if (i === sysIdx) out.push({ role: "system", content: (m.content ?? "") + (tools.length ? toolPrompt(tools) : "") });
    else if (m.role === "assistant" && m.tool_calls?.length) {
      const calls = m.tool_calls.map((c) => `${OPEN}{"name": ${JSON.stringify(c.function.name)}, "arguments": ${c.function.arguments || "{}"}}${CLOSE}`).join("\n");
      out.push({ role: "assistant", content: [m.content, calls].filter(Boolean).join("\n") });
    } else if (m.role === "tool") {
      out.push({ role: "user", content: `<tool_result name="${m.name ?? ""}">\n${m.content}\n</tool_result>` });
    } else out.push({ role: m.role, content: m.content, ...(m.images?.length ? { images: m.images } : {}) });
  }
  if (sysIdx < 0 && tools.length) out.unshift({ role: "system", content: toolPrompt(tools).trim() });
  // Merge consecutive user messages (several tool results) for models that require alternation.
  return out.reduce<ChatMessage[]>((acc, m) => {
    const prev = acc.at(-1);
    if (prev && prev.role === "user" && m.role === "user") {
      prev.content = `${prev.content}\n\n${m.content}`;
      if (m.images?.length) prev.images = [...(prev.images ?? []), ...m.images];
    }
    else acc.push({ ...m });
    return acc;
  }, []);
}

export function parseTextToolCalls(text: string): { content: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*(<\/tool_call>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    try {
      const raw = m[1].replace(/^```(?:json)?|```$/g, "").trim();
      const obj = JSON.parse(raw);
      toolCalls.push({ id: `call_${toolCalls.length}_${Date.now()}`, type: "function", function: { name: String(obj.name), arguments: JSON.stringify(obj.arguments ?? {}) } });
    } catch {
      // Keep the malformed call so the loop can send a repair message.
      toolCalls.push({ id: `call_${toolCalls.length}_${Date.now()}`, type: "function", function: { name: "__malformed__", arguments: m[1] } });
    }
  }
  return { content: text.replace(re, "").trim(), toolCalls };
}

/** Hide tool_call markup from the streamed text while still streaming normal prose. */
function textToolStreamFilter(onToken?: (t: string) => void) {
  if (!onToken) return undefined;
  let buf = "";
  let inside = false;
  return (t: string) => {
    buf += t;
    while (buf) {
      if (inside) {
        const end = buf.indexOf(CLOSE);
        if (end < 0) return;
        buf = buf.slice(end + CLOSE.length);
        inside = false;
      } else {
        const start = buf.indexOf(OPEN);
        if (start >= 0) {
          if (start) onToken(buf.slice(0, start));
          buf = buf.slice(start + OPEN.length);
          inside = true;
        } else {
          // Hold back a possible partial "<tool_call" prefix.
          let keep = Math.min(buf.length, OPEN.length - 1);
          while (keep > 0 && !OPEN.startsWith(buf.slice(-keep))) keep--;
          const safe = buf.slice(0, buf.length - keep);
          if (safe) onToken(safe);
          buf = buf.slice(safe.length);
          return;
        }
      }
    }
  };
}

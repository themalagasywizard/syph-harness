// The agent loop: call the model, run the tools it asks for, feed results back, repeat.
// Deliberately small. Everything clever lives in context, tools and strategies.
import type { Home } from "./home.ts";
import { complete, type BudgetCategory } from "./providers/llm.ts";
import type { ToolRegistry } from "./tools/registry.ts";
import type { ToolContext } from "./tools/types.ts";
import type { AgentEvent, ChatMessage, Usage } from "./types.ts";

export interface AgentRun {
  home: Home;
  model: string;
  /** Full conversation including the system message. New messages are appended to a copy. */
  messages: ChatMessage[];
  tools?: ToolRegistry;
  ctx?: ToolContext;
  maxSteps?: number;
  temperature?: number;
  category?: BudgetCategory;
  signal?: AbortSignal;
  emit?: (e: AgentEvent) => void;
}

export interface AgentResult {
  content: string;
  messages: ChatMessage[];
  /** Messages added by this run (assistant + tool messages). */
  added: ChatMessage[];
  usage: Usage;
  toolsCalled: string[];
}

export const emptyUsage = (): Usage => ({ promptTokens: 0, completionTokens: 0, costUsd: 0 });
export const addUsage = (a: Usage, b: { promptTokens: number; completionTokens: number; costUsd: number }) => {
  a.promptTokens += b.promptTokens;
  a.completionTokens += b.completionTokens;
  a.costUsd += b.costUsd;
};

export async function runAgent(run: AgentRun): Promise<AgentResult> {
  const emit = run.emit ?? (() => {});
  const messages = [...run.messages];
  const start = messages.length;
  const usage = emptyUsage();
  const toolsCalled: string[] = [];
  const maxSteps = run.maxSteps ?? run.home.config().agent.maxSteps;
  const specs = run.tools && run.ctx ? run.tools.specs() : undefined;
  let emptyRetries = 0;

  for (let step = 1; ; step++) {
    if (run.signal?.aborted) throw new Error("cancelled");
    const lastStep = step > maxSteps;
    if (lastStep) messages.push({ role: "user", content: "You have used all your tool steps. Give your final answer now from what you have, and say what is unfinished." });

    const res = await complete(run.home, {
      model: run.model,
      messages,
      tools: lastStep ? undefined : specs,
      temperature: run.temperature,
      category: run.category,
      signal: run.signal,
      onToken: (t) => emit({ type: "token", text: t }),
    });
    addUsage(usage, res);
    emit({ type: "step", step, usage: { promptTokens: res.promptTokens, completionTokens: res.completionTokens, costUsd: res.costUsd } });

    const assistant: ChatMessage = { role: "assistant", content: res.content || null };
    if (res.toolCalls.length && !lastStep) assistant.tool_calls = res.toolCalls;
    messages.push(assistant);
    emit({ type: "message", message: assistant });

    if (!assistant.tool_calls?.length) {
      if (!res.content.trim() && emptyRetries++ < 1) {
        messages.push({ role: "user", content: "Your reply was empty. Please answer the request." });
        continue;
      }
      return { content: res.content, messages, added: messages.slice(start), usage, toolsCalled };
    }

    for (const call of assistant.tool_calls) {
      const name = call.function.name;
      let result: string, ok: boolean, args: unknown;
      const t0 = Date.now();
      if (name === "__malformed__" || !run.tools || !run.ctx) {
        ok = false;
        args = call.function.arguments;
        result = `Error: that tool call could not be parsed. Use exactly <tool_call>{"name": "...", "arguments": {...}}</tool_call> with valid JSON.`;
        emit({ type: "tool_call", id: call.id, name, args });
      } else {
        let parsed: unknown = call.function.arguments;
        try {
          parsed = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* registry reports it */
        }
        emit({ type: "tool_call", id: call.id, name, args: parsed });
        ({ ok, result, args } = await run.tools.execute(name, call.function.arguments, run.ctx));
        toolsCalled.push(name);
      }
      emit({ type: "tool_result", id: call.id, name, ok, result, ms: Date.now() - t0 });
      messages.push({ role: "tool", tool_call_id: call.id, name, content: result });
    }
  }
}

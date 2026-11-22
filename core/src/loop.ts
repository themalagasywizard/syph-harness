// The agent loop: call the model, run the tools it asks for, feed results back, repeat.
// Deliberately small. Everything clever lives in context, tools and strategies. The loop owns
// the exits, though: a budget, a stop on repeated errors, and room for the user to steer.
import { historyTokens, shrinkToolResults } from "./context.ts";
import type { Home } from "./home.ts";
import { complete, type BudgetCategory } from "./providers/llm.ts";
import { getProfile } from "./providers/models.ts";
import type { ToolRegistry } from "./tools/registry.ts";
import type { ToolContext } from "./tools/types.ts";
import type { AgentEvent, ChatMessage, StopReason, Usage } from "./types.ts";

export interface AgentRun {
  home: Home;
  model: string;
  /** Full conversation including the system message. New messages are appended to a copy. */
  messages: ChatMessage[];
  tools?: ToolRegistry;
  ctx?: ToolContext;
  /** Step budget. Defaults to config agent.maxSteps. */
  maxSteps?: number;
  /** Spend and time budget for this run (defaults from config agent.maxUsdPerRun / maxMinutes). */
  budget?: { usd?: number; minutes?: number };
  temperature?: number;
  category?: BudgetCategory;
  signal?: AbortSignal;
  emit?: (e: AgentEvent) => void;
  /** Messages the user sent while the run was working. Drained at each step boundary. */
  inbox?: () => string[];
}

export interface AgentResult {
  content: string;
  messages: ChatMessage[];
  /** Messages added by this run (assistant + tool messages, and user messages sent mid-run). */
  added: ChatMessage[];
  usage: Usage;
  toolsCalled: string[];
  /** Why the run ended. Anything but "done" means the work may be unfinished. */
  stopReason: StopReason;
  /** What was asked, when the run stopped on a question (ask_user). */
  question?: { question: string; options: string[] };
}

export const emptyUsage = (): Usage => ({ promptTokens: 0, completionTokens: 0, costUsd: 0 });
export const addUsage = (a: Usage, b: { promptTokens: number; completionTokens: number; costUsd: number; cachedTokens?: number }) => {
  a.promptTokens += b.promptTokens;
  a.completionTokens += b.completionTokens;
  a.costUsd += b.costUsd;
  if (b.cachedTokens) a.cachedTokens = (a.cachedTokens ?? 0) + b.cachedTokens;
};

/** Marks user messages the loop adds for the user (kept in history), vs nudges to the model (dropped). */
export const STEER_PREFIX = "[Message from the user while you were working]\n";

/** Tools whose repeated identical calls are expected (they report state, not do work). */
const REPEATABLE = new Set(["update_plan", "note_progress", "set_contract"]);

export async function runAgent(run: AgentRun): Promise<AgentResult> {
  const emit = run.emit ?? (() => {});
  let messages = [...run.messages];
  const start = messages.length;
  const usage = emptyUsage();
  const toolsCalled: string[] = [];
  const config = run.home.config();
  const maxSteps = run.maxSteps ?? config.agent.maxSteps;
  const maxUsd = run.budget?.usd ?? config.agent.maxUsdPerRun ?? 0;
  const maxMs = (run.budget?.minutes ?? config.agent.maxMinutes ?? 0) * 60_000;
  const window = getProfile(run.home, run.model).contextWindow;
  const specs = () => (run.tools && run.ctx ? run.tools.specs(run.ctx) : undefined);
  const started = Date.now();
  let emptyRetries = 0;
  let lastPrompt = 0;
  let stopReason: StopReason = "done";
  let question: AgentResult["question"];
  // A tool (ask_user) can end the turn once this step's tools have run.
  let endTurn: { reason: StopReason; question?: AgentResult["question"] } | null = null;
  const ctx: ToolContext | undefined = run.ctx && { ...run.ctx, hooks: { ...run.ctx.hooks, endTurn: (q) => void (endTurn = { reason: "question", question: q }) } };
  const calls = new Map<string, number>();
  const failures = new Map<string, number>();
  let finalNudge: string | null = null;

  const result = (content: string): AgentResult => ({ content, messages, added: messages.slice(start), usage, toolsCalled, stopReason, question });

  for (let step = 1; ; step++) {
    if (run.signal?.aborted) throw new Error("cancelled");

    // The user can steer a running task: their messages join at the next step.
    for (const text of run.inbox?.() ?? []) {
      messages.push({ role: "user", content: STEER_PREFIX + text });
      emit({ type: "steer", text });
    }

    // Exits the harness owns: the step, spend and time budget.
    if (!finalNudge) {
      const over =
        step > maxSteps ? `${maxSteps} steps` : maxUsd > 0 && usage.costUsd >= maxUsd ? `$${maxUsd.toFixed(2)} of spend` : maxMs > 0 && Date.now() - started >= maxMs ? `${Math.round(maxMs / 60_000)} minutes` : null;
      if (over) {
        stopReason = "budget";
        finalNudge = `You have reached this run's budget (${over}). Stop working now. Reply with a short status: what is done, what is left, and the next step. Your progress is saved, and the user can press Continue.`;
      }
    }
    const lastStep = !!finalNudge;
    if (lastStep && messages.at(-1)?.content !== finalNudge) messages.push({ role: "user", content: finalNudge });

    // Keep the context lean inside a long turn: old tool output becomes a short stub.
    const used = Math.max(lastPrompt, historyTokens(messages));
    if (used > window * 0.6) {
      messages = shrinkToolResults(messages, 6, 1200);
      if (historyTokens(messages) > window * 0.8) messages = shrinkToolResults(messages, 2, 300);
      emit({ type: "note", text: "Trimmed older tool output to keep the context small." });
    }

    const res = await complete(run.home, {
      model: run.model,
      messages,
      tools: lastStep ? undefined : specs(),
      temperature: run.temperature,
      category: run.category,
      signal: run.signal,
      onToken: (t) => emit({ type: "token", text: t }),
    });
    addUsage(usage, res);
    lastPrompt = res.promptTokens;
    emit({ type: "step", step, usage: { promptTokens: res.promptTokens, completionTokens: res.completionTokens, costUsd: res.costUsd } });
    emit({ type: "status", step, contextTokens: res.promptTokens || historyTokens(messages), contextWindow: window, usage: { ...usage }, cachedTokens: res.cachedTokens ?? 0 });

    const assistant: ChatMessage = { role: "assistant", content: res.content || null };
    if (res.toolCalls.length && !lastStep) assistant.tool_calls = res.toolCalls;
    messages.push(assistant);
    emit({ type: "message", message: assistant });

    if (!assistant.tool_calls?.length) {
      if (!res.content.trim() && emptyRetries++ < 1) {
        messages.push({ role: "user", content: "Your reply was empty. Please answer the request." });
        continue;
      }
      return result(res.content);
    }

    let stuck: string | null = null;
    for (const call of assistant.tool_calls) {
      const name = call.function.name;
      let result: string, ok: boolean, args: unknown;
      const t0 = Date.now();
      if (name === "__malformed__" || !run.tools || !ctx) {
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
        ({ ok, result, args } = await run.tools.execute(name, call.function.arguments, ctx));
        toolsCalled.push(name);
      }
      // Exits: the same error twice, or the same call three times, means a missing fact, not a missing try.
      if (!REPEATABLE.has(name)) {
        const sig = `${name}:${call.function.arguments}`;
        const n = (calls.get(sig) ?? 0) + 1;
        calls.set(sig, n);
        if (!ok) {
          const fsig = `${name}:${result.slice(0, 300)}`;
          const f = (failures.get(fsig) ?? 0) + 1;
          failures.set(fsig, f);
          if (f >= 2) stuck = `${name} failed twice with the same error: ${result.split("\n")[0].slice(0, 200)}`;
        }
        if (n >= 3) stuck = `${name} was called three times with the same arguments`;
      }
      emit({ type: "tool_result", id: call.id, name, ok, result, ms: Date.now() - t0 });
      messages.push({ role: "tool", tool_call_id: call.id, name, content: result });
    }

    const ended = endTurn as { reason: StopReason; question?: AgentResult["question"] } | null;
    if (ended) {
      stopReason = ended.reason;
      question = ended.question;
      const text = question ? [question.question, ...question.options.map((o) => `- ${o}`)].join("\n") : "";
      messages.push({ role: "assistant", content: text });
      emit({ type: "token", text });
      return result(text);
    }
    if (stuck && !finalNudge) {
      stopReason = "repeated_error";
      emit({ type: "note", text: `Stopped retrying: ${stuck}.` });
      finalNudge = `Stop: ${stuck}. Another attempt will not be different, because something is missing. Do not call more tools. Reply to the user with what you tried, the exact error, and the fact or decision you need from them to continue.`;
    }
  }
}

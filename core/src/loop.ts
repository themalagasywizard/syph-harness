// The agent loop: call the model, run the tools it asks for, feed results back, repeat.
// Deliberately small. Everything clever lives in context, tools and strategies. The loop owns
// the exits, though: a budget, a stop on repeated errors, and room for the user to steer.
import { historyTokens, shrinkToolResults } from "./context.ts";
import type { Home } from "./home.ts";
import { BudgetError, complete, type BudgetCategory } from "./providers/llm.ts";
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
  /** Fixed step budget (evals, sub-agents). When unset, the short/long budgets from config apply. */
  maxSteps?: number;
  /** Whether this run is a long task (an approved contract, a plan of several steps, long-task mode). Checked every step. */
  isLong?: () => boolean;
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
/** Bookkeeping: these record intent but change nothing. A run of steps with only these is a stall. */
const BOOKKEEPING = new Set(["update_plan", "note_progress", "set_contract"]);
/** Steps of bookkeeping only before the harness tells the model to act, and before it stops the run. */
export const IDLE_NUDGE = 3;
export const IDLE_STOP = 8;

export async function runAgent(run: AgentRun): Promise<AgentResult> {
  const emit = run.emit ?? (() => {});
  let messages = [...run.messages];
  const start = messages.length;
  const usage = emptyUsage();
  const toolsCalled: string[] = [];
  const config = run.home.config();
  const a = config.agent;
  // Short requests get a modest budget. Long tasks (detected each step) run until they are done,
  // like a coding agent: only their own caps, the daily budget and the exits below stop them.
  const fixed = run.maxSteps !== undefined;
  let long = false;
  let graceUntil = 0;
  const limits = () => {
    long = !fixed && !!run.isLong?.();
    return long
      ? { steps: a.longSteps ?? 0, usd: run.budget?.usd ?? a.maxUsdPerLongRun ?? 0, ms: (run.budget?.minutes ?? a.longMinutes ?? 0) * 60_000 }
      : { steps: run.maxSteps ?? a.shortSteps ?? 30, usd: run.budget?.usd ?? a.maxUsdPerRun ?? 0, ms: (run.budget?.minutes ?? a.maxMinutes ?? 0) * 60_000 };
  };
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
  let stuckCount = 0;
  let idleSteps = 0;
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
      const lim = limits();
      const stepsOver = lim.steps > 0 && step > lim.steps && step > graceUntil;
      // A short request that turns out to be big: ask the model to plan the rest (which makes it a
      // long task) instead of stopping the user with a Continue button.
      if (stepsOver && !long && !fixed && run.isLong && !graceUntil) {
        graceUntil = step + 10;
        messages.push({ role: "user", content: `[Harness] This request has taken ${lim.steps} steps. If more work remains, call update_plan now with the remaining steps (that switches you to long-task mode and you keep going until it's done). If you are done, give the final answer.` });
        emit({ type: "note", text: "This is taking a while: asking Syph to plan the rest." });
      } else {
        const over = stepsOver ? `${lim.steps} steps` : lim.usd > 0 && usage.costUsd >= lim.usd ? `$${lim.usd.toFixed(2)} of spend` : lim.ms > 0 && Date.now() - started >= lim.ms ? `${Math.round(lim.ms / 60_000)} minutes` : null;
        if (over) {
          stopReason = "budget";
          finalNudge = `You have reached this run's budget (${over}). Stop working now. Reply with a short status: what is done, what is left, and the next step. Your progress is saved, and the user can press Continue.`;
        }
      }
    }
    const lastStep = !!finalNudge;
    if (lastStep && messages.at(-1)?.content !== finalNudge) messages.push({ role: "user", content: finalNudge });

    // Keep the context lean inside a long turn: old tool output becomes a short stub.
    const used = Math.max(lastPrompt, historyTokens(messages));
    if (used > window * 0.6) {
      messages = shrinkToolResults(messages, 6, 1200);
      if (historyTokens(messages) > window * 0.8) messages = shrinkToolResults(messages, 2, 300);
      // Hours-long runs outgrow even stubs: fold the older middle of the run into a summary.
      // The contract and progress live in the system prompt and the progress file, so they survive.
      if (historyTokens(messages) > window * 0.7) messages = await foldMiddle(run, messages, start, usage);
      emit({ type: "note", text: "Trimmed older tool output to keep the context small." });
    }

    let res;
    try {
      res = await complete(run.home, {
        model: run.model,
        messages,
        tools: lastStep ? undefined : specs(),
        temperature: run.temperature,
        category: run.category,
        signal: run.signal,
        onToken: (t) => emit({ type: "token", text: t }),
      });
    } catch (e) {
      // The daily budget ran out mid-run: end with a status, not an error, so the work can resume.
      if (!(e instanceof BudgetError) || step === 1) throw e;
      stopReason = "budget";
      const text = `Paused: ${e.message} Progress so far is saved; raise the daily budget in Settings or continue tomorrow.`;
      messages.push({ role: "assistant", content: text });
      emit({ type: "token", text });
      return result(text);
    }
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
        messages.pop(); // don't keep an empty assistant message: some providers reject it
        messages.push({ role: "user", content: "Your reply was empty. Please answer the request." });
        continue;
      }
      if (!res.content.trim()) {
        const text = `${run.model.replace(/^openrouter:/, "")} returned an empty reply twice${res.finishReason ? ` (finish reason: ${res.finishReason})` : ""}. Try again, or pick another model.`;
        assistant.content = text;
        emit({ type: "token", text });
        return result(text);
      }
      return result(res.content);
    }

    let stuck: string | null = null;
    // A stall: the model only takes notes ("writing now…") and never makes the call. Different
    // wording each time, so the same-call guard below can't see it.
    const idle = assistant.tool_calls.every((c) => BOOKKEEPING.has(c.function.name));
    idleSteps = idle ? idleSteps + 1 : 0;
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
    if (!stuck && !finalNudge && idleSteps >= IDLE_STOP) {
      stuck = `${idleSteps} steps in a row only recorded notes or plans without doing the work`;
      stuckCount = 3; // a stall isn't fixed by another approach: stop
    } else if (!stuck && !finalNudge && idleSteps > 0 && idleSteps % IDLE_NUDGE === 0) {
      // Often the tool it means to call isn't loaded. Load any hidden tool it named, then insist.
      const said = messages.slice(-idleSteps * 3).map((m) => `${m.content ?? ""} ${(m.tool_calls ?? []).map((c) => c.function.arguments).join(" ")}`).join(" ");
      const named = run.tools && ctx ? run.tools.hidden(ctx).filter((t) => said.includes(t.name)).map((t) => t.name) : [];
      if (named.length) ctx?.hooks.loadTools?.(named);
      const avail = new Set((specs() ?? []).map((t) => t.name).concat(named));
      const missing = [...new Set(said.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])].filter((n) => !avail.has(n) && !BOOKKEEPING.has(n) && /_(write|send|create|update|append|delete|post|put|insert|upload)$|^(write|send|create|update|append)_/.test(n));
      emit({ type: "note", text: `Syph only wrote notes for ${idleSteps} steps. Asking it to act.` });
      messages.push({
        role: "user",
        content: `[Harness] You have recorded notes for ${idleSteps} steps in a row without doing the work. Stop taking notes. Your next reply must be the real tool call${named.length ? ` (now loaded: ${named.join(", ")})` : ""}.${missing.length ? ` ${missing.join(", ")} is not one of your tools: call find_tools to load it, or use the tool you have that does it.` : ""} If you cannot make the call (no such tool, the data is too big, an error), say so plainly in your reply instead.`,
      });
    }
    if (stuck && !finalNudge && long && ++stuckCount < 3) {
      // Long tasks don't stop at the first wall: record it and try another way. Three walls stop it.
      calls.clear();
      failures.clear();
      emit({ type: "note", text: `Hit the same problem again (${stuck}). Trying a different approach.` });
      messages.push({ role: "user", content: `[Harness] ${stuck}. Repeating it won't work. Record this as a dead end with note_progress, then try a different approach. If nothing else can work without the user, call ask_user.` });
    } else if (stuck && !finalNudge) {
      stopReason = "repeated_error";
      emit({ type: "note", text: `Stopped retrying: ${stuck}.` });
      finalNudge = `Stop: ${stuck}. Another attempt will not be different, because something is missing. Do not call more tools. Reply to the user with what you tried, the exact error, and the fact or decision you need from them to continue.`;
    }
  }
}

/** Replace the older part of this run (after the request) with a summary, keeping the recent steps whole. */
async function foldMiddle(run: AgentRun, messages: ChatMessage[], start: number, usage: Usage): Promise<ChatMessage[]> {
  let cut = messages.length - 8;
  // Never split a tool call from its results: cut just before an assistant message.
  while (cut > start && messages[cut]?.role !== "assistant") cut--;
  if (cut <= start + 2) return messages;
  const middle = messages.slice(start, cut);
  const text = middle.map((m) => `${m.role}${m.name ? `(${m.name})` : ""}: ${(m.content ?? "").slice(0, 1500)}${m.tool_calls ? ` [called ${m.tool_calls.map((c) => `${c.function.name} ${c.function.arguments.slice(0, 200)}`).join("; ")}]` : ""}`).join("\n").slice(0, 60_000);
  try {
    const r = await complete(run.home, {
      model: run.model,
      category: run.category,
      signal: run.signal,
      messages: [
        { role: "system", content: "Summarise this stretch of an agent's work so it can carry on: what was done (files, commands, results), decisions, dead ends, and what was about to happen next. Keep paths, names and numbers exact. Be concise." },
        { role: "user", content: text },
      ],
    });
    addUsage(usage, r);
    return [...messages.slice(0, start), { role: "user", content: `[Summary of earlier steps in this run]\n${r.content}` }, { role: "assistant", content: "Understood. Continuing." }, ...messages.slice(cut)];
  } catch {
    return messages;
  }
}

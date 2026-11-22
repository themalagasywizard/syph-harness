// Inference strategies: different ways to spend compute on one request. A model profile picks
// one; the improvement loop can switch it when evals favour another. Extensions can add more.
import { runAgent, addUsage, type AgentResult, type AgentRun } from "../loop.ts";
import { complete } from "../providers/llm.ts";
import { getProfile } from "../providers/models.ts";
import { extractJson } from "../util.ts";

export interface StrategyInput extends AgentRun {
  /** The user's request in plain text (for critics and judges). */
  request: string;
}

export interface Strategy {
  name: string;
  description: string;
  run: (input: StrategyInput) => Promise<AgentResult>;
}

const toolLog = (r: AgentResult) =>
  r.added
    .filter((m) => m.role === "tool")
    .map((m) => `${m.name}: ${(m.content ?? "").slice(0, 600)}`)
    .join("\n")
    .slice(0, 6000);

export interface Critique {
  ok: boolean;
  issues: string[];
  confidence: number;
}

/** Ask a model to check an answer against the request. Used by verify, cascade and best-of-n. */
export async function critique(input: StrategyInput, answer: string, tools: string, model = getProfile(input.home, input.model).critic ?? input.model): Promise<{ c: Critique; usage: { promptTokens: number; completionTokens: number; costUsd: number } }> {
  const res = await complete(input.home, {
    model,
    category: input.category,
    signal: input.signal,
    temperature: 0,
    messages: [
      { role: "system", content: "You check an assistant's answer before the user sees it. Be strict about: answering what was actually asked, following every explicit instruction (format, length, single word, JSON only, etc.), factual or arithmetic errors, claims not supported by the tool results, and invented content. Do not nitpick style. Reply with JSON only: {\"ok\": true|false, \"issues\": [\"...\"], \"confidence\": 0-1}" },
      { role: "user", content: `Request:\n${input.request}\n\nTool results seen by the assistant:\n${tools || "(none)"}\n\nAnswer:\n${answer}` },
    ],
  });
  const c = extractJson<Critique>(res.content) ?? { ok: true, issues: [], confidence: 0.5 };
  return { c: { ok: c.ok !== false, issues: Array.isArray(c.issues) ? c.issues : [], confidence: Number(c.confidence ?? 0.5) }, usage: res };
}

export const direct: Strategy = {
  name: "direct",
  description: "One agent run. Best for strong models.",
  run: (input) => runAgent(input),
};

export const verify: Strategy = {
  name: "verify",
  description: "Run, self-check against the request, and revise once if the check finds problems. Helps smaller models follow instructions.",
  run: async (input) => {
    const first = await runAgent(input);
    const { c, usage } = await critique(input, first.content, toolLog(first));
    addUsage(first.usage, usage);
    if (c.ok || !c.issues.length) return first;
    input.emit?.({ type: "note", text: `Self-check found: ${c.issues.join("; ")}. Revising.`, reset: true });
    const second = await runAgent({
      ...input,
      messages: [...first.messages, { role: "user", content: `Before this reaches the user, a review found these problems:\n- ${c.issues.join("\n- ")}\nFix them and reply with the corrected final answer only (the user will not see your previous answer).` }],
    });
    addUsage(second.usage, first.usage);
    return { ...second, added: [...first.added, ...second.added.slice(-1)], toolsCalled: [...first.toolsCalled, ...second.toolsCalled] };
  },
};

export const bestOfN: Strategy = {
  name: "best_of_n",
  description: "Sample 3 answers (no tools) and let a judge pick the best. For writing and reasoning without side effects.",
  run: async (input) => {
    if (input.tools && input.ctx && input.tools.list().length) return verify.run(input); // tools have side effects; don't run them 3 times
    const quiet = { ...input, emit: undefined, temperature: 0.8 };
    const samples = await Promise.all([0, 1, 2].map(() => runAgent(quiet)));
    const res = await complete(input.home, {
      model: input.model,
      category: input.category,
      temperature: 0,
      messages: [
        { role: "system", content: 'Pick the answer that best satisfies the request: correct, follows every instruction, concise. Reply with JSON only: {"best": <index>}' },
        { role: "user", content: `Request:\n${input.request}\n\n${samples.map((s, i) => `<answer index="${i}">\n${s.content}\n</answer>`).join("\n")}` },
      ],
    });
    const best = samples[Math.min(2, Math.max(0, Number(extractJson<{ best: number }>(res.content)?.best ?? 0)))];
    for (const s of samples) if (s !== best) addUsage(best.usage, s.usage);
    addUsage(best.usage, res);
    input.emit?.({ type: "token", text: best.content });
    return best;
  },
};

export const cascade: Strategy = {
  name: "cascade",
  description: "Answer with this (usually local) model, check it, and escalate to the profile's escalateTo model if the check fails.",
  run: async (input) => {
    const profile = getProfile(input.home, input.model);
    const first = await runAgent(input);
    if (!profile.escalateTo) return first;
    const { c, usage } = await critique(input, first.content, toolLog(first));
    addUsage(first.usage, usage);
    if (c.ok && c.confidence >= 0.5) return first;
    input.emit?.({ type: "note", text: `Escalating to ${profile.escalateTo}: ${c.issues.join("; ") || "low confidence"}.`, reset: true });
    const second = await runAgent({ ...input, model: profile.escalateTo });
    addUsage(second.usage, first.usage);
    return second;
  },
};

const registry = new Map<string, Strategy>([direct, verify, bestOfN, cascade].map((s) => [s.name, s]));

export function registerStrategy(s: Strategy) {
  registry.set(s.name, s);
}

export function getStrategy(name: string): Strategy {
  return registry.get(name) ?? direct;
}

export const listStrategies = () => [...registry.values()].map(({ name, description }) => ({ name, description }));

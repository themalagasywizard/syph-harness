import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Home } from "../src/home.ts";
import { registerMockModel } from "../src/providers/llm.ts";
import type { CompletionRequest, CompletionResult } from "../src/providers/client.ts";
import type { ToolCall } from "../src/types.ts";

export function tempHome(config: Record<string, unknown> = {}) {
  const home = new Home(mkdtempSync(join(tmpdir(), "syph-test-"))).init();
  home.saveConfig({
    defaults: { chatModel: "mock:main", taskModel: "mock:main", reflectorModel: "mock:reflector", judgeModel: "mock:judge" },
    evolve: { samplesPerCase: 1, maxAttempts: 2, heldOutFraction: 0 },
    ...config,
  } as any);
  return home;
}

export const reply = (content: string, toolCalls: ToolCall[] = []): CompletionResult => ({ content, toolCalls, promptTokens: 10, completionTokens: 5, costUsd: 0.0001 });

export const call = (name: string, args: unknown): ToolCall => ({ id: `c_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } });

export function mock(name: string, fn: (req: CompletionRequest) => CompletionResult | Promise<CompletionResult>) {
  registerMockModel(name, async (req) => {
    const r = await fn(req);
    if (r.content) req.onToken?.(r.content);
    return r;
  });
}

export const lastUser = (req: CompletionRequest) => [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
export const system = (req: CompletionRequest) => req.messages.find((m) => m.role === "system")?.content ?? "";

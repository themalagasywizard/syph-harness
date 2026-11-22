// Every run writes a JSONL trace of its events plus one summary line in traces/index.jsonl.
// Traces are the raw material for evals, the example bank and the reflector.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Home } from "./home.ts";
import type { AgentEvent } from "./types.ts";
import { ensureDir, id, now, today } from "./util.ts";

export type RunKind = "chat" | "task" | "eval" | "evolve" | "subagent" | "judge";

export interface RunSummary {
  runId: string;
  kind: RunKind;
  chatId?: string;
  taskId?: string;
  projectId?: string;
  model: string;
  strategy: string;
  startedAt: string;
  endedAt?: string;
  status: "ok" | "error" | "cancelled";
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  input: string;
  output: string;
  toolErrors: number;
  file: string;
}

export class Trace {
  readonly runId = id("run_");
  readonly file: string;
  readonly startedAt = now();
  private toolErrors = 0;

  constructor(private home: Home, readonly meta: { kind: RunKind; model: string; strategy: string; chatId?: string; taskId?: string; projectId?: string; input: string }) {
    const dir = `traces/${today()}`;
    ensureDir(home.path(dir));
    this.file = `${dir}/${this.runId}.jsonl`;
    this.write({ type: "meta", ...meta, runId: this.runId, at: this.startedAt });
  }

  private write(obj: unknown) {
    appendFileSync(this.home.path(this.file), JSON.stringify(obj) + "\n");
  }

  event(e: AgentEvent | { type: string; [k: string]: unknown }) {
    if (e.type === "token") return; // tokens are reconstructable from messages; keep traces small
    if (e.type === "tool_result" && !(e as any).ok) this.toolErrors++;
    this.write({ ...e, at: now() });
  }

  finish(r: { status: RunSummary["status"]; output: string; promptTokens: number; completionTokens: number; costUsd: number }): RunSummary {
    const summary: RunSummary = {
      runId: this.runId,
      ...this.meta,
      input: this.meta.input.slice(0, 2000),
      startedAt: this.startedAt,
      endedAt: now(),
      status: r.status,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      costUsd: r.costUsd,
      output: r.output.slice(0, 4000),
      toolErrors: this.toolErrors,
      file: this.file,
    };
    this.write({ type: "summary", ...summary });
    appendFileSync(this.home.path("traces/index.jsonl"), JSON.stringify(summary) + "\n");
    return summary;
  }
}

function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}

export const listRuns = (home: Home) => readLines<RunSummary>(home.path("traces/index.jsonl"));

export function readTrace(home: Home, runId: string) {
  const run = listRuns(home).find((r) => r.runId === runId);
  return run ? readLines<Record<string, unknown>>(home.path(run.file)) : [];
}

export interface Rating {
  runId: string;
  rating: "up" | "down";
  note?: string;
  at: string;
}

export function addRating(home: Home, r: Omit<Rating, "at">) {
  appendFileSync(home.path("traces/ratings.jsonl"), JSON.stringify({ ...r, at: now() }) + "\n");
}

/** Latest rating per run. */
export function ratings(home: Home): Map<string, Rating> {
  const m = new Map<string, Rating>();
  for (const r of readLines<Rating>(home.path("traces/ratings.jsonl"))) m.set(r.runId, r);
  return m;
}

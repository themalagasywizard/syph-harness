// Few-shot example bank. Good answers (rated up, or from a stronger model that passed evals)
// are stored and the closest ones are shown to weaker models as demonstrations.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Home } from "./home.ts";
import { ensureDir, id, now } from "./util.ts";

export interface Example {
  id: string;
  input: string;
  output: string;
  model: string;
  source: "rating" | "eval" | "manual";
  createdAt: string;
}

const FILE = "examples/bank.jsonl";

export function addExample(home: Home, e: Omit<Example, "id" | "createdAt">) {
  ensureDir(home.path("examples"));
  const ex: Example = { ...e, id: id("ex_"), createdAt: now() };
  appendFileSync(home.path(FILE), JSON.stringify(ex) + "\n");
  return ex;
}

export function allExamples(home: Home): Example[] {
  if (!existsSync(home.path(FILE))) return [];
  return readFileSync(home.path(FILE), "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Example];
      } catch {
        return [];
      }
    });
}

const tokenize = (s: string) => s.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];

/** TF-IDF cosine similarity. Dependency-free and good enough for a few thousand examples. */
export function retrieve(home: Home, query: string, k: number, exclude?: (e: Example) => boolean): Example[] {
  const docs = allExamples(home).filter((e) => !exclude?.(e));
  if (!docs.length || k <= 0) return [];
  const df = new Map<string, number>();
  const tfs = docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of tokenize(d.input)) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return tf;
  });
  const idf = (t: string) => Math.log((docs.length + 1) / ((df.get(t) ?? 0) + 1)) + 1;
  const vec = (tf: Map<string, number>) => {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, c] of tf) {
      const w = c * idf(t);
      v.set(t, w);
      norm += w * w;
    }
    return { v, norm: Math.sqrt(norm) || 1 };
  };
  const qtf = new Map<string, number>();
  for (const t of tokenize(query)) qtf.set(t, (qtf.get(t) ?? 0) + 1);
  const q = vec(qtf);
  return docs
    .map((d, i) => {
      const dv = vec(tfs[i]);
      let dot = 0;
      for (const [t, w] of q.v) dot += w * (dv.v.get(t) ?? 0);
      return { d, s: dot / (q.norm * dv.norm) };
    })
    .filter((x) => x.s > 0.15)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.d);
}

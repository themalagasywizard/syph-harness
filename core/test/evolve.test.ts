import assert from "node:assert/strict";
import { test } from "node:test";
import { rmSync, readFileSync } from "node:fs";
import { evolveOnce, gate } from "../src/evolve/engine.ts";
import { createProposal } from "../src/evolve/proposals.ts";
import { runSuite, caseFromRun, isHeldOut } from "../src/evals/index.ts";
import { Harness } from "../src/harness.ts";
import { exportDatasets } from "../src/export.ts";
import { store } from "../src/index.ts";
import { lastUser, mock, reply, system, tempHome } from "./helpers.ts";

function homeWithCases(cases: object[]) {
  const home = tempHome();
  rmSync(home.path("evals/cases"), { recursive: true, force: true });
  for (const c of cases) home.write(`evals/cases/${(c as any).id}.json`.replace(/^/, ""), JSON.stringify({ createdAt: "", ...c }));
  return home;
}

// The home's evals/ folder is protected from proposals, but tests write it directly through Home.write.
const CASES = [
  { id: "sum-1", input: "Summarise: The council approved the bike lanes.", checks: [{ type: "contains", value: "SOURCE:" }] },
  { id: "sum-2", input: "Summarise: Rain is expected on Friday.", checks: [{ type: "contains", value: "SOURCE:" }] },
  { id: "math", input: "2+2? number only", checks: [{ type: "regex", pattern: "^4$" }] },
];

/** A model that only adds a SOURCE line when its system prompt tells it to. */
function sourceModel() {
  mock("main", (req) => {
    const q = lastUser(req);
    if (q.startsWith("2+2")) return reply("4");
    return reply(system(req).includes("End summaries with SOURCE:") ? "Short summary.\nSOURCE: user text" : "Short summary.");
  });
}

test("eval suite scores deterministic checks", async () => {
  const home = homeWithCases(CASES);
  sourceModel();
  const r = await runSuite(home, "mock:main", { record: false });
  assert.equal(r.results.find((x) => x.id === "math")!.score, 1);
  assert.equal(r.results.find((x) => x.id === "sum-1")!.score, 0);
  assert.ok(Math.abs(r.score - 1 / 3) < 1e-9);
});

test("gate passes a change that fixes failures and rejects one that does nothing useful", async () => {
  const home = homeWithCases(CASES);
  sourceModel();
  const base = home.read("prompts/system.md")!;
  const good = createProposal(home, { kind: "prompt", title: "Add source line", reason: "r", files: [{ path: "prompts/system.md", content: base + "\n- End summaries with SOURCE: <where it came from>.\n" }], source: "reflector", targetCases: ["sum-1", "sum-2"] });
  const g = await gate(home, good, "mock:main", { samples: 1 });
  assert.equal(g.passed, true, g.notes.join(" "));
  assert.ok(g.candidate > g.baseline);
  const useless = createProposal(home, { kind: "prompt", title: "Be nice", reason: "r", files: [{ path: "prompts/system.md", content: base + "\n- Be nice.\n" }], source: "reflector", targetCases: ["sum-1"] });
  const g2 = await gate(home, useless, "mock:main", { samples: 1 });
  assert.equal(g2.passed, false);
  // The real home was never modified by gating.
  assert.equal(home.read("prompts/system.md"), base);
});

test("evolveOnce: a weakened prompt is found, fixed by the reflector after a failed attempt, and waits for approval", async () => {
  const home = homeWithCases(CASES);
  sourceModel();
  let attempt = 0;
  mock("reflector", (req) => {
    attempt++;
    const sys = /<file path="prompts\/system.md">\n([\s\S]*?)\n<\/file>/.exec(lastUser(req))![1];
    const content = attempt === 1 ? sys + "\n- Be concise.\n" : sys + "\n- End summaries with SOURCE: <where it came from>.\n";
    if (attempt === 2) assert.match(lastUser(req), /earlier attempts this cycle failed/);
    return reply(JSON.stringify({ diagnosis: "Summaries lack a source line.", kind: "prompt", title: attempt === 1 ? "Be concise" : "Require a source line", reason: "Checks expect SOURCE:", files: [{ path: "prompts/system.md", content }] }));
  });
  const logs: string[] = [];
  const r = await evolveOnce(home, "mock:main", (m) => logs.push(m));
  assert.equal(r.status, "proposed", logs.join("\n"));
  assert.equal(r.attempts, 2);
  assert.equal(r.proposal!.status, "pending");
  assert.equal(r.proposal!.gate!.passed, true);
  const h = await new Harness(home).init({ mcp: false });
  assert.equal(h.proposals().filter((p) => p.status === "failed").length, 1);
  await h.decide(r.proposal!.id, "accept");
  const after = await runSuite(home, "mock:main", { record: false });
  assert.equal(after.score, 1);
});

test("evolveOnce refuses a reflector that tries to edit the evals", async () => {
  const home = homeWithCases(CASES);
  sourceModel();
  mock("reflector", () => reply(JSON.stringify({ kind: "prompt", title: "Cheat", reason: "x", files: [{ path: "evals/cases/sum-1.json", content: "{}" }] })));
  const r = await evolveOnce(home, "mock:main");
  assert.equal(r.status, "no_improvement");
  assert.ok(home.read("evals/cases/sum-1.json")!.includes("SOURCE:"));
});

test("an extension proposal whose own test fails never reaches evals", async () => {
  const home = homeWithCases(CASES);
  sourceModel();
  const p = createProposal(home, { kind: "extension", title: "Bad tool", reason: "x", files: [{ path: "extensions/bad.ts", content: "export default (s) => ({ tools: [], test: () => { throw new Error('nope'); } });" }], source: "reflector" });
  const g = await gate(home, p, "mock:main");
  assert.equal(g.passed, false);
  assert.match(g.notes.join(" "), /nope/);
});

test("judge checks, mining cases from ratings, held-out split and dataset export", async () => {
  const home = homeWithCases([{ id: "judge-1", input: "Explain DNS briefly", checks: [{ type: "judge", rubric: "Mentions names to IP addresses" }] }]);
  mock("main", () => reply("DNS maps names to IP addresses."));
  mock("judge", (req) => reply(lastUser(req).includes("Rubric") ? '{"score": 9, "reason": "good"}' : "- Must mention IP addresses"));
  const r = await runSuite(home, "mock:main", { record: false });
  assert.equal(r.results[0].score, 0.9);

  const h = await new Harness(home).init({ mcp: false });
  const chat = store.createChat(home, {});
  const t1 = await h.chat(chat.id, "What is DNS?");
  h.rate(chat.id, t1.id, "down");
  const c = await h.turnIntoEval(t1.runId!, "down");
  assert.equal(c.checks[0].type, "judge");
  assert.match((c.checks[0] as any).rubric, /IP addresses/);

  const chat2 = store.createChat(home, {});
  const t2 = await h.chat(chat2.id, "What is DNS?");
  h.rate(chat2.id, t2.id, "up");
  const up = await caseFromRun(home, t2.runId!, "up");
  assert.equal((up.checks[0] as any).reference, "DNS maps names to IP addresses.");

  const ex = exportDatasets(home);
  assert.equal(ex.sftCount, 1);
  assert.equal(ex.dpoCount, 1);
  assert.match(readFileSync(ex.dpo, "utf8"), /"chosen"/);

  home.saveConfig({ evolve: { samplesPerCase: 1, maxAttempts: 2, heldOutFraction: 0.2 } } as any);
  const held = Array.from({ length: 200 }, (_, i) => isHeldOut(home, `case-${i}`)).filter(Boolean).length;
  assert.ok(held > 20 && held < 60, `held-out ${held}/200`);
});

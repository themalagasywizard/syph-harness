import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/providers/llm.ts";
import { GEMINI_DEFAULT, getProfile, listModels } from "../src/providers/models.ts";
import { adjustGeminiUsage, geminiUsage, nextMonthResetMs, recordGeminiUsage } from "../src/providers/usage.ts";
import { isFrontendTask, resolveThreadModel } from "../src/threads.ts";
import { Harness, store } from "../src/index.ts";
import { call, mock, reply, system, tempHome } from "./helpers.ts";

async function fakeGemini() {
  const bodies: any[] = [];
  const srv = createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "models/gemini-4-neon" },
            { id: "models/gemini-4-argon" },
            { id: "models/gemini-3.8-flash" },
            { id: "models/text-embedding-004" },
          ],
        }),
      );
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.setHeader("content-type", "text/event-stream");
      const chunks = [
        { choices: [{ delta: { content: "Built hero section." } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100_000, completion_tokens: 10_000, prompt_tokens_details: { cached_tokens: 40_000 } } },
      ];
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  return { bodies, srv, base: `http://127.0.0.1:${(srv.address() as any).port}/v1beta/openai` };
}

test("Gemini is a built-in provider, hidden until key saved, and normalizes model IDs", async () => {
  const home = tempHome({ providers: [{ name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" }] });
  const cfg = home.config();
  assert.equal(cfg.providers.find((p) => p.name === "gemini")?.apiKeyEnv, "GEMINI_API_KEY");
  assert.equal(cfg.budgets.geminiMonthlyCreditUsd, 10);
  assert.equal((await listModels(home)).filter((m) => m.provider === "gemini").length, 0);

  const prof = getProfile(home, GEMINI_DEFAULT);
  assert.equal(GEMINI_DEFAULT, "gemini:gemini-4-neon");
  assert.equal(prof.contextWindow, 1_048_576);
  assert.equal(prof.vision, true);
  assert.equal(prof.costPerMTokIn, 3.0);
  assert.equal(prof.costPerMTokOut, 15.0);
});

test("Gemini calls omit OpenRouter usage field, map effort, and track monthly $10 credit", async () => {
  const { bodies, srv, base } = await fakeGemini();
  const home = tempHome({
    providers: [{ name: "gemini", baseUrl: base, apiKeyEnv: "GEMINI_API_KEY" }],
    defaults: { chatModel: "mock:main", taskModel: "mock:main", frontendModel: GEMINI_DEFAULT, reflectorModel: "mock:main", judgeModel: "mock:main", effort: "high" },
  });
  home.setEnv("GEMINI_API_KEY", "AIzaSyTestKey0123456789abcdef");
  try {
    const res = await complete(home, { model: GEMINI_DEFAULT, messages: [{ role: "user", content: "Build a hero" }], jsonMode: true });
    assert.equal(res.content, "Built hero section.");
    assert.equal(bodies[0].usage, undefined, "OpenRouter-only usage flag must not be sent to Gemini");
    assert.equal(bodies[0].reasoning_effort, "high");
    assert.deepEqual(bodies[0].response_format, { type: "json_object" });

    // Gemini 4 Neon: Uncached 60k * $3.00/1M ($0.18) + cached 40k * $0.15/1M ($0.006) + 10k * $15/1M ($0.15) = $0.336
    assert.ok(Math.abs(res.costUsd - 0.336) < 1e-6, `expected ~0.336, got ${res.costUsd}`);

    const u = geminiUsage(home);
    assert.equal(u.provider, "gemini");
    assert.equal(u.meters.length, 1);
    assert.equal(u.meters[0].label, "Monthly credit");
    assert.equal(u.meters[0].total, 10);
    assert.ok(Math.abs(u.meters[0].used - 0.336) < 1e-6);
    assert.equal(u.meters[0].unit, "usd");
    assert.equal(u.meters[0].resetsAt, nextMonthResetMs(u.checkedAt));

    // Manual sync / reset works cleanly
    adjustGeminiUsage(home, 0);
    assert.equal(geminiUsage(home).meters[0].used, 0);

    // Model discovery strips leading models/ and excludes embeddings
    const models = await listModels(home);
    const gRefs = models.filter((m) => m.provider === "gemini").map((m) => m.ref);
    assert.ok(gRefs.includes("gemini:gemini-4-neon"));
    assert.ok(gRefs.includes("gemini:gemini-4-argon"));
    assert.ok(!gRefs.some((r) => r.includes("embedding")));
  } finally {
    srv.close();
  }
});

test("Coordinator routes frontend threads to Gemini and keeps general work on cheap default model, with credit cap fallback", async () => {
  const home = tempHome({
    defaults: { chatModel: "mock:cheap", taskModel: "mock:cheap", frontendModel: GEMINI_DEFAULT, reflectorModel: "mock:cheap", judgeModel: "mock:cheap" },
    agent: { threadBriefs: false, maxThreads: 3 },
  });
  home.setEnv("GEMINI_API_KEY", "AIzaSyTestKey0123456789abcdef");

  // Strict frontend routing: ONLY when using the frontend-design skill (or frontend: true).
  // Mere mentions of "website" during research/prospecting/auditing MUST stay on the cheap default model.
  assert.equal(isFrontendTask("Build restaurant site", "Call read_skill(\"frontend-design\") and build the landing page"), true);
  assert.equal(isFrontendTask("Research small businesses without websites", "Find 10 French companies that don't have a website or have a bad website"), false);
  assert.equal(isFrontendTask("Analyse Q3 invoices", "Parse CSV and output totals"), false);

  const researchRoute = resolveThreadModel(home, "mock:cheap", {
    title: "Find French companies without websites",
    prompt: "Research 10 small businesses without a website and export prospects.csv",
  });
  assert.equal(researchRoute.model, "mock:cheap");
  assert.equal(researchRoute.routedFrontend, false);

  const feSkillRoute = resolveThreadModel(home, "mock:cheap", {
    title: "Build bakery landing page",
    prompt: "Use the frontend-design skill to build a landing page",
  });
  assert.equal(feSkillRoute.model, GEMINI_DEFAULT);
  assert.equal(feSkillRoute.routedFrontend, true);

  const feFlagRoute = resolveThreadModel(home, "mock:cheap", {
    title: "Build bakery landing page",
    prompt: "Build the page",
    frontend: true,
  });
  assert.equal(feFlagRoute.model, GEMINI_DEFAULT);
  assert.equal(feFlagRoute.routedFrontend, true);

  const genRoute = resolveThreadModel(home, "mock:cheap", { title: "Summarize PDF", prompt: "Extract action items" });
  assert.equal(genRoute.model, "mock:cheap");
  assert.equal(genRoute.routedFrontend, false);

  // Exhaust $10 monthly credit -> graceful fallback to cheap coordinator model
  recordGeminiUsage(home, { costUsd: 10.05 });
  const capped = resolveThreadModel(home, "mock:cheap", { title: "Build SaaS landing page", prompt: "Build site", frontend: true });
  assert.equal(capped.model, "mock:cheap");
  assert.equal(capped.routedFrontend, false);
  assert.match(capped.fallbackReason ?? "", /monthly credit/i);

  // Reset credit and verify live coordinator system prompt + thread routing
  adjustGeminiUsage(home, 0);
  const h = await new Harness(home).init({ mcp: false, scheduler: false });
  const proj = store.createProject(home, { name: "Agency" });
  store.updateProject(home, proj.id, { coordinatorWake: false });
  const coord = store.getOrCreateCoordinator(home, proj.id);

  let coordSys = "";
  mock("cheap", (req) => {
    const sys = system(req);
    if (sys.includes("# You are this project's coordinator")) {
      coordSys = sys;
      const hasTool = req.messages.some((m) => m.role === "tool");
      if (!hasTool) {
        return reply("", [
          call("start_thread", { title: "Build dental clinic landing page", prompt: "Create an agency-grade landing page.", frontend: true }),
          call("start_thread", { title: "Draft client email", prompt: "Write a short follow-up email." }),
        ]);
      }
      return reply("Started both threads.");
    }
    return reply("Done on cheap model.");
  });

  // Override thread execution for gemini:gemini-2.5-pro? Since resolveModel would hit HTTP, test via mock frontendModel:
  home.saveConfig({ defaults: { ...home.config().defaults, frontendModel: "mock:frontend" } });
  let frontendRan = false;
  mock("frontend", () => {
    frontendRan = true;
    return reply("Built high-craft landing page.");
  });

  await h.chat(coord.id, "Build a dental clinic landing page and draft an email.");
  for (let i = 0; i < 40; i++) {
    const ts = store.listThreads(home, coord.id);
    if (ts.length === 2 && ts.every((t) => t.threadState === "done" || t.threadState === "review_ready")) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await h.threads.settled();

  assert.match(coordSys, /# Thread model routing/);
  assert.equal(frontendRan, true);
  const threads = store.listThreads(home, coord.id);
  const feThread = threads.find((t) => t.title.includes("landing page"))!;
  const genThread = threads.find((t) => t.title.includes("email"))!;
  assert.equal(feThread.model, "mock:frontend");
  assert.equal(genThread.model, "mock:cheap");

  // Unsure which model to use: ask_model pauses thread with an in-thread model selector, then launches on chosen model.
  let chosenModelRan = false;
  mock("chosen", () => {
    chosenModelRan = true;
    return reply("Completed on user-selected model.");
  });
  const paused = h.threads.start(coord.id, {
    title: "Mixed research and prototype",
    prompt: "Do the requested work",
    ask_model: true,
    model_reason: "Pick MiniMax for research or Gemini 4 Neon for UI design.",
  });
  assert.equal(paused.threadState, "blocked");
  assert.equal(paused.turns.at(-1)?.question?.kind, "model");
  assert.equal(paused.turns.at(-1)?.question?.pendingStart, true);
  assert.equal(chosenModelRan, false);

  h.threads.startWithModel(paused.id, "mock:chosen");
  for (let i = 0; i < 40; i++) {
    const t = store.getChat(home, paused.id);
    if (t?.threadState === "done") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await h.threads.settled();
  assert.equal(chosenModelRan, true);
  const finished = store.getChat(home, paused.id)!;
  assert.equal(finished.model, "mock:chosen");
  assert.equal(finished.turns.at(-1)?.content, "Completed on user-selected model.");
  await h.close();
});

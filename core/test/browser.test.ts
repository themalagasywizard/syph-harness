import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isLocalUrl, normalizeBrowserUrl } from "../src/browser.ts";
import { browserOpenTool } from "../src/tools/browser.ts";
import { searchWebMiniMax } from "../src/tools/search.ts";
import { Harness, store } from "../src/index.ts";
import { call, mock, reply, tempHome } from "./helpers.ts";

// Tiny valid 1x1 PNG
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2S8AAAAASUVORK5CYII=";

test("URL normalization and localhost auto-approval gating", () => {
  assert.equal(normalizeBrowserUrl("localhost:8765"), "http://localhost:8765");
  assert.equal(normalizeBrowserUrl(":5173"), "http://localhost:5173");
  assert.equal(normalizeBrowserUrl("firstparebrise.fr"), "https://firstparebrise.fr");
  assert.equal(isLocalUrl("localhost:8765"), true);
  assert.equal(isLocalUrl("http://127.0.0.1:3000/app"), true);
  assert.equal(isLocalUrl("https://www.firstparebrise.fr"), false);

  assert.equal(browserOpenTool.needsApproval?.({ url: "http://localhost:8765" }, {} as any), null, "localhost previews run without asking");
  assert.ok(browserOpenTool.needsApproval?.({ url: "https://example.com" }, {} as any), "external sites ask unless YOLO is on");
});

test("Agent browser tools drive the live bridge, inspect DOM, and attach screenshots as vision images", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false, scheduler: false });
  const seenActions: string[] = [];
  const stateEvents: boolean[] = [];
  h.browser.onChange((s) => stateEvents.push(s.open));

  h.browser.setDriver(
    {
      exec: async (cmd) => {
        seenActions.push(cmd.action);
        if (cmd.action === "open") {
          h.browser.syncState({ open: true, url: cmd.url ?? "", title: "APEX Pare-Brise" });
          return { ok: true, url: cmd.url, title: "APEX Pare-Brise", consoleErrors: [] };
        }
        if (cmd.action === "inspect") {
          return { ok: true, title: "APEX Pare-Brise", viewport: { width: 1280, height: 800 }, horizontalOverflow: false, brokenImages: [] };
        }
        if (cmd.action === "screenshot") {
          return { ok: true, base64: PNG_1X1, width: 1280, height: 800, url: "http://localhost:8765/" };
        }
        if (cmd.action === "click") {
          return { ok: true, tag: "button", text: "Prendre RDV" };
        }
        return { ok: true };
      },
    },
    true,
  );

  let sawVisionImage = false;
  let step = 0;
  mock("main", (req) => {
    step++;
    if (req.messages.some((m) => Array.isArray(m.images) && m.images.some((u) => u.startsWith("data:image/png;base64,")))) {
      sawVisionImage = true;
    }
    if (step === 1) return reply("", [call("browser_open", { url: "http://localhost:8765/" })]);
    if (step === 2) return reply("", [call("browser_inspect", {}), call("browser_screenshot", { path: "qa-shot.png" })]);
    if (step === 3) return reply("", [call("browser_interact", { action: "click", selector: "#rdvBtn" })]);
    return reply("Visual QA passed with 0 broken images and clean layout.");
  });

  const chat = store.createChat(home, { title: "QA" });
  const turn = await h.chat(chat.id, "Preview http://localhost:8765/ and check the layout.");

  assert.deepEqual(seenActions, ["open", "inspect", "screenshot", "click"]);
  assert.equal(sawVisionImage, true, "screenshot must be attached to the next model step for visual QA");
  assert.ok(stateEvents.includes(true), "opening the browser notifies live SSE subscribers");
  assert.ok(existsSync(home.path("workspace", "qa-shot.png")), "screenshot PNG saved cleanly to workspace");
  assert.match(turn.content, /Visual QA passed/);
  await h.close();
});

test("Headless web_search uses MiniMax Coding Plan search and falls back to MiniMax-M3.1-Flash without touching Gemini", async () => {
  const seenUrls: string[] = [];
  const planFetch = (async (url: string) => {
    seenUrls.push(url);
    return new Response(
      JSON.stringify({
        organic: [
          { title: "Vitrerie Montard — Veauche", link: "https://annuaire-entreprises.data.gouv.fr/entreprise/montard", snippet: "Tel: 06 58 07 75 11, artisan vitrier." },
        ],
        related_searches: [{ query: "Vitrerie Montard avis" }],
        base_resp: { status_code: 0, status_msg: "success" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const res = await searchWebMiniMax("sk-cp-test", { query: "Vitrerie Montard Veauche", fetch: planFetch });
  assert.equal(seenUrls.length, 1);
  assert.match(seenUrls[0], /api\.minimax\.io\/v1\/coding_plan\/search/);
  assert.equal(res.via, "coding_plan");
  assert.equal(res.sources.length, 1);
  assert.match(res.sources[0].snippet ?? "", /06 58 07 75 11/);

  // Fallback to MiniMax-M3.1-Flash when coding_plan/search returns 403
  const fallbackUrls: string[] = [];
  const flashFetch = (async (url: string) => {
    fallbackUrls.push(url);
    if (url.includes("coding_plan/search")) return new Response("forbidden", { status: 403 });
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: "Vitrerie Montard in Veauche (42): 06 58 07 75 11.",
            citations: [{ title: "Annuaire", url: "https://annuaire-entreprises.data.gouv.fr/entreprise/montard" }],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const res2 = await searchWebMiniMax("sk-standard-test", { query: "Vitrerie Montard Veauche", fetch: flashFetch });
  assert.equal(res2.via, "minimax_flash");
  assert.match(fallbackUrls[1], /anthropic\/v1\/messages/);
  assert.match(res2.answer ?? "", /06 58 07 75 11/);
  assert.equal(res2.sources[0]?.url, "https://annuaire-entreprises.data.gouv.fr/entreprise/montard");
});

test("ask_user preserves streamed explanation text instead of overwriting it with the bare question", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false, scheduler: false });
  mock("main", () =>
    reply("Here is what I will do: I will update 15 Etsy listing tags using the official API, which respects Etsy TOS.", [
      call("ask_user", { question: "Given the above, shall I go ahead?", options: ["Go ahead now", "Cancel"] }),
    ]),
  );
  const chat = store.createChat(home, { title: "Etsy" });
  const turn = await h.chat(chat.id, "Explain what you will do and if it respects Etsy TOS");
  assert.equal(turn.stopReason, "question");
  assert.equal(turn.question?.question, "Given the above, shall I go ahead?");
  assert.match(turn.content, /respects Etsy TOS/, "explanation text before ask_user must be preserved");
  await h.close();
});

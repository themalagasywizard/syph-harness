import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isLocalUrl, normalizeBrowserUrl } from "../src/browser.ts";
import { browserOpenTool } from "../src/tools/browser.ts";
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

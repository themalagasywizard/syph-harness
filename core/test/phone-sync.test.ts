import assert from "node:assert/strict";
import { test } from "node:test";
import { store } from "../src/index.ts";
import { tempHome } from "./helpers.ts";

test("a chat made on the phone comes in once, and a repeated sync updates it", () => {
  const home = tempHome();
  const first = store.importPhoneChat(home, {
    phoneId: "phone-1",
    title: "Trip ideas",
    model: "openrouter:x/y",
    turns: [
      { role: "user", content: "Where should I go in May?", createdAt: "2026-11-20T10:00:00.000Z" },
      { role: "assistant", content: "Lisbon.", model: "openrouter:x/y" },
    ],
  });
  assert.equal(first.title, "Trip ideas");
  assert.equal(first.turns.length, 2);
  assert.deepEqual(first.history, [
    { role: "user", content: "Where should I go in May?" },
    { role: "assistant", content: "Lisbon." },
  ]);

  const again = store.importPhoneChat(home, {
    phoneId: "phone-1",
    title: "Trip ideas",
    turns: [
      { role: "user", content: "Where should I go in May?" },
      { role: "assistant", content: "Lisbon." },
      { role: "user", content: "And June?" },
      { role: "assistant", content: "Porto." },
    ],
  });
  assert.equal(again.id, first.id);
  assert.equal(store.getChat(home, first.id)!.turns.length, 4);
  assert.equal(store.listChats(home).filter((c) => c.phoneId === "phone-1").length, 1);
});

test("a phone chat with an unknown project or bad turns is still safe to import", () => {
  const home = tempHome();
  const c = store.importPhoneChat(home, { phoneId: "p2", projectId: "nope", turns: [{ role: "system" as any, content: "x" }, { role: "user", content: "hi" }] });
  assert.equal(c.projectId, undefined);
  assert.equal(c.turns.length, 1);
  assert.throws(() => store.importPhoneChat(home, { phoneId: " ", turns: [] }));
});

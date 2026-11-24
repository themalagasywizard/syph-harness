import { test } from "node:test";
import assert from "node:assert/strict";
import { miniMaxUsage, openRouterUsage, parseMiniMaxRemains, tightest } from "../src/providers/usage.ts";
import { tempHome } from "./helpers.ts";

const NOW = 1_800_000_000_000;

test("MiniMax remains: the 5-hour and weekly windows, with reset times in ms or s", () => {
  const meters = parseMiniMaxRemains(
    {
      model_remains: [
        { model_name: "speech-2.6", current_interval_total_count: 0, current_interval_usage_count: 0 },
        {
          model_name: "MiniMax-M3.1-Flash",
          current_interval_total_count: 1500,
          current_interval_usage_count: 255,
          remains_time: 3 * 3600 * 1000,
          current_weekly_total_count: 15000,
          current_weekly_usage_count: 4000,
          weekly_end_time: Math.floor(NOW / 1000) + 86400,
        },
      ],
      base_resp: { status_code: 0 },
    },
    "MiniMax-M3.1-Flash",
    NOW,
  );
  assert.deepEqual(meters, [
    { label: "5-hour window", used: 255, total: 1500, unit: "requests", resetsAt: NOW + 3 * 3600 * 1000 },
    { label: "Weekly", used: 4000, total: 15000, unit: "requests", resetsAt: NOW + 86400 * 1000 },
  ]);
  assert.equal(tightest(meters)?.label, "Weekly");
  assert.deepEqual(parseMiniMaxRemains({ data: { foo: 1 } }), [], "an unknown shape shows nothing");
});

test("MiniMax usage tries the documented endpoint and keeps the last answer", async () => {
  const home = tempHome();
  const seen: string[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    seen.push(url);
    assert.equal(init.headers.authorization, "Bearer sk-cp-x");
    if (!url.includes("token_plan")) return new Response("nope", { status: 404 });
    return Response.json({ model_remains: [{ current_interval_total_count: 100, current_interval_usage_count: 100, end_time: NOW }] });
  }) as typeof fetch;
  const u = await miniMaxUsage(home, { key: "sk-cp-x", baseUrl: "https://api.minimax.io/v1", fetch: fakeFetch });
  assert.equal(seen[0], "https://api.minimax.io/v1/api/openplatform/coding_plan/remains");
  assert.equal(seen[1], "https://api.minimax.io/v1/token_plan/remains");
  assert.equal(u.meters[0].used, 100);
  assert.equal(u.error, undefined);
});

test("OpenRouter usage: account credit and the key's own limit", async () => {
  const fakeFetch = (async (url: string) =>
    url.endsWith("/credits")
      ? Response.json({ data: { total_credits: 10, total_usage: 7.5 } })
      : Response.json({ data: { limit: 5, limit_remaining: 0.4, usage: 4.6 } })) as typeof fetch;
  const u = await openRouterUsage({ key: "sk-or-v1-x", fetch: fakeFetch });
  assert.deepEqual(u.meters.map((m) => [m.label, m.used, m.total]), [["Credits", 7.5, 10], ["Key limit", 4.6, 5]]);
  assert.equal(tightest(u.meters)?.label, "Key limit");
});

test("MiniMax remains: current plans report only a remaining percentage", () => {
  // Shape seen from a real MiniMax plan key (counts are 0, percentages carry the usage).
  const meters = parseMiniMaxRemains(
    {
      model_remains: [
        {
          start_time: NOW - 3600_000, end_time: NOW + 5836469, remains_time: 5836469,
          current_interval_total_count: 0, current_interval_usage_count: 0, model_name: "general",
          current_weekly_total_count: 0, current_weekly_usage_count: 0, weekly_end_time: NOW + 592636469, weekly_remains_time: 592636469,
          current_interval_status: 1, current_interval_remaining_percent: 26, current_weekly_status: 1, current_weekly_remaining_percent: 92,
        },
      ],
      base_resp: { status_code: 0, status_msg: "success" },
    },
    "MiniMax-M3.1-Flash",
    NOW,
  );
  assert.deepEqual(meters, [
    { label: "5-hour window", used: 74, total: 100, unit: "percent", resetsAt: NOW + 5836469 },
    { label: "Weekly", used: 8, total: 100, unit: "percent", resetsAt: NOW + 592636469 },
  ]);
});

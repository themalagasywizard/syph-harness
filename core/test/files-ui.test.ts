import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Harness } from "../src/harness.ts";
import { canAccess, preview } from "../src/files/index.ts";
import { checkUi, listUi, resetUi } from "../src/ui-ext.ts";
import * as store from "../src/store.ts";
import { call, mock, reply, tempHome } from "./helpers.ts";

const fixture = (n: string) => new URL(`./fixtures/${n}`, import.meta.url).pathname;

test("previews: PowerPoint slides with text, table, chart and picture; Word as HTML; Excel as sheets", () => {
  const deck: any = preview(fixture("deck.pptx"));
  assert.equal(deck.kind, "slides");
  assert.equal(deck.slides.length, 4);
  assert.ok(Math.abs(deck.width / deck.height - 16 / 9) < 0.01);
  const texts = JSON.stringify(deck.slides[0]);
  assert.ok(texts.includes("NEA Sales Pipeline Review"), "title placeholder text, positioned from the layout");
  const s2 = deck.slides[1].shapes;
  assert.ok(s2.some((s: any) => s.kind === "chart" && s.chart.type === "col" && s.chart.series.length === 2 && s.chart.categories[0] === "Lead"));
  assert.ok(s2.some((s: any) => s.kind === "table" && s.rows[1][0].paragraphs[0].runs[0].text === "Amina"));
  assert.ok(s2.some((s: any) => s.kind === "image" && s.src.startsWith("data:image/png")));
  assert.ok(s2.some((s: any) => s.fill === "#0b2e4f"), "solid fill colour");
  const bullets = deck.slides[2].shapes.flatMap((s: any) => s.paragraphs ?? []).filter((p: any) => p.bullet);
  assert.ok(bullets.length >= 3, "body placeholder paragraphs get the master's bullets");
  assert.equal(deck.slides[3].shapes.find((s: any) => s.kind === "chart").chart.type, "pie");

  const doc: any = preview(fixture("memo.docx"));
  assert.equal(doc.kind, "document");
  assert.match(doc.html, /<h1 class="title">Board memo<\/h1>/);
  assert.match(doc.html, /<b>18%<\/b>/);
  assert.match(doc.html, /<span class="mk">1\.<\/span>Second point/);
  assert.match(doc.html, /<img src="data:image\/png/);
  assert.ok(!/<script/i.test(doc.html));

  const xl: any = preview(fixture("sheet.xlsx"));
  assert.equal(xl.kind, "sheets");
  assert.deepEqual(xl.sheets[0].rows[1], ["Lead", "120", "140", "2026-11-01", "31%"]);
  assert.equal(xl.sheets[1].name, "Other");
});

test("a run's new and changed files are tracked with full paths, from write_file and from a script", async () => {
  const home = tempHome({ approval: { autoAccept: { memory: false, skill: false }, yolo: true } });
  const h = await new Harness(home).init({ mcp: false });
  const project = store.createProject(home, { name: "Board" });
  const chat = store.createChat(home, { projectId: project.id });
  const folder = store.workspaceFor(home, project.id);
  const script = process.platform === "win32" ? "Set-Content -Path reports/out.txt -Value hi" : "mkdir -p reports && printf hi > reports/out.txt";
  let step = 0;
  mock("main", () => {
    step++;
    if (step === 1) return reply("", [call("write_file", { path: "scripts/build.py", content: "print('hi')" })]);
    if (step === 2) return reply("", [call("shell", { command: script })]);
    if (step === 3) return reply("", [call("read_file", { path: "scripts/build.py" })]);
    return reply("Made reports/out.txt");
  });
  const events: any[] = [];
  const turn = await h.chat(chat.id, "make the report", { emit: (e) => events.push(e) });
  const paths = (turn.files ?? []).map((f) => f.path);
  // The helper script isn't a deliverable, so the answer shows only the report.
  assert.deepEqual(paths, [join(folder, "reports", "out.txt")]);
  assert.ok(turn.files!.every((f) => f.action === "created" && f.size > 0));
  assert.equal(turn.files!.find((f) => f.name === "out.txt")!.rel, "reports/out.txt");
  assert.equal(events.filter((e) => e.type === "files").length, 1, "one event per tool that wrote a deliverable");
  assert.equal(store.getChat(home, chat.id)!.turns.at(-1)!.files!.length, 1, "saved with the answer");
  assert.ok(canAccess(home, join(folder, "scripts", "build.py")), "hidden files can still be opened");
  assert.ok(canAccess(home, paths[0]));
  assert.equal(canAccess(home, home.path(".env")), false);
  assert.equal(canAccess(home, home.path("secrets", "connectors.json")), false);
  assert.equal(canAccess(home, "/etc/passwd"), false);
  await h.close();
});

const repoUi = {
  id: "github-repos",
  name: "Connect GitHub repo",
  description: "Pick a repo and clone it.",
  elements: [
    {
      id: "connect-repo",
      slot: "chat.composer",
      type: "button",
      label: "Connect repo",
      icon: "github",
      when: { connector: "gh" },
      action: {
        type: "picker",
        title: "Pick a repository",
        source: { connector: "gh", get: "https://api.github.com/user/repos?per_page=100", pages: 3 },
        label: "{full_name}",
        detail: "{owner.login}",
        then: { type: "clone_repo", connector: "gh", url: "{clone_url}", name: "{name}", hosts: ["github.com"], then: { type: "prompt", text: "Cloned {full_name} at {repo.path}" } },
      },
    },
  ],
};

test("interface changes are checked against the schema and the running app", () => {
  const env = { connectors: new Set(["gh"]), readTools: new Set(["list_files"]) };
  assert.deepEqual(checkUi(repoUi, env).errors, []);
  const bad = structuredClone(repoUi) as any;
  bad.elements[0].icon = "gitub";
  bad.elements[0].action.source.connector = "nope";
  bad.elements[0].action.then.then.text = "{repo.path} {missing}";
  assert.equal(checkUi(bad, env).errors.length, 2, "item fields are allowed after a picker; icon and connector are not");
  const early = { ...repoUi, elements: [{ id: "x", slot: "sidebar", type: "button", label: "X", action: { type: "prompt", text: "Hi {full_name}" } }] };
  assert.match(checkUi(early, env).errors.join(), /full_name/);
  const shell = { ...repoUi, elements: [{ id: "x", slot: "chat.header", type: "button", label: "X", action: { type: "picker", title: "t", source: { tool: "shell", input: { command: "rm -rf /" } }, label: "{line}", then: { type: "draft", text: "{line}" } } }] };
  assert.match(checkUi(shell, env).errors.join(), /changes things/);
  const unknownKey = { ...repoUi, elements: [{ ...repoUi.elements[0], onClick: "alert(1)" }] };
  assert.ok(checkUi(unknownKey, env).errors.length > 0, "unknown fields (such as code) are refused");
  const host = { ...repoUi, elements: [{ ...repoUi.elements[0], action: { ...repoUi.elements[0].action, source: { connector: "gh", get: "https://{host}/x" } } }] };
  assert.match(checkUi(host, env).errors.join(), /fixed host/);
});

async function fakeGitHub() {
  const seen: { url: string; auth: string }[] = [];
  let base = "";
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url!, auth: String(req.headers.authorization ?? "") });
    const page = new URL(req.url!, "http://x").searchParams.get("page") ?? "1";
    const items = page === "1" ? [{ name: "alpha", full_name: "ryan/alpha", clone_url: "https://github.com/ryan/alpha.git", owner: { login: "ryan" } }] : [{ name: "beta", full_name: "ryan/beta", clone_url: "https://evil.example/beta.git", owner: { login: "ryan" } }];
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (page === "1") headers.link = `<https://api.github.com/user/repos?per_page=100&page=2>; rel="next"`;
    res.writeHead(200, headers);
    res.end(JSON.stringify(items));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  return { base, seen, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

test("Syph proposes a Connect repo button; it appears only once approved, its list reads GitHub, and it can be undone", async () => {
  const gh = await fakeGitHub();
  process.env.SYPH_CONNECTOR_URL_MAP = JSON.stringify({ "https://api.github.com": gh.base });
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  await h.connectors.create({ id: "gh", name: "GitHub", description: "GitHub API", auth: "apiKey", code: 'export default (syph) => ({ tools: [syph.defineTool({ name: "me", description: "Who am I", permission: "auto", schema: syph.z.object({}), run: () => "ryan" })] })' });
  h.connectors.saveFields("gh", { apiKey: "ghp_secret" });
  await h.connectorsChanged();
  const chat = store.createChat(home, {});
  let step = 0;
  mock("main", (req) => {
    step++;
    if (step === 1) return reply("", [call("propose_ui_change", { spec: { ...repoUi, elements: [{ ...repoUi.elements[0], icon: "nope" }] }, reason: "Connect repos in one click" })]);
    if (step === 2) {
      assert.match(String(req.messages.at(-1)!.content), /failed its checks[\s\S]*icon/);
      return reply("", [call("propose_ui_change", { spec: repoUi, reason: "Connect repos in one click" })]);
    }
    return reply("I proposed a Connect repo button.");
  });
  const turn = await h.chat(chat.id, "add a button to connect my GitHub repos");
  const pid = /\((pr_\w+)\)/.exec(turn.toolCalls!.at(-1)!.result!)![1];
  assert.equal(listUi(home).length, 0, "nothing is live before approval");
  assert.ok(!h.tools().get("propose_ui_change")!.needsApproval, "the proposal itself is the approval step");

  await h.decide(pid, "accept");
  const items = listUi(home);
  assert.equal(items.length, 1);
  assert.equal(items[0].spec!.elements[0].label, "Connect repo");

  const { items: repos } = await h.uiSource("github-repos", "connect-repo", 0, {});
  assert.deepEqual(repos.map((r) => r.full_name), ["ryan/alpha", "ryan/beta"], "follows the next link");
  assert.equal(repos[0]["owner.login"], "ryan");
  assert.ok(gh.seen.every((s) => s.auth === "Bearer ghp_secret"), "read with the connector's key");
  // The clone step only reaches the hosts the approved button names, and only https.
  await assert.rejects(h.uiClone("github-repos", "connect-repo", 1, repos[1]), /Only https:\/\/ repositories on github\.com/);
  await assert.rejects(h.uiClone("github-repos", "connect-repo", 1, { ...repos[0], clone_url: "http://github.com/ryan/alpha.git" }), /Only https/);
  await assert.rejects(h.uiSource("github-repos", "connect-repo", 1, {}), /isn't a list/);
  await assert.rejects(h.uiSource("other", "connect-repo", 0, {}), /isn't installed/);

  // Switched off or in safe mode it isn't served; rollback removes it; reset clears everything.
  home.saveConfig({ ui: { disabled: ["github-repos"] } });
  await assert.rejects(h.uiSource("github-repos", "connect-repo", 0, {}), /isn't installed/);
  home.saveConfig({ ui: { disabled: [] } });
  await h.decide(pid, "rollback");
  assert.equal(listUi(home).length, 0);
  assert.equal(existsSync(home.path("ui", "github-repos.json")), false);
  home.write("ui/x.json", "{ not json");
  assert.equal(listUi(home)[0].error, "Not valid JSON.");
  const r = resetUi(home);
  assert.equal(r.moved, 1);
  assert.ok(existsSync(join(r.backup!, "x.json")), "reset keeps a backup");
  assert.equal(listUi(home).length, 0);
  delete process.env.SYPH_CONNECTOR_URL_MAP;
  await gh.close();
  await h.close();
});

test("the reflector can't touch the interface, and accepting re-checks it", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  const ctx = (h as any).toolContext("r1", { approve: async () => false, model: "mock:main" });
  const p = ctx.propose({ kind: "ui", title: "t", reason: "r", files: [{ path: "ui/a.json", content: JSON.stringify({ ...repoUi, id: "a" }) }], source: "agent" });
  // The connector it names doesn't exist (any more), so it can't go live.
  await assert.rejects(h.decide(p.id, "accept"), /no longer passes/);
  assert.equal(existsSync(home.path("ui", "a.json")), false);
  assert.ok(readFileSync(new URL("../src/evolve/engine.ts", import.meta.url), "utf8").includes('startsWith("ui/")'));
  await h.close();
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Harness } from "../src/harness.ts";
import { repoSlug } from "../src/connectors/github.ts";
import { gitEnv, parseRepo } from "../src/repos.ts";
import * as store from "../src/store.ts";
import type { AgentEvent } from "../src/types.ts";
import { call, mock, reply, tempHome } from "./helpers.ts";

// Commits in these tests must not pick up the machine's own git identity.
const gitHome = mkdtempSync(join(tmpdir(), "syph-git-"));
writeFileSync(join(gitHome, "gitconfig"), "[init]\n\tdefaultBranch = main\n");
process.env.GIT_CONFIG_GLOBAL = join(gitHome, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Seed", GIT_AUTHOR_EMAIL: "seed@x", GIT_COMMITTER_NAME: "Seed", GIT_COMMITTER_EMAIL: "seed@x" } }).trim();

/** A bare "remote" with one commit, and a clone of it linked to a project. */
function setupRepo(h: Harness) {
  const root = mkdtempSync(join(tmpdir(), "syph-remote-"));
  const bare = join(root, "origin.git");
  sh(root, "init", "--bare", "-b", "main", bare);
  const seed = join(root, "seed");
  sh(root, "clone", bare, seed);
  writeFileSync(join(seed, "README.md"), "# demo\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-m", "first");
  sh(seed, "push", "origin", "main");
  const project = store.createProject(h.home, { name: "Demo" });
  const dir = join(store.workspaceFor(h.home, project.id), "demo");
  sh(root, "clone", bare, dir);
  store.updateProject(h.home, project.id, { repos: [{ name: "demo", url: "https://github.com/me/demo", path: dir, connector: "github", connectedAt: new Date().toISOString() }] });
  return { bare, dir, project };
}

test("repo names: owner/name, GitHub URLs and SSH remotes all become a clone URL", () => {
  assert.equal(repoSlug("themalagasywizard/syph-harness"), "themalagasywizard/syph-harness");
  assert.equal(repoSlug("https://github.com/a/b.git"), "a/b");
  assert.equal(repoSlug("git@github.com:a/b.git"), "a/b");
  assert.equal(repoSlug("https://gitlab.com/a/b"), null);
  assert.deepEqual(parseRepo("a/b"), { url: "https://github.com/a/b", name: "b", github: true });
  assert.equal(parseRepo("https://gitlab.com/g/x.git").github, false);
  assert.throws(() => parseRepo("http://example.com/x"), /https/);
  // The token goes to github.com only, as a header in the environment, never in the command line.
  const env = gitEnv("tok123");
  const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
  assert.ok(pairs.some(([k, v]) => k === "http.https://github.com/.extraheader" && v === `AUTHORIZATION: basic ${Buffer.from("x-access-token:tok123").toString("base64")}`));
  assert.equal(gitEnv(null).GIT_CONFIG_COUNT, "0");
});

test("the agent plans, commits and pushes on its own; destructive git asks; unsafe options are refused", async () => {
  const home = tempHome();
  const h = await new Harness(home).init({ mcp: false });
  const { bare, dir, project } = setupRepo(h);
  const chat = store.createChat(home, { projectId: project.id });

  let step = 0;
  let sys = "";
  mock("main", (req) => {
    sys ||= req.messages[0].content ?? "";
    const plan = (s: string[]) => call("update_plan", { steps: ["Edit the README", "Commit", "Push to main"].map((text, i) => ({ text, status: s[i] })) });
    const script = [
      () => reply("", [plan(["in_progress", "pending", "pending"])]),
      () => reply("", [call("write_file", { path: "demo/README.md", content: "# demo\n\nUpdated by Syph.\n" })]),
      () => reply("", [plan(["done", "in_progress", "pending"]), call("git", { args: ["add", "-A"] })]),
      () => reply("", [call("git", { args: ["commit", "-m", "Update README"] })]),
      () => reply("", [call("git", { args: ["push", "origin", "main"] }), plan(["done", "done", "done"])]),
      () => reply("", [call("git", { args: ["push", "--force", "origin", "main"] })]),
      () => reply("", [call("git", { args: ["rebase", "-x", "echo hi", "main"] }), call("git", { args: ["config", "core.hooksPath", "/tmp/x"] }), call("list_repos", {})]),
      () => reply("Done: README updated and pushed to main."),
    ];
    return script[step++]();
  });

  const events: AgentEvent[] = [];
  const asked: string[] = [];
  const turn = await h.chat(chat.id, "Update the README and push it", { emit: (e) => events.push(e), approve: async (tool, _a, reason) => (asked.push(`${tool}: ${reason}`), false) });

  assert.match(sys, /# Repositories[\s\S]*demo \(active\)[\s\S]*branch main/);
  assert.match(sys, /update_plan/);
  assert.equal(turn.content, "Done: README updated and pushed to main.");
  const calls = turn.toolCalls!;
  const gitCalls = calls.filter((c) => c.name === "git");
  assert.ok(gitCalls.slice(0, 3).every((c) => c.ok), JSON.stringify(gitCalls.slice(0, 3)));
  // Pushed to the remote, with an author even though git has no identity set.
  assert.match(sh(bare, "log", "--format=%an <%ae> %s", "-1", "main"), /^Syph <syph@localhost> Update README$/);
  // Force-push asked (and was declined); program-running options and config writes were refused without asking.
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^git: .*force-push/);
  assert.match(gitCalls[3].result!, /declined/);
  assert.match(gitCalls[4].result!, /runs other programs/);
  assert.match(gitCalls[5].result!, /only reads config/);
  assert.match(calls.find((c) => c.name === "list_repos")!.result!, /demo \(active\)[\s\S]*branch main → origin\/main · 0 uncommitted · 0 ahead, 0 behind/);
  // The plan is a live event stream and is saved with the answer; git doesn't show up as "files made".
  const plans = events.filter((e) => e.type === "plan") as Extract<AgentEvent, { type: "plan" }>[];
  assert.equal(plans.length, 3);
  assert.deepEqual(turn.plan!.map((s) => s.status), ["done", "done", "done"]);
  assert.deepEqual(turn.files?.map((f) => f.rel), ["demo/README.md"]);
  assert.ok(turn.durationMs! >= 0);
  const saved = store.getChat(home, chat.id)!;
  assert.equal(saved.turns.at(-1)!.plan!.length, 3);

  // Status for the UI: branch, changes, ahead/behind; the chat's active repo.
  writeFileSync(join(dir, "new.txt"), "x");
  const [st] = await h.repoStatuses({ chatId: chat.id });
  assert.equal(st.branch, "main");
  assert.equal(st.dirty, 1);
  assert.equal(st.active, true);
  assert.equal(st.scope, "project");
  await h.close();
});

test("GitHub connector: built in, keeps the token from an older GitHub connector, finds the account and lists repos", async () => {
  const seen: { auth?: string; ua?: string }[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ auth: req.headers.authorization, ua: req.headers["user-agent"] });
    const url = new URL(req.url!, "http://x");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/gh/user") return res.end(JSON.stringify({ login: "octo", id: 7, name: "Octo Cat" }));
    if (url.pathname === "/gh/user/repos") {
      const page = Number(url.searchParams.get("page") ?? 1);
      if (page === 1) res.setHeader("link", '<https://api.github.com/user/repos?page=2>; rel="next"');
      const repo = (n: string) => ({ full_name: `octo/${n}`, name: n, owner: { login: "octo" }, private: n === "secret", default_branch: "main", html_url: `https://github.com/octo/${n}`, clone_url: `https://github.com/octo/${n}.git`, pushed_at: "2026-11-01T00:00:00Z" });
      return res.end(JSON.stringify(page === 1 ? [repo("alpha"), repo("secret")] : [repo("gamma")]));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  process.env.SYPH_CONNECTOR_URL_MAP = JSON.stringify({ "https://api.github.com": `http://localhost:${port}/gh` });
  try {
    const home = tempHome();
    // An older, agent-made "github" connector saved its token under another field name.
    mkdirSync(home.path("secrets"), { recursive: true });
    writeFileSync(home.path("secrets", "connectors.json"), JSON.stringify({ github: { fields: { token: "ghp_oldtoken" } } }));
    const h = await new Harness(home).init({ mcp: false });
    const gh = h.connectors.list().find((c) => c.id === "github")!;
    assert.equal(gh.builtin, true);
    assert.equal(gh.state, "ready");
    assert.equal(gh.account, "octo");
    assert.deepEqual(h.githubState(), { connected: true, account: "octo", state: "ready", error: undefined });
    assert.equal(await h.connectors.bearerToken("github"), "ghp_oldtoken");
    const repos = await h.githubRepos();
    assert.deepEqual(repos.map((r) => r.full_name), ["octo/alpha", "octo/secret", "octo/gamma"]);
    assert.ok(seen.every((s) => s.auth === "Bearer ghp_oldtoken" && s.ua === "Syph"));
    const names = h.tools().list().map((t) => t.name);
    for (const n of ["github_repos", "github_api", "github_pr_create", "github_clone", "git", "list_repos", "update_plan"]) assert.ok(names.includes(n), n);
    // DELETE on the API asks first; everything else is automatic.
    const api = h.tools().get("github_api")!;
    assert.equal(api.permission, "auto");
    assert.match(api.needsApproval!({ method: "DELETE", path: "/repos/octo/alpha" } as any, {} as any)!, /delete/);
    assert.equal(api.needsApproval!({ method: "POST", path: "/repos/octo/alpha/issues" } as any, {} as any), null);
    await h.close();
  } finally {
    delete process.env.SYPH_CONNECTOR_URL_MAP;
    server.closeAllConnections();
    server.close();
  }
});

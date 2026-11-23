import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { acceptProposal, commitUserChange, createProposal, getProposal, rollbackProposal } from "../src/evolve/proposals.ts";
import { reviewRun } from "../src/evolve/review.ts";
import { buildSystemPrompt } from "../src/context.ts";
import { auditSkills, listAllSkills, listSkills, readSkill, skillFile, skillInfos, skillProposal, skillSimilarity } from "../src/skills.ts";
import { listProposals } from "../src/evolve/proposals.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { builtinTools } from "../src/tools/builtin.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { mock, reply, tempHome } from "./helpers.ts";

const EDIT = skillFile("careful-edits", "Use when editing a file: read it first, make the edit, read it back to verify.", "1. Read the file with read_file.\n2. Make the edit with edit_file.\n3. Read the file back and check the edit landed.");
const EDIT_V2 = skillFile("verify-file-edits", "Use when editing files: read the file first, edit it, then read it back to verify the edit.", "1. Read the file with read_file before editing.\n2. Edit with edit_file.\n3. Read the file back to verify the change.");

const ctxFor = (home: ReturnType<typeof tempHome>): ToolContext => ({ home, workspace: home.path("workspace"), runId: "r", approve: async () => false, propose: (input) => createProposal(home, input), hooks: {} });

test("a switched-off skill leaves the prompt and read_skill, and comes back when switched on", async () => {
  const home = tempHome();
  commitUserChange(home, { kind: "skill", title: "add", reason: "r", files: [{ path: "skills/careful-edits/SKILL.md", content: EDIT }] });
  assert.ok(listSkills(home).some((s) => s.name === "careful-edits"));

  const off = commitUserChange(home, skillProposal(home, [{ action: "deactivate", name: "careful-edits" }], "r", "user"));
  assert.equal(off.status, "accepted");
  assert.ok(!listSkills(home).some((s) => s.name === "careful-edits"));
  assert.equal(listAllSkills(home).find((s) => s.name === "careful-edits")?.active, false);
  assert.equal(readSkill(home, "careful-edits"), null);
  assert.ok(!buildSystemPrompt(home, { model: "mock:main" } as any).includes("careful-edits"));
  const r = await new ToolRegistry(builtinTools).execute("read_skill", JSON.stringify({ name: "careful-edits" }), ctxFor(home));
  assert.match(r.result, /switched off/);

  commitUserChange(home, skillProposal(home, [{ action: "activate", name: "careful-edits" }], "r", "user"));
  assert.ok(readSkill(home, "careful-edits")?.includes("Read the file back"));
});

test("deleting a skill removes its folder and Undo (rollback) restores every file", () => {
  const home = tempHome();
  commitUserChange(home, { kind: "skill", title: "add", reason: "r", files: [{ path: "skills/careful-edits/SKILL.md", content: EDIT }, { path: "skills/careful-edits/notes.md", content: "extra" }] });
  const del = commitUserChange(home, skillProposal(home, [{ action: "delete", name: "careful-edits" }], "r", "user"));
  assert.equal(del.changes.length, 2);
  assert.equal(existsSync(home.path("skills/careful-edits")), false);
  rollbackProposal(home, del.id);
  assert.equal(home.read("skills/careful-edits/SKILL.md"), EDIT);
  assert.equal(home.read("skills/careful-edits/notes.md"), "extra");
});

test("editing keeps the name and can switch the skill off in the same step", () => {
  const home = tempHome();
  commitUserChange(home, { kind: "skill", title: "add", reason: "r", files: [{ path: "skills/careful-edits/SKILL.md", content: EDIT }] });
  commitUserChange(home, skillProposal(home, [{ action: "edit", name: "careful-edits", body: "1. New steps.", active: false }], "r", "user"));
  const s = listAllSkills(home).find((x) => x.name === "careful-edits")!;
  assert.equal(s.active, false);
  assert.match(home.read(s.path)!, /^---\nname: careful-edits\ndescription: Use when editing/);
  assert.match(home.read(s.path)!, /1\. New steps\./);
});

test("similar skills are flagged as duplicates; unrelated ones are not", () => {
  const home = tempHome();
  commitUserChange(home, { kind: "skill", title: "add", reason: "r", files: [{ path: "skills/careful-edits/SKILL.md", content: EDIT }, { path: "skills/verify-file-edits/SKILL.md", content: EDIT_V2 }] });
  const audit = auditSkills(home, skillInfos(home, listProposals(home)));
  assert.ok(audit.duplicates.some((d) => d.skills.includes("careful-edits") && d.skills.includes("verify-file-edits")), JSON.stringify(audit));
  assert.ok(!audit.duplicates.some((d) => d.skills.includes("summarise")));
  assert.ok(skillSimilarity({ name: "summarise", description: "Summarise a long text into bullets", body: "1. Read. 2. Bullets." }, { name: "careful-edits", description: "Use when editing a file", body: "read_file edit_file" }) < 0.2);
});

test("a reflector rewrite that duplicates an existing skill replaces it instead of stacking", () => {
  const home = tempHome();
  commitUserChange(home, { kind: "skill", title: "add", reason: "r", files: [{ path: "skills/careful-edits/SKILL.md", content: EDIT }] });
  const p = createProposal(home, { kind: "skill", title: "Add verify-file-edits", reason: "Edits failed.", files: [{ path: "skills/verify-file-edits/SKILL.md", content: EDIT_V2 }], source: "reflector" });
  assert.deepEqual(p.changes.map((c) => c.path), ["skills/careful-edits/SKILL.md"]);
  assert.match(p.reason, /instead of adding "verify-file-edits"/);
  acceptProposal(home, p.id);
  assert.equal(listAllSkills(home).filter((s) => /edit/.test(s.name)).length, 1);
  assert.match(home.read("skills/careful-edits/SKILL.md")!, /name: careful-edits/);
  // An agent asking by name is respected (it can merge with `replaces`).
  const a = createProposal(home, { kind: "skill", title: "x", reason: "r", files: [{ path: "skills/verify-file-edits/SKILL.md", content: EDIT_V2 }], source: "agent" });
  assert.equal(a.changes[0].path, "skills/verify-file-edits/SKILL.md");
});

test("agent tools: list_skills flags duplicates; propose_skill merges with replaces; propose_skill_changes batches", async () => {
  const home = tempHome();
  commitUserChange(home, { kind: "skill", title: "add", reason: "r", files: [{ path: "skills/careful-edits/SKILL.md", content: EDIT }, { path: "skills/verify-file-edits/SKILL.md", content: EDIT_V2 }] });
  const reg = new ToolRegistry(builtinTools);
  const ctx = ctxFor(home);
  const list = await reg.execute("list_skills", "{}", ctx);
  assert.match(list.result, /Likely duplicates/);
  assert.match(list.result, /careful-edits \+ verify-file-edits|verify-file-edits \+ careful-edits/);

  const merged = await reg.execute("propose_skill", JSON.stringify({ name: "careful-edits", description: "Use when editing a file.", body: "1. Read. 2. Edit. 3. Read back.", reason: "Two skills said the same thing.", replaces: ["verify-file-edits"] }), ctx);
  assert.match(merged.result, /Proposed merging/);
  const p = listProposals(home).find((x) => x.status === "pending")!;
  assert.equal(p.title, "Merge verify-file-edits into skill careful-edits");
  assert.ok(p.changes.some((c) => c.path === "skills/verify-file-edits/SKILL.md" && c.after === null));
  // Nothing changed before approval.
  assert.ok(home.exists("skills/verify-file-edits/SKILL.md"));
  acceptProposal(home, p.id);
  assert.ok(!home.exists("skills/verify-file-edits/SKILL.md"));

  const batch = await reg.execute("propose_skill_changes", JSON.stringify({ changes: [{ action: "deactivate", name: "careful-edits" }, { action: "delete", name: "summarise" }], reason: "Not useful." }), ctx);
  assert.match(batch.result, /Clean up skills careful-edits, summarise/);
  const bad = await reg.execute("propose_skill_changes", JSON.stringify({ changes: [{ action: "delete", name: "nope" }], reason: "x" }), ctx);
  assert.match(bad.result, /No skill named "nope"/);
});

test("read_skill counts uses for the Skills page and the audit", async () => {
  const home = tempHome();
  const reg = new ToolRegistry(builtinTools);
  await reg.execute("read_skill", JSON.stringify({ name: "summarise" }), ctxFor(home));
  await reg.execute("read_skill", JSON.stringify({ name: "summarise" }), ctxFor(home));
  const info = skillInfos(home, listProposals(home)).find((s) => s.name === "summarise")!;
  assert.equal(info.usage.uses, 2);
  assert.equal(info.createdBy, "default");
});

test("run review sees full skill text and may delete a skill its fix makes redundant", async () => {
  const home = tempHome();
  commitUserChange(home, { kind: "skill", title: "add", reason: "r", files: [{ path: "skills/careful-edits/SKILL.md", content: EDIT }, { path: "skills/old-edits/SKILL.md", content: skillFile("old-edits", "Never read files before editing them.", "1. Just write the whole file.") }] });
  let seen = "";
  mock("reflector", (req) => {
    seen = req.messages.map((m) => m.content).join("\n");
    return reply(JSON.stringify({ kind: "skill", title: "Fix edit skill", reason: "r", files: [{ path: "skills/careful-edits/SKILL.md", content: EDIT.replace("3.", "3. Always") }, { path: "skills/old-edits/SKILL.md", content: null }] }));
  });
  const turn = { id: "t", role: "assistant", content: "done", toolCalls: [1, 2, 3, 4].map(() => ({ name: "edit_file", ok: false, result: "old text not found" })) } as any;
  const { proposal } = await reviewRun(home, { model: "mock:main", runId: "r1", request: "edit it", turn });
  assert.match(seen, /Just write the whole file/);
  assert.match(seen, /rewrite THAT file/);
  assert.ok(proposal);
  assert.ok(proposal!.changes.some((c) => c.path === "skills/old-edits/SKILL.md" && c.after === null));
  assert.equal(getProposal(home, proposal!.id)!.status, "pending");
});

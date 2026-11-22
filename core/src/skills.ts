// Skills are folders with one SKILL.md. Only name + description enter the prompt; the body
// is loaded on demand with read_skill (progressive disclosure keeps context small).
import { existsSync, readdirSync } from "node:fs";
import type { Home } from "./home.ts";
import { parseFrontmatter } from "./util.ts";

export interface Skill {
  name: string;
  description: string;
  path: string;
}

export function listSkills(home: Home): Skill[] {
  const dir = home.path("skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const path = `skills/${d.name}/SKILL.md`;
      const src = home.read(path);
      if (!src) return [];
      const { meta } = parseFrontmatter(src);
      return [{ name: meta.name || d.name, description: meta.description || "", path }];
    });
}

export function readSkill(home: Home, name: string): string | null {
  const s = listSkills(home).find((x) => x.name === name || x.path === `skills/${name}/SKILL.md`);
  if (!s) return null;
  const { body } = parseFrontmatter(home.read(s.path) ?? "");
  const extra = home.list(`skills/${s.path.split("/")[1]}`).filter((p) => !p.endsWith("SKILL.md"));
  return body.trim() + (extra.length ? `\n\nFiles in this skill: ${extra.join(", ")}` : "");
}

export const skillFile = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n${body.trim()}\n`;

// Walls from the contract: paths a task may change, and paths it must never touch.
import type { Contract } from "./types.ts";

/** Simple globs: ** spans folders, * stays inside one, a trailing / means the whole folder. */
export function globToRegExp(glob: string) {
  const g = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "/**");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      re += ".*";
      i++;
      if (g[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]]/g, "\\$&");
  }
  return new RegExp(`^${re}(/.*)?$`);
}

/** Why a write to `rel` (workspace-relative) breaks the contract, or null when it is allowed. */
export function scopeViolation(c: Contract | undefined, rel: string): string | null {
  if (!c || c.draft) return null;
  const path = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  const hit = c.never.find((g) => globToRegExp(g).test(path));
  if (hit) return `Error: ${path} is off limits for this task (contract: never touch ${hit}). Change the contract with set_contract if the user agrees.`;
  if (c.scope.length && !c.scope.some((g) => globToRegExp(g).test(path))) return `Error: ${path} is outside this task's scope (${c.scope.join(", ")}). Stay in scope, or change the contract with set_contract if the user agrees.`;
  return null;
}

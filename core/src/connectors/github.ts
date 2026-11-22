// GitHub: the user's repositories, pull requests, issues and the whole REST API with one personal
// access token. Plain REST calls, no SDK. Working on code (clone, commit, pull, push) happens with
// the git tool in repos.ts, which signs in with the same token.
//
// Syph handles GitHub on its own: reading and writing are automatic, only deleting asks first.
import { truncate } from "../util.ts";
import type { BuiltinConnector } from "./index.ts";
import type { ConnectorRuntime } from "./types.ts";

export const GITHUB_API = "https://api.github.com";

const SETUP = `GitHub signs Syph in with a personal access token. It takes a minute, once.

1. Open [New token (classic)](https://github.com/settings/tokens/new?scopes=repo,workflow,read:org,read:user,user:email&description=Syph) on GitHub. The link ticks the scopes Syph needs: **repo**, **workflow**, **read:org**, **read:user** and **user:email**.
2. Pick an expiration (or *No expiration* for your own computer) and press **Generate token**.
3. Copy the token (it starts with \`ghp_\`) and paste it here.

A [fine-grained token](https://github.com/settings/personal-access-tokens/new) works too: give it the repositories you want and *Read and write* on Contents, Pull requests, Issues and Workflows.

The token stays on this computer in Syph's secrets folder. Git uses it only for github.com, and it is never written into a repository's settings.`;

export interface GithubRepo {
  full_name: string;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  default_branch: string;
  html_url: string;
  clone_url: string;
  pushed_at: string;
  fork: boolean;
  archived: boolean;
}

const repoRow = (r: any): GithubRepo => ({
  full_name: r.full_name,
  name: r.name,
  owner: r.owner?.login ?? "",
  private: !!r.private,
  description: r.description ?? "",
  default_branch: r.default_branch ?? "main",
  html_url: r.html_url,
  clone_url: r.clone_url,
  pushed_at: r.pushed_at ?? "",
  fork: !!r.fork,
  archived: !!r.archived,
});

/** The user's repositories (owned, collaborator and organisation), most recently pushed first. */
export async function listGithubRepos(g: ConnectorRuntime, opts: { query?: string; max?: number } = {}): Promise<GithubRepo[]> {
  const max = opts.max ?? 300;
  const out: GithubRepo[] = [];
  let url: string | null = `${GITHUB_API}/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member`;
  for (let page = 0; url && page < 10 && out.length < max; page++) {
    const res = await g.fetch(url);
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub answered ${res.status}: ${(() => { try { return JSON.parse(text).message; } catch { return text.slice(0, 200); } })()}`);
    out.push(...(JSON.parse(text) as any[]).map(repoRow));
    const next: string | null = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
    url = next && new URL(next).host === new URL(GITHUB_API).host ? next : null;
  }
  const q = opts.query?.trim().toLowerCase();
  return (q ? out.filter((r) => r.full_name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)) : out).slice(0, max);
}

/** "owner/name", a github.com URL or an SSH remote, as owner/name. */
export function repoSlug(input: string): string | null {
  const s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([\w.-]+)\/([\w.-]+)$/.exec(s);
  return m ? `${m[1]}/${m[2]}` : null;
}

export const github: BuiltinConnector = {
  manifest: {
    id: "github",
    name: "GitHub",
    description: "Your repositories: clone, commit, pull and push, pull requests, issues, Actions and the whole GitHub API.",
    icon: "github",
    auth: "apiKey",
    fields: [{ key: "apiKey", label: "Personal access token", secret: true, required: true, placeholder: "ghp_… or github_pat_…", help: "From GitHub → Settings → Developer settings → Personal access tokens." }],
    apiKeyAuth: { header: "Authorization", value: "Bearer {apiKey}" },
    accountUrl: `${GITHUB_API}/user`,
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "Syph" },
    setup: SETUP,
    createdBy: "syph",
  },
  factory: ({ z, defineTool }, g) => ({
    tools: [
      defineTool({
        name: "github_repos",
        description: "List the user's GitHub repositories (their own, collaborator and organisation ones), most recently pushed first. Optional query filters by name or description.",
        schema: z.object({ query: z.string().optional(), max: z.number().int().min(1).max(300).default(50) }),
        permission: "auto",
        run: async ({ query, max }) => {
          const repos = await listGithubRepos(g, { query, max });
          if (!repos.length) return query ? `No repositories match "${query}".` : "No repositories.";
          return repos.map((r) => `- ${r.full_name}${r.private ? " (private)" : ""}${r.archived ? " (archived)" : ""} · default branch ${r.default_branch} · pushed ${r.pushed_at.slice(0, 10)}${r.description ? `\n  ${r.description}` : ""}`).join("\n");
        },
      }),
      defineTool({
        name: "github_pr_create",
        description: "Open a pull request on GitHub. Push the branch first with the git tool. repo is owner/name.",
        schema: z.object({ repo: z.string(), head: z.string().describe("Branch with the changes"), base: z.string().optional().describe("Branch to merge into (default: the repo's default branch)"), title: z.string(), body: z.string().default(""), draft: z.boolean().default(false) }),
        permission: "auto",
        run: async ({ repo, head, base, title, body, draft }) => {
          const slug = repoSlug(repo);
          if (!slug) throw new Error(`Give repo as owner/name, not "${repo}".`);
          const target = base ?? (await g.json(`${GITHUB_API}/repos/${slug}`)).default_branch;
          const pr = await g.json(`${GITHUB_API}/repos/${slug}/pulls`, { method: "POST", body: { head, base: target, title, body, draft } });
          return `Opened pull request #${pr.number}: ${pr.html_url}`;
        },
      }),
      defineTool({
        name: "github_api",
        description: `Call any GitHub REST API endpoint as the user (https://docs.github.com/rest). path is relative to ${GITHUB_API}, e.g. "/repos/owner/name/issues?state=open", "/repos/owner/name/actions/runs?per_page=5", "/user". Use it for issues, comments, reviews, merges, releases, Actions, branches and anything else. DELETE asks the user first.`,
        schema: z.object({
          method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).default("GET"),
          path: z.string().describe("Starts with /"),
          body: z.any().optional().describe("JSON body for POST, PATCH and PUT"),
        }),
        permission: "auto",
        needsApproval: ({ method, path }) => (method === "DELETE" ? `Syph wants to delete on GitHub: DELETE ${path}` : null),
        run: async ({ method, path, body }) => {
          if (!path.startsWith("/") || path.startsWith("//")) throw new Error('path must start with "/", e.g. /user/repos');
          const res = await g.fetch(`${GITHUB_API}${path}`, {
            method,
            headers: body !== undefined ? { "content-type": "application/json" } : undefined,
            body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
          });
          const text = await res.text();
          const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
          let shown = text;
          try {
            shown = JSON.stringify(JSON.parse(text), null, 1);
          } catch {
            /* not JSON */
          }
          return `${res.status} ${res.statusText}${next ? `\nNext page: ${next.replace(GITHUB_API, "")}` : ""}\n${truncate(shown || "(no body)", 40_000)}`;
        },
      }),
    ],
  }),
};

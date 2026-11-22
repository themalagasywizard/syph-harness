// Tools that let the agent see its connectors and write new ones when the user asks for an app
// Syph can't reach yet. Creating one asks the user first; keys are then added on the Connectors page.
import { z } from "zod";
import { defineTool, type Tool } from "../tools/types.ts";
import type { Connectors } from "./index.ts";

const EXAMPLE = `export default (syph, connector) => ({
  tools: [
    syph.defineTool({
      name: "search_pages",               // becomes notion_search_pages
      description: "Search Notion pages by title.",
      permission: "auto",                  // "auto" to read, "ask" for anything that sends, creates or changes data
      schema: syph.z.object({ query: syph.z.string() }),
      run: async ({ query }) => {
        const r = await connector.json("https://api.notion.com/v1/search", {
          method: "POST",
          headers: { "Notion-Version": "2022-06-28" },
          body: { query },
        });
        return r.results.map((p) => "- " + p.id + " " + (p.url ?? "")).join("\\n") || "No pages.";
      },
    }),
  ],
});`;

export function connectorAgentTools(connectors: Connectors, onChange: () => void): Tool[] {
  const list = defineTool({
    name: "list_connectors",
    description: "List the app connectors (Google Workspace and any others), whether each is ready, and the tools each one gives you.",
    schema: z.object({}),
    permission: "auto",
    run: () =>
      connectors
        .list()
        .map((c) => {
          const state = !c.enabled ? "turned off" : c.state === "ready" ? `ready${c.account ? ` (${c.account})` : ""}` : c.state === "needs_setup" ? "needs keys from the user" : c.state === "needs_signin" ? "needs the user to sign in" : `error: ${c.error}`;
          return `- ${c.name} [${c.id}]: ${state}. ${c.description}${c.tools.length ? `\n  tools: ${c.tools.map((t) => t.name).join(", ")}` : ""}`;
        })
        .join("\n") || "No connectors yet.",
  });

  const create = defineTool({
    name: "create_connector",
    description: `Create a new connector so you can use an app or API Syph can't reach yet (Notion, GitHub, Slack, Airtable, a company API, ...). Use it when the user asks you to connect an app. The user approves it, then adds keys or signs in on the Connectors page.

- auth "apiKey": declare fields (default one secret field "apiKey") and apiKeyAuth, e.g. {"header":"Authorization","value":"Bearer {apiKey}"} or {"query":"key","value":"{apiKey}"}. Field values fill {placeholders}.
- auth "oauth2": give oauth.authUrl, oauth.tokenUrl, oauth.scopes. Client ID and secret fields are added for you; the user registers an OAuth app with redirect URI http://127.0.0.1 (any port) and pastes them.
- auth "none": public APIs.
- setup: short Markdown steps telling the user where to get the key (with links).
- code: TypeScript module, no imports. It receives syph ({ z, defineTool }) and connector ({ get(field), fetch(url, init), json(url, {method, headers, body}) }) where fetch/json already add the auth. Tool names get the connector id as a prefix. Example:
${EXAMPLE}`,
    schema: z.object({
      id: z.string().describe("snake_case, e.g. notion"),
      name: z.string(),
      description: z.string(),
      auth: z.enum(["none", "apiKey", "oauth2"]),
      fields: z.array(z.object({ key: z.string(), label: z.string(), secret: z.boolean().optional(), required: z.boolean().optional(), help: z.string().optional(), placeholder: z.string().optional() })).optional(),
      apiKeyAuth: z.object({ header: z.string().optional(), query: z.string().optional(), value: z.string() }).optional(),
      oauth: z.object({ authUrl: z.string(), tokenUrl: z.string(), scopes: z.array(z.string()), params: z.record(z.string(), z.string()).optional(), userInfoUrl: z.string().optional(), revokeUrl: z.string().optional() }).optional(),
      setup: z.string().optional(),
      code: z.string(),
    }),
    permission: "ask",
    run: async (input) => {
      const r = await connectors.create(input);
      onChange();
      const next = r.state === "ready" ? "It's ready to use now." : r.state === "needs_signin" ? "Ask the user to open Connectors and sign in." : "Ask the user to open Connectors and add the keys it needs.";
      return `Created connector ${r.manifest.name} [${r.manifest.id}] with tools: ${r.tools.join(", ")}. ${next} The tools appear in your next message after that.`;
    },
  });

  return [list, create];
}

/** A short section for the system prompt so the agent knows what it can reach. */
export function connectorPrompt(connectors: Connectors) {
  const items = connectors.list();
  const ready = items.filter((c) => c.enabled && c.state === "ready");
  const waiting = items.filter((c) => c.enabled && c.state !== "ready");
  const lines = ["# Connectors"];
  if (ready.length) lines.push(`Connected apps you can use through their tools: ${ready.map((c) => `${c.name}${c.account ? ` (${c.account})` : ""}`).join(", ")}.`);
  if (waiting.length) lines.push(`Not set up yet (the user must add keys or sign in on the Connectors page): ${waiting.map((c) => c.name).join(", ")}.`);
  lines.push("If the user wants an app you can't reach, offer to build a connector with create_connector.");
  return lines.join("\n");
}

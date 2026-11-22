// MCP client: each configured server's tools become Syph tools (permission "ask" by default).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { SyphConfig } from "./types.ts";
import type { Tool } from "./tools/types.ts";

export interface McpConnection {
  name: string;
  tools: Tool[];
  error?: string;
  close: () => Promise<void>;
}

export async function connectMcp(servers: SyphConfig["mcpServers"]): Promise<McpConnection[]> {
  return Promise.all(
    servers.map(async (s) => {
      const client = new Client({ name: "syph", version: "0.1.0" });
      try {
        const transport = new StdioClientTransport({ command: s.command, args: s.args ?? [], env: { ...(process.env as Record<string, string>), ...(s.env ?? {}) } });
        await client.connect(transport);
        const { tools } = await client.listTools();
        const wrapped: Tool[] = tools.map((t) => ({
          name: `${s.name}__${t.name}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64),
          description: `[${s.name}] ${t.description ?? ""}`.trim(),
          schema: z.any(),
          jsonSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
          permission: "ask",
          run: async (args: unknown) => {
            const res: any = await client.callTool({ name: t.name, arguments: (args ?? {}) as Record<string, unknown> });
            const text = (res.content ?? []).map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
            return res.isError ? `Error: ${text}` : text;
          },
        }));
        return { name: s.name, tools: wrapped, close: () => client.close() };
      } catch (e) {
        return { name: s.name, tools: [], error: (e as Error).message, close: async () => {} };
      }
    }),
  );
}

import { z } from "zod";
import type { ToolSpec } from "../providers/llm.ts";
import { truncate } from "../util.ts";
import type { Permission, Tool, ToolContext } from "./types.ts";

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private overrides: Record<string, Permission> = {};

  constructor(tools: Tool[] = [], overrides: Record<string, Permission> = {}) {
    for (const t of tools) this.add(t);
    this.overrides = overrides;
  }

  add(t: Tool) {
    this.tools.set(t.name, t);
    return this;
  }

  remove(name: string) {
    this.tools.delete(name);
  }

  get(name: string) {
    return this.tools.get(name);
  }

  list() {
    return [...this.tools.values()];
  }

  permissionOf(t: Tool): Permission {
    return this.overrides[t.name] ?? t.permission;
  }

  /** Subset by name, e.g. for sub-agents or evals. */
  pick(names: string[]) {
    return new ToolRegistry(this.list().filter((t) => names.includes(t.name)), this.overrides);
  }

  specs(): ToolSpec[] {
    return this.list()
      .filter((t) => this.permissionOf(t) !== "deny")
      .map((t) => {
        const schema = (t.jsonSchema ? { ...t.jsonSchema } : z.toJSONSchema(t.schema, { io: "input" })) as Record<string, unknown>;
        delete schema.$schema;
        return { name: t.name, description: t.description, parameters: schema };
      });
  }

  /** Validate, check permission, run. Errors come back as text so the model can recover. */
  async execute(name: string, rawArgs: string, ctx: ToolContext): Promise<{ ok: boolean; result: string; args: unknown }> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, result: `Error: unknown tool "${name}". Available: ${this.list().map((t) => t.name).join(", ")}`, args: rawArgs };
    let parsedJson: unknown;
    try {
      parsedJson = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch (e) {
      return { ok: false, result: `Error: arguments are not valid JSON (${(e as Error).message}). Send a JSON object matching the tool's parameters.`, args: rawArgs };
    }
    const parsed = tool.schema.safeParse(parsedJson);
    if (!parsed.success) {
      return { ok: false, result: `Error: invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, args: parsedJson };
    }
    const args = parsed.data;
    const perm = this.permissionOf(tool);
    if (perm === "deny") return { ok: false, result: `Error: the tool ${name} is disabled.`, args };
    const reason = perm === "ask" ? `Syph wants to run ${name}.` : tool.needsApproval?.(args, ctx) ?? null;
    if (reason && !(await ctx.approve(name, args, reason))) return { ok: false, result: "The user declined this action. Do not retry it; continue without it or ask what they prefer.", args };
    try {
      return { ok: true, result: truncate(String(await tool.run(args, ctx)), 60_000), args };
    } catch (e) {
      return { ok: false, result: `Error: ${(e as Error).message}`, args };
    }
  }
}

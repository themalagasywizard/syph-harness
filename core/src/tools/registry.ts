import { z } from "zod";
import type { ToolSpec } from "../providers/llm.ts";
import { truncate } from "../util.ts";
import type { Permission, Tool, ToolContext } from "./types.ts";

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private overrides: Record<string, Permission> = {};
  /** Tools left out of the specs until a chat loads them (connector and MCP tools). */
  private lazy = new Set<string>();

  constructor(tools: Tool[] = [], overrides: Record<string, Permission> = {}, lazy: Iterable<string> = []) {
    for (const t of tools) this.add(t);
    this.overrides = overrides;
    this.lazy = new Set(lazy);
  }

  /** Tools that are hidden until loaded, and not yet loaded in `ctx`. */
  hidden(ctx?: Pick<ToolContext, "loadedTools">) {
    return this.list().filter((t) => this.lazy.has(t.name) && !ctx?.loadedTools?.has(t.name) && this.permissionOf(t) !== "deny");
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
    return new ToolRegistry(this.list().filter((t) => names.includes(t.name)), this.overrides, this.lazy);
  }

  /** What the model is shown. Lazy tools appear once the chat has loaded them. */
  specs(ctx?: Pick<ToolContext, "loadedTools">): ToolSpec[] {
    const hidden = new Set(this.hidden(ctx).map((t) => t.name));
    return this.list()
      .filter((t) => this.permissionOf(t) !== "deny" && !hidden.has(t.name))
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
    let reason: string | null;
    try {
      reason = perm === "ask" ? (tool.needsApproval?.(args, ctx) ?? `Syph wants to run ${name}.`) : (tool.needsApproval?.(args, ctx) ?? null);
    } catch (e) {
      return { ok: false, result: `Error: ${(e as Error).message}`, args };
    }
    if (reason && !(await ctx.approve(name, args, reason))) return { ok: false, result: "The user declined this action. Do not retry it; continue without it or ask what they prefer.", args };
    try {
      const result = truncate(String(await tool.run(args, ctx)), 40_000);
      // Loud failure: a tool that reports an error is a failed call, so the loop and the UI see it.
      return { ok: !/^Error\b/.test(result), result, args };
    } catch (e) {
      return { ok: false, result: `Error: ${(e as Error).message}`, args };
    }
  }
}

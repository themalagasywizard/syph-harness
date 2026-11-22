// The agent's plan for a multi-step task, shown to the user as a checklist that updates live.
import { z } from "zod";
import { defineTool } from "./tools/types.ts";

export const updatePlanTool = defineTool({
  name: "update_plan",
  description:
    "Show the user your plan for a task with several steps, as a checklist in the chat. Call it before you start (all steps pending, the first in_progress), then again each time a step finishes or starts, sending the whole list every time. Keep steps short (under 10 words), in the order you'll do them, and only one in_progress. Skip it for quick questions and one-step tasks.",
  schema: z.object({
    steps: z
      .array(z.object({ text: z.string().min(1).max(200), status: z.enum(["pending", "in_progress", "done"]).default("pending") }))
      .min(1)
      .max(30),
  }),
  permission: "auto",
  run: ({ steps }, ctx) => {
    ctx.hooks.plan?.(steps);
    const done = steps.filter((s) => s.status === "done").length;
    const next = steps.find((s) => s.status === "in_progress") ?? steps.find((s) => s.status === "pending");
    return done === steps.length ? "Plan updated: every step is done." : `Plan updated: ${done}/${steps.length} done.${next ? ` Now: ${next.text}` : ""}`;
  },
});

export const planPrompt =
  "# Plans\nFor a task with three or more steps (building, fixing or researching something), call update_plan first with the steps, then update it as you go so the user sees a live checklist. Mark each step done as soon as it is, and finish with every step done (or say which you couldn't do).";

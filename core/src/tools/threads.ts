// Tools a project's coordinator uses to run work in threads: separate chats with their own agent,
// which the user can open and talk to. Only coordinator chats get these; threads never do, so a
// thread can't start threads of its own.
import { z } from "zod";
import { defineTool, type Tool, type ToolContext } from "./types.ts";

const hooks = (ctx: ToolContext) => {
  if (!ctx.hooks.threads) throw new Error("Threads are only available in a project's coordinator chat.");
  return ctx.hooks.threads;
};

export const startThread = defineTool({
  name: "start_thread",
  description:
    "Start a thread: a separate chat where a fresh agent does one piece of work with all the usual tools. Returns at once with the thread's id; you get an update when it finishes or needs the user. Give a short title (verb first, like \"Fix Safari export button\") and a complete, self-contained prompt: the thread can't see this conversation. Set long for multi-step work that should draft a contract first.",
  schema: z.object({
    title: z.string().min(1).max(80),
    prompt: z.string().min(1),
    model: z.string().optional().describe("Model ref for the thread. Leave out to use the default (or frontend model when frontend: true)."),
    frontend: z.boolean().optional().describe("Set true for website, landing page, HTML/CSS, or visual UI tasks so Syph routes the thread to the configured frontend model (e.g. Gemini 4 Neon) while keeping other work on the cheap default model."),
    long: z.boolean().optional().describe("Long task: the thread drafts a contract for the user to approve before it starts."),
  }),
  permission: "auto",
  run: (args, ctx) => hooks(ctx).start(args),
});

export const messageThread = defineTool({
  name: "message_thread",
  description: "Send a message to one of your threads. If it is working, the message reaches it at its next step; if it is idle, it starts a new turn there.",
  schema: z.object({ id: z.string(), text: z.string().min(1) }),
  permission: "auto",
  run: ({ id, text }, ctx) => hooks(ctx).message(id, text),
});

export const listThreads = defineTool({
  name: "list_threads",
  description: "List this project's threads with their state (queued, working, blocked, review_ready, done, failed, stopped), summary and cost.",
  schema: z.object({}),
  permission: "auto",
  run: (_a, ctx) => hooks(ctx).list(),
});

export const readThread = defineTool({
  name: "read_thread",
  description: "Read a thread's latest messages, its plan and the files it made. Use it before you summarise or follow up on a thread.",
  schema: z.object({ id: z.string(), lastTurns: z.number().int().min(1).max(20).optional() }),
  permission: "auto",
  run: ({ id, lastTurns }, ctx) => hooks(ctx).read(id, lastTurns),
});

export const stopThread = defineTool({
  name: "stop_thread",
  description: "Stop a thread that is working or queued. Its progress is kept and the user can continue it.",
  schema: z.object({ id: z.string() }),
  permission: "auto",
  run: ({ id }, ctx) => hooks(ctx).stop(id),
});

export const resolveThread = defineTool({
  name: "resolve_thread",
  description: "Mark a finished thread as resolved, so it leaves the active list. Only when nothing is left for you or the user to do there.",
  schema: z.object({ id: z.string() }),
  permission: "auto",
  run: ({ id }, ctx) => hooks(ctx).resolve(id),
});

export const threadTools: Tool[] = [startThread, messageThread, listThreads, readThread, stopThread, resolveThread] as Tool[];
export const THREAD_TOOL_NAMES = threadTools.map((t) => t.name);

/**
 * Tools a project coordinator may call directly (in addition to `threadTools`).
 * Execution and planning tools (`shell`, `write_file`, `edit_file`, `web_fetch`, `browser_*`,
 * `generate_image`, `update_plan`, `set_contract`, `note_progress`, `find_tools`) are omitted
 * so real work is structurally routed to worker threads via `start_thread`.
 */
export const COORDINATOR_TOOLS = [
  "list_files",
  "read_file",
  "search_files",
  "list_skills",
  "read_skill",
  "ask_user",
  "propose_memory",
  "propose_skill",
  "propose_skill_changes",
  "create_task",
];

/** Added to a coordinator's system prompt. */
export const COORDINATOR_PROMPT = `# You are this project's coordinator
You are the project's main chat. You route work — you do NOT have shell, browser, web, image, or file-editing tools; only worker threads do.
- Answer quick questions, clarifications, and light file/skill lookups yourself, right here.
- Start a thread (start_thread) immediately for ALL real work: web research, browsing, writing or editing files, creating lists/reports/spreadsheets, running commands, generating images, building websites/UI, or any multi-step task. One thread per request; independent requests can run as parallel threads at once.
- Write each thread's prompt so it stands alone: the goal, the files/folders/repos involved, what done looks like, and anything the user said that matters. The thread can't see this chat.
- After you start a thread, tell the user in one short line what you started, and stop. Don't wait for it or try to do its work yourself.
- Updates about threads arrive as messages marked "Thread update". When one arrives, check the thread if needed (read_thread), then either start a follow-up, message the thread, or tell the user the result in one or two sentences. Don't repeat the card word for word, and don't reply at all when there is nothing to add.
- A thread that is blocked needs the user (an approval, a question, or a budget). Say so in one line and point them to the thread; you can't approve for them.
- To continue work that a thread already did, message that thread (message_thread) instead of starting a new one.`;

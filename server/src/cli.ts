#!/usr/bin/env -S npx tsx
// syph serve | chat "<message>" | eval [model] | evolve [model] | export | home
import { Harness, store } from "@syph/core";
import { createApp } from "./server.ts";
import { loadAppEnv } from "./env.ts";

loadAppEnv();

const [cmd = "serve", ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};

const homeDir = flag("home");
const port = Number(flag("port") ?? process.env.SYPH_PORT ?? 7337);

async function main() {
  const h = await new Harness(homeDir).init({ scheduler: cmd === "serve" });
  switch (cmd) {
    case "serve": {
      const server = createApp(h);
      server.listen(port, "127.0.0.1", () => console.log(`Syph is running at http://localhost:${port}  (home: ${h.home.root})`));
      const stop = async () => {
        await h.close();
        server.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "chat": {
      const model = flag("model");
      const chat = store.createChat(h.home, { title: "CLI" });
      await h.chat(chat.id, args.join(" "), {
        model,
        emit: (e) => {
          if (e.type === "token") process.stdout.write(e.text);
          if (e.type === "tool_call") process.stdout.write(`\n[${e.name} ${JSON.stringify(e.args)}]\n`);
          if (e.type === "note") process.stdout.write(`\n(${e.text})\n`);
          if (e.type === "approval_request") {
            process.stdout.write(`\n[declined ${e.tool}: approve tools in the app]\n`);
            h.resolveApproval(e.id, false);
          }
          if (e.type === "run_end") process.stdout.write(`\n\n— ${e.usage.promptTokens}+${e.usage.completionTokens} tokens, $${e.usage.costUsd.toFixed(5)}\n`);
        },
      });
      break;
    }
    case "eval":
    case "evolve": {
      const job = cmd === "eval" ? h.runEvals(args[0], Number(flag("samples") ?? 1)) : h.evolve(args[0]);
      let shown = 0;
      await new Promise<void>((done) => {
        const off = h.on((e) => {
          if (e.type !== "job" || e.job.id !== job.id) return;
          for (; shown < e.job.log.length; shown++) console.log(e.job.log[shown]);
          if (e.job.status !== "running") {
            off();
            done();
          }
        });
      });
      break;
    }
    case "export":
      console.log(h.exportDatasets());
      break;
    case "home":
      console.log(h.home.root);
      break;
    default:
      console.log("Usage: syph [serve|chat <text>|eval [model]|evolve [model]|export|home] [--home <dir>] [--port <n>] [--model <ref>]");
  }
  await h.close();
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});

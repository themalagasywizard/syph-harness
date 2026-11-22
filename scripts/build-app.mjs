// Bundles the server into one file and gathers what the packaged desktop app needs:
//   desktop/app/server.mjs   the server and harness (no tsx or node_modules needed)
//   desktop/app/defaults/    first-run contents of the home folder
//   desktop/app/ui/          the built UI
// Run `npm run build -w ui` first (npm run dist does both).
import { build } from "esbuild";
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "desktop/app");
if (!existsSync(resolve(root, "ui/dist/index.html"))) throw new Error("Build the UI first: npm run build -w ui");
rmSync(out, { recursive: true, force: true });

await build({
  entryPoints: [resolve(root, "server/src/cli.ts")],
  outfile: resolve(out, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // esbuild is optional at runtime: extensions fall back to Node's built-in type stripping.
  external: ["esbuild"],
  banner: { js: 'import { createRequire as __syphRequire } from "node:module"; const require = __syphRequire(import.meta.url);' },
  legalComments: "none",
  logLevel: "warning",
});
cpSync(resolve(root, "core/defaults"), resolve(out, "defaults"), { recursive: true });
cpSync(resolve(root, "ui/dist"), resolve(out, "ui"), { recursive: true });
console.log("Packaged app files written to desktop/app");

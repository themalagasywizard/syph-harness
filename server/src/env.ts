import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load keys from a .env next to the app (the folder you cloned Syph into), so a key
 * dropped there works without opening Settings. Windows often saves it as ".env.txt",
 * so that name is read too. A bare OpenRouter key on its own line is accepted.
 * Values already in the environment win. The home folder's .env is read separately.
 */
export function loadAppEnv(root = process.env.SYPH_APP_DIR ?? resolve(fileURLToPath(import.meta.url), "../../..")) {
  for (const name of [".env", ".env.txt"]) {
    const file = resolve(root, name);
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      const [key, value] = m ? [m[1], m[2].replace(/^["']|["']$/g, "")] : line.startsWith("sk-or-") ? ["OPENROUTER_API_KEY", line] : [];
      if (key && value && !process.env[key]) process.env[key] = value;
    }
  }
}

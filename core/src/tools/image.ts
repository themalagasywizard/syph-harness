// Generate bespoke studio imagery using Google AI Studio's Gemini / Imagen API (uses GEMINI_API_KEY).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { z } from "zod";
import { resolvePath } from "./builtin.ts";
import { defineTool } from "./types.ts";
import { recordGeminiUsage } from "../providers/usage.ts";

/** Estimated USD cost per generated image (Imagen 3 / Gemini image tier) for the $10/month credit meter. */
export const IMAGE_GEN_COST_USD = 0.03;

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

type FetchFn = typeof fetch;

export async function generateGeminiImage(
  key: string,
  opts: { prompt: string; aspectRatio?: string; mimeType?: string; fetch?: FetchFn; signal?: AbortSignal },
): Promise<{ bytes: Buffer; mimeType: string; model: string }> {
  const f = opts.fetch ?? fetch;
  const aspectRatio = opts.aspectRatio ?? "4:3";
  const wantedMime = opts.mimeType ?? "image/jpeg";

  // 1) Try Imagen 3 (fast, studio-clean commercial photography)
  const imagenUrl = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${encodeURIComponent(key)}`;
  const r1 = await f(imagenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instances: [{ prompt: opts.prompt }],
      parameters: { sampleCount: 1, aspectRatio, outputOptions: { mimeType: wantedMime } },
    }),
    signal: opts.signal ?? AbortSignal.timeout(45_000),
  }).catch(() => null);

  if (r1?.ok) {
    const j: any = await r1.json().catch(() => null);
    const b64 = j?.predictions?.[0]?.bytesBase64Encoded;
    if (typeof b64 === "string" && b64.length > 0) {
      return { bytes: Buffer.from(b64, "base64"), mimeType: j?.predictions?.[0]?.mimeType ?? wantedMime, model: "imagen-3.0-generate-002" };
    }
  }

  // 2) Fallback: Gemini native image generation (gemini-2.5-flash-image)
  const flashUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(key)}`;
  const r2 = await f(flashUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${opts.prompt}\nAspect ratio: ${aspectRatio}. Photorealistic commercial studio quality, no text or watermarks.` }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
    signal: opts.signal ?? AbortSignal.timeout(60_000),
  });

  if (!r2.ok) {
    const errText = await r2.text().catch(() => "");
    throw new Error(`Google image generation failed (${r2.status}): ${errText.slice(0, 300)}`);
  }
  const j2: any = await r2.json().catch(() => null);
  const parts: any[] = j2?.candidates?.[0]?.content?.parts ?? [];
  const inline = parts.find((p) => p?.inlineData?.data)?.inlineData;
  if (!inline?.data) throw new Error("Google image generation returned no image data.");
  return { bytes: Buffer.from(inline.data, "base64"), mimeType: inline.mimeType ?? "image/png", model: "gemini-2.5-flash-image" };
}

export const generateImageTool = defineTool({
  name: "generate_image",
  description:
    "Generate a photorealistic studio image with Google Gemini/Imagen (uses GEMINI_API_KEY) and save it directly to a file in the workspace or a writable linked folder. Keep to 3-5 purposeful images per website to stay token- and credit-efficient. Never ask for small UI text inside images.",
  schema: z.object({
    path: z.string().min(1).describe("Output file path (e.g. assets/img/hero-bg.jpg or full path in a writable linked folder)."),
    prompt: z.string().min(10).describe("Art-directed photography prompt (subject, lighting, backdrop, composition, no text/logos/watermarks)."),
    aspectRatio: z.enum(["16:9", "4:3", "1:1", "3:4", "9:16"]).default("4:3").describe("16:9 for hero banners, 4:3 for feature/product cards, 1:1 for avatars/icons."),
  }),
  permission: "auto",
  run: async ({ path, prompt, aspectRatio }, ctx) => {
    const key = ctx.home.env("GEMINI_API_KEY");
    if (!key) return "Error: No GEMINI_API_KEY set. Add your Google Gemini API key in Settings → Model providers to generate images.";
    const abs = resolvePath(ctx, path, "write");
    const mimeType = MIME_BY_EXT[extname(abs).toLowerCase()] ?? "image/jpeg";
    const img = await generateGeminiImage(key, { prompt, aspectRatio, mimeType, signal: ctx.signal });
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, img.bytes);
    recordGeminiUsage(ctx.home, { costUsd: IMAGE_GEN_COST_USD, images: 1 });
    const kb = Math.max(1, Math.round(img.bytes.length / 1024));
    return `Saved ${aspectRatio} image (${kb} KB, ${img.model}, ~$${IMAGE_GEN_COST_USD.toFixed(2)}) to ${path}`;
  },
});

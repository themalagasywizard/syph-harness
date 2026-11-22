// Previews of Office files without Office: PowerPoint slides are laid out from their XML (text,
// shapes, pictures, tables and charts), Word documents become simple HTML, Excel sheets become
// tables. Good enough to check what Syph made before opening it in the real app.
import { posix } from "node:path";
import { readZip, type ZipEntry } from "./zip.ts";
import { child, children, decode, find, findAll, parseXml, path, textOf, type XNode } from "./xml.ts";

// ---------- Shared shapes of a preview ----------

export interface Run {
  text: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  font?: string;
}

export interface Para {
  runs: Run[];
  align?: "l" | "ctr" | "r" | "just";
  bullet?: string;
  level?: number;
}

export interface TableCell {
  paragraphs: Para[];
  fill?: string;
  span?: number;
}

export interface Chart {
  type: "bar" | "col" | "line" | "pie" | "doughnut" | "area" | "scatter";
  title?: string;
  stacked?: boolean;
  categories: string[];
  series: { name: string; values: number[]; color?: string }[];
  /** Theme accent colours, for series and pie slices without their own. */
  palette: string[];
}

export interface SlideShape {
  kind: "shape" | "image" | "table" | "chart";
  /** Position and size as fractions of the slide. */
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
  geom?: string;
  fill?: string;
  line?: string;
  /** Line width as a fraction of the slide width. */
  lineWidth?: number;
  anchor?: "t" | "ctr" | "b";
  paragraphs?: Para[];
  /** Text inset as fractions of the slide width (left, top, right, bottom). */
  inset?: [number, number, number, number];
  src?: string;
  rows?: TableCell[][];
  cols?: number[];
  /** Table style hints: a coloured header row and banded rows, in this accent colour. */
  header?: boolean;
  banded?: boolean;
  accent?: string;
  chart?: Chart;
  vertical?: boolean;
}

export interface Slide {
  background?: string;
  backgroundImage?: string;
  shapes: SlideShape[];
  notes?: string;
}

export interface SlidesPreview {
  kind: "slides";
  /** Slide size in points (1/72 inch). */
  width: number;
  height: number;
  slides: Slide[];
  truncated?: boolean;
}

export interface SheetPreview {
  name: string;
  rows: string[][];
  truncated?: boolean;
}

const EMU_PER_PT = 12700;
const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".bmp": "image/bmp" };

class Pkg {
  private zip: Map<string, ZipEntry>;
  private cache = new Map<string, XNode | null>();
  imageBudget = 40 * 1024 * 1024;
  constructor(buf: Buffer) {
    this.zip = readZip(buf);
  }
  has(name: string) {
    return this.zip.has(name);
  }
  xml(name: string): XNode | null {
    if (!this.cache.has(name)) {
      const e = this.zip.get(name);
      this.cache.set(name, e ? parseXml(e.read().toString("utf8")) : null);
    }
    return this.cache.get(name)!;
  }
  /** Relationship id → absolute part name, for the part `name`. */
  rels(name: string): Record<string, { target: string; type: string; external: boolean }> {
    const dir = posix.dirname(name);
    const relsName = posix.join(dir, "_rels", posix.basename(name) + ".rels");
    const x = this.xml(relsName);
    const out: Record<string, { target: string; type: string; external: boolean }> = {};
    for (const r of findAll(x ?? undefined, "Relationship")) {
      const external = r.attrs.TargetMode === "External";
      const t = r.attrs.Target ?? "";
      out[r.attrs.Id] = { target: external ? t : t.startsWith("/") ? t.slice(1) : posix.normalize(posix.join(dir, t)), type: r.attrs.Type ?? "", external };
    }
    return out;
  }
  dataUrl(name: string): string | undefined {
    const e = this.zip.get(name);
    const mime = IMAGE_MIME[posix.extname(name).toLowerCase()];
    if (!e || !mime || e.size > 12 * 1024 * 1024 || e.size > this.imageBudget) return undefined;
    this.imageBudget -= e.size;
    return `data:${mime};base64,${e.read().toString("base64")}`;
  }
}

// ---------- Colours ----------

type Theme = Record<string, string>;

function themeColors(x: XNode | null): Theme {
  const scheme = find(x ?? undefined, "a:clrScheme");
  const out: Theme = {};
  for (const c of scheme?.children ?? []) {
    const key = c.name.replace(/^a:/, "");
    const v = child(c, "a:srgbClr")?.attrs.val ?? child(c, "a:sysClr")?.attrs.lastClr;
    if (v) out[key] = v;
  }
  out.tx1 ??= out.dk1 ?? "000000";
  out.bg1 ??= out.lt1 ?? "FFFFFF";
  out.tx2 ??= out.dk2 ?? "44546A";
  out.bg2 ??= out.lt2 ?? "E7E6E6";
  return out;
}

const PRESET: Record<string, string> = { black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", gray: "808080", grey: "808080", orange: "FFA500" };

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToHex(h: number, s: number, l: number) {
  const f = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  let r = l, g = l, b = l;
  if (s) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    r = f(p, q, h + 1 / 3);
    g = f(p, q, h);
    b = f(p, q, h - 1 / 3);
  }
  return [r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
}

/** A colour element (a:srgbClr, a:schemeClr, ...) inside `n`, with lumMod/lumOff/tint/shade applied. */
function colorIn(n: XNode | undefined, theme: Theme, ph?: string): string | undefined {
  if (!n) return undefined;
  const c = n.children.find((k) => /^a:(srgbClr|schemeClr|sysClr|prstClr|scrgbClr)$/.test(k.name));
  if (!c) return undefined;
  let hex: string | undefined;
  if (c.name === "a:srgbClr") hex = c.attrs.val;
  else if (c.name === "a:sysClr") hex = c.attrs.lastClr ?? "000000";
  else if (c.name === "a:prstClr") hex = PRESET[c.attrs.val] ?? "000000";
  else if (c.name === "a:schemeClr") hex = c.attrs.val === "phClr" ? ph : theme[c.attrs.val];
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return undefined;
  let [h, s, l] = hexToHsl(hex);
  for (const m of c.children) {
    const v = Number(m.attrs.val) / 100000;
    if (m.name === "a:lumMod") l *= v;
    else if (m.name === "a:lumOff") l += v;
    else if (m.name === "a:tint") l = l + (1 - l) * (1 - v);
    else if (m.name === "a:shade") l *= v;
  }
  const alpha = child(c, "a:alpha")?.attrs.val;
  const out = "#" + hslToHex(h, s, Math.min(1, Math.max(0, l)));
  return alpha && Number(alpha) < 100000 ? out + Math.round((Number(alpha) / 100000) * 255).toString(16).padStart(2, "0") : out;
}

/** The fill inside a properties element: solid, first gradient stop, or "none". */
function fillOf(props: XNode | undefined, theme: Theme): string | undefined {
  if (!props) return undefined;
  if (child(props, "a:noFill")) return "none";
  const solid = child(props, "a:solidFill");
  if (solid) return colorIn(solid, theme);
  const grad = child(props, "a:gradFill");
  if (grad) return colorIn(find(grad, "a:gs"), theme);
  return undefined;
}

// ---------- PowerPoint ----------

interface Xf {
  ox: number;
  oy: number;
  sx: number;
  sy: number;
  cx: number;
  cy: number;
}
const IDENTITY: Xf = { ox: 0, oy: 0, sx: 1, sy: 1, cx: 0, cy: 0 };

interface PhInfo {
  xfrm?: XNode;
  bodyPr?: XNode;
  lstStyle?: XNode;
  spPr?: XNode;
}

interface Ctx {
  pkg: Pkg;
  theme: Theme;
  W: number;
  H: number;
  part: string;
  rels: ReturnType<Pkg["rels"]>;
  /** Placeholders on the layout and master, by "type" and "idx:N". */
  layoutPh: Map<string, PhInfo>;
  masterPh: Map<string, PhInfo>;
  txStyles?: XNode;
}

function phKey(ph: XNode) {
  return { type: ph.attrs.type ?? (ph.attrs.idx ? "body" : "body"), idx: ph.attrs.idx };
}

function collectPlaceholders(tree: XNode | undefined): Map<string, PhInfo> {
  const map = new Map<string, PhInfo>();
  for (const sp of findAll(tree, "p:sp")) {
    const ph = path(sp, "p:nvSpPr", "p:nvPr", "p:ph");
    if (!ph) continue;
    const info: PhInfo = { xfrm: path(sp, "p:spPr", "a:xfrm"), bodyPr: path(sp, "p:txBody", "a:bodyPr"), lstStyle: path(sp, "p:txBody", "a:lstStyle"), spPr: child(sp, "p:spPr") };
    const { type, idx } = phKey(ph);
    if (idx && !map.has(`idx:${idx}`)) map.set(`idx:${idx}`, info);
    if (!map.has(type)) map.set(type, info);
  }
  return map;
}

function lookupPh(ctx: Ctx, ph: XNode | undefined): PhInfo[] {
  if (!ph) return [];
  const { type, idx } = phKey(ph);
  const alias = type === "ctrTitle" ? "title" : type === "subTitle" || type === "obj" ? "body" : type;
  const out: PhInfo[] = [];
  const l = (idx && ctx.layoutPh.get(`idx:${idx}`)) || ctx.layoutPh.get(type) || ctx.layoutPh.get(alias);
  if (l) out.push(l);
  const m = ctx.masterPh.get(type) || ctx.masterPh.get(alias) || (idx ? ctx.masterPh.get(`idx:${idx}`) : undefined);
  if (m) out.push(m);
  return out;
}

function box(xfrm: XNode | undefined, xf: Xf, ctx: Ctx) {
  const off = child(xfrm, "a:off"), ext = child(xfrm, "a:ext");
  if (!off || !ext) return null;
  const x = xf.ox + (Number(off.attrs.x) - xf.cx) * xf.sx;
  const y = xf.oy + (Number(off.attrs.y) - xf.cy) * xf.sy;
  const w = Number(ext.attrs.cx) * xf.sx;
  const h = Number(ext.attrs.cy) * xf.sy;
  const rot = xfrm?.attrs.rot ? Number(xfrm.attrs.rot) / 60000 : undefined;
  return { x: x / ctx.W, y: y / ctx.H, w: w / ctx.W, h: h / ctx.H, rot };
}

/** Level properties (a:lvl1pPr ...) from a list style, for paragraph level `lvl`. */
const lvlPr = (lst: XNode | undefined, lvl: number) => child(lst, `a:lvl${lvl + 1}pPr`);

function paragraphs(txBody: XNode | undefined, ctx: Ctx, inherited: (XNode | undefined)[], opts: { bullets: boolean; fontScale: number; defaultSize: number; defaultColor?: string }): Para[] {
  const out: Para[] = [];
  const counters: number[] = [];
  for (const p of children(txBody, "a:p")) {
    const pPr = child(p, "a:pPr");
    const level = Number(pPr?.attrs.lvl ?? 0);
    const chain = [pPr, ...inherited.map((l) => lvlPr(l, level))].filter(Boolean) as XNode[];
    const pick = (attr: string) => chain.find((n) => n.attrs[attr] !== undefined)?.attrs[attr];
    const defR = chain.map((n) => child(n, "a:defRPr")).filter(Boolean) as XNode[];
    const align = (pick("algn") as Para["align"]) ?? undefined;
    let bullet: string | undefined;
    const buNode = chain.find((n) => child(n, "a:buNone") || child(n, "a:buChar") || child(n, "a:buAutoNum"));
    if (buNode && !child(buNode, "a:buNone")) {
      const ch = child(buNode, "a:buChar");
      if (ch) bullet = ch.attrs.char || "•";
      else {
        counters[level] = (counters[level] ?? 0) + 1;
        counters.length = level + 1;
        const scheme = child(buNode, "a:buAutoNum")?.attrs.type ?? "arabicPeriod";
        const n = counters[level];
        bullet = scheme.startsWith("alpha") ? String.fromCharCode((scheme.startsWith("alphaUc") ? 64 : 96) + ((n - 1) % 26) + 1) + "." : scheme.startsWith("roman") ? ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"][(n - 1) % 10] + "." : `${n}.`;
      }
    } else if (!buNode && opts.bullets) bullet = undefined;
    if (bullet && bullet.length === 1 && /[\uf000-\uf0ff]/.test(bullet)) bullet = "•"; // Wingdings glyphs
    const runs: Run[] = [];
    for (const r of p.children) {
      if (r.name === "a:br") {
        runs.push({ text: "\n" });
        continue;
      }
      if (r.name !== "a:r" && r.name !== "a:fld") continue;
      const rPr = child(r, "a:rPr");
      const rc = [rPr, ...defR].filter(Boolean) as XNode[];
      const at = (a: string) => rc.find((n) => n.attrs[a] !== undefined)?.attrs[a];
      const sz = at("sz");
      const color = rc.map((n) => fillOf(n, ctx.theme)).find((c) => c && c !== "none") ?? opts.defaultColor;
      const font = rc.map((n) => child(n, "a:latin")?.attrs.typeface).find((f) => f && !f.startsWith("+"));
      runs.push({
        text: textOf(child(r, "a:t")),
        size: Math.round(((sz ? Number(sz) / 100 : opts.defaultSize) * opts.fontScale) * 10) / 10,
        bold: at("b") === "1" || at("b") === "true" || undefined,
        italic: at("i") === "1" || at("i") === "true" || undefined,
        underline: (at("u") && at("u") !== "none") || undefined,
        color,
        font,
      });
    }
    if (!runs.length) {
      const end = child(p, "a:endParaRPr");
      const sz = end?.attrs.sz ?? defR.find((n) => n.attrs.sz)?.attrs.sz;
      runs.push({ text: "", size: (sz ? Number(sz) / 100 : opts.defaultSize) * opts.fontScale });
      bullet = undefined;
    }
    out.push({ runs, align, bullet, level: level || undefined });
  }
  return out;
}

function insetOf(bodyPr: XNode | undefined, ctx: Ctx): [number, number, number, number] {
  const v = (a: string, d: number) => (bodyPr?.attrs[a] !== undefined ? Number(bodyPr.attrs[a]) : d) / ctx.W;
  return [v("lIns", 91440), v("tIns", 45720), v("rIns", 91440), v("bIns", 45720)];
}

function shapeFrom(sp: XNode, ctx: Ctx, xf: Xf, fromMaster: boolean): SlideShape | null {
  const ph = path(sp, "p:nvSpPr", "p:nvPr", "p:ph");
  if (fromMaster && ph) return null; // placeholders on layouts/masters are prompts, not content
  const inh = lookupPh(ctx, ph);
  const spPr = child(sp, "p:spPr");
  const xfrm = child(spPr, "a:xfrm") ?? inh.map((i) => i.xfrm).find(Boolean);
  const b = box(xfrm, xf, ctx);
  if (!b) return null;
  const style = child(sp, "p:style");
  let fill = fillOf(spPr, ctx.theme);
  if (fill === undefined && style) {
    const ref = child(style, "a:fillRef");
    if (ref && Number(ref.attrs.idx) > 0) fill = colorIn(ref, ctx.theme);
  }
  if (fill === undefined) fill = inh.map((i) => fillOf(i.spPr, ctx.theme)).find((f) => f !== undefined);
  const blip = path(spPr, "a:blipFill", "a:blip")?.attrs["r:embed"];
  const ln = child(spPr, "a:ln");
  let line = ln ? fillOf(ln, ctx.theme) : undefined;
  if (line === undefined && style) {
    const ref = child(style, "a:lnRef");
    if (ref && Number(ref.attrs.idx) > 0) line = colorIn(ref, ctx.theme);
  }
  const lineWidth = line && line !== "none" ? Math.max(Number(ln?.attrs.w ?? 12700), 6350) / ctx.W : undefined;
  const geom = child(spPr, "a:prstGeom")?.attrs.prst ?? (child(spPr, "a:custGeom") ? "custom" : "rect");

  const txBody = child(sp, "p:txBody");
  const bodyPr = child(txBody, "a:bodyPr");
  const bodyChain = [bodyPr, ...inh.map((i) => i.bodyPr)];
  const anchor = (bodyChain.find((n) => n?.attrs.anchor)?.attrs.anchor as SlideShape["anchor"]) ?? (ph && /title/i.test(ph.attrs.type ?? "") ? "ctr" : "t");
  const scale = child(bodyPr, "a:normAutofit")?.attrs.fontScale;
  const type = ph?.attrs.type ?? (ph ? "body" : undefined);
  const isTitle = type === "title" || type === "ctrTitle";
  const txStyle = ph ? child(ctx.txStyles, isTitle ? "p:titleStyle" : "p:bodyStyle") : child(ctx.txStyles, "p:otherStyle");
  const lists = [child(txBody, "a:lstStyle"), ...inh.map((i) => i.lstStyle), txStyle];
  const defaultSize = isTitle ? 40 : ph ? 24 : 18;
  const paras = txBody ? paragraphs(txBody, ctx, lists, { bullets: !!ph && !isTitle, fontScale: scale ? Number(scale) / 100000 : 1, defaultSize, defaultColor: colorIn(child(style, "a:fontRef"), ctx.theme) ?? `#${ctx.theme.tx1}` }) : undefined;
  const hasText = paras?.some((p) => p.runs.some((r) => r.text.trim()));
  const visible = hasText || (fill && fill !== "none") || (line && line !== "none") || blip;
  if (!visible) return null;
  const vert = bodyPr?.attrs.vert;
  return {
    kind: blip ? "image" : "shape",
    ...b,
    geom,
    fill: blip ? undefined : fill,
    line,
    lineWidth,
    anchor,
    paragraphs: hasText ? paras : undefined,
    inset: insetOf(bodyPr ?? inh.map((i) => i.bodyPr).find(Boolean), ctx),
    src: blip ? ctx.pkg.dataUrl(ctx.rels[blip]?.target ?? "") : undefined,
    vertical: vert === "vert" || vert === "vert270" || undefined,
  };
}

function picFrom(pic: XNode, ctx: Ctx, xf: Xf): SlideShape | null {
  const b = box(path(pic, "p:spPr", "a:xfrm"), xf, ctx);
  if (!b) return null;
  const rid = path(pic, "p:blipFill", "a:blip")?.attrs["r:embed"];
  const target = rid ? ctx.rels[rid]?.target : undefined;
  return { kind: "image", ...b, geom: path(pic, "p:spPr", "a:prstGeom")?.attrs.prst, src: target ? ctx.pkg.dataUrl(target) : undefined };
}

function chartFrom(part: string, pkg: Pkg, theme: Theme): Chart | undefined {
  const x = pkg.xml(part);
  if (!x) return undefined;
  const plot = find(x, "c:plotArea");
  const kinds: Record<string, Chart["type"]> = { "c:barChart": "bar", "c:bar3DChart": "bar", "c:lineChart": "line", "c:line3DChart": "line", "c:pieChart": "pie", "c:pie3DChart": "pie", "c:doughnutChart": "doughnut", "c:areaChart": "area", "c:area3DChart": "area", "c:scatterChart": "scatter" };
  const node = plot?.children.find((c) => kinds[c.name]);
  if (!node) return undefined;
  let type = kinds[node.name];
  if (type === "bar" && child(node, "c:barDir")?.attrs.val !== "bar") type = "col";
  const grouping = child(node, "c:grouping")?.attrs.val ?? "";
  const pts = (n: XNode | undefined) => {
    const cache = find(n, "c:strCache") ?? find(n, "c:numCache") ?? find(n, "c:strLit") ?? find(n, "c:numLit");
    const list: string[] = [];
    for (const pt of children(cache, "c:pt")) list[Number(pt.attrs.idx)] = textOf(child(pt, "c:v"));
    return Array.from(list, (v) => v ?? "");
  };
  const series = children(node, "c:ser").map((s, i) => ({
    name: textOf(find(child(s, "c:tx"), "c:v")) || textOf(find(child(s, "c:tx"), "a:t")) || `Series ${i + 1}`,
    values: pts(child(s, "c:val") ?? child(s, "c:yVal")).map((v) => Number(v) || 0),
    color: fillOf(child(s, "c:spPr"), theme) ?? (child(s, "c:spPr") ? fillOf(child(child(s, "c:spPr"), "a:ln"), theme) : undefined),
  }));
  const first = children(node, "c:ser")[0];
  const categories = pts(child(first, "c:cat") ?? child(first, "c:xVal"));
  const title = textOf(child(find(x, "c:chart"), "c:title"), "a:t") || undefined;
  const palette = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"].map((k) => theme[k]).filter(Boolean).map((h) => `#${h}`);
  return { type, title, stacked: grouping.includes("tacked") || undefined, categories, series: series.map((s) => (s.color === "none" ? { ...s, color: undefined } : s)), palette };
}

function frameFrom(gf: XNode, ctx: Ctx, xf: Xf): SlideShape | null {
  const b = box(child(gf, "p:xfrm"), xf, ctx);
  if (!b) return null;
  const data = path(gf, "a:graphic", "a:graphicData");
  const tbl = child(data, "a:tbl");
  if (tbl) {
    const cols = children(child(tbl, "a:tblGrid"), "a:gridCol").map((c) => Number(c.attrs.w));
    const total = cols.reduce((a, c) => a + c, 0) || 1;
    const rows: TableCell[][] = children(tbl, "a:tr").map((tr) =>
      children(tr, "a:tc")
        .filter((tc) => !tc.attrs.hMerge && !tc.attrs.vMerge)
        .map((tc) => ({
          paragraphs: paragraphs(child(tc, "a:txBody"), ctx, [], { bullets: false, fontScale: 1, defaultSize: 18, defaultColor: `#${ctx.theme.tx1}` }),
          fill: fillOf(child(tc, "a:tcPr"), ctx.theme),
          span: tc.attrs.gridSpan ? Number(tc.attrs.gridSpan) : undefined,
        })),
    );
    const tblPr = child(tbl, "a:tblPr");
    const styled = !!child(tblPr, "a:tableStyleId") || !!tblPr?.attrs.firstRow;
    return { kind: "table", ...b, rows, cols: cols.map((c) => c / total), header: styled && tblPr?.attrs.firstRow === "1", banded: styled && tblPr?.attrs.bandRow === "1", accent: ctx.theme.accent1 ? `#${ctx.theme.accent1}` : "#4472c4" };
  }
  const chartRef = find(data, "c:chart");
  if (chartRef) {
    const target = ctx.rels[chartRef.attrs["r:id"]]?.target;
    return { kind: "chart", ...b, chart: target ? chartFrom(target, ctx.pkg, ctx.theme) : undefined };
  }
  const pic = find(data, "p:pic");
  if (pic) return picFrom(pic, ctx, xf);
  return null;
}

function walkTree(tree: XNode | undefined, ctx: Ctx, xf: Xf, out: SlideShape[], fromMaster: boolean) {
  for (const n of tree?.children ?? []) {
    let s: SlideShape | null = null;
    if (n.name === "p:sp" || n.name === "p:cxnSp") s = shapeFrom(n, ctx, xf, fromMaster);
    else if (n.name === "p:pic") s = picFrom(n, ctx, xf);
    else if (n.name === "p:graphicFrame") s = frameFrom(n, ctx, xf);
    else if (n.name === "p:grpSp") {
      const g = path(n, "p:grpSpPr", "a:xfrm");
      const off = child(g, "a:off"), ext = child(g, "a:ext"), chOff = child(g, "a:chOff"), chExt = child(g, "a:chExt");
      if (off && ext && chOff && chExt) {
        const sx = (Number(ext.attrs.cx) / (Number(chExt.attrs.cx) || 1)) * xf.sx;
        const sy = (Number(ext.attrs.cy) / (Number(chExt.attrs.cy) || 1)) * xf.sy;
        const ox = xf.ox + (Number(off.attrs.x) - xf.cx) * xf.sx;
        const oy = xf.oy + (Number(off.attrs.y) - xf.cy) * xf.sy;
        walkTree(n, ctx, { ox, oy, sx, sy, cx: Number(chOff.attrs.x), cy: Number(chOff.attrs.y) }, out, fromMaster);
      } else walkTree(n, ctx, xf, out, fromMaster);
    } else if (n.name === "mc:AlternateContent") walkTree(child(n, "mc:Fallback") ?? child(n, "mc:Choice"), ctx, xf, out, fromMaster);
    if (s) out.push(s);
  }
}

function backgroundOf(x: XNode | null, theme: Theme, pkg: Pkg, rels: ReturnType<Pkg["rels"]>): { color?: string; image?: string } | null {
  const bg = find(x ?? undefined, "p:bg");
  if (!bg) return null;
  const pr = child(bg, "p:bgPr");
  if (pr) {
    const blip = path(pr, "a:blipFill", "a:blip")?.attrs["r:embed"];
    if (blip) return { image: pkg.dataUrl(rels[blip]?.target ?? "") };
    return { color: fillOf(pr, theme) };
  }
  const ref = child(bg, "p:bgRef");
  return ref ? { color: colorIn(ref, theme) } : null;
}

export function pptxPreview(buf: Buffer, maxSlides = 80): SlidesPreview {
  const pkg = new Pkg(buf);
  const pres = pkg.xml("ppt/presentation.xml");
  if (!pres) throw new Error("This doesn't look like a PowerPoint file.");
  const sz = find(pres, "p:sldSz");
  const W = Number(sz?.attrs.cx ?? 12192000), H = Number(sz?.attrs.cy ?? 6858000);
  const presRels = pkg.rels("ppt/presentation.xml");
  const ids = children(find(pres, "p:sldIdLst"), "p:sldId").map((s) => presRels[s.attrs["r:id"]]?.target).filter(Boolean);
  const slides: Slide[] = [];
  for (const part of ids.slice(0, maxSlides)) {
    const x = pkg.xml(part);
    if (!x) continue;
    const rels = pkg.rels(part);
    const layoutPart = Object.values(rels).find((r) => r.type.endsWith("/slideLayout"))?.target;
    const layoutRels = layoutPart ? pkg.rels(layoutPart) : {};
    const masterPart = Object.values(layoutRels).find((r) => r.type.endsWith("/slideMaster"))?.target;
    const masterRels = masterPart ? pkg.rels(masterPart) : {};
    const themePart = Object.values(masterRels).find((r) => r.type.endsWith("/theme"))?.target ?? "ppt/theme/theme1.xml";
    const theme = themeColors(pkg.xml(themePart));
    const layout = layoutPart ? pkg.xml(layoutPart) : null;
    const master = masterPart ? pkg.xml(masterPart) : null;
    const base = { pkg, theme, W, H, layoutPh: collectPlaceholders(find(layout ?? undefined, "p:spTree")), masterPh: collectPlaceholders(find(master ?? undefined, "p:spTree")), txStyles: find(master ?? undefined, "p:txStyles") };
    const shapes: SlideShape[] = [];
    const showMaster = (n: XNode | null) => find(n ?? undefined, "p:sld")?.attrs.showMasterSp ?? n?.children[0]?.attrs.showMasterSp;
    if (showMaster(x) !== "0") {
      if (master && showMaster(layout) !== "0") walkTree(find(master, "p:spTree"), { ...base, part: masterPart!, rels: masterRels }, IDENTITY, shapes, true);
      if (layout) walkTree(find(layout, "p:spTree"), { ...base, part: layoutPart!, rels: layoutRels }, IDENTITY, shapes, true);
    }
    walkTree(find(x, "p:spTree"), { ...base, part, rels }, IDENTITY, shapes, false);
    const bg = backgroundOf(x, theme, pkg, rels) ?? backgroundOf(layout, theme, pkg, layoutRels) ?? backgroundOf(master, theme, pkg, masterRels);
    const notesPart = Object.values(rels).find((r) => r.type.endsWith("/notesSlide"))?.target;
    const notes = notesPart ? findAll(find(pkg.xml(notesPart) ?? undefined, "p:spTree"), "p:sp").filter((sp) => path(sp, "p:nvSpPr", "p:nvPr", "p:ph")?.attrs.type === "body").map((sp) => children(child(sp, "p:txBody"), "a:p").map((p) => textOf(p, "a:t")).join("\n")).join("\n").trim() : "";
    slides.push({ background: bg?.color && bg.color !== "none" ? bg.color : "#ffffff", backgroundImage: bg?.image, shapes, notes: notes || undefined });
  }
  return { kind: "slides", width: W / EMU_PER_PT, height: H / EMU_PER_PT, slides, truncated: ids.length > maxSlides || undefined };
}

// ---------- Word ----------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const hex = (v?: string) => (v && /^[0-9a-f]{6}$/i.test(v) ? `#${v}` : undefined);

export function docxPreview(buf: Buffer): string {
  const pkg = new Pkg(buf);
  const doc = pkg.xml("word/document.xml");
  if (!doc) throw new Error("This doesn't look like a Word document.");
  const rels = pkg.rels("word/document.xml");
  const styles = new Map<string, string>();
  for (const s of findAll(pkg.xml("word/styles.xml") ?? undefined, "w:style")) styles.set(s.attrs["w:styleId"], (child(s, "w:name")?.attrs["w:val"] ?? "").toLowerCase());
  const numFmt = new Map<string, string>();
  const numbering = pkg.xml("word/numbering.xml");
  const abstract = new Map<string, XNode>();
  for (const a of findAll(numbering ?? undefined, "w:abstractNum")) abstract.set(a.attrs["w:abstractNumId"], a);
  for (const n of findAll(numbering ?? undefined, "w:num")) {
    const a = abstract.get(child(n, "w:abstractNumId")?.attrs["w:val"] ?? "");
    for (const lvl of children(a, "w:lvl")) numFmt.set(`${n.attrs["w:numId"]}:${lvl.attrs["w:ilvl"]}`, child(lvl, "w:numFmt")?.attrs["w:val"] ?? "bullet");
  }
  const counters = new Map<string, number>();

  const runs = (p: XNode): string =>
    p.children
      .map((r) => {
        if (r.name === "w:hyperlink") {
          const href = r.attrs["r:id"] ? rels[r.attrs["r:id"]]?.target : undefined;
          const inner = runs(r);
          return href && /^https?:/i.test(href) ? `<a href="${esc(href)}">${inner}</a>` : inner;
        }
        if (r.name === "w:ins" || r.name === "w:smartTag" || r.name === "w:sdt" || r.name === "w:sdtContent") return runs(r);
        if (r.name !== "w:r") return "";
        const pr = child(r, "w:rPr");
        let html = "";
        for (const c of r.children) {
          if (c.name === "w:t") html += esc(c.text);
          else if (c.name === "w:tab") html += "&emsp;";
          else if (c.name === "w:br" || c.name === "w:cr") html += "<br>";
          else if (c.name === "w:drawing" || c.name === "w:pict") {
            const rid = find(c, "a:blip")?.attrs["r:embed"] ?? find(c, "v:imagedata")?.attrs["r:id"];
            const ext = find(c, "wp:extent");
            const src = rid ? pkg.dataUrl(rels[rid]?.target ?? "") : undefined;
            if (src) html += `<img src="${src}" style="max-width:100%;${ext ? `width:${Math.round(Number(ext.attrs.cx) / 9525)}px` : ""}">`;
          }
        }
        if (!html) return "";
        const st: string[] = [];
        const color = hex(child(pr, "w:color")?.attrs["w:val"]);
        if (color) st.push(`color:${color}`);
        const sz = child(pr, "w:sz")?.attrs["w:val"];
        if (sz) st.push(`font-size:${Number(sz) / 2}pt`);
        const hl = child(pr, "w:highlight")?.attrs["w:val"];
        if (hl && hl !== "none") st.push(`background:${/^[a-z]+$/i.test(hl) ? hl : "yellow"}`);
        const on = (k: string) => {
          const n = child(pr, k);
          return n && n.attrs["w:val"] !== "0" && n.attrs["w:val"] !== "false";
        };
        if (on("w:b")) html = `<b>${html}</b>`;
        if (on("w:i")) html = `<i>${html}</i>`;
        if (child(pr, "w:u") && child(pr, "w:u")!.attrs["w:val"] !== "none") html = `<u>${html}</u>`;
        if (on("w:strike")) html = `<s>${html}</s>`;
        return st.length ? `<span style="${st.join(";")}">${html}</span>` : html;
      })
      .join("");

  const para = (p: XNode): string => {
    const pPr = child(p, "w:pPr");
    const style = styles.get(child(pPr, "w:pStyle")?.attrs["w:val"] ?? "") ?? "";
    const jc = child(pPr, "w:jc")?.attrs["w:val"];
    const align = jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : jc === "both" ? "justify" : undefined;
    const body = runs(p) || "&nbsp;";
    const attr = align ? ` style="text-align:${align}"` : "";
    const h = /^heading (\d)/.exec(style);
    if (style === "title") return `<h1 class="title"${attr}>${body}</h1>`;
    if (style === "subtitle") return `<p class="subtitle"${attr}>${body}</p>`;
    if (h) return `<h${Math.min(6, Number(h[1]))}${attr}>${body}</h${Math.min(6, Number(h[1]))}>`;
    const num = child(pPr, "w:numPr");
    if (num || style.startsWith("list")) {
      const numId = child(num, "w:numId")?.attrs["w:val"] ?? "0";
      const ilvl = Number(child(num, "w:ilvl")?.attrs["w:val"] ?? 0);
      const fmt = numFmt.get(`${numId}:${ilvl}`) ?? (style.includes("number") ? "decimal" : "bullet");
      let marker = "•";
      if (fmt !== "bullet" && fmt !== "none") {
        const key = `${numId}:${ilvl}`;
        const n = (counters.get(key) ?? 0) + 1;
        counters.set(key, n);
        for (const k of counters.keys()) if (k.startsWith(`${numId}:`) && Number(k.split(":")[1]) > ilvl) counters.delete(k);
        marker = fmt.startsWith("lower") ? String.fromCharCode(96 + n) + "." : fmt.startsWith("upper") ? String.fromCharCode(64 + n) + "." : `${n}.`;
      }
      return `<p class="li" style="margin-left:${1.5 + ilvl * 1.5}em"><span class="mk">${marker}</span>${body}</p>`;
    }
    return `<p${attr}>${body}</p>`;
  };

  const table = (t: XNode): string =>
    `<table>${children(t, "w:tr")
      .map(
        (tr) =>
          `<tr>${children(tr, "w:tc")
            .map((tc) => {
              const pr = child(tc, "w:tcPr");
              const span = child(pr, "w:gridSpan")?.attrs["w:val"];
              const fill = hex(child(pr, "w:shd")?.attrs["w:fill"]);
              return `<td${span ? ` colspan="${Number(span)}"` : ""}${fill ? ` style="background:${fill}"` : ""}>${block(tc)}</td>`;
            })
            .join("")}</tr>`,
      )
      .join("")}</table>`;

  const block = (n: XNode): string =>
    n.children
      .map((c) => (c.name === "w:p" ? para(c) : c.name === "w:tbl" ? table(c) : c.name === "w:sdt" ? block(child(c, "w:sdtContent") ?? c) : ""))
      .join("\n");

  const body = find(doc, "w:body");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html{background:#e9e8e4}body{margin:24px auto;max-width:816px;background:#fff;color:#1f1f1f;padding:72px 80px;box-shadow:0 1px 4px rgba(0,0,0,.15);font:11pt/1.45 Calibri,"Segoe UI",Arial,sans-serif}
h1,h2,h3,h4{font-weight:600;color:#1f3864;margin:1.1em 0 .4em}h1{font-size:20pt}h1.title{font-size:28pt;font-weight:400;color:#111}h2{font-size:15pt}h3{font-size:12.5pt}
p{margin:0 0 .5em}p.subtitle{color:#666;font-size:14pt}p.li{position:relative}p.li .mk{position:absolute;left:-1.3em}
table{border-collapse:collapse;width:100%;margin:.6em 0}td{border:1px solid #bbb;padding:4px 6px;vertical-align:top}td p{margin:0}img{display:inline-block}a{color:#0563c1}
</style></head><body>${body ? block(body) : ""}</body></html>`;
}

// ---------- Excel ----------

const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function colIndex(ref: string) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n - 1;
}

function serialDate(v: number) {
  const d = new Date(Math.round((v - 25569) * 86400 * 1000));
  return v % 1 ? d.toISOString().slice(0, 16).replace("T", " ") : d.toISOString().slice(0, 10);
}

export function xlsxPreview(buf: Buffer, maxRows = 300, maxCols = 40): SheetPreview[] {
  const pkg = new Pkg(buf);
  const wb = pkg.xml("xl/workbook.xml");
  if (!wb) throw new Error("This doesn't look like an Excel file.");
  const rels = pkg.rels("xl/workbook.xml");
  const shared = findAll(pkg.xml("xl/sharedStrings.xml") ?? undefined, "si").map((si) => textOf(si, "t"));
  const stylesX = pkg.xml("xl/styles.xml");
  const custom = new Map<number, string>();
  for (const f of findAll(stylesX ?? undefined, "numFmt")) custom.set(Number(f.attrs.numFmtId), f.attrs.formatCode ?? "");
  const cellXfs = find(stylesX ?? undefined, "cellXfs");
  const fmtOf = (s?: string) => {
    const xf = s !== undefined ? children(cellXfs, "xf")[Number(s)] : undefined;
    return xf ? Number(xf.attrs.numFmtId ?? 0) : 0;
  };
  const out: SheetPreview[] = [];
  for (const s of findAll(find(wb, "sheets"), "sheet")) {
    const target = rels[s.attrs["r:id"]]?.target;
    const x = target ? pkg.xml(target) : null;
    if (!x) continue;
    const grid: string[][] = [];
    let truncated = false;
    let width = 0;
    for (const row of findAll(find(x, "sheetData"), "row")) {
      const r = Number(row.attrs.r ?? grid.length + 1) - 1;
      if (r >= maxRows) {
        truncated = true;
        break;
      }
      const cells: string[] = (grid[r] = grid[r] ?? []);
      children(row, "c").forEach((c, i) => {
        const ci = c.attrs.r ? colIndex(c.attrs.r) : i;
        if (ci >= maxCols) {
          truncated = true;
          return;
        }
        const t = c.attrs.t;
        const v = textOf(child(c, "v"));
        let text = "";
        if (t === "s") text = shared[Number(v)] ?? "";
        else if (t === "inlineStr") text = textOf(child(c, "is"), "t");
        else if (t === "b") text = v === "1" ? "TRUE" : "FALSE";
        else if (t === "str" || t === "e") text = v;
        else if (v !== "") {
          const num = Number(v);
          const id = fmtOf(c.attrs.s);
          const code = custom.get(id) ?? "";
          if (DATE_FMT_IDS.has(id) || (/[dmy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, "")) && !/0|#/.test(code))) text = serialDate(num);
          else if (id === 9 || id === 10 || code.includes("%")) text = `${+(num * 100).toFixed(2)}%`;
          else text = Number.isFinite(num) ? String(+num.toPrecision(12)) : v;
        }
        cells[ci] = decode(text);
        width = Math.max(width, ci + 1);
      });
    }
    const rows = Array.from(grid, (r) => Array.from({ length: width }, (_, i) => r?.[i] ?? ""));
    while (rows.length && rows[rows.length - 1].every((v) => !v)) rows.pop();
    out.push({ name: s.attrs.name ?? `Sheet ${out.length + 1}`, rows, truncated: truncated || undefined });
  }
  return out;
}

export function csvPreview(text: string, maxRows = 500): SheetPreview {
  const first = text.split("\n", 1)[0];
  const delim = [",", ";", "\t", "|"].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return { name: "CSV", rows, truncated: rows.length >= maxRows || undefined };
}

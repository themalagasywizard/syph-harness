// Files Syph made: a card in the chat (name, full path, Open, Show in folder) and a side panel
// that previews the file inline: slides, documents, sheets, PDFs, images, web pages, code.
import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Eye, File, FileCode2, FileImage, FileSpreadsheet, FileText, FileVideo, FolderOpen, Presentation, RefreshCw, SquareArrowOutUpRight, X } from "lucide-react";
import { api, type FileRef } from "../api";
import { Markdown } from "./Markdown";

export const fileRaw = (p: string) => `/api/files/raw?path=${encodeURIComponent(p)}`;
export const openFile = (p: string) => api.post("/files/open", { path: p });
export const revealFile = (p: string) => api.post("/files/reveal", { path: p });

const ext = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

export function FileIcon({ name, size = 18 }: { name: string; size?: number }) {
  const e = ext(name);
  if (["pptx", "pptm", "ppsx", "key"].includes(e)) return <Presentation size={size} />;
  if (["xlsx", "xlsm", "csv", "tsv"].includes(e)) return <FileSpreadsheet size={size} />;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(e)) return <FileImage size={size} />;
  if (["mp4", "webm", "mov"].includes(e)) return <FileVideo size={size} />;
  if (["docx", "doc", "pdf", "md", "txt", "rtf"].includes(e)) return <FileText size={size} />;
  if (["ts", "tsx", "js", "py", "json", "html", "css", "sh", "ps1", "sql"].includes(e)) return <FileCode2 size={size} />;
  return <File size={size} />;
}

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

function CopyPath({ path }: { path: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="icon-btn sm" title="Copy the full path" aria-label="Copy path" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(path); setDone(true); setTimeout(() => setDone(false), 1200); }}>
      {done ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}

/** Open / Show in folder, with any error shown next to them. */
export function FileActions({ path, canOpen = true, compact }: { path: string; canOpen?: boolean; compact?: boolean }) {
  const [error, setError] = useState<string>();
  const run = (fn: () => Promise<unknown>) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setError(undefined);
    fn().catch((err) => setError((err as Error).message));
  };
  return (
    <>
      {canOpen && <button className="btn ghost sm" onClick={run(() => openFile(path))} title="Open it in its app"><SquareArrowOutUpRight size={14} />{!compact && " Open"}</button>}
      <button className="btn ghost sm" onClick={run(() => revealFile(path))} title="Show it in File Explorer"><FolderOpen size={14} />{!compact && " Show in folder"}</button>
      {error && <span className="file-err">{error}</span>}
    </>
  );
}

export function FileCard({ f, onPreview }: { f: FileRef; onPreview: (path: string) => void }) {
  return (
    <div className="file-card" onClick={() => onPreview(f.path)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onPreview(f.path)}>
      <div className="file-ic"><FileIcon name={f.name} /></div>
      <div className="file-name">
        <span className="ellipsis">{f.name}</span>
        <span className={`file-badge ${f.action}`}>{f.action === "created" ? "Created" : "Updated"}</span>
        {f.exists === false && <span className="file-badge gone">Moved or deleted</span>}
      </div>
      <div className="file-btns">
        <button className="btn tonal sm" onClick={(e) => { e.stopPropagation(); onPreview(f.path); }}><Eye size={14} /> Preview</button>
        <FileActions path={f.path} compact />
        <CopyPath path={f.path} />
      </div>
      <div className="file-path" title={f.path}>{f.path}</div>
    </div>
  );
}

// ---------- The preview panel ----------

interface Run { text: string; size?: number; bold?: boolean; italic?: boolean; underline?: boolean; color?: string; font?: string }
interface Para { runs: Run[]; align?: string; bullet?: string; level?: number }
interface Chart { type: string; title?: string; stacked?: boolean; categories: string[]; series: { name: string; values: number[]; color?: string }[]; palette: string[] }
interface Shape {
  kind: "shape" | "image" | "table" | "chart";
  x: number; y: number; w: number; h: number; rot?: number;
  geom?: string; fill?: string; line?: string; lineWidth?: number; anchor?: string;
  paragraphs?: Para[]; inset?: [number, number, number, number]; src?: string;
  rows?: { paragraphs: Para[]; fill?: string; span?: number }[][]; cols?: number[]; header?: boolean; banded?: boolean; accent?: string;
  chart?: Chart; vertical?: boolean;
}
interface SlideData { background?: string; backgroundImage?: string; shapes: Shape[]; notes?: string }
type PreviewData =
  | { kind: "slides"; width: number; height: number; slides: SlideData[]; truncated?: boolean }
  | { kind: "document"; html: string }
  | { kind: "sheets"; sheets: { name: string; rows: string[][]; truncated?: boolean }[] }
  | { kind: "text"; language: string; content: string; truncated?: boolean }
  | { kind: "markdown"; content: string; truncated?: boolean }
  | { kind: "html"; content: string }
  | { kind: "image" | "pdf" | "video" | "audio" }
  | { kind: "none"; reason: string };

interface FileInfo { path: string; name: string; folder: string; size: number; modified: string; isDir: boolean; canOpen: boolean; preview: PreviewData }

const ALIGN: Record<string, string> = { l: "left", ctr: "center", r: "right", just: "justify" };

function Paragraphs({ paras, W }: { paras: Para[]; W: number }) {
  // Sizes are points on a slide W points wide: as a share of the slide's width they scale with it.
  const cq = (pt: number) => `${(pt / W) * 100}cqw`;
  return (
    <>
      {paras.map((p, i) => {
        const first = p.runs[0]?.size ?? 18;
        return (
          <p key={i} style={{ textAlign: (ALIGN[p.align ?? "l"] ?? "left") as any, marginLeft: p.bullet || p.level ? cq(18 + (p.level ?? 0) * 24) : undefined, textIndent: p.bullet ? cq(-14) : undefined, fontSize: cq(first) }}>
            {p.bullet && <span style={{ display: "inline-block", width: cq(14) }}>{p.bullet}</span>}
            {p.runs.map((r, j) =>
              r.text === "\n" ? <br key={j} /> : (
                <span key={j} style={{ fontSize: r.size ? cq(r.size) : undefined, fontWeight: r.bold ? 700 : undefined, fontStyle: r.italic ? "italic" : undefined, textDecoration: r.underline ? "underline" : undefined, color: r.color, fontFamily: r.font ? `"${r.font}", var(--slide-font)` : undefined }}>{r.text || "​"}</span>
              ),
            )}
          </p>
        );
      })}
    </>
  );
}

function ChartSvg({ c, ratio }: { c: Chart; ratio: number }) {
  const W = 640, H = Math.max(200, Math.round(W / ratio));
  const colors = (i: number) => c.series[i]?.color ?? c.palette[i % Math.max(1, c.palette.length)] ?? "#4472c4";
  const top = c.title ? 70 : 24, bottom = 90, left = 80, right = 24;
  const legend = (
    <g fontSize={26} fill="#444">
      {(c.type === "pie" || c.type === "doughnut" ? c.categories : c.series.map((s) => s.name)).slice(0, 8).map((n, i, all) => {
        const step = (W - 80) / all.length;
        const x = 40 + i * step;
        return (
          <g key={i} transform={`translate(${x},${H - 30})`}>
            <rect width={22} height={22} y={-18} fill={c.type === "pie" || c.type === "doughnut" ? c.palette[i % c.palette.length] ?? colors(i) : colors(i)} rx={3} />
            <text x={30} y={0}>{String(n).slice(0, 18)}</text>
          </g>
        );
      })}
    </g>
  );
  const title = c.title && <text x={W / 2} y={44} textAnchor="middle" fontSize={34} fontWeight={600} fill="#333">{c.title}</text>;
  if (c.type === "pie" || c.type === "doughnut") {
    const vals = c.series[0]?.values ?? [];
    const total = vals.reduce((a, v) => a + Math.max(0, v), 0) || 1;
    const cx = W / 2, cy = top + (H - top - bottom) / 2, r = Math.min(W, H - top - bottom) / 2 - 10;
    let a0 = -Math.PI / 2;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
        {title}
        {vals.map((v, i) => {
          const a1 = a0 + (Math.max(0, v) / total) * Math.PI * 2;
          const large = a1 - a0 > Math.PI ? 1 : 0;
          const d = `M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z`;
          const mid = (a0 + a1) / 2;
          const el = (
            <g key={i}>
              <path d={d} fill={c.palette[i % c.palette.length] ?? colors(i)} stroke="#fff" strokeWidth={3} />
              {v / total > 0.05 && <text x={cx + r * 0.65 * Math.cos(mid)} y={cy + r * 0.65 * Math.sin(mid)} textAnchor="middle" dominantBaseline="middle" fontSize={28} fill="#fff" fontWeight={600}>{Math.round((v / total) * 100)}%</text>}
            </g>
          );
          a0 = a1;
          return el;
        })}
        {c.type === "doughnut" && <circle cx={cx} cy={cy} r={r * 0.5} fill="#fff" />}
        {legend}
      </svg>
    );
  }
  const n = c.categories.length || Math.max(0, ...c.series.map((s) => s.values.length));
  const sums = Array.from({ length: n }, (_, i) => c.series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const max = Math.max(1, ...(c.stacked ? sums : c.series.flatMap((s) => s.values)));
  const nice = Math.pow(10, Math.floor(Math.log10(max)));
  const yMax = Math.ceil(max / nice) * nice;
  const horizontal = c.type === "bar";
  const pw = W - left - right, ph = H - top - bottom;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const fmt = (v: number) => (Math.abs(v) >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : `${+v.toFixed(2)}`);
  const band = (horizontal ? ph : pw) / Math.max(1, n);
  const groups = c.stacked || c.type === "line" || c.type === "area" ? 1 : c.series.length;
  const barW = (band * 0.7) / groups;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" fontFamily="var(--slide-font)">
      {title}
      {ticks.map((t) => {
        const v = t * yMax;
        return horizontal ? (
          <g key={t}><line x1={left + t * pw} x2={left + t * pw} y1={top} y2={top + ph} stroke="#ddd" /><text x={left + t * pw} y={top + ph + 30} textAnchor="middle" fontSize={22} fill="#666">{fmt(v)}</text></g>
        ) : (
          <g key={t}><line x1={left} x2={left + pw} y1={top + ph - t * ph} y2={top + ph - t * ph} stroke="#ddd" /><text x={left - 10} y={top + ph - t * ph + 7} textAnchor="end" fontSize={22} fill="#666">{fmt(v)}</text></g>
        );
      })}
      {c.categories.map((cat, i) => horizontal ? (
        <text key={i} x={left - 10} y={top + band * (i + 0.5) + 7} textAnchor="end" fontSize={22} fill="#555">{String(cat).slice(0, 12)}</text>
      ) : (
        <text key={i} x={left + band * (i + 0.5)} y={top + ph + 30} textAnchor="middle" fontSize={22} fill="#555">{String(cat).slice(0, 14)}</text>
      ))}
      {c.type === "line" || c.type === "area" || c.type === "scatter"
        ? c.series.map((s, si) => {
            const pts = s.values.map((v, i) => [left + band * (i + 0.5), top + ph - (v / yMax) * ph]);
            const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
            return (
              <g key={si}>
                {c.type === "area" && pts.length > 0 && <path d={`${d} L${pts[pts.length - 1][0]},${top + ph} L${pts[0][0]},${top + ph} Z`} fill={colors(si)} opacity={0.25} />}
                {c.type !== "scatter" && <path d={d} fill="none" stroke={colors(si)} strokeWidth={5} />}
                {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={7} fill={colors(si)} />)}
              </g>
            );
          })
        : Array.from({ length: n }, (_, i) => {
            let acc = 0;
            return c.series.map((s, si) => {
              const v = s.values[i] ?? 0;
              const len = (v / yMax) * (horizontal ? pw : ph);
              const off = c.stacked ? (acc / yMax) * (horizontal ? pw : ph) : 0;
              acc += v;
              const slot = c.stacked ? 0 : si;
              const pos = band * i + band * 0.15 + slot * barW;
              return horizontal ? (
                <rect key={`${i}-${si}`} x={left + off} y={top + pos} width={Math.max(0, len)} height={barW} fill={colors(si)} />
              ) : (
                <rect key={`${i}-${si}`} x={left + pos} y={top + ph - off - len} width={barW} height={Math.max(0, len)} fill={colors(si)} />
              );
            });
          })}
      {c.series.length > 1 || c.title ? legend : null}
    </svg>
  );
}

function SlideView({ s, W, H, index }: { s: SlideData; W: number; H: number; index: number }) {
  const cq = (f: number) => `${f * 100}cqw`;
  return (
    <figure className="slide-wrap">
      <div className="slide" style={{ aspectRatio: `${W} / ${H}`, background: s.backgroundImage ? `center / cover url(${s.backgroundImage})` : s.background ?? "#fff" }}>
        {s.shapes.map((sh, i) => {
          const base: React.CSSProperties = { left: `${sh.x * 100}%`, top: `${sh.y * 100}%`, width: `${sh.w * 100}%`, height: `${sh.h * 100}%`, transform: sh.rot ? `rotate(${sh.rot}deg)` : undefined };
          if (sh.kind === "image")
            return sh.src ? <img key={i} className="sh" style={base} src={sh.src} alt="" /> : <div key={i} className="sh sh-missing" style={base}>Picture</div>;
          if (sh.kind === "chart")
            return <div key={i} className="sh" style={base}>{sh.chart ? <ChartSvg c={sh.chart} ratio={(sh.w * W) / Math.max(1, sh.h * H)} /> : <div className="sh-missing" style={{ width: "100%", height: "100%" }}>Chart</div>}</div>;
          if (sh.kind === "table")
            return (
              <div key={i} className="sh" style={{ ...base, height: "auto", minHeight: base.height }}>
                <table className="sh-table">
                  {sh.cols && <colgroup>{sh.cols.map((w, k) => <col key={k} style={{ width: `${w * 100}%` }} />)}</colgroup>}
                  <tbody>
                    {sh.rows?.map((r, ri) => (
                      <tr key={ri}>
                        {r.map((cell, ci) => {
                          const head = sh.header && ri === 0;
                          const fill = cell.fill && cell.fill !== "none" ? cell.fill : head ? sh.accent : sh.banded && ri % 2 === 1 ? `color-mix(in srgb, ${sh.accent} 18%, white)` : sh.banded ? `color-mix(in srgb, ${sh.accent} 8%, white)` : undefined;
                          return (
                            <td key={ci} colSpan={cell.span} style={{ background: fill, color: head && !cell.fill ? "#fff" : undefined, fontWeight: head ? 700 : undefined }}>
                              <Paragraphs paras={head ? cell.paragraphs.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, color: cell.fill ? r.color : "#fff" })) })) : cell.paragraphs} W={W} />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          const radius = sh.geom === "ellipse" ? "50%" : sh.geom === "roundRect" ? cq(Math.min(sh.w, (sh.h * H) / W) * 0.18) : undefined;
          return (
            <div
              key={i}
              className={`sh sh-text anchor-${sh.anchor ?? "t"}`}
              style={{
                ...base,
                background: sh.fill && sh.fill !== "none" ? sh.fill : undefined,
                border: sh.line && sh.line !== "none" ? `${cq(sh.lineWidth ?? 0.001)} solid ${sh.line}` : undefined,
                borderRadius: radius,
                padding: sh.inset ? sh.inset.map(cq).join(" ") : undefined,
                writingMode: sh.vertical ? "vertical-rl" : undefined,
              }}
            >
              {sh.paragraphs && <div className="sh-body"><Paragraphs paras={sh.paragraphs} W={W} /></div>}
            </div>
          );
        })}
      </div>
      <figcaption>Slide {index + 1}{s.notes ? <span className="slide-notes">{s.notes}</span> : null}</figcaption>
    </figure>
  );
}

function Sheets({ sheets }: { sheets: { name: string; rows: string[][]; truncated?: boolean }[] }) {
  const [i, setI] = useState(0);
  const sh = sheets[i] ?? sheets[0];
  const width = Math.max(0, ...(sh?.rows.map((r) => r.length) ?? [0]));
  const col = (n: number) => { let s = ""; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  return (
    <div className="sheets">
      {sheets.length > 1 && <div className="sheet-tabs">{sheets.map((s, k) => <button key={k} className={`tab ${k === i ? "active" : ""}`} onClick={() => setI(k)}>{s.name}</button>)}</div>}
      {!sh?.rows.length ? <div className="empty">This sheet is empty.</div> : (
        <div className="sheet-scroll">
          <table className="sheet">
            <thead><tr><th />{Array.from({ length: width }, (_, k) => <th key={k}>{col(k)}</th>)}</tr></thead>
            <tbody>{sh.rows.map((r, ri) => <tr key={ri}><th>{ri + 1}</th>{Array.from({ length: width }, (_, k) => <td key={k} className={/^-?[\d.,]+%?$/.test(r[k] ?? "") ? "num" : ""}>{r[k]}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
      {sh?.truncated && <p className="hint">Showing the first rows and columns. Open the file to see everything.</p>}
    </div>
  );
}

function PreviewBody({ info, version }: { info: FileInfo; version: number }) {
  const p = info.preview;
  const src = `${fileRaw(info.path)}&v=${version}`;
  switch (p.kind) {
    case "slides":
      return (
        <div className="slides">
          {p.slides.map((s, i) => <SlideView key={i} s={s} W={p.width} H={p.height} index={i} />)}
          {p.truncated && <p className="hint">Only the first slides are shown. Open the file to see all of them.</p>}
          <p className="hint">A quick preview drawn by Syph. Fonts, effects and some layouts look different in PowerPoint.</p>
        </div>
      );
    case "document":
      return <iframe className="doc-frame" sandbox="" srcDoc={p.html} title={info.name} />;
    case "sheets":
      return <Sheets sheets={p.sheets} />;
    case "html":
      return <iframe className="doc-frame white" sandbox="allow-scripts" srcDoc={p.content} title={info.name} />;
    case "markdown":
      return <div className="md-preview"><Markdown text={p.content} /></div>;
    case "text":
      return <pre className="code-preview">{p.content}{p.truncated ? "\n\n… (cut short: open the file to see the rest)" : ""}</pre>;
    case "image":
      return <div className="img-preview"><img src={src} alt={info.name} /></div>;
    case "pdf":
      return <iframe className="doc-frame" src={src} title={info.name} />;
    case "video":
      return <video className="media" src={src} controls />;
    case "audio":
      return <audio className="media" src={src} controls />;
    default:
      return <div className="empty" style={{ padding: 40 }}>{p.reason}</div>;
  }
}

export function FilePanel({ path, onClose }: { path: string; onClose: () => void }) {
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    setError(undefined);
    api.get<FileInfo>(`/files/preview?path=${encodeURIComponent(path)}`).then(setInfo).catch((e) => { setInfo(null); setError((e as Error).message); });
  }, [path, version]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  const name = useMemo(() => path.split(/[\\/]/).pop() ?? path, [path]);
  return (
    <aside className="file-panel" aria-label={`Preview of ${name}`}>
      <div className="fp-head">
        <div className="file-ic"><FileIcon name={name} /></div>
        <div className="fp-title">
          <div className="file-name"><span className="ellipsis">{name}</span></div>
          <div className="fp-meta">{info ? `${fmtSize(info.size)} · changed ${new Date(info.modified).toLocaleString()}` : ""}</div>
        </div>
        <button className="icon-btn sm" onClick={() => setVersion((v) => v + 1)} title="Reload the preview" aria-label="Reload"><RefreshCw size={16} /></button>
        <button className="icon-btn sm" onClick={onClose} title="Close (Esc)" aria-label="Close preview"><X size={18} /></button>
      </div>
      <div className="fp-path">
        <span className="hint">Saved at</span>
        <code title={path}>{path}</code>
        <CopyPath path={path} />
      </div>
      <div className="fp-actions"><FileActions path={path} canOpen={info?.canOpen ?? true} /></div>
      <div className="fp-body">
        {error ? <div className="banner bad" style={{ margin: 16 }}>{error}</div> : !info ? <div className="thinking" style={{ margin: 24 }}><span /><span /><span /></div> : <PreviewBody info={info} version={version} />}
      </div>
    </aside>
  );
}

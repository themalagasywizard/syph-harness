// Minimal 5-field cron: minute hour day-of-month month day-of-week.
// Supports *, numbers, ranges (1-5), lists (1,3,5) and steps (*/15, 0-30/5). Local time.

type Field = Set<number>;
export interface Cron {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
  domAny: boolean;
  dowAny: boolean;
}

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(src: string, [lo, hi]: [number, number]): Field {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const [rangeSrc, stepSrc] = part.split("/");
    const step = stepSrc ? Number(stepSrc) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in "${part}"`);
    let a = lo, b = hi;
    if (rangeSrc !== "*") {
      const [x, y] = rangeSrc.split("-").map(Number);
      if (!Number.isInteger(x) || (y !== undefined && !Number.isInteger(y))) throw new Error(`Bad value "${part}"`);
      a = x;
      b = y ?? (stepSrc ? hi : x);
    }
    if (a < lo || b > hi || a > b) throw new Error(`"${part}" is out of range ${lo}-${hi}`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error("Cron needs 5 fields: minute hour day month weekday");
  const [minute, hour, dom, month, dow] = f.map((x, i) => parseField(x, RANGES[i]));
  if (dow.has(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: f[2] === "*", dowAny: f[4] === "*" };
}

export function matches(c: Cron, d: Date) {
  if (!c.minute.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.month.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  // Standard cron: if both day fields are restricted, either may match.
  if (!c.domAny && !c.dowAny) return domOk || dowOk;
  return domOk && dowOk;
}

/** Next matching minute strictly after `from`. Searches up to ~2 years. */
export function nextRun(expr: string, from = new Date()): Date | null {
  const c = parseCron(expr);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 2 * 366 * 24 * 60; i++) {
    if (matches(c, d)) return d;
    // Skip whole hours/days quickly when they can't match.
    if (!c.month.has(d.getMonth() + 1) || (!c.hour.has(d.getHours()) && d.getMinutes() === 0)) {
      d.setMinutes(0);
      d.setHours(d.getHours() + 1);
      continue;
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** Most recent matching minute at or before `at` and after `since`, or null. */
export function lastDue(expr: string, since: Date, at = new Date()): Date | null {
  let cur = nextRun(expr, new Date(since.getTime()));
  let last: Date | null = null;
  let guard = 0;
  while (cur && cur <= at && guard++ < 100000) {
    last = cur;
    cur = nextRun(expr, cur);
  }
  return last;
}

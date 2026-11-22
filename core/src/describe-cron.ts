// Human-readable descriptions for the common 5-field cron shapes.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n: string) => n.padStart(2, "0");

function days(dow: string): string {
  if (dow === "*") return "every day";
  if (dow === "1-5") return "weekdays";
  if (dow === "0,6" || dow === "6,0") return "weekends";
  return dow.split(",").map((d) => DAYS[Number(d) % 7] ?? d).join(", ");
}

export function describeCron(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return "Invalid: needs 5 fields (min hour day month weekday)";
  const [min, hour, dom, mon, dow] = f;
  if (min.startsWith("*/") && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `Every ${min.slice(2)} minutes`;
  if (min === "*" && hour === "*") return "Every minute";
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && dow === "*") return min === "0" ? "Every hour" : `Every hour at :${pad(min)}`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*") return `${days(dow)[0].toUpperCase()}${days(dow).slice(1)} at ${pad(hour)}:${pad(min)}`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && mon === "*") return `Day ${dom} of every month at ${pad(hour)}:${pad(min)}`;
  return "Custom schedule";
}

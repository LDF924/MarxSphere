export function cellText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  if (Number.isNaN(n) || !Number.isFinite(n)) return String(v);
  const abs = Math.abs(n);
  if (abs >= 1000 || (abs > 0 && abs < 0.001)) return n.toExponential(3);
  if (abs > 0 && abs < 0.01) return n.toFixed(4);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3);
}

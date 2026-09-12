/** 数值格式(闭源 Oe() L1751): |x|≥1000 或 <0.001 → toExponential(3); <0.01 → 4 位小数; 整数原样; 否则 3 位 */
export function formatStatNum(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  if (Number.isNaN(n)) return String(v);
  if (!Number.isFinite(n)) return String(v);
  const abs = Math.abs(n);
  if (abs >= 1000 || (abs > 0 && abs < 0.001)) return n.toExponential(3);
  if (abs > 0 && abs < 0.01) return n.toFixed(4);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3);
}

/** 中文字数统计(去空白) */
export function charCount(text: string): number {
  return String(text ?? "").replace(/\s/g, "").length;
}

/** 防抖(闭源各处 debounce 500/1200/300ms) */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait = 500): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export function throttle<A extends unknown[]>(fn: (...args: A) => void, wait = 300): (...args: A) => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  return (...args: A) => {
    const now = Date.now();
    lastArgs = args;
    if (now - last >= wait) {
      last = now;
      fn(...args);
      return;
    }
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        if (lastArgs) fn(...lastArgs);
      }, wait - (now - last));
    }
  };
}

/** 随机 id(闭源 mat_ + ts / quick-{ts} / v2_ 等形态) */
export function randId(prefix = ""): string {
  const ts = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 9);
  return `${prefix}${ts}_${r}`;
}

/** UUID(闭源 crypto.randomUUID 兜底) */
export function uuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** 截断文本 */
export function truncate(text: string, max = 120): string {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** LLM JSON 五级容错解析(闭源 editor-review §2.2 parseFinalResult 前端算法还原) */
export function parseLlmJsonStrict(text: string): { ok: boolean; value?: unknown; raw?: string } {
  const src = String(text ?? "").trim();
  if (!src) return { ok: false, raw: src };
  // 1. 直解
  try {
    return { ok: true, value: JSON.parse(src) };
  } catch { /* 落下一级 */ }
  // 2. 剥 ```json 围栏 / 弯引号 / // 注释
  let s = src.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  s = s.replace(/^\s*\/\/.*$/gm, "");
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch { /* 落下一级 */ }
  // 3. 大括号平衡: 截取首个 { 到末个 }(平衡度检查)
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const cand = s.slice(first, last + 1);
    try {
      return { ok: true, value: JSON.parse(cand) };
    } catch { /* 落下一级 */ }
  }
  // 4. 末级: 在包围区外用原始文本
  return { ok: false, raw: src };
}

/**
 * markdown 渲染管线 — 还原闭源 AIPanel 渲染(AI 结果区): katex 先行提取公式 → 占位符
 * → marked(breaks) → 占位回填 → DOMPurify → innerHTML; 及 Materials/Workspace 的 markdown-body 渲染
 */
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ breaks: true, gfm: true });

/** 公式占位符识别: $$...$$ | \[...\] | \(...\) */
const FORMULA_RE = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\))/g;

/** 渲染含 LaTeX 的 markdown → 净化 HTML(katex 存在则渲染公式, 否则占位原样) */
export function renderMdWithLatex(text: string): string {
  if (!text) return "";
  const placeholders: string[] = [];
  const replaced = String(text).replace(FORMULA_RE, (m) => {
    const idx = placeholders.length;
    placeholders.push(m);
    return `@@EDITOR_FORMULA_${idx}@@`;
  });
  let html = "";
  try {
    html = marked.parse(replaced, { async: false }) as string;
  } catch {
    html = replaced;
  }
  // 公式回填
  placeholders.forEach((f, i) => {
    const token = `@@EDITOR_FORMULA_${i}@@`;
    const renderFormula = (() => {
      try {
        // 动态 require katex(仓库已有依赖)
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const katexMod = (globalThis as Record<string, unknown>).__katex as { renderToString: (s: string, o?: { displayMode?: boolean }) => string } | undefined;
        if (katexMod) {
          const display = f.startsWith("$$") || f.startsWith("\\[");
          const body = f.replace(/^\$\$/, "").replace(/\$\$$/, "").replace(/^\\\[/, "").replace(/\\\]$/, "").replace(/^\\\(/, "").replace(/\\\)$/, "");
          return katexMod.renderToString(body, { displayMode: display });
        }
      } catch { /* 忽略 */ }
      return null;
    })();
    const piece = renderFormula ?? `<span class="rf-formula-raw">${f.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`;
    html = html.split(token).join(piece);
  });
  return DOMPurify.sanitize(html);
}

/** 普通 markdown → 净化 HTML */
export function renderMd(text: string): string {
  if (!text) return "";
  let html = "";
  try {
    html = marked.parse(text, { async: false }) as string;
  } catch {
    html = text;
  }
  return DOMPurify.sanitize(html);
}

/** 加载 katex 供公式渲染(懒加载单例) */
export async function loadKatex(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  if (g.__katex) return;
  try {
    const katex = await import("katex");
    g.__katex = { renderToString: (s: string, o: { displayMode?: boolean }) => katex.renderToString(s, o) };
  } catch { /* katex 缺失时公式原样输出 */ }
}

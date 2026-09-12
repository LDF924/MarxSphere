/** 4 套排版预设 — 还原自闭源格式预设表(Ma, E:18891-18961) + localStorage ade-format-preset */
export interface FormatPreset {
  key: string;
  name: string;
  description: string;
  fontFamily: string;
  fontSize: string;
  lineHeight: number;
  paragraphMargin: string;
  firstLineIndent: string;
  docxFont: string;
  docxFontSize: number;
}

export const FORMAT_PRESETS: FormatPreset[] = [
  {
    key: "general",
    name: "通用学术论文",
    description: "宋体/Times New Roman，适合中文论文草稿与通用投稿前检查。",
    fontFamily: '"Noto Serif SC", "Songti SC", SimSun, "Times New Roman", serif',
    fontSize: "15px",
    lineHeight: 1.85,
    paragraphMargin: "5px",
    firstLineIndent: "2em",
    docxFont: "SimSun",
    docxFontSize: 10.5
  },
  {
    key: "journal_cn",
    name: "中文期刊风格",
    description: "更紧凑的中文期刊预览，强调段落缩进和标题层级。",
    fontFamily: 'SimSun, "Noto Serif SC", serif',
    fontSize: "14.5px",
    lineHeight: 1.75,
    paragraphMargin: "4px",
    firstLineIndent: "2em",
    docxFont: "SimSun",
    docxFontSize: 10.5
  },
  {
    key: "apa",
    name: "APA 草稿",
    description: "英文论文草稿预览，使用 Times New Roman 与双倍行距。",
    fontFamily: '"Times New Roman", Times, serif',
    fontSize: "16px",
    lineHeight: 2,
    paragraphMargin: "6px",
    firstLineIndent: "0.5in",
    docxFont: "Times New Roman",
    docxFontSize: 12
  },
  {
    key: "degree",
    name: "学位论文草稿",
    description: "适合较长篇幅论文的宽松预览，便于逐章审阅。",
    fontFamily: 'SimSun, "Noto Serif SC", serif',
    fontSize: "15px",
    lineHeight: 1.9,
    paragraphMargin: "6px",
    firstLineIndent: "2em",
    docxFont: "SimSun",
    docxFontSize: 11
  }
];

const KEY = "ade-format-preset";
export function loadPresetKey(): string {
  const k = localStorage.getItem(KEY);
  return FORMAT_PRESETS.some((p) => p.key === k) ? (k as string) : "general";
}
export function savePresetKey(key: string): void {
  localStorage.setItem(KEY, key);
}
export function presetByKey(key: string): FormatPreset {
  return FORMAT_PRESETS.find((p) => p.key === key) ?? FORMAT_PRESETS[0];
}

/** 预设 → CSS 变量映射(闭源 ES: --ade-doc-* 五变量) */
export function presetToCssVars(p: FormatPreset): Record<string, string> {
  return {
    "--ade-doc-font-family": p.fontFamily,
    "--ade-doc-font-size": p.fontSize,
    "--ade-doc-line-height": String(p.lineHeight),
    "--ade-doc-paragraph-margin": p.paragraphMargin,
    "--ade-doc-first-line-indent": p.firstLineIndent
  };
}

/** AI 面板宽度持久化(闭源 vd=ade-ai-panel-width, clamp 340-720) */
export const AI_PANEL_MIN = 340;
export const AI_PANEL_MAX = 720;
export function loadAiPanelWidth(): number {
  const v = Number(localStorage.getItem("ade-ai-panel-width"));
  if (Number.isNaN(v)) return 420;
  return Math.min(AI_PANEL_MAX, Math.max(AI_PANEL_MIN, v));
}
export function saveAiPanelWidth(w: number): void {
  localStorage.setItem("ade-ai-panel-width", String(Math.min(AI_PANEL_MAX, Math.max(AI_PANEL_MIN, w))));
}

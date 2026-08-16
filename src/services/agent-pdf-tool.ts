// agent-pdf-tool.ts — V395-1: 多模态 PDF 解析工具（Agent 可调用）
// 复用 PDF2Obsidian 开源项目(yeora26)的 MinerU 官方管线: 完整 6 阶段导入 或 轻量单步解析
// 支持扫描件 OCR / 公式 / 表格 / 翻译 / Obsidian 导出
import { parsePdfViaP2O, importPdfWithP2O } from "./pdf2obsidian-adapter.js";

/**
 * V395-1: 提取 PDF 文本（轻量单步, Agent 步骤用）
 */
export async function parsePdf(
  filePath: string,
  maxChars = 8000,
  opts?: { ocr?: boolean }
): Promise<{ ok: boolean; content?: string; engine?: string; error?: string }> {
  const r = await parsePdfViaP2O(filePath, maxChars, opts);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, engine: "mineru-official", content: r.content };
}

/**
 * V395-1: 完整管线导入（6 阶段: upload→mineru→normalize→translate→obsidian_export→quality_check）
 * 供前端 PDF2Obsidian tab 调用
 */
export async function importPdfFull(
  filePath: string,
  opts?: { config?: any; onStep?: (ev: { step: string; status: string; message?: string }) => void }
): Promise<{ ok: boolean; result?: any; error?: string; steps?: string[] }> {
  return importPdfWithP2O(filePath, opts);
}

/** Agent 工具定义（pdf_parse） */
export const pdfParseTool = {
  name: "pdf_parse",
  label: "PDF解析",
  description: "提取 PDF 文档为 Markdown（MinerU 官方 API via PDF2Obsidian, 支持扫描件 OCR/公式/表格; 经典原著/政策文件）",
  params: {
    filePath: { type: "string", required: true, desc: "PDF 文件路径" },
    maxChars: { type: "number", desc: "最多提取字符数(默认8000)" },
    ocr: { type: "boolean", desc: "是否启用OCR(扫描件)" },
  },
  risk: "safe" as const,
  run: async (args: Record<string, unknown>): Promise<string> => {
    const r = await parsePdf(String(args.filePath), Number(args.maxChars) || 8000, { ocr: !!args.ocr });
    if (!r.ok) return "PDF解析失败: " + (r.error || "");
    return `【PDF解析·MinerU】\n${r.content || ""}`;
  },
};

/**
 * 语料库提取: PDF 解析后自动识别"可引用句式候选"（积累入口之一）
 * 启发式规则: 找 2-3 句的学术性表述（含学术动词/连接词/引用标记）, 标注来源供人工筛选
 * 只推荐候选, 不自动入库（人工确认后经 addCorpusText 落库）
 */
export async function extractCorpusCandidatesFromPdf(
  filePath: string,
  opts?: { maxCandidates?: number; ocr?: boolean }
): Promise<{ ok: boolean; candidates: Array<{ text: string; reason: string }>; error?: string }> {
  const r = await parsePdf(filePath, 20_000, opts);
  if (!r.ok) return { ok: false, candidates: [], error: r.error };
  const content = r.content || "";
  // 候选信号: 含学术连接词/引用标记/学术动词的完整句
  const SENTENCE_END = /[。！？.!?]\s*/;
  const sentences = content.split(SENTENCE_END).map((s) => s.trim()).filter((s) => s.length >= 25 && s.length <= 200);
  const signals = [
    /(?:表明|揭示|指出|强调|认为|表明|说明|显示)/,          // 中文学术动词
    /(?:(?:19|20)\d{2}[a-z]?\)|（(?:19|20)\d{2}|et al\.|等\()/,  // 引用标记
    /(?:然而|但是|因此|综上|值得注意的是|进一步地|此外)/,       // 连接词
    /(?:demonstrate|suggest|indicate|highlight|argue|emphasize|reveal|underscore)/i,
    /(?:however|therefore|notably|furthermore|in contrast|taken together)/i,
  ];
  const candidates: Array<{ text: string; reason: string }> = [];
  for (const s of sentences) {
    const hit = signals.findIndex((re) => re.test(s));
    if (hit >= 0) {
      candidates.push({
        text: s,
        reason: ["学术动词表述", "含引用标记(年份/作者)", "学术连接词", "英文学术动词", "英文连接词"][hit],
      });
      if (candidates.length >= (opts?.maxCandidates || 5)) break;
    }
  }
  return { ok: true, candidates };
}

export const agentPdfTool = { parsePdf, importPdfFull, pdfParseTool, extractCorpusCandidatesFromPdf };

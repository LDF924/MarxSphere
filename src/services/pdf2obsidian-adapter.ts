// pdf2obsidian-adapter.ts — V395-1: PDF2Obsidian 集成适配层
// 复用 yeora26/PDF2Obsidian 完整管线(importPdf): MinerU解析→规范化→翻译→Obsidian导出→质量检查
// 直接从 vendor/pdf2obsidian 编译产物 import（保持开源项目独立性）
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// 动态加载 vendor 编译产物（避免 SAG 启动时加载失败）
async function loadPipeline() {
  const pipeline = await import("../../vendor/pdf2obsidian/packages/pipeline/dist/index.js");
  return pipeline;
}

/** 构建 PDF2Obsidian 配置（MinerU 官方模式; 字段按 types.ts 补全） */
export function buildP2OConfig(overrides?: Record<string, unknown>): any {
  return {
    vault: {
      path: overrides?.vaultPath || process.env.P2O_VAULT_PATH || "D:/Desktop/ov_import",
      documentDir: "资本规范与引导、资本治理",
      imageDirName: "images",
    },
    mineru: {
      command: "mineru",
      outputDir: ".pipeline/mineru-out",
      mode: "official",
      backend: "pipeline",
      method: "auto",
      apiTokenEnv: "MINERU_TOKEN",  // V395-1: 显式指定（默认是 MINERU_OFFICIAL_API_TOKEN）
      modelVersion: "vlm",
      formula: true,
      table: true,
      imageAnalysis: true,
      allowLocalMode: true,
    },
    translation: {
      enabled: false,  // 默认不翻译（马理论原文保留）
      provider: "openai-compatible",
      preset: "deepseek",
      model: process.env.P2O_TRANSLATE_MODEL || "deepseek-chat",
      baseUrl: process.env.P2O_TRANSLATE_BASE_URL || "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      systemPrompt: "将学术论文翻译为中文，保持术语准确。",
      chunkCharLimit: 6000,
      cacheDir: ".pipeline/translation-cache",
      maxRetries: 2,
    },
    tasks: {
      stateDir: ".pipeline/tasks",
      inboxDir: ".pipeline/inbox",
      concurrency: 2,
      watchPollIntervalMs: 5000,
      watch: { enabled: false, dir: "" },
    },
    readingAssets: {
      enabled: process.env.P2O_READING_ASSETS !== "0",  // V395-10: 默认开启（摘要/术语表/问答）; P2O_READING_ASSETS=0 关闭
      cacheDir: ".pipeline/reading",
      summaryFileName: "摘要.md",
      termsFileName: "术语表.md",
      qaFileName: "问答.md",
      // 以下照抄原版 load-config.js 默认值（缺失会触发生成异常）
      maxSourceChars: 50000,
      maxRetries: 3,
      systemPrompt: [
        "你是严谨的论文阅读助手。",
        "只根据用户提供的原文和译文生成内容，不要引入外部知识或没有依据的结论。",
        "输出必须是简体中文 Markdown。",
        "保留必要的英文术语、论文名、方法名和缩写。",
      ].join("\n"),
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      maxTokens: 1500,
      temperature: 0.3,
    },
    quality: { reportFileName: "质量报告.md" },
    obsidian: {
      autoLink: {
        enabled: false,
        scanDirs: [],
        excludeDirs: [".obsidian", ".trash"],
        minAliasLength: 4,
        maxLinksPerNote: 30,
      },
      database: { enabled: false, fileName: "Bases.md" },
    },
    metadata: {
      enrichFromMarkdown: false,
      online: { enabled: false, providers: ["crossref", "openalex"], timeoutMs: 12000, cacheDir: ".pipeline/core-cache" },
      journalMetrics: { sqlite: { path: ".pipeline/journal-metrics.sqlite" }, easyScholar: { enabled: false, baseUrl: "https://www.easyscholar.cc/open/getPublicationRank", timeoutMs: 12000 } },
      overrides: {},
    },
    ...overrides,
  };
}

/**
 * V395-1: 用 PDF2Obsidian 完整管线导入 PDF
 * @returns 管线结果（6 阶段: upload→mineru→normalize→translate→obsidian_export→quality_check）
 */
export async function importPdfWithP2O(
  pdfPath: string,
  opts?: { config?: any; onStep?: (ev: { step: string; status: string; message?: string }) => void }
): Promise<{ ok: boolean; result?: any; error?: string; steps?: string[] }> {
  try {
    const pipeline = await loadPipeline();
    const config = opts?.config || buildP2OConfig();
    const completedSteps = new Set<any>();
    const steps: string[] = [];
    const result = await pipeline.importPdf({
      pdfPath,
      config,
      completedSteps,
      onStep: (ev: any) => {
        steps.push(`${ev.step}:${ev.status}`);
        opts?.onStep?.(ev);
      },
    });
    return { ok: true, result, steps };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

/** 直接调用 MinerU 解析（Agent 工具用, 轻量单步） */
export async function parsePdfViaP2O(
  pdfPath: string,
  maxChars = 8000,
  opts?: { ocr?: boolean }
): Promise<{ ok: boolean; content?: string; error?: string }> {
  try {
    const core = await import("../../vendor/pdf2obsidian/packages/core/dist/index.js");
    // 用 runMineru 的官方模式解析到临时目录, 读回 md
    const { join } = await import("node:path");
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const outDir = await mkdtemp(join(tmpdir(), "p2o-"));
    await core.runMineru({
      pdfPath,
      outputDir: outDir,
      command: "mineru",
      mode: "official",
      backend: "pipeline",
      method: opts?.ocr ? "ocr" : "auto",
      apiTokenEnv: "MINERU_TOKEN",
      modelVersion: "vlm",
      formula: true,
      table: true,
    });
    // 从输出目录找 md（findPrimaryMarkdown(rootDir, preferredStem)）
    const { findPrimaryMarkdown, readTextFile } = core;
    const { basename, extname } = await import("node:path");
    const mdPath = await findPrimaryMarkdown(outDir, basename(pdfPath, extname(pdfPath)));
    const content = mdPath ? await readTextFile(mdPath) : "";
    if (!content) return { ok: false, error: "MinerU 未产出 Markdown" };
    return { ok: true, content: content.slice(0, maxChars) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

export const pdf2obsidianAdapter = { importPdfWithP2O, parsePdfViaP2O, buildP2OConfig };

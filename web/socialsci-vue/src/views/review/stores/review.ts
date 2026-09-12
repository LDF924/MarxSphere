/**
 * review store — 还原自闭源 ReviewView-B4QyxKEn.js Pinia review(R:623-1198) 核心状态机
 * pageState: input_ready/reviewing/result_view/detail_view; paper 六元组; settings 三要素
 * LLM 结果五级容错解析(直解→剥围栏→括号平衡→字符串修复→rawOutput 兜底)
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";

export interface ReviewDimension {
  name: string;
  score: number;
  maxScore?: number;
  weight?: number;
  weightLabel?: string;
  status?: string;
  summary?: string;
  issues?: Array<{
    id?: string;
    severity?: string;
    location?: string;
    originalText?: string;
    comment?: string;
    suggestion?: string;
  }>;
}

export interface ReviewResult {
  paperTitle: string;
  wordCount: number;
  overallScore: number;
  grade: string;
  overallComment: string;
  overall?: string;
  dimensions: ReviewDimension[];
  annotations?: Array<{ id: string; type: string; dimension: string; highlightText: string; comment: string }>;
  highlights?: string[];
  topSuggestions?: string[];
  majorIssues?: unknown[];
  minorIssues?: unknown[];
  reviewedAt?: string;
  rawOutput?: string;
  parseFailed?: boolean;
}

export interface ReviewSettings {
  strictness: string; // lax | standard | strict(闭源三档)
  journalId: string | null;
  standardIds: string[];
  customRequirements: string;
  /** 审稿用模型(空 = 平台默认)。随任务落库, 重审/重开历史任务沿用同一模型 */
  modelId?: string;
}

export type ReviewPageState = "input_ready" | "reviewing" | "result_view" | "detail_view";

export const useReviewStore = defineStore("review", () => {
  // ── state(闭源 R:623 起) ──
  const pageState = ref<ReviewPageState>("input_ready");
  const reviewing = ref(false);
  const currentStep = ref(0);
  const stepMessage = ref("");
  const reviewSteps = ref<Array<{ key: number; label: string; done: boolean }>>([
    { key: 1, label: "审稿进行中", done: false }
  ]);
  const currentJobId = ref("");
  // paper 六元组
  const paperTitle = ref("");
  const paperContent = ref("");
  const paperFileName = ref("");
  const paperSourceFileId = ref("");
  const paperSourceType = ref(""); // txt/pdf/docx
  // settings
  const settings = ref<ReviewSettings>({ strictness: "standard", journalId: null, standardIds: [], customRequirements: "", modelId: "" });
  const result = ref<ReviewResult | null>(null);
  const errorMessage = ref("");

  // ── derived(闭源 R:663-675) ──
  const overallScore = computed(() => result.value?.overallScore ?? 0);
  const grade = computed(() => result.value?.grade ?? "");
  const dimensions = computed(() => result.value?.dimensions ?? []);
  const annotations = computed(() => result.value?.annotations ?? []);
  const topSuggestions = computed(() => result.value?.topSuggestions ?? []);
  const highlights = computed(() => result.value?.highlights ?? []);

  const issueStats = computed(() => {
    const stats = { major: 0, minor: 0, suggestion: 0 };
    for (const d of dimensions.value) {
      for (const iss of d.issues ?? []) {
        const sev = iss.severity ?? "";
        if (sev === "major" || sev === "error") stats.major++;
        else if (sev === "minor" || sev === "warning") stats.minor++;
        else if (sev === "suggestion" || sev === "info") stats.suggestion++;
      }
    }
    return stats;
  });

  // ── 页面切换(闭源 setPaper/resetPaper/showResult/showDetail/backToInput/backToResult) ──
  function setPaper(p: { title?: string; content?: string; fileName?: string; sourceFileId?: string; sourceType?: string }) {
    if (p.title !== undefined) paperTitle.value = p.title;
    if (p.content !== undefined) paperContent.value = p.content;
    if (p.fileName !== undefined) paperFileName.value = p.fileName;
    if (p.sourceFileId !== undefined) paperSourceFileId.value = p.sourceFileId;
    if (p.sourceType !== undefined) paperSourceType.value = p.sourceType;
  }
  function resetPaper() {
    paperTitle.value = "";
    paperContent.value = "";
    paperFileName.value = "";
    paperSourceFileId.value = "";
    paperSourceType.value = "";
    result.value = null;
    currentJobId.value = "";
    errorMessage.value = "";
  }
  function showResult() {
    pageState.value = "result_view";
    reviewing.value = false;
  }
  function showDetail() {
    pageState.value = "detail_view";
  }
  function backToInput() {
    pageState.value = "input_ready";
    reviewing.value = false;
  }
  function backToResult() {
    pageState.value = "result_view";
  }

  function resetAll() {
    resetPaper();
    settings.value = { strictness: "standard", journalId: null, standardIds: [], customRequirements: "", modelId: "" };
    pageState.value = "input_ready";
    reviewing.value = false;
    currentStep.value = 0;
    stepMessage.value = "";
    currentJobId.value = "";
  }

  // ── 五级容错 JSON 解析(闭源 parseFinalResult R:768-816 + jsonrepair 状态机语义) ──
  function parseFinalResult(text: string): { ok: boolean; value?: unknown; raw?: string } {
    const src = String(text ?? "").trim();
    if (!src) return { ok: false, raw: src };
    // 1) 直解
    try {
      return { ok: true, value: JSON.parse(src) };
    } catch { /* 下一级 */ }
    // 2) 剥 ```json 围栏 + 弯引号 + 注释
    let s = src.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/^\s*\/\/.*$/gm, "");
    try {
      return { ok: true, value: JSON.parse(s) };
    } catch { /* 下一级 */ }
    // 3) 大括号平衡: 首个 { 到末个 }
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first >= 0 && last > first) {
      const cand = s.slice(first, last + 1);
      try {
        return { ok: true, value: JSON.parse(cand) };
      } catch { /* 下一级 */ }
    }
    // 4) 字符串修复(引号配对): 截断到最后一个成对引号后补 }
    try {
      let depth = 0;
      let inStr = false;
      let cut = -1;
      for (let i = first; i <= last; i++) {
        const ch = s[i];
        if (inStr) {
          if (ch === "\\") { i++; continue; }
          if (ch === '"') inStr = false;
        } else if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) { cut = i; break; }
        }
      }
      if (cut > first) {
        const repaired = s.slice(first, cut + 1);
        try {
          return { ok: true, value: JSON.parse(repaired) };
        } catch { /* 下一级 */ }
      }
    } catch { /* 忽略 */ }
    // 5) 兜底 rawOutput
    return { ok: false, raw: src };
  }

  // ── 快照(闭源 collectState/restoreFromState; 任务侧栏) ──
  function collectState(): Record<string, unknown> {
    return {
      pageState: pageState.value,
      paperTitle: paperTitle.value,
      paperContent: paperContent.value.slice(0, 50_000),
      paperFileName: paperFileName.value,
      paperSourceFileId: paperSourceFileId.value,
      paperSourceType: paperSourceType.value,
      settings: settings.value,
      result: result.value,
      currentJobId: currentJobId.value
    };
  }
  function restoreFromState(state: Record<string, unknown>): void {
    if (!state) return;
    const s = state as Record<string, unknown>;
    if (s.pageState) pageState.value = s.pageState as ReviewPageState;
    paperTitle.value = String(s.paperTitle ?? "");
    paperContent.value = String(s.paperContent ?? "");
    paperFileName.value = String(s.paperFileName ?? "");
    paperSourceFileId.value = String(s.paperSourceFileId ?? "");
    paperSourceType.value = String(s.paperSourceType ?? "");
    if (s.settings) settings.value = { ...settings.value, ...(s.settings as ReviewSettings) };
    if (s.result) result.value = s.result as ReviewResult;
    if (s.currentJobId) currentJobId.value = String(s.currentJobId);
  }

  return {
    pageState, reviewing, currentStep, stepMessage, reviewSteps, currentJobId,
    paperTitle, paperContent, paperFileName, paperSourceFileId, paperSourceType,
    settings, result, errorMessage,
    overallScore, grade, dimensions, annotations, topSuggestions, highlights, issueStats,
    setPaper, resetPaper, showResult, showDetail, backToInput, backToResult, resetAll,
    parseFinalResult, collectState, restoreFromState
  };
});

/** 严格度三档文案(闭源 radio 形态) */
export const STRICTNESS_OPTIONS = [
  { value: "lax", label: "宽松", desc: "以鼓励为主, 主要问题提示" },
  { value: "standard", label: "标准", desc: "期刊编辑视角, 全面指出问题" },
  { value: "strict", label: "严格", desc: "审稿人苛刻视角, 逐条深挖" }
];

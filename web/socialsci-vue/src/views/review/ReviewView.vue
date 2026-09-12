<script setup lang="ts">
/**
 * ReviewView — 还原自闭源 ReviewView-B4QyxKEn.js(R:36724-37255) 容器 + 4 页面状态机
 * input_ready(输入设置)/reviewing(审稿动画)/result_view(评分卡)/detail_view(原文对照)
 * 提交链: 校验 → 建任务 → POST review/jobs → SSE review.started/status/delta/completed → 收敛 getJob
 */
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useReviewStore, STRICTNESS_OPTIONS } from "./stores/review";
import type { ReviewResult } from "./stores/review";
import { createReviewJob, listReviewJobs, getReviewJob, cancelReviewJob, retryReviewJob, deleteReviewJob, extractFileText, listJournals, listStandards, streamReviewJob, getReviewModels, setReviewModel, exportReviewHtml, exportReviewWord } from "./reviewApi";
import type { JournalRecord, StandardRecord } from "./reviewApi";
import { toast, confirmDialog } from "@/shared/ui";
import { ensureModuleTask } from "@/shared/tasks";
import { relativeTime } from "@/shared/constants";

const store = useReviewStore();
/** 单次审稿字数上限(与后端 MAX_REVIEW_CHARS 一致) */
const MAX_REVIEW_CHARS = 120_000;
const route = useRoute();
const router = useRouter();

// ── 输入页状态 ──
const inputTab = ref<"paste" | "upload">("paste");
const pastedText = ref("");
const uploadFileName = ref("");
const uploadChunked = ref(false);
const submitting = ref(false);
const journals = ref<JournalRecord[]>([]);
const standards = ref<StandardRecord[]>([]);
const jobs = ref<Array<{ id: string; title: string; status: string; created_at?: string; attempt_index?: number }>>([]);
// 往期审稿分页: 原先写死取 20 条, 更多的永远看不到(且界面不提示还有更多)
const JOB_PAGE = 20;
const jobsTotal = ref(0);
const jobsLoading = ref(false);
const hasMoreJobs = computed(() => jobs.value.length < jobsTotal.value);
// 审稿模型: 空 = 用平台默认(角色 editor)
const llmModels = ref<Array<{ id: string; label: string; provider: string; desc: string }>>([]);
// 重审链: 后端向上追链给出 attempt_index(0=首次), prevJobId 用于跳回上一版结果
const attemptIndex = ref(0);
const prevJobId = ref("");

const canSubmit = computed(() => {
  const text = store.paperContent;
  if (inputTab.value === "paste") return pastedText.value.trim().length >= 100;
  return text.trim().length >= 100 && !!uploadFileName.value;
});

function onPasteInput() {
  store.setPaper({ content: pastedText.value, title: pastedText.value.slice(0, 40), sourceType: "txt" });
}

async function onFileSelected(file: File) {
  if (!file) return;
  uploadFileName.value = file.name;
  try {
    toast("正在提取文本…", "info");
    const r = await extractFileText(file);
    store.setPaper({ content: r.text, title: file.name.replace(/\.[^.]+$/, ""), fileName: file.name, sourceFileId: r.fileId, sourceType: r.metadata?.sourceType ?? "txt" });
    uploadChunked.value = (r.metadata?.reviewChunkCount ?? 1) > 1;
    if (r.metadata?.truncated) {
      toast(`文档较长, 仅提取前 ${r.metadata.extractedPages ?? "?"}/${r.metadata.pageCount ?? "?"} 页`, "warning");
    }
    if (!r.text || r.text.trim().length < 100) {
      // 清掉状态: 否则文件卡片显示"✓ 已读取"而实际没取到正文, 用户不知道该怎么办
      uploadFileName.value = "";
      store.setPaper({ content: "", title: "", fileName: "", sourceFileId: "", sourceType: "" });
      toast("提取文本不足 100 字, 请改用粘贴或检查文件", "error");
      return;
    }
    toast(`文本提取完成(${r.text.length} 字)`, "success");
  } catch (e) {
    toast(`提取失败: ${(e as Error).message}`, "error");
  }
}

// ── 设置项 ──
const journalOptions = computed(() => journals.value);
const standardOptions = computed(() => standards.value);
function selectJournal(id: string) {
  store.settings.journalId = id || null;
}
function toggleStandard(id: string) {
  const arr = [...store.settings.standardIds];
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(id);
  store.settings.standardIds = arr;
}

/**
 * 合并后的维度预览(2026-09-12)。
 *
 * 由来: 真实场景是"期刊格式规范 + 学科通用标准"叠加, 但面板只做了单选(select), 后端的
 *   standardIds[] 多选逻辑一直是死的。改多选后用户必须能看清"叠加是什么结果" ——
 *   否则他不知道第二个标准是加维度还是被第一个吃掉。
 *
 * **必须与后端同款去重规则**(review-service.createReviewJob): 按 key||name 去重, **先选的优先**
 *   (seen 集合首个见到的保留), 后选的同 key 维度被丢弃。这里算错就会骗用户。
 */
function normWeight(d: { weight?: number; weightLabel?: number }): number {
  const wl = Number(d.weightLabel);
  if (Number.isFinite(wl) && wl > 0) return wl;
  const w = Number(d.weight);
  return Number.isFinite(w) ? w : 1;
}
const mergedDimensions = computed(() => {
  const seen = new Set<string>();
  const out: Array<{ name: string; weight: number; from: string; overridden: boolean }> = [];
  for (const id of store.settings.standardIds) {
    const std = standards.value.find((s) => (s.id ?? s.name) === id);
    if (!std) continue;
    for (const d of std.dimensions ?? []) {
      const k = String(d.name ?? "").trim().toLowerCase().replace(/[\s_\-()（）]/g, "");
      if (!k) continue;
      if (seen.has(k)) { out.push({ name: d.name, weight: normWeight(d), from: std.name, overridden: true }); continue; }
      seen.add(k);
      out.push({ name: d.name, weight: normWeight(d), from: std.name, overridden: false });
    }
  }
  return out;
});
/** 实际参与打分的维度 = 去掉被先选标准覆盖掉的同 key 项 */
const effectiveDimensions = computed(() => mergedDimensions.value.filter((d) => !d.overridden));
const weightSum = computed(() => effectiveDimensions.value.reduce((s, d) => s + d.weight, 0));

// ── 提交(闭源 _() R:37026-37064) ──
async function submitReview() {
  const text = store.paperContent.trim();
  if (text.length < 100) {
    toast("论文内容至少 100 字", "warning");
    return;
  }
  submitting.value = true;
  try {
    const { taskId } = await ensureModuleTask("review", store.paperTitle || "未命名审稿").catch(() => ({ taskId: "" as string }));
    const { job, truncated } = await createReviewJob({
      title: store.paperTitle || "未命名论文",
      content: text,
      settings: {
        strictness: store.settings.strictness,
        journalId: store.settings.journalId,
        standardIds: store.settings.standardIds,
        customRequirements: store.settings.customRequirements,
        // 随任务落库: 重审/重开历史任务都沿用同一个模型, 不会"当时用 A 审的, 重开走了默认模型"
        modelId: store.settings.modelId || undefined
      },
      sidebarTaskId: taskId || undefined,
      sourceFileId: store.paperSourceFileId || undefined
    });
    if (truncated) toast(`稿件超出单次审稿上限 ${MAX_REVIEW_CHARS} 字, 本次只审前 ${MAX_REVIEW_CHARS} 字`, "warning");
    store.currentJobId = job.id;
    store.reviewing = true;
    store.pageState = "reviewing";
    watchJob(job.id);
    void refreshJobs();
    void router.replace({ query: { jobId: job.id } });
  } catch (e) {
    toast(`提交失败: ${(e as Error).message}`, "error");
  } finally {
    submitting.value = false;
  }
}

// ── 进度轮询 + SSE(闭源 E() R:36886-36924) ──
let pollTimer: ReturnType<typeof setInterval> | null = null;
let sseCleanup: (() => void) | null = null;

// ── 审稿进度细化(2026-09-12) ──
// 原来只有"第 N/M 段", 看不出审的是论文哪一段、已发现多少问题。
// 字数区间用**全文字符偏移**, 用户对着原文按字数找更直观。
const segDetail = ref<{ segChars: number; segFrom: number; segTo: number; foundSoFar: number } | null>(null);
/** 段落总数只在 SSE 的 review.started/status 里带 —— store.reviewSteps 是静态的 3 步清单, 没有总数 */
const segTotal = ref(0);
/** 进度百分比: 段数为主口径(每段耗时差异大, 用字数会跳得很难看) */
const progressPct = computed(() => {
  if (!segTotal.value) return 0;
  return Math.min(100, Math.round(((store.currentStep + 1) / segTotal.value) * 100));
});

function watchJob(jobId: string) {
  // SSE
  const handle = streamReviewJob(jobId, {
    onStatus: (step, message, total, detail) => {
      store.currentStep = step;
      store.stepMessage = message;
      if (total) segTotal.value = total;
      if (detail) {
        segDetail.value = detail;
      } else if (total) {
        // 老后端不发细节: 至少让段落总数对得上, 别把上一次的残留显示出来
        segDetail.value = { segChars: 0, segFrom: 0, segTo: 0, foundSoFar: segDetail.value?.foundSoFar ?? 0 };
      }
      if (step === -1) store.stepMessage = message; // 汇总阶段
      else store.reviewSteps[0].done = step > 0;
    },
    onCompleted: (result) => {
      applyResult(result, jobId);
    },
    onError: () => {
      // SSE 断/终态事件缺失 → 轮询兜底已在跑
    }
  });
  sseCleanup = () => handle.controller.abort();
  // 轮询兜底(1.5s; SSE 无终态事件时收敛)
  pollTimer = setInterval(async () => {
    try {
      // 归属校验: 定时器只允许改动它自己那个任务 —— 防止任何残留 watcher 改写当前页面
      if (store.currentJobId !== jobId) return;
      const { job } = await getReviewJob(jobId);
      if (isDoneStatus(job.status)) {
        stopWatch();
        noteJob(job);
        const res = parseResult(job.result);
        if (res) applyResult(res, jobId);
        else {
          toast("审稿完成但结果解析失败", "error");
          store.backToInput();
        }
        restorePaperFromJob(job);
      } else if (job.status === "failed" || job.status === "cancelled") {
        stopWatch();
        store.reviewing = false;
        const msg = (job.error as { message?: string; userMessage?: string } | null)?.userMessage
          ?? (job.error as { message?: string } | null)?.message ?? "审稿任务失败";
        // 先回输入页再弹窗: 弹窗是单例, 若用户此时点了别的任务, 第二次 confirmDialog 会覆盖
        //   前一个的 resolve → 前一个 Promise 永不结算(实测会叠加两次弹窗)
        store.backToInput();
        if (job.status === "failed") {
          await confirmDialog({ message: msg, title: "审稿失败", okText: "知道了" });
        }
      } else {
        store.stepMessage = job.progress_message || (job.status === "queued" ? "等待审稿任务执行..." : "正在审稿...");
      }
    } catch { /* 容忍 */ }
  }, 1500);
}

function parseResult(res: unknown): ReviewResult | null {
  if (!res) return null;
  if (typeof res === "string") {
    const parsed = store.parseFinalResult(res);
    if (parsed.ok && parsed.value) return parsed.value as ReviewResult;
    return { paperTitle: store.paperTitle, wordCount: 0, overallScore: 0, grade: "", overallComment: "", dimensions: [], rawOutput: res, parseFailed: true };
  }
  return res as ReviewResult;
}

/** 任务元信息(第几次审 / 上一版) — 结果页要能看出"这是重审第 2 次" */
function noteJob(job: { attempt_index?: number; retry_of?: string | null } | null | undefined) {
  attemptIndex.value = Number(job?.attempt_index ?? 0) || 0;
  prevJobId.value = String(job?.retry_of ?? "");
}

function applyResult(result: ReviewResult, jobId: string, opts: { silent?: boolean } = {}) {
  stopWatch();
  store.result = result;
  store.pageState = "result_view";
  store.reviewing = false;
  if (!opts.silent) toast("审稿完成", "success");
  void router.replace({ query: { jobId } });
  void refreshJobs();
}

/** 审稿进程态: 后端用 running/segmenting/summarizing/streaming 表示"真的在跑",
 *  UI 只认 running 会让刷新恢复后停在输入页(报告出来了也不显示)。 */
const ACTIVE_STATUS = ["queued", "running", "segmenting", "summarizing", "streaming", "paused"];
const isDoneStatus = (s: string) => s === "done" || s === "completed";
/** 徽标/文案按状态归类(后端状态远多于 done/failed 两个) */
const JOB_STATE_LABEL: Record<string, string> = {
  done: "已完成", running: "审稿中", queued: "排队中", failed: "失败", cancelled: "已取消",
};
function jobStateKind(s: string): "done" | "running" | "queued" | "failed" | "cancelled" {
  if (isDoneStatus(s)) return "done";
  if (s === "failed" || s === "cancelled" || s === "queued") return s;
  return "running";
}

/** 从任务行补回原文与标题: 刷新后 store.paperContent 是空的,
 *  详情页「原文对照」会定位不到任何批注(实测只显示"⚠ 未能在原文定位该批注")。 */
let restoreTriedFor = "";
function restorePaperFromJob(job: { id?: string; title?: string; source_file_name?: string; source_file_type?: string }) {
  if (store.paperContent) return;
  const id = String(job.id ?? store.currentJobId ?? "");
  if (!id || restoreTriedFor === id) return;
  restoreTriedFor = id;
  void (async () => {
    try {
      const { job: full } = await getReviewJob(id);
      const text = (full as { text_snapshot?: string })?.text_snapshot ?? "";
      if (!text) return;
      store.setPaper({
        content: text,
        title: store.paperTitle || job.title || full.title || "",
        fileName: job.source_file_name || store.paperFileName,
        sourceType: job.source_file_type || store.paperSourceType || "txt",
      });
    } catch { /* 容忍: 定位不到只是降级, 不影响报告 */ }
  })();
}

function startWatching(jobId: string) {
  // 必须先停掉上一个 watcher: watchJob 会覆盖模块级 pollTimer/sseCleanup,
  //   旧任务(B)的定时器就永远清不掉了 —— 它之后完成时会用 B 的结果覆盖当前页面
  //   (实测路径: 审稿中点开另一个 running 任务)
  stopWatch();
  store.currentJobId = jobId;
  store.pageState = "reviewing";
  store.reviewing = true;
  watchJob(jobId);
}

function stopWatch() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  sseCleanup?.();
  sseCleanup = null;
}

async function cancelReview() {
  if (!store.currentJobId) return;
  await cancelReviewJob(store.currentJobId).catch(() => null);
  stopWatch();
  store.reviewing = false;
  store.pageState = "input_ready";
  toast("审稿已取消", "warning");
  void router.replace({ query: {} });
}

/** 回到上一版结果(重审后对比用) */
async function openPrevAttempt() {
  if (!prevJobId.value) return;
  try {
    const { job } = await getReviewJob(prevJobId.value);
    store.currentJobId = job.id;
    noteJob(job);
    const res = parseResult(job.result);
    if (res) applyResult(res, job.id, { silent: true });
    restorePaperFromJob(job);
    void router.replace({ query: { jobId: job.id } });
  } catch { toast("上一版结果不存在", "warning"); }
}

// ── 结果纵向对比(2026-09-12) ──
// 原来只有「查看上一版结果」= 跳过去看, 用户得自己记着两边差在哪。真实需求是改完再审后
// 关心"分数涨了没、哪些问题消掉了" —— 那就要**并排**。
// 数据结构已有: each job 的 retry_of 指向上一版, dimensions[].issues 是问题清单。
const compareOpen = ref(false);
const compareBase = ref<{ id: string; label: string; result: ReviewResult | null } | null>(null);
const compareLoading = ref(false);

/** 取上一版结果并进入对比视图 */
async function openCompare() {
  if (!prevJobId.value || compareLoading.value) return;
  compareLoading.value = true;
  try {
    const { job } = await getReviewJob(prevJobId.value);
    compareBase.value = {
      id: job.id,
      label: `第 ${Number((job as { attempt_index?: number }).attempt_index ?? 0) + 1} 次`,
      result: parseResult(job.result),
    };
    compareOpen.value = true;
  } catch (e) {
    toast(`读取上一版失败: ${(e as Error).message}`, "error");
  } finally {
    compareLoading.value = false;
  }
}
function closeCompare() {
  compareOpen.value = false;
  compareBase.value = null;
}

/** 维度得分对比: 按维度名对齐两版(维度名可能因换标准而变, 对不上的单独标出) */
const compareDimensions = computed(() => {
  const cur = store.result?.dimensions ?? [];
  const prev = compareBase.value?.result?.dimensions ?? [];
  const key = (s: string) => String(s ?? "").trim().toLowerCase();
  const prevMap = new Map(prev.map((d) => [key(d.name), d]));
  // 维度可能在一版有、另一版没有(换了标准), 所以两端都可空, 用 null 而非 0 ——
  //   0 会被读成"得分 0 分", 那是完全不同的意思
  const rows: Array<{ name: string; prev: number | null; cur: number | null; delta: number | null }> =
    cur.map((d) => {
      const p = prevMap.get(key(d.name));
      if (p) prevMap.delete(key(d.name));
      return { name: d.name, prev: p?.score ?? null, cur: d.score, delta: p ? d.score - p.score : null };
    });
  // 只在上一版出现过的维度(换标准时会这样): 如实列出, 标成"本版已移除"
  for (const p of prevMap.values()) rows.push({ name: p.name, prev: p.score, cur: null, delta: null });
  return rows;
});

/** 问题清单对比: 用 "维度+位置+建议前30字" 做指纹, 判断某条问题是否在新版里仍存在 */
const compareIssues = computed(() => {
  const grab = (r: ReviewResult | null) => {
    const out: Array<{ dim: string; severity: string; text: string }> = [];
    for (const d of r?.dimensions ?? []) {
      for (const i of d.issues ?? []) {
        const text = String(i.suggestion ?? i.comment ?? i.originalText ?? "").trim();
        if (!text) continue;
        out.push({ dim: String(d.name ?? ""), severity: String(i.severity ?? ""), text });
      }
    }
    return out;
  };
  const prev = grab(compareBase.value?.result ?? null);
  const cur = grab(store.result ?? null);
  const fp = (x: { dim: string; text: string }) => `${x.dim}::${x.text.slice(0, 30)}`;
  const curSet = new Set(cur.map(fp));
  const prevSet = new Set(prev.map(fp));
  return {
    fixed: prev.filter((p) => !curSet.has(fp(p))),      // 上一版有、本版没有 → 已解决(或被改写)
    remaining: cur.filter((c) => prevSet.has(fp(c))),   // 两版都有 → 仍存在
    added: cur.filter((c) => !prevSet.has(fp(c))),      // 本版新出现
  };
});
const compareScoreDelta = computed(() => {
  const p = compareBase.value?.result?.overallScore;
  const c = store.result?.overallScore;
  if (typeof p !== "number" || typeof c !== "number") return null;
  return Math.round((c - p) * 10) / 10;
});

async function retryJob() {
  if (!store.currentJobId) return;
  const { job } = await retryReviewJob(store.currentJobId);
  if (job?.id && job.id !== store.currentJobId) {
    void router.replace({ query: { jobId: job.id } });
    startWatching(job.id);
    toast("已重新发起审稿", "info");
  } else {
    toast("重新审稿未生效, 请回到输入页重新提交", "warning");
  }
}

// ── 审稿模板预设(2026-09-12) ──
// 每次审稿都要重新配"严格度+期刊+标准+额外要求+模型", 而常用组合就那么几套。
// 存 localStorage 而非后端: 这是**本机操作偏好**, 不是要跨设备同步的资产;
//   与标准库(真资产, 存库)分工明确。
const PRESET_KEY = "skf_review_presets";
interface ReviewPreset {
  name: string;
  strictness: string;
  journalId: string | null;
  standardIds: string[];
  customRequirements: string;
  /** 与 ReviewSettings.modelId 同为可选(空 = 平台默认) */
  modelId?: string;
}
const presets = ref<ReviewPreset[]>([]);
const presetName = ref("");
function loadPresets() {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    presets.value = Array.isArray(arr) ? arr.filter((p) => p && typeof p.name === "string") : [];
  } catch { presets.value = []; }
}
function savePresets() {
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets.value)); } catch { /* 配额满/隐私模式: 不阻断使用 */ }
}
/** 存当前设置为一套命名预设(同名覆盖, 不产生一堆重复条目) */
function savePreset() {
  const name = presetName.value.trim();
  if (!name) { toast("请先给模板起个名字", "warning"); return; }
  const p: ReviewPreset = {
    name,
    strictness: store.settings.strictness,
    journalId: store.settings.journalId,
    standardIds: [...store.settings.standardIds],
    customRequirements: store.settings.customRequirements,
    modelId: store.settings.modelId,
  };
  const i = presets.value.findIndex((x) => x.name === name);
  if (i >= 0) presets.value[i] = p;
  else presets.value.push(p);
  savePresets();
  presetName.value = "";
  toast(i >= 0 ? `已更新模板「${name}」` : `已保存模板「${name}」`, "success");
}
function applyPreset(p: ReviewPreset) {
  store.settings.strictness = p.strictness || "standard";
  store.settings.journalId = p.journalId ?? null;
  store.settings.standardIds = [...(p.standardIds ?? [])];
  store.settings.customRequirements = p.customRequirements ?? "";
  store.settings.modelId = p.modelId ?? "";
  toast(`已套用模板「${p.name}」`, "success");
}
async function removePreset(p: ReviewPreset) {
  const ok = await confirmDialog({ message: `删除审稿模板「${p.name}」?`, title: "删除模板", okText: "删除", danger: true });
  if (!ok) return;
  presets.value = presets.value.filter((x) => x.name !== p.name);
  savePresets();
}

// ── 人工复核层 + 偏好反哺(2026-09-12) ──
// AI 审完就结束了 —— 没人告诉它"这条我同意/这条是误报"。这里把用户的逐条判断沉淀下来,
// 并在下次审稿时把**被否定的模式**注入提示词, 让同一类误报收敛。
// 存 localStorage(按 jobId 分桶): 这是"我对这次结果的态度", 不是要长期归档的资产;
//   跨任务汇总出的偏好才是有价值的, 见 buildReviewPrefs。
const VERDICTS = [
  // ⚠ cls 而不是 key 直接当 class 用: 值必须是 "rv-v-*" 带前缀的。
  //   由来(2026-09-12 用户反馈"已修改这几个字出现在已修改的上面"): 这里原本
  //   `:class="[v.key, ...]"` → 第三个按钮拿到字面量 class `fixed`, 而本子工程启用了
  //   Tailwind(@tailwind utilities), 它扫描到源码里的 "fixed" 就生成了 `.fixed{position:fixed}`
  //   → 该按钮被抽成固定定位、脱离文档流跑回容器左上角, 压在「我的判断」上(实测坐标 x=779,
  //   与 label 完全重叠)。agree/disagree 侥幸没撞只是因为 Tailwind 没有同名工具类, 不是设计。
  //   带前缀后彻底避开 Tailwind 的类名空间; key 保持原名(它同时是 localStorage 里的存储值)。
  { key: "agree", cls: "rv-v-agree", label: "同意", hint: "这条问题确实存在" },
  { key: "disagree", cls: "rv-v-disagree", label: "不同意", hint: "误报 —— 下次别再提这类" },
  { key: "fixed", cls: "rv-v-fixed", label: "已修改", hint: "已按建议改过了" },
] as const;
type VerdictKey = (typeof VERDICTS)[number]["key"];
const VERDICT_KEY = "skf_review_verdicts";
/** { jobId: { [issueOrAnnId]: verdict } } */
const verdicts = ref<Record<string, Record<string, VerdictKey>>>({});

function loadVerdicts() {
  try {
    const raw = localStorage.getItem(VERDICT_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    verdicts.value = obj && typeof obj === "object" ? obj : {};
  } catch { verdicts.value = {}; }
}
function saveVerdicts() {
  try { localStorage.setItem(VERDICT_KEY, JSON.stringify(verdicts.value)); } catch { /* 配额满: 不阻断 */ }
}
const curVerdicts = computed<Record<string, VerdictKey>>(() => verdicts.value[store.currentJobId || ""] ?? {});
function verdictOf(id: string): VerdictKey | undefined {
  return curVerdicts.value[id];
}
function setVerdict(id: string, v: VerdictKey) {
  const job = store.currentJobId || "";
  if (!job) return;
  const bucket = { ...(verdicts.value[job] ?? {}) };
  // 再点一次同一档 = 撤销(避免误点后无法回到未表态)
  if (bucket[id] === v) delete bucket[id];
  else bucket[id] = v;
  verdicts.value = { ...verdicts.value, [job]: bucket };
  saveVerdicts();
}
const verdictCounts = computed(() => {
  const list = Object.values(curVerdicts.value);
  return {
    done: list.length,
    agree: list.filter((v) => v === "agree").length,
    disagree: list.filter((v) => v === "disagree").length,
    fixed: list.filter((v) => v === "fixed").length,
  };
});

/**
 * 跨任务汇总"被否定的模式" → 下次审稿的额外要求。
 *
 * 只反哺**否定项**(误报), 不反哺同意项: 同意的说明 AI 判得对, 无需调整;
 *   把同意项也塞进去只会让提示词越来越长、越来越像废话。
 * 用**批注正文**而非 id: 提示词里写 `ann-003` 对模型毫无信息量, 必须带上原文里的问题描述。
 */
const REVIEW_PREFS_HEADER = "【历史误报偏好(请避免重复提出这类问题)】";
/** 把 id 还原成可读描述: 优先取当前结果里的批注/问题文本 */
function verdictLabel(id: string): string | null {
  const ann = annotationsFlat.value.find((a) => a.id === id);
  if (ann) {
    const t = String(ann.comment || ann.suggestion || ann.highlightText || "").trim();
    if (t) return t.slice(0, 60);
  }
  for (const d of store.result?.dimensions ?? []) {
    for (const iss of d.issues ?? []) {
      if (iss.id === id) {
        const t = String(iss.suggestion || iss.comment || iss.originalText || "").trim();
        if (t) return t.slice(0, 60);
      }
    }
  }
  return null;
}
function buildReviewPrefs(): string {
  const recent: string[] = [];
  const buckets = Object.entries(verdicts.value);
  for (let i = buckets.length - 1; i >= 0 && recent.length < 8; i--) {
    for (const [id, v] of Object.entries(buckets[i][1])) {
      if (v !== "disagree") continue;
      // 跨任务时其他任务的文本取不到(只存了 id), 这时退化成"某条被否定的建议"而不是编内容
      const label = verdictLabel(id) ?? "一条被判定为误报的建议(原文未留存)";
      recent.push(`- ${label}`);
      if (recent.length >= 8) break;
    }
  }
  return recent.length ? `${REVIEW_PREFS_HEADER}\n${recent.join("\n")}` : "";
}
/** 把偏好并进额外要求(不覆盖用户自己写的内容) */
function applyPrefsToRequirements() {
  const prefs = buildReviewPrefs();
  if (!prefs) { toast("还没有标记为「不同意」的批注可反哺", "warning"); return; }
  const cur = store.settings.customRequirements || "";
  if (cur.includes(REVIEW_PREFS_HEADER)) { toast("额外要求里已经有偏好片段了", "info"); return; }
  store.settings.customRequirements = cur ? `${cur}\n\n${prefs}` : prefs;
  toast("已把历史误报偏好写入额外要求, 下次审稿生效", "success");
}

/** 与编辑器交接内容的 localStorage 键(?new=1 时被读取) */
const HANDOFF_KEY = "skf_doc_handoff";
/**
 * 把批注/建议写回学术文本编辑器(2026-09-12)。
 *
 * 信道选择: 跨视图是**同窗口路由切换**(/soc/#/review → /soc/#/editor), 不是 iframe。
 *   EditorView 的 message 监听要等 onMounted 才注册, 所以"先 postMessage 再跳"必丢;
 *   而"跳完再补发"只能盲猜时机(轮询假投递)。
 *   改用 localStorage 交接 + `?new=1`: 编辑器挂载时 handleRouteIntent 会读到并建新文档,
 *   时序上是**读方主动取**, 不依赖发送方猜测接收方是否就绪。
 */
function sendToEditor(markdown: string, title: string) {
  if (!markdown.trim()) { toast("没有可发送的内容", "warning"); return; }
  try {
    localStorage.setItem(HANDOFF_KEY, JSON.stringify({ markdown, title, at: Date.now() }));
  } catch {
    toast("写入失败(localStorage 不可用或已满)", "error");
    return;
  }
  void router.push({ path: "/editor", query: { new: "1" } });
  toast(`已发送到编辑器, 将新建文档「${title}」`, "success");
}

/** 选中的批注 → markdown 修改清单 */
function annotationsToMarkdown(): { md: string; title: string } {
  const chosen = annotationsFlat.value.filter((a) => verdictOf(a.id) === "agree" || verdictOf(a.id) === "fixed");
  const list = chosen.length ? chosen : annotationsFlat.value;
  const title = `${store.result?.paperTitle || "审稿报告"}-修改清单`;
  const lines: string[] = [
    `# ${title}`,
    "",
    `> 来源: 论文质量评审 · 综合评分 ${fmtScore(store.overallScore)} (${store.grade || "—"})`,
    chosen.length ? `> 仅包含我标记为「同意 / 已修改」的 ${chosen.length} 条` : `> 全部 ${annotationsFlat.value.length} 条批注`,
    "",
  ];
  for (const [i, a] of list.entries()) {
    lines.push(`## ${i + 1}. ${a.dimension || "批注"}`);
    if (a.location) lines.push(`- 位置: ${a.location}`);
    if (a.highlightText) lines.push(`- 原文: ${a.highlightText}`);
    if (a.comment) lines.push(`- 问题: ${a.comment}`);
    if (a.suggestion) lines.push(`- 建议: ${a.suggestion}`);
    lines.push("");
  }
  const sug = store.topSuggestions ?? [];
  if (sug.length) {
    lines.push("## 首要修改建议", "");
    for (const s of sug) lines.push(`- ${s}`);
    lines.push("");
  }
  return { md: lines.join("\n"), title };
}

/** 把该批注所在段落 + 建议合成一段可直接粘贴的修订稿 */
function annotationToPatch(a: { dimension?: string; highlightText?: string; suggestion?: string; comment?: string }): {
  md: string; title: string;
} {
  const title = `${store.result?.paperTitle || "稿件"}-${a.dimension || "批注"}-修订片段`;
  const md = [
    `# ${title}`,
    "",
    a.highlightText ? `**原文片段**\n\n${a.highlightText}\n` : "",
    a.comment ? `**问题**\n\n${a.comment}\n` : "",
    a.suggestion ? `**修改建议**\n\n${a.suggestion}\n` : "",
    "",
    "> 在下方直接改写这段文字, 完成后替换回原稿。",
  ].filter(Boolean).join("\n");
  return { md, title };
}

async function sendAllToEditor() {
  if (!annotationsFlat.value.length) { toast("本次审稿没有批注可发送", "warning"); return; }
  const { md, title } = annotationsToMarkdown();
  sendToEditor(md, title);
}

function sendOneToEditor() {
  const a = activeAnnotation.value;
  if (!a) { toast("请先选择一条批注", "warning"); return; }
  const { md, title } = annotationToPatch(a);
  sendToEditor(md, title);
}

// ── 报告导出(2026-09-12) ──
// 后端 export-word/export-html 路由一直存在, 前端 reviewApi 里也写了函数却**从未被调用** ——
// 报告只能看不能带走。原因之一是契约对不上(见 reviewApi.exportReviewHtml 注释), 已修。
const exporting = ref<"" | "html" | "word">("");
/** base64 → Blob 下载(Node/浏览器通用的"存文件"路径, 不依赖后端给 URL) */
function downloadBase64(base64: string, fileName: string, mime: string) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function safeName(base: string): string {
  return String(base || "审稿报告").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
}

/** HTML 报告: 新窗口打开(可直接 Ctrl+P 存 PDF) + 同时存一份文件, 两种用法都覆盖 */
async function exportHtml() {
  if (!store.currentJobId || exporting.value) return;
  exporting.value = "html";
  try {
    const html = await exportReviewHtml(store.currentJobId);
    const w = window.open("", "_blank");
    if (w) { w.document.write(html); w.document.close(); }
    // 弹窗被拦截时也要能拿到文件, 所以两个都给
    const b64 = btoa(unescape(encodeURIComponent(html)));
    downloadBase64(b64, `${safeName(store.result?.paperTitle ?? "")}-审稿报告.html`, "text/html;charset=utf-8");
    toast("已生成 HTML 报告(新窗口可直接打印存 PDF)", "success");
  } catch (e) {
    toast(`导出失败: ${(e as Error).message}`, "error");
  } finally {
    exporting.value = "";
  }
}

/** Word 批注报告: 直接下载 .docx */
async function exportWord() {
  if (!store.currentJobId || exporting.value) return;
  exporting.value = "word";
  try {
    const { base64, fileName } = await exportReviewWord(store.currentJobId);
    downloadBase64(base64, fileName || `${safeName(store.result?.paperTitle ?? "")}-审稿报告.docx`,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    toast("已导出 Word 批注报告", "success");
  } catch (e) {
    toast(`导出失败: ${(e as Error).message}`, "error");
  } finally {
    exporting.value = "";
  }
}

// ── 恢复(闭源 ?jobId= 恢复 / ?new=1 重置) ──
async function handleRouteIntent() {
  const query = route.query;
  await refreshJobs();
  if (query.new) {
    store.resetAll();
    void router.replace({ query: {} });
    return;
  }
  const jobId = query.jobId ? String(query.jobId) : store.currentJobId;
  if (jobId) {
    try {
      const { job } = await getReviewJob(jobId);
      if (isDoneStatus(job.status)) {
        store.currentJobId = job.id;
        noteJob(job);
        const res = parseResult(job.result);
        if (res) applyResult(res, job.id, { silent: true });
        else toast("审稿已完成但报告解析失败, 请到「往期审稿」重开该任务", "error");
        restorePaperFromJob(job);
      } else if (ACTIVE_STATUS.includes(job.status)) {
        startWatching(job.id);
      } else {
        const label = job.status === "failed" ? "失败" : job.status === "cancelled" ? "已取消" : job.status;
        const detail = String((job.error as { userMessage?: string })?.userMessage ?? "").slice(0, 80);
        toast(`该次审稿${label}${detail ? ": " + detail : ""}, 可回到输入重新审稿`, "warning");
      }
    } catch { /* job 不存在 → input */ }
  }
}

/** append=true 时追加下一页(「加载更多」); 否则重新拉第一页 */
async function refreshJobs(append = false) {
  if (jobsLoading.value) return;
  jobsLoading.value = true;
  try {
    const offset = append ? jobs.value.length : 0;
    const r = await listReviewJobs(JOB_PAGE, offset);
    const list = (r.jobs ?? []).map((j) => ({ id: j.id, title: j.title, status: j.status, created_at: j.created_at, attempt_index: j.attempt_index }));
    jobs.value = append ? [...jobs.value, ...list] : list;
    if (typeof r.total === "number") jobsTotal.value = r.total;
    else jobsTotal.value = jobs.value.length;   // 老后端没有 total → 不显示"加载更多"
  } catch { /* 容忍 */ } finally {
    jobsLoading.value = false;
  }
}

/** 切换审稿模型: 立即持久化(下次进页面即选中), 失败不阻断本次审稿 */
function onModelChange(id: string) {
  store.settings.modelId = id;
  void setReviewModel(id).catch(() => {});
}

/** 从往期列表直接重审(不必先打开报告再点重新审稿) */
async function retryFromHistory(j: { id: string; status: string }) {
  const r = await retryReviewJob(j.id).catch(() => null);
  const newId = (r as { job?: { id?: string } } | null)?.job?.id;
  if (!newId) {
    toast("重审未成功, 请打开该记录后重试", "warning");
    return;
  }
  toast("已重新提交审稿", "success");
  await refreshJobs();
  void router.replace({ query: { jobId: newId } });
  startWatching(newId);
}

/** 删除一条审稿记录(需确认; 删的是报告不是稿件原文) */
async function removeJob(j: { id: string; title?: string; status: string }) {
  const ok = await confirmDialog({
    message: `确定删除「${(j.title || "未命名").slice(0, 30)}」这条审稿记录? 报告与批注将一并删除, 不可恢复。`,
    title: "删除审稿记录",
    okText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteReviewJob(j.id);
  } catch (e) {
    // 失败要说清是哪种。用 ApiError.status 判定, 不要靠字符串匹配 —— 上一版就是那样,
    //   后端把 409 的文案换一下就误判了。
    const err = e as { status?: number; message?: string };
    if (err?.status === 409) toast("该任务正在执行或排队中, 请先取消审稿再删除", "warning");
    else if (err?.status === 404) toast("这条记录已不存在, 已为你刷新列表", "warning");
    else toast(`删除失败: ${err?.message ?? String(e)}`, "error");
    await refreshJobs();
    return;
  }
  // 删的正好是当前打开的这条 → 退回输入页, 否则界面停在已不存在的报告上
  if (store.currentJobId === j.id) {
    store.resetPaper();
    void router.replace({ query: {} });
  }
  toast("已删除", "success");
  await refreshJobs();
}

// ── 历史选择(闭源 rail 双击规则) ──
async function selectHistoryJob(job: { id: string; status: string }) {
  if (ACTIVE_STATUS.includes(job.status)) {
    void router.replace({ query: { jobId: job.id } });
    startWatching(job.id);
  } else if (isDoneStatus(job.status)) {
    const full = await getReviewJob(job.id).catch(() => null);
    if (!full) return;
    store.currentJobId = job.id;
    noteJob(full.job);
    const res = parseResult(full.job.result);
    if (res) applyResult(res, job.id, { silent: true });
    restorePaperFromJob({ ...full.job, id: job.id });
  } else {
    // failed/cancelled: 明确反馈(审查修复: 原静默落空, 用户反复点以为能重试)
    const full = await getReviewJob(job.id).catch(() => null);
    const label = job.status === "failed" ? "该次审稿执行失败" : "该次审稿已取消";
    const detail = full?.job?.error ? `: ${String((full.job.error as { userMessage?: string })?.userMessage ?? "").slice(0, 80)}` : "";
    toast(`${label}${detail}, 请在输入页重新提交(或点结果页「重新审稿」)`, "warning");
  }
}

// ── 详情页(原文对照) ──
const detailMode = ref<"side" | "annotation">("side");
const annotationsFlat = computed(() => {
  const out: Array<{ id: string; severity: string; dimension: string; highlightText: string; comment: string; suggestion?: string; location?: string }> = [];
  for (const d of store.dimensions) {
    for (const iss of d.issues ?? []) {
      out.push({
        id: iss.id ?? `i-${out.length}`,
        severity: iss.severity ?? "minor",
        dimension: d.name,
        highlightText: iss.originalText ?? iss.comment ?? "",
        comment: iss.comment ?? iss.suggestion ?? "",
        suggestion: iss.suggestion,
        location: iss.location
      });
    }
  }
  for (const a of store.annotations) {
    out.push({ id: a.id, severity: a.type === "error" ? "major" : a.type === "warning" ? "minor" : "suggestion", dimension: a.dimension, highlightText: a.highlightText, comment: a.comment });
  }
  return out;
});
const activeAnnIdx = ref(0);
const activeAnnotation = computed(() => annotationsFlat.value[activeAnnIdx.value] ?? null);

/** 去空白映射定位(闭源 txt 三级定位: 直接 indexOf → 空白归一 posMap → 首尾夹逼)
 *  先建"原文非空白字符 → 原文下标"映射表, 再在去空白串中找 needle, 经映射回原文区间 */
function highlightPosition(text: string): { start: number; len: number } | null {
  const src = store.paperContent;
  const hay: string[] = [];
  const map: number[] = []; // hay 字符下标 → src 下标
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (!/\s/.test(ch)) {
      map.push(i);
      hay.push(ch);
    }
  }
  const needle = (activeAnnotation.value?.highlightText ?? "").replace(/\s+/g, "");
  if (!needle) return null;
  const idx = hay.join("").indexOf(needle);
  if (idx < 0) return null;
  const start = map[idx];
  const end = map[idx + needle.length - 1];
  return { start, len: end - start + 1 };
}
const txtPreview = computed(() => {
  const pos = highlightPosition(store.paperContent);
  if (!pos) return { before: "", hit: activeAnnotation.value?.highlightText ?? "", after: "", found: false };
  const s = store.paperContent;
  return { before: s.slice(Math.max(0, pos.start - 40), pos.start), hit: s.slice(pos.start, pos.start + pos.len), after: s.slice(pos.start + pos.len, pos.start + pos.len + 80), found: true };
});

function navAnn(dir: 1 | -1) {
  const n = annotationsFlat.value.length;
  if (!n) return;
  activeAnnIdx.value = (activeAnnIdx.value + dir + n) % n;
}

// ── 结果页速览(问题分布 + 指标) ──
const issueTotal = computed(() =>
  store.issueStats.major + store.issueStats.minor + store.issueStats.suggestion);

const severitySegments = computed(() => [
  { key: "major", label: "严重", value: store.issueStats.major },
  { key: "minor", label: "一般", value: store.issueStats.minor },
  { key: "suggestion", label: "建议", value: store.issueStats.suggestion },
]);

const overviewMetrics = computed(() => [
  { icon: "◫", label: "评审维度", value: String(store.dimensions.length), hint: "本次审稿的评分维度数" },
  { icon: "✎", label: "正文字数", value: store.result?.wordCount ? String(store.result.wordCount) : "—", hint: "报告认定的正文字数" },
  { icon: "❝", label: "原文批注", value: String(store.annotations.length), hint: "可在「原文对照与批注」中逐条定位" },
  { icon: "◷", label: "审稿时间", value: relativeTime(store.result?.reviewedAt) || "—", hint: "本次审稿完成时间" },
]);

// ── 页面结构 ──
const curPage = computed(() => store.pageState);
const gradeMeta = computed(() => {
  const g = store.grade || "";
  const color = /^A/.test(g) ? "#5FD0B4" : /^B/.test(g) ? "#2563eb" : /^C/.test(g) ? "#E8B54A" : "#dc2626";
  return { color };
});
function fmtScore(n: number | undefined | null): string {
  if (n === undefined || n === null) return "—";
  return String(n);
}

// ── 批量审稿 + 横向对比(2026-09-12) ──
// 原来一次只能审一篇; 实际场景是"手头几篇都要过一遍, 最后横向对比"。
// 复用既有链路: extractFileText(逐篇提文) → createReviewJob(逐篇建任务) → 轮询汇总。
// 不新开 SSE: 每条流要占一个执行槽位(REVIEW_CONCURRENCY), 批量开流会把槽位抢光并拖慢每一篇;
//   轮询 /review/jobs 拿状态更稳, 用户也不必一直开着页面。
interface BatchItem {
  key: string;
  fileName: string;
  jobId: string | null;
  status: string;
  error: string;
  score: number | null;
  grade: string;
  result: ReviewResult | null;
}
const batchItems = ref<BatchItem[]>([]);
const batchRunning = ref(false);
const batchFileInput = ref<HTMLInputElement | null>(null);
let batchTimer: ReturnType<typeof setInterval> | null = null;

async function onBatchFiles(files: FileList | null) {
  if (!files?.length) return;
  batchItems.value = Array.from(files).map((f, i) => ({
    key: `${Date.now()}-${i}`, fileName: f.name, jobId: null, status: "pending", error: "", score: null, grade: "", result: null,
  }));
  batchRunning.value = true;
  try {
    // 逐篇提文+建任务。并发限 2: 提文要调后端解析(PDF 走 Python), 全量并发会把它打满
    const queue = Array.from(files);
    let idx = 0;
    const worker = async () => {
      while (idx < queue.length) {
        const myIdx = idx++;
        const item = batchItems.value[myIdx];
        try {
          const ex = await extractFileText(queue[myIdx]);
          const text = String(ex.text ?? "");
          if (text.trim().length < 100) throw new Error("提取到的正文少于 100 字, 无法审稿");
          const { job } = await createReviewJob({
            title: queue[myIdx].name.replace(/\.[^.]+$/, "") || "未命名论文",
            content: text,
            settings: {
              strictness: store.settings.strictness,
              journalId: store.settings.journalId,
              standardIds: [...store.settings.standardIds],
              customRequirements: store.settings.customRequirements,
              modelId: store.settings.modelId || undefined,
            },
            sourceFileId: ex.fileId || undefined,
          });
          item.jobId = job.id;
          item.status = "queued";
        } catch (e) {
          item.status = "failed";
          item.error = (e as Error).message;
        }
      }
    };
    await Promise.all([worker(), worker()]);
    const created = batchItems.value.filter((b) => b.jobId).length;
    if (!created) { toast("没有成功创建任何审稿任务", "error"); return; }
    toast(`已提交 ${created} 篇, 正在审稿…`, "success");
    startBatchPoll();
  } finally {
    batchRunning.value = false;
  }
}

/** 轮询批量任务状态: 全部到终态就停(不无限轮询) */
function startBatchPoll() {
  stopBatchPoll();
  batchTimer = setInterval(() => { void pollBatch(); }, 5000);
  void pollBatch();
}
function stopBatchPoll() {
  if (batchTimer) clearInterval(batchTimer);
  batchTimer = null;
}
async function pollBatch() {
  const pending = batchItems.value.filter((b) => b.jobId && !["done", "completed", "failed", "cancelled"].includes(b.status));
  if (!pending.length) { stopBatchPoll(); return; }
  try {
    const r = await listReviewJobs(100, 0);
    const byId = new Map((r.jobs ?? []).map((j) => [j.id, j]));
    for (const item of batchItems.value) {
      if (!item.jobId) continue;
      const j = byId.get(item.jobId);
      if (!j) continue;
      item.status = j.status;
      const res = parseResult((j as { result?: unknown }).result);
      if (res) {
        item.result = res;
        item.score = typeof res.overallScore === "number" ? res.overallScore : null;
        item.grade = res.grade ?? "";
      }
    }
    const stillPending = batchItems.value.some((b) => b.jobId && !["done", "completed", "failed", "cancelled"].includes(b.status));
    if (!stillPending) {
      stopBatchPoll();
      const ok = batchItems.value.filter((b) => b.result).length;
      toast(`批量审稿完成: ${ok}/${batchItems.value.length} 篇有结果`, ok ? "success" : "warning");
    }
  } catch { /* 单次轮询失败不终止, 下一轮再试 */ }
}
/** 横向对比表按分数降序(没有分数的排后面, 失败的最后) */
const batchSorted = computed(() => [...batchItems.value].sort((a, b) => {
  const av = a.score ?? -1, bv = b.score ?? -1;
  return bv - av;
}));
/** 打开某一篇的完整报告 */
async function openBatchItem(item: BatchItem) {
  if (!item.jobId) return;
  store.currentJobId = item.jobId;
  try {
    const { job } = await getReviewJob(item.jobId);
    noteJob(job);
    const res = parseResult(job.result);
    if (res) applyResult(res, item.jobId, { silent: true });
    restorePaperFromJob(job);
    void router.replace({ query: { jobId: item.jobId } });
  } catch { toast("打开失败", "error"); }
}
function clearBatch() {
  stopBatchPoll();
  batchItems.value = [];
}
/** 批量对比: 各篇在关键指标上的横向差异 */
const batchCompareRows = computed(() => {
  const withResult = batchSorted.value.filter((b) => b.result);
  if (withResult.length < 2) return [];
  const cells = (pick: (r: ReviewResult) => string) => withResult.map((b) => pick(b.result as ReviewResult) || "—");
  const issueCount = (r: ReviewResult) => (r.dimensions ?? []).reduce((n, d) => n + (d.issues?.length ?? 0), 0);
  return [
    { label: "综合评分", cells: cells((r) => String(r.overallScore ?? "")) },
    { label: "等级", cells: cells((r) => r.grade ?? "") },
    { label: "字数", cells: cells((r) => (r.wordCount ? String(r.wordCount) : "")) },
    { label: "维度数", cells: cells((r) => String((r.dimensions ?? []).length)) },
    { label: "问题总数", cells: cells((r) => String(issueCount(r))) },
    { label: "批注数", cells: cells((r) => String((r.annotations ?? []).length)) },
    { label: "各维度得分", cells: cells((r) => (r.dimensions ?? []).map((d) => `${d.name} ${d.score}`).join(" · ")) },
  ];
});

onMounted(() => {
  loadPresets();
  loadVerdicts();
  void handleRouteIntent();
  void listJournals().then((r) => { journals.value = (r.data ?? r.journals ?? []) as JournalRecord[]; }).catch(() => {});
  void listStandards().then((r) => { standards.value = (r.data ?? r.standards ?? []) as StandardRecord[]; }).catch(() => {});
  // 审稿模型(角色 editor): 只列已配密钥的; 未选则用平台默认
  void getReviewModels().then((r) => {
    llmModels.value = r.models;
    // 未选过则落到平台当前值, 再退到第一个可用模型(空字符串=后端默认, 也允许)
    store.settings.modelId = store.settings.modelId || r.current || r.models[0]?.id || "";
  }).catch(() => {});
});
onUnmounted(() => { stopWatch(); stopBatchPoll(); });
</script>

<template>
  <div class="review-workspace">
    <div class="review-workspace__main">
      <!-- ═══ 纵向对比漂浮面板(2026-09-12) ═══ -->
      <div v-if="compareOpen && compareBase" class="cmp-overlay" @click.self="closeCompare">
        <div class="cmp-panel">
          <div class="cmp-head">
            <strong>{{ compareBase.label }} → 第 {{ attemptIndex + 1 }} 次</strong>
            <span v-if="compareScoreDelta !== null" class="cmp-delta" :class="compareScoreDelta >= 0 ? 'up' : 'down'">
              {{ compareScoreDelta >= 0 ? "▲" : "▼" }} {{ Math.abs(compareScoreDelta) }} 分
            </span>
            <span v-else class="cmp-delta flat">两次分数不可比</span>
            <span class="cmp-summary">
              已解决 {{ compareIssues.fixed.length }} · 仍存在 {{ compareIssues.remaining.length }} · 新出现 {{ compareIssues.added.length }}
            </span>
            <button class="cmp-close" @click="closeCompare">×</button>
          </div>

          <div class="cmp-body">
            <div class="cmp-block">
              <strong>各维度得分</strong>
              <table class="cmp-tbl">
                <thead><tr><th>维度</th><th>上一版</th><th>本次</th><th>变化</th></tr></thead>
                <tbody>
                  <tr v-for="(r, i) in compareDimensions" :key="i">
                    <td class="cmp-dim">{{ r.name }}</td>
                    <td>{{ r.prev ?? "—" }}</td>
                    <td>{{ r.cur ?? "—" }}</td>
                    <td :class="r.delta === null ? '' : (r.delta >= 0 ? 'cmp-up' : 'cmp-down')">
                      {{ r.delta === null ? "—" : (r.delta >= 0 ? "+" : "") + r.delta }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="cmp-block">
              <strong class="cmp-fixed-t">✓ 已解决({{ compareIssues.fixed.length }})</strong>
              <div v-if="!compareIssues.fixed.length" class="cmp-none">上一版没有已消解的问题</div>
              <div v-for="(x, i) in compareIssues.fixed" :key="'f' + i" class="cmp-issue fixed">
                <span class="cmp-issue-dim">{{ x.dim }}</span>{{ x.text.slice(0, 90) }}
              </div>
            </div>

            <div class="cmp-block">
              <strong class="cmp-remain-t">● 仍存在({{ compareIssues.remaining.length }})</strong>
              <div v-if="!compareIssues.remaining.length" class="cmp-none">没有重复出现的问题</div>
              <div v-for="(x, i) in compareIssues.remaining" :key="'r' + i" class="cmp-issue remain">
                <span class="cmp-issue-dim">{{ x.dim }}</span>{{ x.text.slice(0, 90) }}
              </div>
            </div>

            <div class="cmp-block">
              <strong class="cmp-added-t">+ 新出现({{ compareIssues.added.length }})</strong>
              <div v-if="!compareIssues.added.length" class="cmp-none">本版没有新问题</div>
              <div v-for="(x, i) in compareIssues.added" :key="'a' + i" class="cmp-issue added">
                <span class="cmp-issue-dim">{{ x.dim }}</span>{{ x.text.slice(0, 90) }}
              </div>
            </div>
          </div>

          <p class="cmp-foot">
            问题按「维度 + 建议前 30 字」匹配; 改了措辞的同一条问题可能被算作"已解决 + 新出现", 请注意甄别。
          </p>
        </div>
      </div>

      <!-- ═══ 输入页 ═══ -->
      <div v-if="curPage === 'input_ready'" class="review-input-page">
        <div class="page-head">
          <div>
            <h1 class="page-title">论文审稿</h1>
            <p class="page-sub">AI 多维度学术评审 · 期刊标准 + 审稿维度 + 原文批注</p>
          </div>
          <router-link to="/review/library" class="lib-link">审稿库 →</router-link>
        </div>

        <div class="input-card">
          <div class="input-tabs">
            <button :class="{ active: inputTab === 'paste' }" @click="inputTab = 'paste'">粘贴文本</button>
            <button :class="{ active: inputTab === 'upload' }" @click="inputTab = 'upload'">上传文件</button>
            <!-- 批量入口提到 tab 层(2026-09-12): 放在"上传文件"里时默认视图看不到,
                 而它的价值恰恰是"一次多篇" —— 藏起来等于没有 -->
            <label class="batch-tab">
              <input type="file" multiple accept=".txt,.md,.docx,.pdf" style="display: none" @change="(ev) => { void onBatchFiles((ev.target as HTMLInputElement).files); (ev.target as HTMLInputElement).value = ''; }" />
              <span>{{ batchRunning ? "提交中…" : "批量审稿(多选)" }}</span>
            </label>
          </div>

          <template v-if="inputTab === 'paste'">
            <textarea v-model="pastedText" class="paste-area" placeholder="在此粘贴论文全文(至少 100 字)…" @input="onPasteInput"></textarea>
            <div class="input-hint">{{ pastedText.length }} 字</div>
          </template>
          <template v-else>
            <label class="upload-zone">
              <input type="file" accept=".txt,.md,.docx,.pdf" style="display: none" @change="(ev) => { const f = (ev.target as HTMLInputElement).files?.[0]; if (f) void onFileSelected(f); (ev.target as HTMLInputElement).value = ''; }" />
              <div class="upload-zone-inner">
                <span class="upload-icon">📄</span>
                <p>{{ uploadFileName || "点击选择文件(支持 .pdf 文字版 / .docx / .txt)" }}</p>
                <p v-if="uploadFileName" class="upload-done">✓ 已读取</p>
              </div>
            </label>
            <div v-if="uploadChunked" class="chunk-note">文档较长, 将分 {{ Math.ceil((store.paperContent.length || 1) / 2000) }} 段审稿后汇总全文结论</div>
          </template>

          <!-- 批量进度与横向对比表 -->
          <div v-if="batchItems.length" class="batch-panel">
            <div class="bp-head">
              <strong>批量审稿({{ batchItems.length }} 篇)</strong>
              <span class="bp-stat">
                完成 {{ batchItems.filter((b) => b.result).length }}
                · 进行中 {{ batchItems.filter((b) => b.jobId && !b.result && b.status !== "failed").length }}
                · 失败 {{ batchItems.filter((b) => b.status === "failed").length }}
              </span>
              <button class="ghost-btn sm" @click="clearBatch">清空</button>
            </div>

            <table class="batch-tbl">
              <thead>
                <tr><th>论文</th><th>状态</th><th>评分</th><th>等级</th><th></th></tr>
              </thead>
              <tbody>
                <tr v-for="b in batchSorted" :key="b.key">
                  <td class="bt-name" :title="b.fileName">{{ b.fileName }}</td>
                  <td>
                    <span class="bt-status" :class="'st-' + jobStateKind(b.status)">{{ b.status }}</span>
                  </td>
                  <td class="bt-score">{{ b.score ?? (b.status === "failed" ? "—" : "…") }}</td>
                  <td>{{ b.grade || "—" }}</td>
                  <td>
                    <button v-if="b.result" class="mini-btn" @click="openBatchItem(b)">查看报告</button>
                    <span v-else-if="b.error" class="bt-err" :title="b.error">{{ b.error.slice(0, 30) }}</span>
                  </td>
                </tr>
              </tbody>
            </table>

            <div v-if="batchCompareRows.length" class="bp-compare">
              <strong>横向对比({{ batchSorted.filter((b) => b.result).length }} 篇有结果)</strong>
              <table class="batch-tbl">
                <thead>
                  <tr>
                    <th class="bt-label-col">指标</th>
                    <th v-for="b in batchSorted.filter((x) => x.result)" :key="b.key" :title="b.fileName">{{ b.fileName.slice(0, 14) }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in batchCompareRows" :key="row.label">
                    <td class="bt-label-col">{{ row.label }}</td>
                    <td v-for="(c, i) in row.cells" :key="i" class="bt-cell">{{ c }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="settings-block">
            <!-- 模板预设: 常用组合一键套用, 免去每次重配五项 -->
            <div class="preset-bar">
              <span class="preset-label">审稿模板</span>
              <button
                v-for="p in presets"
                :key="p.name"
                class="preset-chip"
                :title="`严格度 ${p.strictness} · ${p.standardIds.length} 个标准 · ${p.journalId ? '已选刊物' : '未选刊物'}`"
                @click="applyPreset(p)"
              >
                {{ p.name }}
                <span class="preset-del" title="删除该模板" @click.stop="removePreset(p)">×</span>
              </button>
              <span v-if="!presets.length" class="preset-empty">把下面配好后存成模板, 下次一键套用</span>
              <input v-model="presetName" class="preset-input" placeholder="模板名, 如「马理论严格审」" @keydown.enter="savePreset" />
              <button class="ghost-btn sm" :disabled="!presetName.trim()" @click="savePreset">存为模板</button>
            </div>
            <div class="setting-row">
              <label class="setting-label">严格度</label>
              <div class="strictness-options">
                <button
                  v-for="o in STRICTNESS_OPTIONS"
                  :key="o.value"
                  class="strictness-btn"
                  :class="{ active: store.settings.strictness === o.value }"
                  @click="store.settings.strictness = o.value"
                >
                  <strong>{{ o.label }}</strong>
                  <small>{{ o.desc }}</small>
                </button>
              </div>
            </div>
            <div class="setting-row">
              <label class="setting-label">选用刊物</label>
              <select class="setting-select" :value="store.settings.journalId ?? ''" @change="selectJournal(($event.target as HTMLSelectElement).value)">
                <option value="">(不选用)</option>
                <option v-for="j in journalOptions" :key="j.id ?? j.name" :value="j.id ?? j.name">{{ j.name }}</option>
              </select>
              <router-link to="/review/library" class="setting-link">管理期刊库</router-link>
            </div>
            <div class="setting-row std-row">
              <label class="setting-label">
                审核标准
                <span v-if="store.settings.standardIds.length" class="label-badge">{{ store.settings.standardIds.length }} 个</span>
              </label>
              <div class="std-picker">
                <div v-if="!standardOptions.length" class="std-empty">
                  标准库还是空的。去<router-link to="/review/library" class="setting-link">标准库</router-link>粘贴评审细则生成, 或用模板导入。
                </div>
                <label v-for="s in standardOptions" :key="s.id ?? s.name" class="std-opt" :class="{ on: store.settings.standardIds.includes(s.id ?? s.name) }">
                  <input
                    type="checkbox"
                    :checked="store.settings.standardIds.includes(s.id ?? s.name)"
                    @change="toggleStandard(s.id ?? s.name)"
                  />
                  <span class="std-name">{{ s.name }}</span>
                  <span v-if="s.isDefault" class="std-flag">默认</span>
                  <span class="std-dims">{{ (s.dimensions ?? []).length }} 维</span>
                </label>
              </div>
              <span class="setting-note">
                可多选叠加(如「期刊格式规范 + 学科通用标准」)。同维度名时<strong>先选的优先</strong>, 后来者被忽略。
              </span>
            </div>

            <!-- 合并预览: 多选后必须让用户看清"叠加到底是什么结果", 否则不知道第二个标准加没加进去 -->
            <div v-if="store.settings.standardIds.length" class="merge-preview">
              <div class="mp-head">
                <strong>合并后实际参与打分: {{ effectiveDimensions.length }} 维</strong>
                <span class="mp-sum">权重合计 {{ weightSum }}</span>
              </div>
              <div class="mp-dims">
                <span
                  v-for="(d, i) in mergedDimensions"
                  :key="i"
                  class="mp-chip"
                  :class="{ off: d.overridden }"
                  :title="d.overridden ? `与先选标准同维度, 已被忽略(来自「${d.from}」)` : `来自「${d.from}」`"
                >
                  {{ d.name }}<span class="mp-w">{{ d.weight }}</span>
                </span>
              </div>
              <span v-if="mergedDimensions.some((d) => d.overridden)" class="mp-note">
                划掉的是与先选标准重名、已被忽略的维度。
              </span>
            </div>
            <div class="setting-row">
              <label class="setting-label">额外要求</label>
              <textarea v-model="store.settings.customRequirements" class="setting-textarea" placeholder="例如: 重点检查实证方法是否规范、结论是否有数据支撑…"></textarea>
              <button class="ghost-btn sm prefs-btn" title="把历史被标为「不同意」的批注汇总成提示, 让下次审稿少提这类问题" @click="applyPrefsToRequirements">
                注入历史误报偏好
              </button>
            </div>
            <div class="setting-row">
              <label class="setting-label">审稿模型</label>
              <select
                class="setting-select"
                :value="store.settings.modelId"
                @change="onModelChange(($event.target as HTMLSelectElement).value)"
              >
                <option v-for="m in llmModels" :key="m.id" :value="m.id">{{ m.label }}</option>
                <option v-if="!llmModels.length" value="">(使用平台默认)</option>
              </select>
              <span class="setting-note">{{ llmModels.find((m) => m.id === store.settings.modelId)?.desc ?? "未探测到已配密钥的模型, 将走平台默认" }}</span>
            </div>
          </div>

          <div class="submit-row">
            <button class="primary-btn" :disabled="!canSubmit || submitting" @click="submitReview">
              {{ submitting ? "提交中…" : "开始审稿" }}
            </button>
          </div>
        </div>

        <!-- 往期审稿 -->
        <div class="history-block">
          <div class="history-head">
            <strong>往期审稿</strong>
            <span v-if="jobs.length" class="hh-hint">点击任意一条查看报告</span>
            <span class="hh-count">{{ jobsTotal ? `已显示 ${jobs.length} / 共 ${jobsTotal} 条` : `${jobs.length} 条` }}</span>
          </div>
          <div v-if="jobs.length" class="history-list">
            <div
              v-for="j in jobs"
              :key="j.id"
              class="history-item"
              :class="{ 'is-current': j.id === store.currentJobId }"
              role="button"
              tabindex="0"
              :title="`查看「${(j.title || '未命名').slice(0, 40)}」的审稿报告`"
              @click="selectHistoryJob(j)"
              @keydown.enter="selectHistoryJob(j)"
            >
              <span class="h-status" :class="'hs-' + jobStateKind(j.status)"></span>
              <span class="h-title">{{ (j.title || '未命名').slice(0, 40) }}</span>
              <span v-if="(j.attempt_index ?? 0) > 0" class="h-attempt">第 {{ (j.attempt_index ?? 0) + 1 }} 次</span>
              <span class="h-status-label">{{ JOB_STATE_LABEL[jobStateKind(j.status)] }}</span>
              <span class="h-time">{{ relativeTime(j.created_at) }}</span>
              <!-- 动作区: 默认淡出, hover/聚焦时才显出来(不干扰浏览, 但明确告诉用户"这条有操作") -->
              <span class="h-actions" @click.stop>
                <button class="h-act" title="重审这份稿" @click.stop="retryFromHistory(j)">重审</button>
                <button class="h-act danger" title="删除这条记录" @click.stop="removeJob(j)">删除</button>
              </span>
              <span class="h-chevron" aria-hidden="true">›</span>
            </div>
          </div>
          <div v-else class="history-empty">暂无审稿记录</div>
          <button v-if="hasMoreJobs" class="more-btn" :disabled="jobsLoading" @click="refreshJobs(true)">
            {{ jobsLoading ? "加载中…" : `加载更多(还有 ${jobsTotal - jobs.length} 条)` }}
          </button>
        </div>
      </div>

      <!-- ═══ 审稿中 ═══ -->
      <div v-else-if="curPage === 'reviewing'" class="review-progress-page">
        <div class="progress-hero">
          <div class="progress-ring"><span class="ring-spinner"></span></div>
          <h2>正在审稿</h2>
          <p>{{ store.stepMessage || "等待审稿任务执行..." }}</p>

          <!-- 进度细化(2026-09-12): 进度条 + 当前段落位置 + 已发现问题数 -->
          <div v-if="segTotal" class="prog-detail">
            <div class="prog-track"><div class="prog-fill" :style="{ width: progressPct + '%' }"></div></div>
            <div class="prog-meta">
              <span class="prog-pct">{{ progressPct }}%</span>
              <span v-if="segDetail?.segChars" class="prog-seg">
                本段 第 {{ segDetail.segFrom }}–{{ segDetail.segTo }} 字 · {{ segDetail.segChars }} 字
              </span>
              <span v-if="segDetail?.foundSoFar" class="prog-found">
                已发现 {{ segDetail.foundSoFar }} 个问题
              </span>
            </div>
          </div>

          <div class="progress-steps">
            <div class="p-step" :class="{ active: store.currentStep >= 0 }">分段审阅</div>
            <div class="p-step" :class="{ active: store.currentStep === -1 }">汇总评分</div>
            <div class="p-step">生成报告</div>
          </div>
          <button class="cancel-btn" @click="cancelReview">取消审稿</button>
        </div>
      </div>

      <!-- ═══ 结果页 ═══ -->
      <div v-else-if="curPage === 'result_view'" class="review-result-page">
        <div class="result-head">
          <div class="score-block">
            <div class="big-score" :style="{ color: gradeMeta.color }">{{ fmtScore(store.overallScore) }}</div>
            <div class="grade-badge" :style="{ background: gradeMeta.color }">{{ store.grade || "—" }}</div>
            <div class="score-label">综合评分</div>
          </div>
          <div class="result-summary">
            <h2>{{ store.result?.paperTitle || "审稿结果" }}</h2>
            <div v-if="attemptIndex > 0" class="attempt-bar">
              <span class="attempt-badge">第 {{ attemptIndex + 1 }} 次审稿</span>
              <button v-if="prevJobId" class="attempt-link" @click="openCompare">
                {{ compareLoading ? "读取中…" : "与上一版对比" }}
              </button>
              <button v-if="prevJobId" class="attempt-link" @click="openPrevAttempt">查看上一版结果</button>
            </div>
            <p>{{ store.result?.overallComment || store.result?.overall || "" }}</p>
            <div class="result-actions">
              <button class="secondary-btn" @click="store.showDetail()">原文对照与批注</button>
              <button class="secondary-btn" :disabled="!annotationsFlat.length" title="把批注整理成修改清单, 在编辑器中新建文档打开" @click="sendAllToEditor">
                发到编辑器
              </button>
              <button class="secondary-btn" :disabled="exporting === 'html'" @click="exportHtml">
                {{ exporting === "html" ? "导出中…" : "导出 HTML" }}
              </button>
              <button class="secondary-btn" :disabled="exporting === 'word'" @click="exportWord">
                {{ exporting === "word" ? "导出中…" : "导出 Word 批注" }}
              </button>
              <button class="secondary-btn" @click="retryJob">重新审稿</button>
              <button class="secondary-btn" @click="store.backToInput()">返回输入</button>
            </div>
          </div>
        </div>

        <!-- 速览条: 问题分布 / 维度数 / 篇幅 —— store.issueStats 本来就算了, 此前没被用上 -->
        <div class="overview-panel">
          <!-- 问题分布: 按比例画条, 比并排三个数字更快看出"问题集中在哪一档" -->
          <div class="ov-severity">
            <div class="ov-sev-head">
              <span class="ov-sev-title">问题分布</span>
              <span class="ov-sev-total">共 {{ issueTotal }} 条</span>
            </div>
            <div class="ov-sev-bar" v-if="issueTotal > 0">
              <div
                v-for="seg in severitySegments"
                :key="seg.key"
                class="ov-seg"
                :class="'seg-' + seg.key"
                :style="{ width: (seg.value / issueTotal * 100) + '%' }"
                :title="`${seg.label} ${seg.value} 条`"
              ></div>
            </div>
            <div class="ov-sev-empty" v-else>本次审稿未提出具体问题</div>
            <div class="ov-sev-legend">
              <span v-for="seg in severitySegments" :key="seg.key" class="lg-item">
                <i class="lg-dot" :class="'seg-' + seg.key"></i>{{ seg.label }}
                <b>{{ seg.value }}</b>
              </span>
            </div>
          </div>
          <!-- 其余指标: 图标 + 数值, 扫一眼即可 -->
          <div class="ov-metrics">
            <div v-for="m in overviewMetrics" :key="m.label" class="ov-metric" :title="m.hint">
              <span class="ov-ico">{{ m.icon }}</span>
              <span class="ov-val">{{ m.value }}</span>
              <span class="ov-lab">{{ m.label }}</span>
            </div>
          </div>
        </div>

        <div v-if="store.result?.parseFailed" class="parse-warn">
          ⚠ 模型输出未能解析成报告结构, 以下是原始返回(不是"0 分", 请重试或改用工整的稿件格式)
          <pre class="raw-output">{{ store.result?.rawOutput || "(无原文)" }}</pre>
        </div>

        <!-- 维度条 -->
        <div class="dimension-grid">
          <div v-for="(d, i) in store.dimensions" :key="i" class="dimension-card">
            <div class="dim-head">
              <strong>{{ d.name }}</strong>
              <span class="dim-score" :style="{ color: Number(d.score ?? 0) >= 80 ? '#5FD0B4' : Number(d.score ?? 0) >= 60 ? '#E8B54A' : '#dc2626' }">{{ fmtScore(d.score) }}</span>
            </div>
            <div class="dim-bar">
              <div class="dim-bar-fill" :style="{ width: Math.min(100, Number(d.score ?? 0)) + '%', background: Number(d.score ?? 0) >= 80 ? '#5FD0B4' : Number(d.score ?? 0) >= 60 ? '#E8B54A' : '#dc2626' }"></div>
            </div>
            <p class="dim-summary">{{ d.summary }}</p>
            <div v-if="d.issues?.length" class="dim-issues">
              <div v-for="(iss, j) in d.issues.slice(0, 4)" :key="j" class="dim-issue">
                <span class="sev-dot" :class="'sev-' + (iss.severity ?? 'minor')"></span>
                <span class="issue-text">{{ iss.comment || iss.suggestion || "" }}</span>
              </div>
              <div v-if="(d.issues?.length ?? 0) > 4" class="more-issues" @click="store.showDetail()">还有 {{ (d.issues?.length ?? 0) - 4 }} 条…</div>
            </div>
          </div>
        </div>

        <!-- 亮点 / 首要建议 -->
        <div class="result-columns">
          <div v-if="store.highlights?.length" class="highlights-card">
            <h3>论文亮点</h3>
            <ul>
              <li v-for="(h, i) in store.highlights" :key="i">{{ h }}</li>
            </ul>
          </div>
          <div v-if="store.topSuggestions?.length" class="suggestions-card">
            <h3>首要修改建议</h3>
            <ol>
              <li v-for="(s, i) in store.topSuggestions" :key="i">{{ s }}</li>
            </ol>
          </div>
        </div>
      </div>

      <!-- ═══ 原文对照 ═══ -->
      <div v-else-if="curPage === 'detail_view'" class="review-detail-page">
        <div class="detail-head">
          <button class="back-btn" title="回到本次审稿的评分结果" @click="store.backToResult()">← 回到审稿结果</button>
          <strong>原文对照与批注</strong>
          <span class="ann-count">{{ annotationsFlat.length }} 条批注</span>
        </div>
        <div class="detail-body">
          <div class="source-col">
            <div class="source-tabs">
              <button :class="{ active: detailMode === 'side' }" @click="detailMode = 'side'">批注定位</button>
            </div>
            <div class="source-text">
              <template v-if="activeAnnotation">
                <p v-if="!txtPreview.found" class="no-locate">⚠ 未能在原文定位该批注</p>
                <p class="ctx-before">{{ txtPreview.before }}</p>
                <mark class="ann-highlight" :class="'sev-' + (activeAnnotation.severity ?? 'minor')">{{ txtPreview.hit }}</mark>
                <p class="ctx-after">{{ txtPreview.after }}</p>
              </template>
              <p v-else class="no-locate">暂无批注</p>
            </div>
          </div>
          <div class="ann-col">
            <div v-if="activeAnnotation" class="ann-card">
              <div class="ann-head">
                <span class="sev-chip" :class="'sev-' + (activeAnnotation.severity ?? 'minor')">{{ activeAnnotation.severity === 'major' ? '严重' : activeAnnotation.severity === 'minor' ? '一般' : '建议' }}</span>
                <span class="ann-dim">{{ activeAnnotation.dimension }}</span>
              </div>
              <div v-if="activeAnnotation.location" class="ann-loc">位置: {{ activeAnnotation.location }}</div>
              <p class="ann-comment">{{ activeAnnotation.comment }}</p>
              <p v-if="activeAnnotation.suggestion" class="ann-suggestion">建议: {{ activeAnnotation.suggestion }}</p>

              <!-- 人工复核(2026-09-12): AI 审完, 用户逐条表态; 统计结果反哺下次审稿的提示词 -->
              <div class="review-verdict">
                <span class="rv-label">我的判断</span>
                <button
                  v-for="v in VERDICTS"
                  :key="v.key"
                  class="rv-btn"
                  :class="[v.cls, { on: verdictOf(activeAnnotation.id) === v.key }]"
                  :title="v.hint"
                  @click="setVerdict(activeAnnotation.id, v.key)"
                >{{ v.label }}</button>
                <button class="rv-send" title="把这条批注整理成修订片段, 在编辑器中新建文档打开" @click="sendOneToEditor">
                  发到编辑器改写
                </button>
              </div>
            </div>
            <div v-else class="ann-empty">选择批注查看详情</div>
            <div class="ann-nav">
              <button @click="navAnn(-1)">← 上一条</button>
              <span>{{ annotationsFlat.length ? activeAnnIdx + 1 + ' / ' + annotationsFlat.length : '0 / 0' }}</span>
              <button @click="navAnn(1)">下一条 →</button>
            </div>
            <!-- 复核进度: 让人知道还剩多少条没看, 否则容易半途而废 -->
            <div v-if="annotationsFlat.length" class="rv-progress">
              <span class="rvp-bar"><span class="rvp-fill" :style="{ width: (verdictCounts.done / annotationsFlat.length * 100) + '%' }"></span></span>
              <span class="rvp-text">
                已复核 {{ verdictCounts.done }}/{{ annotationsFlat.length }}
                · 同意 {{ verdictCounts.agree }} · 不同意 {{ verdictCounts.disagree }} · 已改 {{ verdictCounts.fixed }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.review-workspace {
  width: 100%;
  max-width: none;
  font-family: PingFang SC, Microsoft YaHei, sans-serif;
  background: #1A2333;
  /* 滚动容器必须是这一层: 外层 .soc-shell 是 height:100vh + overflow:hidden,
     用 min-height:100vh 时内容比视口高 → 容器把多余部分交给 body 滚动, 而 body 不可滚 → 直接截断。
     height:100%(=视口) + overflow-y:auto 让内容在这一层滚。 */
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
.review-workspace__main {
  min-width: 0;
  padding: 24px;
  flex: 1;
}
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 18px;
}
.page-title { margin: 0; font-size: 22px; font-weight: 700; color: #E8EEF7; }
.page-sub { margin: 4px 0 0; font-size: 12.5px; color: #8B9BB1; }
.lib-link {
  font-size: 13px;
  color: #2563eb;
  text-decoration: none;
  padding: 6px 14px;
  border: 1px solid #bfdbfe;
  border-radius: 8px;
}
.input-card {
  background: #11192C;
  border: 1px solid #222F44;
  border-radius: 14px;
  padding: 20px;
  margin-bottom: 20px;
}
.input-tabs { display: flex; gap: 4px; margin-bottom: 14px; }
.input-tabs button {
  padding: 7px 18px;
  border: 0;
  border-radius: 8px;
  background: #212C45;
  color: #8B9BB1;
  font-size: 13px;
  cursor: pointer;
}
.input-tabs button.active { background: #4D84CB; color: #F1F5F9; font-weight: 600; }
.paste-area {
  width: 100%;
  min-height: 220px;
  box-sizing: border-box;
  border: 1px solid #222F44;
  border-radius: 10px;
  padding: 12px;
  font-size: 13px;
  line-height: 1.7;
  font-family: inherit;
  resize: vertical;
}
.input-hint { font-size: 11px; color: #7A8AA0; text-align: right; margin-top: 4px; }
.upload-zone {
  display: block;
  border: 2px dashed #c7d2fe;
  border-radius: 10px;
  background: linear-gradient(135deg, #1C2740, #241F38);
  cursor: pointer;
  transition: all 0.2s;
}
.upload-zone:hover { border-color: #8BA4F0; }
.upload-zone-inner { padding: 34px; text-align: center; }
.upload-icon { font-size: 32px; }
.upload-zone-inner p { margin: 6px 0; font-size: 13px; color: #8B9BB1; }
.upload-done { color: #5FD0B4 !important; font-weight: 600; }
.chunk-note {
  margin-top: 8px;
  padding: 7px 11px;
  background: #11192Cbeb;
  border: 1px solid #3A3020;
  border-radius: 7px;
  font-size: 12px;
  color: #E8B54A;
}
.settings-block { margin-top: 16px; display: flex; flex-direction: column; gap: 12px; }
.setting-row { display: flex; align-items: center; gap: 10px; }
.setting-label { width: 80px; flex-shrink: 0; font-size: 13px; font-weight: 600; color: #E8EEF7; }
.strictness-options { display: flex; gap: 8px; flex: 1; }
.strictness-btn {
  flex: 1;
  padding: 9px 10px;
  border: 1.5px solid #222F44;
  border-radius: 9px;
  background: #11192C;
  cursor: pointer;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.strictness-btn.active { border-color: #4D84CB; background: #16233A; }
.strictness-btn strong { font-size: 13px; color: #E8EEF7; }
.strictness-btn small { font-size: 10.5px; color: #7A8AA0; }
.setting-select {
  flex: 1;
  padding: 7px 10px;
  border: 1px solid #222F44;
  border-radius: 8px;
  font-size: 13px;
  background: #11192C;
}
.setting-link { font-size: 12px; color: #7EB0E8; text-decoration: none; white-space: nowrap; }
.setting-textarea {
  flex: 1;
  padding: 7px 10px;
  border: 1px solid #222F44;
  border-radius: 8px;
  font-size: 13px;
  font-family: inherit;
  min-height: 44px;
  resize: vertical;
}
/* 模型说明: 与下拉同行, 空间不够时换行(不撑破 setting-row) */
.setting-note { flex-basis: 100%; font-size: 11px; color: #7A8AA0; line-height: 1.4; padding-left: 2px; }
/* 往期审稿「加载更多」: 次按钮观感, 与列表项同宽 */
.more-btn {
  margin-top: 8px;
  width: 100%;
  padding: 7px;
  border: 1px dashed #2A3A55;
  border-radius: 8px;
  background: transparent;
  color: #8B9BB1;
  font-size: 12px;
  cursor: pointer;
}
.more-btn:hover:not(:disabled) { border-color: #4D84CB; color: #7EB0E8; }
.more-btn:disabled { cursor: wait; opacity: .7; }
.submit-row { margin-top: 18px; display: flex; justify-content: flex-end; }
.primary-btn {
  padding: 10px 34px;
  background: #4D84CB;
  color: #F1F5F9;
  border: 0;
  border-radius: 9px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.primary-btn:hover { background: #5D94DB; }
.primary-btn:disabled { background: #46587A; cursor: not-allowed; }
.history-block {
  background: #11192C;
  border: 1px solid #222F44;
  border-radius: 14px;
  padding: 16px;
}
.history-head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 10px;
}
.history-head strong { font-size: 14px; color: #E8EEF7; }
.history-head span { font-size: 11px; color: #7A8AA0; }
.history-list { display: flex; flex-direction: column; gap: 4px; }
.hh-hint { font-size: 11px; color: #5D94DB; margin-left: auto; margin-right: 10px; }
.hh-count { font-size: 11px; color: #7A8AA0; }
/* 每条记录: 有边框有底色(此前是"裸文字", 看不出是可点的行), hover 时左缘亮起 + 右侧箭头前移 */
.history-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid #222F44;
  border-left: 3px solid transparent;
  background: #11192C;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  text-align: left;
  transition: border-color .15s, background .15s, transform .15s;
}
.history-item:hover {
  background: #16233A;
  border-color: #2E4A74;
  border-left-color: #4D84CB;
}
.history-item:hover .h-chevron { color: #7EB0E8; transform: translateX(2px); }
.history-item:focus-visible { outline: 2px solid #4D84CB; outline-offset: 1px; }
/* 当前正打开的那条: 常亮, 免得用户不知道自己在看哪一条 */
.history-item.is-current { border-left-color: #5FD0B4; background: #13251F; }
.h-actions { display: flex; gap: 4px; flex-shrink: 0; }
/* 常驻可见(不藏 hover —— 触屏点不到, 而且用户已经明确说"删除按钮也没有") */
.h-act {
  border: 1px solid #26364F; background: #131C30; color: #7E93AD;
  border-radius: 6px; padding: 2px 8px; font-size: 11px; cursor: pointer;
  transition: border-color .15s, color .15s;
}
.history-item:hover .h-act { border-color: #2E4A74; color: #A9CDF5; }
.h-act:hover { border-color: #4D84CB; color: #DCE6F2; }
.h-act.danger { border-color: #3A2528; background: #1D1517; color: #A4656A; }
.history-item:hover .h-act.danger { border-color: #5A2E32; color: #E2686A; }
.h-act.danger:hover { border-color: #E2686A; color: #F0A0A2; }
.h-chevron { color: #46587A; font-size: 16px; line-height: 1; transition: color .15s, transform .15s; }
.h-status { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.hs-done, .hs-completed { background: #5FD0B4; }
.hs-failed { background: #dc2626; }
.hs-running { background: #2563eb; animation: blink 1.2s infinite; }
.hs-cancelled { background: #94a3b8; }
.hs-queued { background: #94a3b8; }
@keyframes blink { 50% { opacity: 0.3; } }
.h-title { flex: 1; color: #DCE6F2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.h-status-label { font-size: 11px; color: #8B9BB1; }
.h-time { font-size: 11px; color: #7A8AA0; }
.history-empty { padding: 20px; text-align: center; color: #7A8AA0; font-size: 12.5px; }
.review-progress-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 70vh;
}
.progress-hero { text-align: center; }
.progress-ring { width: 72px; height: 72px; margin: 0 auto 14px; display: grid; place-items: center; }
.ring-spinner {
  width: 56px;
  height: 56px;
  border: 4px solid #222F44;
  border-top-color: #4D84CB;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.progress-hero h2 { margin: 8px 0 4px; font-size: 18px; color: #E8EEF7; }
.progress-hero p { font-size: 13px; color: #8B9BB1; }
.progress-steps { display: flex; justify-content: center; gap: 12px; margin: 16px 0; }
.p-step {
  padding: 5px 13px;
  border-radius: 16px;
  font-size: 12px;
  background: #212C45;
  color: #7A8AA0;
}
.p-step.active { background: #16233A; color: #7EB0E8; font-weight: 600; }
.cancel-btn {
  padding: 7px 20px;
  border: 1px solid #222F44;
  border-radius: 8px;
  background: #11192C;
  color: #8B9BB1;
  cursor: pointer;
  font-size: 13px;
}
.result-head {
  display: flex;
  gap: 26px;
  align-items: flex-start;
  background: #11192C;
  border: 1px solid #222F44;
  border-radius: 14px;
  padding: 24px;
  margin-bottom: 18px;
}
.score-block { text-align: center; flex-shrink: 0; }
.big-score { font-size: 52px; font-weight: 800; line-height: 1; }
.grade-badge {
  display: inline-block;
  margin-top: 6px;
  padding: 3px 14px;
  border-radius: 14px;
  color: #F1F5F9;
  font-size: 15px;
  font-weight: 700;
}
.score-label { font-size: 11px; color: #7A8AA0; margin-top: 5px; }
.result-summary { flex: 1; min-width: 0; }
/* 长 URL/连续英文会把整页撑破, 而外层是 overflow-x:hidden → 内容被直接裁掉 */
.result-summary h2, .result-summary p { overflow-wrap: anywhere; word-break: break-word; }
.dim-summary, .ann-comment, .issue-text { overflow-wrap: anywhere; }
.raw-output {
  margin: 10px 0 0; padding: 12px; max-height: 320px; overflow: auto;
  background: #0F1830; border-radius: 8px; font-size: 12px; line-height: 1.6;
  color: #B8C6DA; white-space: pre-wrap; overflow-wrap: anywhere;
}
.attempt-bar { display: flex; align-items: center; gap: 10px; margin: 6px 0 4px; }
.attempt-badge {
  font-size: 11.5px; padding: 2px 10px; border-radius: 10px;
  background: #212C45; color: #9DB2CE; border: 1px solid #2E3D57;
}
.attempt-link {
  border: 0; background: transparent; color: #6FA6E8; font-size: 12px;
  cursor: pointer; padding: 0; text-decoration: underline;
}
.h-attempt {
  font-size: 10.5px; color: #9DB2CE; background: #212C45;
  padding: 1px 7px; border-radius: 8px; flex-shrink: 0;
}
.result-summary h2 { margin: 0 0 8px; font-size: 18px; color: #E8EEF7; }
.result-summary p { font-size: 13.5px; line-height: 1.75; color: #DCE6F2; }
.result-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.secondary-btn {
  padding: 6px 14px;
  border: 1px solid #222F44;
  border-radius: 8px;
  background: #11192C;
  color: #DCE6F2;
  font-size: 12.5px;
  cursor: pointer;
}
.secondary-btn:hover { border-color: #4D84CB; color: #7EB0E8; }
.parse-warn {
  padding: 9px 13px;
  background: #2A1C1C;
  border: 1px solid #3A2323;
  border-radius: 8px;
  color: #dc2626;
  font-size: 12px;
  margin-bottom: 14px;
}
/* ═══ 结果页速览面板 ═══
   左: 问题严重度分布条(按比例, 一眼看出问题集中在哪一档)
   右: 图标指标卡。此前只把数字和标签平铺出来, 没有层级也没有视觉区分。 */
.overview-panel {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) minmax(320px, 1.1fr);
  gap: 14px;
  margin: 4px 0 18px;
}
.ov-severity {
  background: #11192C; border: 1px solid #222F44; border-radius: 12px;
  padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
}
.ov-sev-head { display: flex; align-items: baseline; gap: 8px; }
.ov-sev-title { font-size: 13px; font-weight: 600; color: #E8EEF7; }
.ov-sev-total { font-size: 11.5px; color: #7A8AA0; margin-left: auto; }
.ov-sev-bar {
  display: flex; height: 10px; border-radius: 5px; overflow: hidden;
  background: #1A2333; gap: 2px;
}
.ov-seg { height: 100%; transition: width .3s ease; min-width: 2px; }
.ov-seg.seg-major { background: linear-gradient(90deg, #E2686A, #cf4a4d); }
.ov-seg.seg-minor { background: linear-gradient(90deg, #E8B54A, #d29f33); }
.ov-seg.seg-suggestion { background: linear-gradient(90deg, #5D94DB, #4D84CB); }
.ov-sev-empty { font-size: 12px; color: #5FD0B4; padding: 4px 0; }
.ov-sev-legend { display: flex; flex-wrap: wrap; gap: 14px; }
.lg-item { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: #8B9BB1; }
.lg-item b { color: #E8EEF7; font-size: 12.5px; }
.lg-dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.lg-dot.seg-major { background: #E2686A; }
.lg-dot.seg-minor { background: #E8B54A; }
.lg-dot.seg-suggestion { background: #4D84CB; }
.ov-metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.ov-metric {
  background: #11192C; border: 1px solid #222F44; border-radius: 12px;
  padding: 12px 14px; display: grid;
  grid-template-columns: auto 1fr; grid-template-rows: auto auto;
  column-gap: 10px; align-items: center;
}
.ov-ico {
  grid-row: 1 / span 2; font-size: 17px; color: #4D84CB;
  width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
  background: #16233A; border-radius: 8px;
}
.ov-val { font-size: 19px; font-weight: 700; color: #E8EEF7; line-height: 1.15; }
.ov-lab { font-size: 11px; color: #7A8AA0; }
@media (max-width: 900px) {
  .overview-panel { grid-template-columns: 1fr; }
  .ov-metrics { grid-template-columns: repeat(2, 1fr); }
}
.dimension-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}
.dimension-card {
  background: #11192C;
  border: 1px solid #222F44;
  border-radius: 12px;
  padding: 14px;
}
.dim-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.dim-head strong { font-size: 14px; color: #E8EEF7; }
.dim-score { font-size: 20px; font-weight: 800; }
.dim-bar { height: 6px; background: #222F44; border-radius: 3px; overflow: hidden; }
.dim-bar-fill { height: 100%; border-radius: 3px; }
.dim-summary { font-size: 12.5px; color: #8B9BB1; line-height: 1.6; margin: 8px 0; }
.dim-issues { display: flex; flex-direction: column; gap: 5px; }
.dim-issue { display: flex; gap: 6px; font-size: 12px; color: #8B9BB1; align-items: flex-start; }
.sev-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-top: 5px;
  flex-shrink: 0;
}
.sev-major, .sev-error { background: #dc2626; }
.sev-minor, .sev-warning { background: #E8B54A; }
.sev-suggestion, .sev-info { background: #94a3b8; }
.issue-text { line-height: 1.5; }
.more-issues { font-size: 11.5px; color: #2563eb; cursor: pointer; margin-top: 4px; }
.result-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.highlights-card, .suggestions-card {
  background: #11192C;
  border: 1px solid #222F44;
  border-radius: 12px;
  padding: 14px 18px;
}
.highlights-card h3 { color: #5FD0B4; font-size: 14px; margin: 0 0 8px; }
.suggestions-card h3 { color: #E8B54A; font-size: 14px; margin: 0 0 8px; }
.highlights-card ul { margin: 0; padding-left: 18px; }
.suggestions-card ol { margin: 0; padding-left: 18px; }
.highlights-card li, .suggestions-card li { font-size: 13px; line-height: 1.7; color: #DCE6F2; margin-bottom: 3px; }
.review-detail-page {
  background: #11192C;
  border: 1px solid #222F44;
  border-radius: 14px;
  overflow: hidden;
}
.detail-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 18px;
  border-bottom: 1px solid #222F44;
}
.back-btn {
  /* 页内导航: 加蓝色描边与外壳的"← 科研中心"(灰色 chrome 按钮)区分开 ——
     实测用户会把两个"返回"混起来, 点错就跳出了论文质量评审 */
  border: 1px solid #2E4A74;
  background: #16233A;
  color: #A9CDF5;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12.5px;
  cursor: pointer;
}
.back-btn:hover { border-color: #4D84CB; color: #DCE6F2; }
.ann-count { margin-left: auto; font-size: 12px; color: #7A8AA0; }
.detail-body { display: flex; gap: 0; min-height: 0; }
.source-col { flex: 1.2; border-right: 1px solid #222F44; display: flex; flex-direction: column; }
.source-tabs { padding: 8px 14px; border-bottom: 1px solid #212C45; }
.source-tabs button {
  border: 0;
  background: #212C45;
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 12px;
  color: #8B9BB1;
  cursor: pointer;
}
.source-text {
  padding: 18px 22px;
  font-size: 14px;
  line-height: 2;
  color: #E8EEF7;
  white-space: pre-wrap;
  overflow-y: auto;
  flex: 1;
}
.source-text p { margin: 0; display: inline; }
.ctx-before, .ctx-after { color: #8B9BB1; }
.ann-highlight {
  background: #3A3020;
  border-bottom: 2px solid #E8B54A;
  padding: 0 2px;
  border-radius: 2px;
}
.ann-highlight.sev-major { background: #3A2323; border-bottom-color: #dc2626; }
.ann-highlight.sev-suggestion { background: #222F44; border-bottom-color: #7A8AA0; }
.no-locate { color: #E8B54A !important; font-size: 12.5px; }
.ann-col { flex: 0.8; min-width: 280px; display: flex; flex-direction: column; }
.ann-card { padding: 16px; border-bottom: 1px solid #212C45; }
.ann-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.sev-chip {
  padding: 2px 9px;
  border-radius: 10px;
  font-size: 11px;
  color: #F1F5F9;
}
.sev-chip.sev-major { background: #dc2626; }
.sev-chip.sev-minor { background: #E8B54A; }
.sev-chip.sev-suggestion { background: #64748b; }
.ann-dim { font-size: 12px; color: #8B9BB1; }
.ann-loc { font-size: 11.5px; color: #7A8AA0; margin-bottom: 6px; }
.ann-comment { font-size: 13.5px; color: #E8EEF7; line-height: 1.7; margin: 0 0 8px; }
.ann-suggestion { font-size: 12.5px; color: #2563eb; margin: 0; }
.ann-empty { padding: 30px; text-align: center; color: #7A8AA0; font-size: 12.5px; }
.ann-nav {
  margin-top: auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  border-top: 1px solid #222F44;
}
.ann-nav button {
  border: 1px solid #222F44;
  background: #11192C;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  color: #DCE6F2;
}
.ann-nav span { font-size: 12px; color: #7A8AA0; }

/* ── 审核标准多选 + 合并预览(2026-09-12) ── */
.label-badge {
  margin-left: 6px; padding: 1px 6px; font-size: 10.5px; font-weight: 500;
  border-radius: 8px; background: rgba(77, 132, 203, .18); color: #7EB0E8;
}
/**
 * 标准选择所在的行要**纵向排布**。
 *
 * 由来(2026-09-12 用户反馈"社科通用标准这几个字怎么是竖着排的"):
 *   .setting-row 是 `display:flex; align-items:center`, 而 .setting-note 带
 *   `flex-basis:100%`(它自己要占满整行)。picker 只有 `flex:1` → 在 395px 宽的行里
 *   被挤到 **92px**, 里面的 .std-name 只剩 **13px** 宽; 13px 装不下一个汉字 →
 *   中文逐字换行, 6 个字排成 6 行(实测 opt 高 123px / 行高 18.75 = 6 行)。
 *   同时 align-items:center 把行高拉到 141px, 标签「审核标准」孤零零居中。
 * 改为 column + stretch: 标签一行、picker 一行、提示一行, 各得整宽, 不再互相挤压。
 */
.std-row { flex-direction: column; align-items: stretch; gap: 8px; }
.std-row .setting-label { width: auto; }
/* flex-basis:100% 在横向 flex 里是"占满整行", 但纵向 flex 的主轴是**高度** ——
   原样保留会变成"高度 100%", 把提示撑成一大块。这里按内容高度即可(它已独占一行)。 */
.std-row .setting-note { flex-basis: auto; padding-left: 0; }
.std-picker {
  display: flex; flex-wrap: wrap; gap: 6px;
  padding: 8px 10px; border: 1px solid #222F44; border-radius: 8px; background: #131C2E;
  min-height: 38px; align-items: center;
}
.std-empty { font-size: 12px; color: #7A8AA0; }
.std-opt {
  display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
  border: 1px solid #2A3A55; border-radius: 14px; cursor: pointer;
  font-size: 12.5px; color: #C7D3E3; transition: all .15s;
}
.std-opt:hover { border-color: #4D84CB; }
.std-opt.on { border-color: #4D84CB; background: rgba(77, 132, 203, .16); color: #E8EEF7; }
.std-opt input { cursor: pointer; accent-color: #4D84CB; margin: 0; }
.std-name { font-weight: 500; }
.std-flag { font-size: 10.5px; color: #5FD0B4; }
.std-dims { font-size: 10.5px; color: #7A8AA0; }

.merge-preview {
  margin: 2px 0 8px; padding: 10px 12px; border: 1px solid #222F44;
  border-radius: 9px; background: #131C2E;
}
.mp-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
.mp-head strong { font-size: 12.5px; color: #DCE6F2; }
.mp-sum { font-size: 11.5px; color: #8B9BB1; }
.mp-dims { display: flex; flex-wrap: wrap; gap: 6px; }
.mp-chip {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px;
  border-radius: 11px; background: rgba(95, 208, 180, .12);
  border: 1px solid rgba(95, 208, 180, .3); font-size: 12px; color: #9FE6D2;
}
.mp-chip.off {
  background: transparent; border-color: #2A3A55; color: #5C6B80;
  text-decoration: line-through;
}
.mp-w { font-size: 10.5px; color: #7A8AA0; }
.mp-note { display: block; margin-top: 7px; font-size: 11px; color: #7A8AA0; }

/* ── 审稿模板预设(2026-09-12) ── */
.preset-bar {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 9px 12px; margin-bottom: 12px;
  border: 1px dashed #2A3A55; border-radius: 9px; background: rgba(77, 132, 203, .04);
}
.preset-label { font-size: 12.5px; font-weight: 600; color: #A9BBD3; }
.preset-chip {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px;
  border: 1px solid #3A4A66; border-radius: 13px; background: #162034;
  color: #C7D3E3; font-size: 12.5px; cursor: pointer; transition: all .15s;
}
.preset-chip:hover { border-color: #4D84CB; color: #7EB0E8; }
.preset-del { color: #7A8AA0; font-size: 13px; line-height: 1; }
.preset-del:hover { color: #dc2626; }
.preset-empty { font-size: 11.5px; color: #7A8AA0; }
.preset-input {
  flex: 1; min-width: 150px; padding: 5px 9px; font-size: 12.5px;
  border: 1px solid #222F44; border-radius: 6px; background: #131C2E; color: #E8EEF7;
}
.preset-input::placeholder { color: #5C6B80; }
.ghost-btn.sm { padding: 4px 11px; font-size: 12.5px; }

/* ── 结果纵向对比(2026-09-12) ── */
.cmp-overlay {
  position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
  background: rgba(6, 10, 20, .62); backdrop-filter: blur(2px); padding: 24px;
}
.cmp-panel {
  width: min(920px, 100%); max-height: 86vh; display: flex; flex-direction: column;
  background: #11192C; border: 1px solid #26344E; border-radius: 12px; overflow: hidden;
}
.cmp-head {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 14px 16px; border-bottom: 1px solid #1E2A42;
}
.cmp-head strong { font-size: 14px; color: #E8EEF7; }
.cmp-delta { font-size: 13px; font-weight: 600; }
.cmp-delta.up { color: #5FD0B4; }
.cmp-delta.down { color: #E0715C; }
.cmp-delta.flat { color: #7A8AA0; font-weight: 400; font-size: 12px; }
.cmp-summary { flex: 1; font-size: 12px; color: #8B9BB1; }
.cmp-close { border: 0; background: transparent; color: #7A8AA0; font-size: 20px; line-height: 1; cursor: pointer; }
.cmp-close:hover { color: #dc2626; }
.cmp-body { padding: 14px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; }
.cmp-block > strong { display: block; margin-bottom: 8px; font-size: 12.5px; color: #DCE6F2; }
.cmp-fixed-t { color: #5FD0B4 !important; }
.cmp-remain-t { color: #E8B54A !important; }
.cmp-added-t { color: #7EB0E8 !important; }
.cmp-none { font-size: 12px; color: #5C6B80; padding: 2px 0 4px; }
.cmp-tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.cmp-tbl th, .cmp-tbl td { padding: 7px 10px; text-align: left; border-bottom: 1px solid #1A2437; color: #C7D3E3; }
.cmp-tbl th { color: #8B9BB1; font-weight: 500; font-size: 11.5px; }
.cmp-dim { color: #A9BBD3; }
.cmp-up { color: #5FD0B4; }
.cmp-down { color: #E0715C; }
.cmp-issue {
  padding: 7px 10px; margin-bottom: 6px; border-radius: 0 6px 6px 0;
  font-size: 12px; line-height: 1.55; color: #C7D3E3;
}
.cmp-issue.fixed { border-left: 2px solid #5FD0B4; background: rgba(95, 208, 180, .07); }
.cmp-issue.remain { border-left: 2px solid #E8B54A; background: rgba(232, 181, 74, .07); }
.cmp-issue.added { border-left: 2px solid #4D84CB; background: rgba(77, 132, 203, .07); }
.cmp-issue-dim { color: #7EB0E8; margin-right: 7px; font-size: 11.5px; }
.cmp-foot { margin: 0; padding: 10px 16px; border-top: 1px solid #1E2A42; font-size: 11px; color: #7A8AA0; line-height: 1.5; }

/* ── 审稿进度细化(2026-09-12) ── */
.prog-detail { width: min(460px, 100%); margin: 14px auto 4px; }
.prog-track { height: 8px; border-radius: 5px; background: #1B2438; overflow: hidden; }
.prog-fill { height: 100%; border-radius: 5px; background: linear-gradient(90deg, #4D84CB, #7EB0E8); transition: width .35s ease; }
.prog-meta { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; margin-top: 8px; }
.prog-pct { font-size: 13px; font-weight: 600; color: #7EB0E8; }
.prog-seg { font-size: 11.5px; color: #8B9BB1; }
.prog-found { font-size: 11.5px; color: #E8B54A; }

/* ── 人工复核层(2026-09-12) ── */
/* 复核条: 允许换行 + 每个按钮禁止被压窄。
   由来(2026-09-12): 实测容器仅 460px, 「我的判断 + 三档 + 发到编辑器改写」在窄栏里会被挤压;
   加 white-space:nowrap 保证按钮文字不折行(中文折行后按钮会变成细高条)。 */
.review-verdict { display: flex; align-items: center; gap: 7px; margin-top: 10px; flex-wrap: wrap; }
.rv-label { font-size: 11.5px; color: #8B9BB1; white-space: nowrap; flex-shrink: 0; }
.rv-btn {
  padding: 3px 11px; font-size: 12px; border-radius: 13px; cursor: pointer;
  border: 1px solid #2A3A55; background: transparent; color: #A9BBD3; transition: all .15s;
  white-space: nowrap; flex-shrink: 0;
}
.rv-btn:hover { border-color: #4D84CB; }
/* 选中态: 用 rv-v-* 前缀(带 .rv-btn 提升特异性) —— 不用裸 .fixed/.agree/.disagree,
   因为本子工程启用了 Tailwind, 裸类名会撞上它的工具类(见 VERDICTS 注释里 fixed 的事故) */
.rv-btn.rv-v-agree.on { border-color: #5FD0B4; background: rgba(95, 208, 180, .16); color: #5FD0B4; }
.rv-btn.rv-v-disagree.on { border-color: #E0715C; background: rgba(224, 113, 92, .16); color: #E0715C; }
.rv-btn.rv-v-fixed.on { border-color: #7EB0E8; background: rgba(126, 176, 232, .16); color: #7EB0E8; }
.rv-progress { display: flex; align-items: center; gap: 9px; margin-top: 10px; }
.rvp-bar { flex: 1; height: 5px; border-radius: 4px; background: #1B2438; overflow: hidden; }
.rvp-fill { display: block; height: 100%; border-radius: 4px; background: linear-gradient(90deg, #4D84CB, #5FD0B4); transition: width .3s ease; }
.rvp-text { font-size: 11px; color: #7A8AA0; white-space: nowrap; }
.prefs-btn { align-self: flex-start; margin-top: 6px; }
.rv-send {
  margin-left: auto; padding: 3px 11px; font-size: 12px; border-radius: 13px; cursor: pointer;
  border: 1px solid #3A4A66; background: #162034; color: #7EB0E8; transition: all .15s;
}
.rv-send:hover { border-color: #4D84CB; background: #1B2A44; }

/* ── 批量审稿(2026-09-12) ── */
.batch-tab {
  margin-left: auto; cursor: pointer; padding: 5px 13px; font-size: 12.5px;
  border: 1px dashed #3A4A66; border-radius: 7px; color: #7EB0E8; transition: all .15s;
}
.batch-tab:hover { border-color: #4D84CB; border-style: solid; background: rgba(77, 132, 203, .08); }
.batch-panel {
  margin-top: 14px; padding: 12px 14px; border: 1px solid #222F44;
  border-radius: 10px; background: #131C2E;
}
.bp-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.bp-head strong { font-size: 13px; color: #DCE6F2; }
.bp-stat { flex: 1; font-size: 12px; color: #8B9BB1; }
.batch-tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-bottom: 4px; }
.batch-tbl th, .batch-tbl td { padding: 7px 9px; text-align: left; border-bottom: 1px solid #1A2437; color: #C7D3E3; }
.batch-tbl th { color: #8B9BB1; font-weight: 500; font-size: 11.5px; }
.bt-name { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bt-score { font-weight: 600; color: #7EB0E8; }
.bt-status { padding: 2px 8px; border-radius: 9px; font-size: 11px; }
.bt-status.st-done { background: rgba(95, 208, 180, .14); color: #5FD0B4; }
.bt-status.st-running { background: rgba(126, 176, 232, .14); color: #7EB0E8; }
.bt-status.st-queued { background: rgba(139, 155, 177, .14); color: #8B9BB1; }
.bt-status.st-failed { background: rgba(224, 113, 92, .14); color: #E0715C; }
.bt-status.st-cancelled { background: rgba(139, 155, 177, .14); color: #7A8AA0; }
.bt-err { font-size: 11.5px; color: #E8B54A; }
.bp-compare { margin-top: 14px; padding-top: 12px; border-top: 1px solid #1E2A42; }
.bp-compare > strong { display: block; margin-bottom: 8px; font-size: 12.5px; color: #DCE6F2; }
.bt-label-col { color: #8B9BB1 !important; white-space: nowrap; width: 90px; }
.bt-cell { font-size: 11.5px; line-height: 1.5; }
</style>

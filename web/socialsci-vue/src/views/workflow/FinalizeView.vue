<script setup lang="ts">
/**
 * FinalizeView(Phase5 合稿定稿) — 还原自闭源 FinalizeView-Br8-MIOb.js(L172-1748)
 * 合稿三轮(merge→review→revise) + 时间轴 + 终稿元数据编辑 + 导出 md/html(Word 走前端 docx 构建)
 * 后端: jobKind merge/phase5_review/phase5_revise → 泵 → project merged_* 列 + review_result 回读
 */
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useWorkflowStore } from "./stores/workflow";
import { createTask, getTask } from "@/shared/tasks";
import { markWorkflowReady, sendMarkdownToEditor } from "@/shared/workflow-bridge";
import { toast, confirmDialog } from "@/shared/ui";
import { q } from "@/shared/api";
import { renderMdWithLatex, loadKatex } from "@/shared/markdown";
import PhaseProgressBar from "./PhaseProgressBar.vue";

const router = useRouter();

/** 终稿预览: 原先按空行切段塞 <p>, 正文里的表格/公式/小标题全被压成纯段落 */
const mergedHtml = computed(() => renderMdWithLatex(String(store.mergedFullText ?? "")));
const refsHtml = computed(() => renderMdWithLatex(String(store.mergedReferences ?? "")));

/** 合稿模式与降 AIGC 档位(2026-09-15 补: 原先只有布尔开关, 档位能力整个缺失) */
const mergeMode = ref<"normal" | "deAIGC">("normal");
const mergeTier = ref<"light" | "medium" | "heavy">("medium");
const MERGE_MODES = [
  { value: "normal" as const, label: "直接合稿", control: "workflow:merge-mode-direct" },
  { value: "deAIGC" as const, label: "降AIGC合稿", control: "workflow:merge-mode-aigc" },
];
const DEAI_TIERS = [
  { value: "light" as const, label: "轻度降重", hint: "只替换套话与空泛修饰，句子结构不动" },
  { value: "medium" as const, label: "中度降重", hint: "调整句式节奏，拆并列排比，删过渡水句" },
  { value: "heavy" as const, label: "重度降重", hint: "重组表达路径与段落切分，事实数据引文冻结" },
];

/** 合稿五步(闭源固定文案, 每步带说明) */
const MERGE_STEPS = [
  { title: "合并正文", desc: "将各章节合并为连贯的全文" },
  { title: "语言润色", desc: "优化表达，消除 AI 痕迹" },
  { title: "整理参考文献", desc: "去重并统一格式" },
  { title: "生成元信息", desc: "标题、摘要、关键词" },
  { title: "完成", desc: "论文合并完成" },
];
const store = useWorkflowStore();

// ── 三轮状态 ──
const mergeRunning = ref(false);
const reviewRunning = ref(false);
const reviseRunning = ref(false);
const mergeStep = ref(0);
const mergeMessage = ref("");
const streamContent = ref("");
const reviewStream = ref("");
const reviewReport = ref<Record<string, unknown> | null>(null);
const pendingRevision = ref<{ title: string; abstract: string; body: string } | null>(null);
// V417: 修订前的正文/摘要 —— viewDiff 要用真旧版对比(原来取的是修订后的值, 两版永远相同)
const preRevisionFullText = ref("");
const preRevisionAbstract = ref("");

// V417: 审查报告的 highlights / checks —— 后端产出(见 research-exec-engine 的 review 执行器),
//   但在界面上原来一个都没渲染, 用户只看到总分和一句评语。
const reviewHighlights = computed(() => {
  const h = (reviewReport.value as Record<string, unknown> | null)?.highlights;
  return Array.isArray(h) ? h.map((x) => String(x)).filter(Boolean) : [];
});
const reviewChecks = computed(() => {
  const c = (reviewReport.value as Record<string, unknown> | null)?.checks;
  if (!c || typeof c !== "object") return [];
  const label: Record<string, string> = {
    requirements: "结构与体例", references: "引文规范", aiTone: "AI 痕迹",
    logic: "论证逻辑", dataAccuracy: "数据可信度",
  };
  return Object.entries(c as Record<string, Record<string, unknown>>).map(([k, v]) => ({
    name: label[k] ?? k,
    pass: v?.pass !== false,
    detail: String(v?.detail ?? ""),
  }));
});
const showDiff = ref(false);
const diffText = ref("");
const exportStatus = ref<"idle" | "running" | "completed" | "failed">("idle");
const exportFmt = ref("md");
const docxBusy = ref(false);
const pptxBusy = ref(false);
const chapterBusy = ref("");
const componentBusy = ref("");

// ── 大纲树 → 后端导出/生成接口要的节点结构 ──
// 后端 /api/paper-outline/* 要的是 {title, level, content, children}; Vue 的 Section 是扁平表
// (带 parentId/order, 见 stores/workflow.ts)。这里把扁平表拼成树 —— 原来这套能力只有被弃用的
// React PaperOutlinePanel 在用, 2026-09-13 搬到 Vue 侧(否则 chapter/export-pptx 就没有界面入口了)。
interface OutlineNode { title: string; level: number; content?: string; children?: OutlineNode[] }
function buildOutlineTree(): OutlineNode[] {
  // 先按 order 排好再挂父子, 这样同级顺序天然正确(不用事后递归排序)
  const ordered = [...(store.sections ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const byId = new Map(ordered.map((s) => [s.id, { title: s.title, level: s.level, content: s.content ?? "", children: [] as OutlineNode[] }]));
  const roots: OutlineNode[] = [];
  for (const s of ordered) {
    const node = byId.get(s.id);
    if (!node) continue;
    const parent = s.parentId ? byId.get(s.parentId) : null;
    if (parent) parent.children!.push(node);
    else roots.push(node);
  }
  // 没有子节点的节点不带空的 children 字段, 免得下游以为是"有子节点但为空"
  const prune = (list: OutlineNode[]): OutlineNode[] => list.map((n) => {
    if (!n.children?.length) { const { children: _drop, ...rest } = n; return rest as OutlineNode; }
    return { ...n, children: prune(n.children) };
  });
  return prune(roots);
}

/** 已生成章节的正文, 按顺序取后 N 条作为"前文上下文" */
function collectGeneratedContents(limit = 5): string[] {
  return (store.sections ?? [])
    .filter((s) => s.content && s.content.length > 0)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((s) => s.content as string)
    .slice(-limit);
}

/** 大纲树的纯文本缩进形式(喂给模型的"全文结构"提示) */
function outlineTreeText(nodes: OutlineNode[], depth = 0): string {
  const lines: string[] = [];
  for (const n of nodes) {
    lines.push(`${"  ".repeat(depth)}${n.title}`);
    if (n.children?.length) lines.push(outlineTreeText(n.children, depth + 1));
  }
  return lines.join("\n");
}

function safeFileName(base: string, ext: string): string {
  return `${String(base || "未命名论文").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}.${ext}`;
}

/** base64 → Blob 下载(与 review 侧同款: 不依赖后端给 URL) */
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

/** 导出 Word(.docx) — 后端 python-docx 生成, 带大纲层级与已生成正文 */
async function exportDocx() {
  const nodes = buildOutlineTree();
  if (!nodes.length) { toast("大纲为空, 无法导出", "error"); return; }
  docxBusy.value = true;
  exportStatus.value = "running";
  try {
    const r = await q<{ ok: boolean; base64?: string }>("/paper-outline/export", {
      method: "POST",
      body: { paperTitle: store.mergedTitle || store.title || "未命名论文", nodes, references: referenceBlock() },
    });
    if (!r.base64) throw new Error("后端未返回文档内容");
    downloadBase64(r.base64, safeFileName(store.mergedTitle || store.title, "docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    exportStatus.value = "completed";
    toast("Word 已导出", "success");
  } catch (e) {
    exportStatus.value = "failed";
    toast(`Word 导出失败: ${(e as Error).message}`, "error");
  } finally { docxBusy.value = false; }
}

/** 导出 PPT(.pptx) — 后端按大纲逐节点出片, 每片抽要点做 bullet */
async function exportPptx() {
  const nodes = buildOutlineTree();
  if (!nodes.length) { toast("大纲为空, 无法导出", "error"); return; }
  pptxBusy.value = true;
  try {
    const r = await q<{ ok: boolean; base64?: string }>("/paper-outline/export-pptx", {
      method: "POST",
      body: { paperTitle: store.mergedTitle || store.title || "未命名论文", nodes },
    });
    if (!r.base64) throw new Error("后端未返回文件内容");
    downloadBase64(r.base64, safeFileName(store.mergedTitle || store.title, "pptx"), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    toast("PPT 已导出", "success");
  } catch (e) {
    toast(`PPT 导出失败: ${(e as Error).message}`, "error");
  } finally { pptxBusy.value = false; }
}

/** 论文要件(摘要/关键词/结论)生成 — 后端 LLM 产出, 结果并回对应章节 */
async function genComponent(kind: "abstract" | "keywords" | "conclusion") {
  const label = { abstract: "摘要", keywords: "关键词", conclusion: "结论" }[kind];
  const nodes = buildOutlineTree();
  const topic = store.mergedTitle || store.title || "";
  if (!topic) { toast("请先填写论文标题", "warning"); return; }
  componentBusy.value = kind;
  try {
    const r = await q<{ content?: string; wordCount?: number }>("/paper-outline/component", {
      method: "POST",
      body: {
        kind, topic,
        sections: nodes.map((n) => n.title).filter((t) => !["摘要", "关键词", "结论"].includes(t)),
        chapterContents: collectGeneratedContents(30),
      },
    });
    if (!r.content) throw new Error("后端未返回内容");
    // 并回同级章节: 已有同名就覆盖内容, 没有就补一个挂在最前
    const existing = (store.sections ?? []).find((s) => s.title === label);
    if (existing) existing.content = r.content;
    else store.sections.unshift({ id: `gen-${kind}-${Date.now()}`, title: label, level: 1, parentId: null, order: -1, content: r.content, status: "generated" });
    await store.saveProject().catch(() => null);
    toast(`${label} 已生成(${r.wordCount ?? r.content.length} 字)`, "success");
  } catch (e) {
    toast(`${label}生成失败: ${(e as Error).message}`, "error");
  } finally { componentBusy.value = ""; }
}

/** 生成选中章节(sectionId)的正文 — 后端按大纲位置+前文上下文写 */
async function genChapter(sectionId: string) {
  const s = (store.sections ?? []).find((x) => x.id === sectionId);
  if (!s) return;
  const nodes = buildOutlineTree();
  chapterBusy.value = sectionId;
  try {
    const r = await q<{ content?: string; wordCount?: number }>("/paper-outline/chapter", {
      method: "POST",
      body: {
        nodeId: s.id, title: s.title, level: Math.min(Math.max(s.level - 1, 0), 3),
        topic: store.mergedTitle || store.title || s.title,
        prevContext: collectGeneratedContents(5).join("\n\n") || undefined,
        outlineTree: outlineTreeText(nodes),
      },
    });
    if (!r.content) throw new Error("后端未返回内容");
    s.content = r.content;
    s.status = "generated";
    await store.saveProject().catch(() => null);
    toast(`「${s.title}」已生成(${r.wordCount ?? r.content.length} 字)`, "success");
  } catch (e) {
    toast(`生成失败: ${(e as Error).message}`, "error");
  } finally { chapterBusy.value = ""; }
}

let poll: ReturnType<typeof setInterval> | null = null;

// ── 合稿门禁(闭源 ge()) ──
async function doMerge() {
  const l1 = store.level1Sections;
  if (!store.taskId) {
    toast("请先创建并保存工作流任务", "warning");
    return;
  }
  const withContent = l1.filter((s) => s.content && s.content.length > 50);
  if (!withContent.length) {
    toast("没有已生成内容的章节可供合稿", "warning");
    return;
  }
  if (l1.length > withContent.length) {
    toast(`还有 ${l1.length - withContent.length} 个一级章节未完成, 不能合稿`, "warning");
    return;
  }
  // 闭源第 ④ 条: 正文节点比已发布的 Phase 4 版本新 → 版本已过期, 先重新发布再合稿。
  //   2026-09-15 接通 —— 此前 phase4Version/Stale 是后端写死的 null/false, 这条门禁等于不存在,
  //   用户改了正文后直接合稿会拿到与当前内容不符的版本快照。
  try {
    const st = await q<{ state?: { phase4Version?: unknown; phase4Stale?: boolean } }>(
      `/research/versions/current?projectId=${store.taskId}`);
    if (st.state?.phase4Version && st.state.phase4Stale) {
      const ok = await confirmDialog({
        title: "Phase 4 正文已变更",
        message: "当前正文比已发布的 Phase 4 版本新。直接合稿会以最新正文为准，但版本凭证会落后于内容。是否继续？",
        okText: "仍然合稿", cancelText: "先去重新生成",
      });
      if (!ok) return;
    }
  } catch { /* 版本服务不可用不阻断合稿 */ }
  mergeRunning.value = true;
  mergeStep.value = 0;
  const deAIGC = mergeMode.value === "deAIGC";
  mergeMessage.value = deAIGC ? `正在合并正文并执行${DEAI_TIERS.find((t) => t.value === mergeTier.value)?.label}…` : "正在合并正文…";
  streamContent.value = "";
  try {
    const t = await createTask({
      title: "论文合并",
      projectId: store.taskId,
      module: "workflow",
      jobKind: "merge",
      goal: store.input.title,
      phase: 5,
      phaseLabel: "合稿定稿",
      inputSnapshot: {
        sections: l1.map((s) => ({ title: s.title })),
        chapterContents: l1.map((s) => s.content ?? ""),
        enableDeAIFyMerge: deAIGC,
        ...(deAIGC ? { deAITier: mergeTier.value } : {})
      }
    });
    pollTask(t.id, "merge", async () => {
      // 2026-09-15: 先放开 mergeRunning 再回读。
      //   refreshMerged() 会把 store.mergeGenerated 置真 → 模式 tab 立刻渲染出来,
      //   但它带着 `:disabled="mergeRunning"`, 而 mergeRunning 要到这两个 await 之后才置 false
      //   —— 结果合稿完成后的短暂窗口里, tab 看得见却点不动(实测: click() 无反应, 状态不翻)。
      mergeRunning.value = false;
      mergeStep.value = 5;
      await refreshMerged();
      // D1/D2 后处理(闭源 Z(): fe 重建引用 → xe 表格重编号 → 落 store)
      await postProcessMerged();
      mergeMessage.value = "论文合并完成";
      toast("论文合并完成", "success");
    });
  } catch (e) {
    mergeRunning.value = false;
    toast(`合稿失败: ${(e as Error).message}`, "error");
  }
}

// ── 全文审查(review 轮) ──
async function doReview() {
  if (!store.phase5VersionId && !store.mergedFullText) {
    toast("请先完成当前合稿, 再执行全文审查", "warning");
    return;
  }
  reviewRunning.value = true;
  reviewStream.value = "";
  try {
    const t = await createTask({
      title: "全文审查",
      projectId: store.taskId,
      module: "workflow",
      jobKind: "phase5_review",
      goal: store.input.title,
      phase: 5,
      phaseLabel: "合稿定稿",
      inputSnapshot: {}
    });
    pollTask(t.id, "review", async () => {
      await refreshMerged();
      reviewRunning.value = false;
      // 审查报告在 project.review_result → store.reviewResult
      toast("全文审查完成", "success");
    });
  } catch (e) {
    reviewRunning.value = false;
    toast(`审查失败: ${(e as Error).message}`, "error");
  }
}

// ── 修订轮(revise) ──
async function doRevise() {
  if (!store.reviewResult && !store.mergedFullText) {
    toast("请先完成合稿与审查, 再生成修订稿", "warning");
    return;
  }
  reviseRunning.value = true;
  try {
    const t = await createTask({
      title: "生成修订稿",
      projectId: store.taskId,
      module: "workflow",
      jobKind: "phase5_revise",
      goal: store.input.title,
      phase: 5,
      phaseLabel: "合稿定稿",
      inputSnapshot: {}
    });
    pollTask(t.id, "revise", async () => {
      await refreshMerged();
      reviseRunning.value = false;
      pendingRevision.value = {
        title: store.mergedTitle,
        abstract: store.mergedAbstract,
        body: store.mergedFullText
      };
      toast("修订稿已生成, 请检查后再采用", "success");
    });
  } catch (e) {
    reviseRunning.value = false;
    toast(`修订失败: ${(e as Error).message}`, "error");
  }
}

// ── 任务轮询(三轮各自独立 interval, 互不杀; done 时清自己的槽) ──
const pollSlots = new Map<string, ReturnType<typeof setInterval>>();
function pollTask(taskId: string, kind: "merge" | "review" | "revise", onDone: () => Promise<void>) {
  stopPollSlot(kind);
  const timer = setInterval(async () => {
    try {
      const t = await getTask(taskId);
      if (!t) return;
      const prog = (t.progress ?? {}) as { stage?: string; current?: number; total?: number; step?: number };
      mergeMessage.value = prog.stage ?? "";
      // 闭源用后端的 phase5.merge_status.step 驱动时间轴(H(Math.min(I,4))), 不是由 current 反推。
      //   后端没报 step 的旧任务回落到 current-1, 免得时间轴卡在第 1 步。
      mergeStep.value = typeof prog.step === "number" ? Math.min(4, Math.max(0, prog.step)) : Math.min(4, Math.max(0, (prog.current ?? 1) - 1));
      if (t.status === "done" || t.status === "completed") {
        stopPollSlot(kind);
        await onDone();
      } else if (t.status === "failed" || t.status === "cancelled") {
        stopPollSlot(kind);
        if (kind === "merge") mergeRunning.value = false;
        else if (kind === "review") reviewRunning.value = false;
        else reviseRunning.value = false;
        toast("任务失败, 请重试", "error");
      }
    } catch { /* 容忍 */ }
  }, 900);
  pollSlots.set(kind, timer);
}
function stopPollSlot(kind: string) {
  const timer = pollSlots.get(kind);
  if (timer) { clearInterval(timer); pollSlots.delete(kind); }
}
function stopPoll() { for (const k of [...pollSlots.keys()]) stopPollSlot(k); }

// ── 合并结果回读(project 列; GET → {project:{merged_*}}) ──
async function refreshMerged() {
  try {
    const r = await q<{ project?: Record<string, unknown>; data?: Record<string, unknown> }>(`/research/projects/${store.taskId}`);
    const p = (r.project ?? r.data ?? {}) as Record<string, unknown>;
    if (p.merged_title) store.mergedTitle = String(p.merged_title);
    if (p.merged_abstract) store.mergedAbstract = String(p.merged_abstract);
    if (p.merged_keywords) store.mergedKeywords = String(p.merged_keywords);
    if (p.merged_fulltext) store.mergedFullText = String(p.merged_fulltext);
    if (p.merged_references) store.mergedReferences = String(p.merged_references);
    if (p.review_result) {
      store.reviewResult = typeof p.review_result === "string" ? JSON.parse(p.review_result) : (p.review_result as Record<string, unknown>);
      reviewReport.value = store.reviewResult;
    }
    if (p.merge_generated !== undefined) store.mergeGenerated = Boolean(p.merge_generated);
    await store.saveProject();
  } catch { /* 容忍 */ }
}

// ── 元数据编辑(mergeGenerated 态; 输入防抖 500ms 持久化, 防止离开页面被 loadProject 覆盖) ──
const mergedBody = computed({
  get: () => store.mergedFullText,
  set: (v: string) => {
    store.mergedFullText = v;
    scheduleMetaSave();
  }
});
let metaSaveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleMetaSave() {
  if (metaSaveTimer) clearTimeout(metaSaveTimer);
  metaSaveTimer = setTimeout(() => {
    void store.saveProject();
  }, 500);
}
function onMetaInput() {
  scheduleMetaSave();
}
onUnmounted(() => {
  if (metaSaveTimer) { clearTimeout(metaSaveTimer); metaSaveTimer = null; }
  stopPoll();
});

// ── 查看差异(修订前/后) ──
function viewDiff() {
  // V417: 原来拿 store.mergedFullText 当"修订前", 但取值发生在 refreshMerged() **之后**,
  //   那时它已经是修订后的文本 → 两个字数永远相同、正文只贴修订后开头, 用户拿不到
  //   任何可比信息就得决定要不要「采用修订稿」。现在用 doRevise 里预存的真旧版, 并做段落级对比。
  const oldText = preRevisionFullText.value || "";
  const newText = pendingRevision.value?.body ?? "";
  const oldN = oldText.replace(/\s/g, "").length;
  const newN = newText.replace(/\s/g, "").length;
  const paras = (t: string) => t.split(/\n\s*\n/).map((x) => x.trim()).filter((x) => x.length > 10);
  const oldSet = new Set(paras(oldText));
  const newSet = new Set(paras(newText));
  const added = paras(newText).filter((x) => !oldSet.has(x));
  const removed = paras(oldText).filter((x) => !newSet.has(x));
  const unchanged = paras(newText).length - added.length;
  const head = (arr: string[], n: number) => arr.slice(0, n).map((x) => `  · ${x.slice(0, 160)}`).join("\n");
  diffText.value = [
    `字数: 修订前 ${oldN} → 修订后 ${newN} (${newN - oldN >= 0 ? "+" : ""}${newN - oldN})`,
    `段落: 新增 ${added.length} 段 / 删除 ${removed.length} 段 / 未变 ${Math.max(0, unchanged)} 段`,
    "",
    added.length ? `=== 新增段落(最多 5 段) ===\n${head(added, 5)}` : "=== 新增段落 === 无",
    "",
    removed.length ? `=== 删除段落(最多 5 段) ===\n${head(removed, 5)}` : "=== 删除段落 === 无",
  ].join("\n");
  showDiff.value = true;
}

// ── 采用修订稿(覆盖 merged_*) ──
async function adoptRevision() {
  const rev = pendingRevision.value;
  if (!rev) return;
  store.mergedTitle = rev.title || store.mergedTitle;
  store.mergedAbstract = rev.abstract || store.mergedAbstract;
  store.mergedFullText = rev.body;
  pendingRevision.value = null;
  await store.saveProject();
  toast("修订稿已采用", "success");
}

// ── 合并后处理(D1 引用重建 fe + D2 表格重编号 xe; 落 store + saveProject) ──
async function postProcessMerged() {
  const text = store.mergedFullText;
  if (!text) return;
  let out = text;
  // D1 引用: 正文 §REF_ 占位符重建 + literature gbRef 拼表
  const refsRes = await rebuildCitationsAndRefs(text, store.mergedReferences).catch(() => null);
  if (refsRes && refsRes.body !== text) out = refsRes.body;
  // D2 表格重编号
  const tabled = renumberTables(out);
  if (tabled !== out || (refsRes && refsRes.references !== store.mergedReferences)) {
    store.mergedFullText = tabled;
    if (refsRes && refsRes.references !== store.mergedReferences) store.mergedReferences = refsRes.references;
    await store.saveProject();
  }
}

// ── 引用/表格重编号(闭源 fe()/xe() 语义 L8840-9400) ──
// fe(): 正文 §REF_a_b§ → 首次出现序 [n](去重); 素材池(literature/citation references[].gbRef 依素材序)
//       的 a 位即素材池位置 → 正文出现序 + 池位置双映射拼 "[n] gbRef" 表
async function rebuildCitationsAndRefs(fulltext: string, refsProvided: string) {
  const raw = String(fulltext ?? "");
  // 无占位符 → 干净文本原样保留(不重排已有正文/参考文献)
  if (!/§REF_(\d+)_(\d+)§/.test(raw)) return { body: raw, references: refsProvided };
  // 素材池: literature/citation 素材的 references[] 依素材序铺开(a 位 = 池位置 1-based)
  // V417: 原来只认 `gbRef` 字段, 但**后端从不产这个字段**(全仓零写入方) → 池恒空 →
  //   引用表永远拼不出来。后端实际写的是 {title, authors, year, source}(见 research-exec-engine
  //   的文献检索素材)。这里两种都认, 缺 gbRef 就用 title/authors/year 现拼一条著录。
  const pool: Array<{ gbRef: string }> = [];
  const seenGb = new Set<string>();
  const gbOf = (rf: Record<string, unknown>): string => {
    const explicit = String(rf.gbRef ?? "").trim();
    if (explicit) return explicit;
    const title = String(rf.title ?? "").trim();
    if (!title) return "";
    const authors = String(rf.author ?? rf.authors ?? "").trim();
    const year = String(rf.year ?? "").trim();
    const source = String(rf.source ?? "").trim();
    return [authors ? `${authors}.` : "", `${title}.`, year ? `${year}.` : "", source ? `${source}.` : ""]
      .filter(Boolean).join(" ");
  };
  try {
    const r = await q<{ materials?: Array<Record<string, unknown>> }>(`/research/materials?projectId=${store.taskId}`);
    for (const m of r.materials ?? []) {
      if (m.kind !== "literature" && m.kind !== "citation") continue;
      const refs = Array.isArray(m.references) ? (m.references as Array<Record<string, unknown>>) : [];
      for (const rf of refs) {
        const g = gbOf(rf);
        if (g && !seenGb.has(g)) { seenGb.add(g); pool.push({ gbRef: g }); }
      }
    }
  } catch { /* 素材读取失败 → 池为空, 引用表保留传入 */ }
  // 正文替换: 首次出现序编号; a 位命中池则登记该 gbRef
  let counter = 0;
  const keyNo = new Map<string, number>(); // §REF 池位置串 → 正文编号
  const gbByNo = new Map<number, string>(); // 正文编号 → gbRef
  const body = raw.replace(/§REF_(\d+)_(\d+)§/g, (_m, a) => {
    const key = String(a);
    if (!keyNo.has(key)) {
      counter++;
      keyNo.set(key, counter);
      const g = pool[Number(a) - 1]?.gbRef;
      if (g) gbByNo.set(counter, g);
    }
    return `[${keyNo.get(key)}]`;
  });
  let refsLines = refsProvided;
  if (gbByNo.size) {
    refsLines = [...gbByNo.entries()].sort((x, y) => x[0] - y[0]).map(([no, g]) => `[${no}] ${g}`).join("\n");
  }
  return { body, references: refsLines };
}
// xe(): **表N[.、：:]xxx** → **表N xxx**(N 递增重编号)
function renumberTables(text: string): string {
  let t = 0;
  return String(text ?? "").replace(/\*\*表\s*\d*\s*[.、：: ]*(.+?)\*\*/g, (_s, cap: string) => {
    t++;
    return `**表${t} ${String(cap ?? "").trim()}**`;
  });
}

/** V417 出站: 终稿 → 学术文本工作台(复用评审侧已验证的 skf_doc_handoff 交接, 不用 postMessage) */
function sendToEditor() {
  const md = [mergedBody.value, "", mdRefs()].filter(Boolean).join("\n\n");
  if (!md.trim()) { toast("终稿为空, 请先合稿", "warning"); return; }
  const title = store.mergedTitle || store.title || "未命名论文";
  if (sendMarkdownToEditor(md, title)) toast("已送往学术文本工作台, 将新建文档", "success");
  else toast("发送失败(localStorage 不可用或已满)", "error");
}

// ── 导出(闭源 _e(); md/html 拼装; docx 提示走 Word) ──
function mdRefs(): string {
  return store.mergedReferences
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * V417: 导出时的参考文献块 —— 后端不猜，由前端把"有没有真实条目/著录全不全"一并传下去。
 * 没接出条目时后端会在文档里显式打印"需人工补录"，而不是给一个空标题。
 */
function referenceBlock(): { text: string; needsManual: boolean } {
  const text = mdRefs();
  if (!text) return { text: "", needsManual: true };
  // `[N] 标题. 年份.` 这种只有标题的（无作者）算著录不全 —— 实测内部库多数条目拿不到作者
  const lines = text.split("\n").filter(Boolean);
  const needsManual = lines.some((l) => /^\[\d+\]\s*[^.。]*[.。]\s*\d{0,4}\s*[.。]?\s*$/.test(l)) || lines.length < 3;
  return { text, needsManual };
}
/** HTML 转义 */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** 导出正文 → 学术 HTML(D3: **表N xxx** 表题行提升 .rf-table-caption + 完整 A4 印刷 CSS) */
function bodyToHtml(text: string): string {
  // 表格 markdown 三线表(|---| 分隔) → .rf-table; 表题行单独提 .rf-table-caption
  const lines = String(text ?? "").split("\n");
  const html: string[] = [];
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const tableCap = l.match(/^\*\*(表\d+[^\n]*?)\*\*/);
    // 表题行(闭源 xe 产物 **表N xxx** 独立成行) → 结束表格 + caption
    if (tableCap) {
      if (inTable) { html.push("</table>"); inTable = false; }
      html.push(`<p class="rf-table-caption">${esc(tableCap[1])}</p>`);
      continue;
    }
    // markdown 表格分隔行 |---|---|
    if (/^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/.test(l) && l.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|")) {
      if (!inTable) { html.push('<table class="rf-table"><tbody>'); inTable = true; }
      continue;
    }
    if (l.trim().startsWith("|") && l.trim().endsWith("|")) {
      const cells = l.trim().slice(1, -1).split("|").map((c) => c.trim());
      const tag = i === 0 || !inTable ? "thead" : "tbody";
      if (!inTable) { html.push('<table class="rf-table">'); inTable = true; }
      const rowTag = inTable && html.length && /<thead>/.test(html[html.length - 1]) ? "" : "";
      if (tag === "thead") html.push(`<thead><tr>${cells.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>`);
      else html.push(`<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`);
      continue;
    }
    if (inTable) { html.push("</tbody></table>"); inTable = false; }
    if (!l.trim()) { html.push("<p>&nbsp;</p>"); continue; }
    // 段落标题(# ~ ####)
    const h = l.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      const lv = Math.min(h[1].length + 1, 4);
      html.push(`<h${lv}>${esc(h[2])}</h${lv}>`);
      continue;
    }
    html.push(`<p>${esc(l)}</p>`);
  }
  if (inTable) html.push("</tbody></table>");
  return html.join("\n");
}
async function doExport() {
  if (!store.mergedFullText) {
    toast("没有可导出的内容", "error");
    return;
  }
  exportStatus.value = "running";
  try {
    const title = store.mergedTitle || store.input.title || "未命名论文";
    const safeName = title.replace(/[\\/:*?"<>|]/g, "_");
    if (exportFmt.value === "md") {
      const md = `# ${title}\n\n## 摘要\n\n${store.mergedAbstract}\n\n**关键词：**${store.mergedKeywords}\n\n## 正文\n\n${store.mergedFullText}\n\n## 参考文献\n\n${mdRefs()}`;
      downloadText(`${safeName}.md`, md);
    } else if (exportFmt.value === "html") {
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
@media print { @page { size: A4; margin: 2.2cm 2.4cm; } body { margin: 0; } }
body{font-family:SimSun,"Noto Serif SC",serif;font-size:12pt;line-height:1.8;color:#111;margin:0 auto;padding:40px 20px;max-width:170mm;text-align:justify}
h1{text-align:center;font-size:18pt;font-family:SimHei,"Noto Sans SC",sans-serif;font-weight:700;margin:0 0 1.2em}
h2{font-size:15pt;font-family:SimHei,"Noto Sans SC",sans-serif;margin:1.6em 0 .6em}
h3{font-size:13pt;font-family:SimHei,"Noto Sans SC",sans-serif;margin:1.4em 0 .5em}
h4{font-size:12pt;font-family:SimHei,"Noto Sans SC",sans-serif;margin:1.2em 0 .4em}
p{text-indent:2em;margin:.35em 0;line-height:1.8}
p.rf-table-caption{text-align:center;text-indent:0;font-weight:600;font-family:SimHei,sans-serif;margin:1.2em 0 .4em}
table.rf-table{border-collapse:collapse;width:92%;margin:.4em auto 1.2em;font-size:10.5pt}
table.rf-table th,table.rf-table td{border-top:1px solid #000;border-bottom:1px solid #000;padding:4px 8px;text-align:center}
table.rf-table thead tr:first-child th{border-top:2px solid #000}
table.rf-table tbody tr:last-child td{border-bottom:2px solid #000}
.abstract-box{margin:1.5em 0;text-align:justify}
.kw-box{margin:0 0 1.5em}
.refs{font-size:10.5pt;line-height:1.7;text-indent:0}
.refs .ref-item{text-indent:-2em;padding-left:2em;margin:.25em 0}
</style></head><body>
<h1>${esc(title)}</h1>
<div class="abstract-box"><b>摘要：</b>${esc(store.mergedAbstract).replace(/\n/g, "</div><div class='abstract-box'>")}</div>
<p class="kw-box"><b>关键词：</b>${esc(store.mergedKeywords)}</p>
${bodyToHtml(store.mergedFullText)}
<h2>参考文献</h2>
<div class="refs">${mdRefs().split("\n").map((l) => `<div class="ref-item">${esc(l)}</div>`).join("")}</div>
</body></html>`;
      downloadText(`${safeName}.html`, html);
    } else if (exportFmt.value === "docx" || exportFmt.value === "pdf") {
      // V417: 原实现这里只弹一句"请使用「下载 Word」功能导出后另存" —— 而界面上根本没有那个
      //   按钮(实际叫「Word(大纲版)」), 下拉里的 PDF 选项更是**永远拿不到文件**。死控件 + 指错路。
      //   改成真调后端导出: docx / pdf 都出同一个 Word 产物(平台没有 PDF 转换通道),
      //   PDF 时额外**说实话**告知需自行另存, 不假装导出了 PDF。
      const nodes = buildOutlineTree();
      if (!nodes.length) { toast("大纲为空, 无法导出", "error"); exportStatus.value = "idle"; return; }
      const r = await q<{ ok: boolean; base64?: string }>("/paper-outline/export", {
        method: "POST",
        body: { paperTitle: store.mergedTitle || store.title || "未命名论文", nodes, references: referenceBlock() },
      });
      if (!r.base64) throw new Error("后端未返回文档内容");
      downloadBase64(r.base64, safeFileName(store.mergedTitle || store.title, "docx"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      if (exportFmt.value === "pdf") {
        toast("已导出 Word 文件。平台没有 PDF 转换通道, 请用 Word/WPS 另存为 PDF", "info", 6000);
      }
    } else {
      toast(`不支持的导出格式: ${exportFmt.value}`, "error");
      exportStatus.value = "idle";
      return;
    }
    exportStatus.value = "completed";
    store.isFinalized = true;
    // D4: 导出状态持久化(exportedAt 时间戳 + exportStatus)
    store.exportedAt = new Date().toISOString();
    store.exportStatus = "completed";
    await store.saveProject();
    toast(`导出成功: ${safeName}.${exportFmt.value}`, "success");
  } catch (e) {
    exportStatus.value = "failed";
    toast(`导出失败: ${(e as Error).message}`, "error");
  }
}
function downloadText(name: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// ── 恢复(挂载: loadProject + refreshMerged 双保险) ──
onMounted(async () => {
  markWorkflowReady();
  void loadKatex();
  await store.loadProject().catch(() => null);
  await refreshMerged().catch(() => null);
});
</script>

<template>
  <div class="workflow-page max-w-5xl mx-auto px-6 py-8 pb-16">
    <PhaseProgressBar />
    <h1 class="wf-h1">合稿定稿</h1>
    <p class="wf-sub">{{ store.title }} — 合并正文 → 全文审查 → 修订定稿 → 导出。</p>

    <!-- 未合稿空态(闭源: 大图标 + 「准备合并定稿」 + 说明 + 开始合并) -->
    <div v-if="!store.mergeGenerated && !mergeRunning" class="finalize-empty">
      <div class="fe-icon">
        <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <h3>准备合并定稿</h3>
      <p>前面各章正文已就绪。合稿会把它们合并为完整论文, 并自动生成摘要、关键词与参考文献。</p>
      <button class="btn-round" data-control="workflow:phase5-merge" @click="doMerge()">开始合并</button>
    </div>

    <!-- ═══ 三轮主流程 ═══ -->
    <div v-else class="rounds-card">
      <!-- 合并轮 -->
      <div class="round-row">
        <div class="round-head">
          <span class="round-num">①</span>
          <div class="round-info">
            <strong>合并正文</strong>
            <span>将全部章节合并为完整论文(自动生成摘要/关键词/参考文献)</span>
          </div>
          <div class="round-actions">
            <!-- 2026-09-15: 原先只有「开始合稿 + 降AIGC合稿」两个按钮, 强度(轻/中/重)整个不存在。
                 现在改成模式 tab + 档位选择, 且档位背后有真实实现(正文逐章降重, 不只是摘要)。 -->
            <div class="merge-mode" role="tablist">
              <!-- 模式/档位是**纯本地选择**, 不起任务 —— 不跟着 mergeRunning 禁用。
                   原先它们带 :disabled="mergeRunning", 合稿完成后 store.mergeGenerated
                   先被置真而 mergeRunning 还没放开, 于是 tab 看得见却点不动。 -->
              <button
                v-for="m in MERGE_MODES" :key="m.value"
                class="mm-tab" :class="{ on: mergeMode === m.value }" role="tab"
                :aria-pressed="mergeMode === m.value"
                :data-control="m.control"
                @click="mergeMode = m.value; if (m.value === 'deAIGC') mergeTier = 'medium'"
              >{{ m.label }}</button>
            </div>
            <button class="btn-round" :disabled="mergeRunning" data-control="workflow:phase5-merge" @click="doMerge()">
              {{ mergeRunning ? "合并中…" : store.mergeGenerated ? "重新合稿" : "开始合稿" }}
            </button>
          </div>
        </div>
        <!-- 强度档: 只在降 AIGC 模式下出现 -->
        <div v-if="mergeMode === 'deAIGC'" class="tier-row">
          <span class="tier-label">强度：</span>
          <button
            v-for="t in DEAI_TIERS" :key="t.value"
            class="tier-btn" :class="{ on: mergeTier === t.value }"
            :title="t.hint"
            :data-control="`workflow:aigc-tier-${t.value}`"
            @click="mergeTier = t.value"
          >{{ t.label }}</button>
          <span class="tier-hint">{{ DEAI_TIERS.find((t) => t.value === mergeTier)?.hint }}</span>
        </div>
        <!-- 时间轴(闭源每步带 desc 副文案) -->
        <div v-if="mergeRunning || mergeStep >= 5" class="merge-timeline">
          <div class="mt-track"><div class="mt-fill" :style="{ height: mergeStep >= 5 ? '100%' : mergeStep * 20 + '%' }"></div></div>
          <div v-for="(st, i) in MERGE_STEPS" :key="st.title" class="mt-item" :class="{ done: mergeStep > i, active: mergeStep === i }">
            <span class="mt-dot">{{ mergeStep > i ? "✓" : mergeStep === i ? "◌" : "" }}</span>
            <span class="mt-text">
              <span class="mt-label">{{ st.title }}</span>
              <span class="mt-desc">{{ st.desc }}</span>
            </span>
          </div>
        </div>
        <div v-if="mergeRunning" class="merge-msg">{{ mergeMessage || "正在合并正文…" }}</div>
      </div>

      <!-- 审查轮 -->
      <div class="round-row">
        <div class="round-head">
          <span class="round-num">②</span>
          <div class="round-info">
            <strong>全文审查</strong>
            <span>AI 对全文进行深度润色与质量提升, 输出结构化审查报告</span>
          </div>
          <button class="btn-round" :disabled="reviewRunning || !store.mergedFullText" @click="doReview" data-control="workflow:review">
            {{ reviewRunning ? "审查中…" : store.reviewResult ? "重新审查" : "开始全文审查" }}
          </button>
        </div>
        <div v-if="reviewStream" class="stream-block amber">{{ reviewStream }}</div>
        <div v-if="reviewReport" class="review-result-card">
          <div class="rr-head">
            <strong>{{ String((reviewReport as Record<string, unknown>).paperTitle ?? store.title) }}</strong>
            <span class="rr-score">{{ String((reviewReport as Record<string, unknown>).overallScore ?? "—") }} 分</span>
            <span class="rr-grade">{{ String((reviewReport as Record<string, unknown>).grade ?? "") }}</span>
          </div>
          <p class="rr-comment">{{ String((reviewReport as Record<string, unknown>).overallComment ?? (reviewReport as Record<string, unknown>).overall ?? "") }}</p>
          <!-- V417: 后端产了 highlights(亮点) 与 checks(五维 pass/detail), 原来前端全丢 ——
               那正是"全文审查"最有价值的部分(哪几维没过、具体什么问题)。 -->
          <div v-if="reviewHighlights.length" class="rr-block">
            <strong>亮点</strong>
            <ul><li v-for="(h, i) in reviewHighlights" :key="i">{{ h }}</li></ul>
          </div>
          <div v-if="reviewChecks.length" class="rr-block">
            <strong>五维审查</strong>
            <div v-for="c in reviewChecks" :key="c.name" class="rr-check" :class="{ fail: !c.pass }">
              <span class="rr-check-name">{{ c.name }}</span>
              <span class="rr-check-flag">{{ c.pass ? "通过" : "未通过" }}</span>
              <p class="rr-check-detail">{{ c.detail }}</p>
            </div>
          </div>
          <div v-if="(reviewReport as Record<string, unknown>).topSuggestions" class="rr-suggestions">
            <strong>首要建议:</strong>
            <ul>
              <li v-for="(s, i) in ((reviewReport as Record<string, unknown>).topSuggestions as string[] ?? []).slice(0, 5)" :key="i">{{ s }}</li>
            </ul>
          </div>
        </div>
      </div>

      <!-- 修订轮 -->
      <div class="round-row">
        <div class="round-head">
          <span class="round-num">③</span>
          <div class="round-info">
            <strong>修订定稿</strong>
            <span>根据审查报告生成修订稿(当前合稿不会被替换, 确认后采用)</span>
          </div>
          <button class="btn-round" :disabled="reviseRunning || !store.reviewResult" @click="doRevise" data-control="workflow:revise">
            {{ reviseRunning ? "修订中…" : "生成修订稿" }}
          </button>
        </div>
        <div v-if="pendingRevision" class="revision-card">
          <p>修订稿已生成, 正文 {{ pendingRevision.body.replace(/\s/g, "").length }} 字。当前合稿未被替换。</p>
          <div class="rev-actions">
            <button class="btn-view-diff" @click="viewDiff">查看差异</button>
            <button class="btn-adopt" @click="adoptRevision" data-control="workflow:adopt-revision">采用修订稿</button>
          </div>
        </div>
        <div v-if="showDiff" class="diff-block">
          <pre>{{ diffText }}</pre>
          <button class="btn-close-diff" @click="showDiff = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- ═══ 终稿编辑(mergeGenerated) ═══ -->
    <div v-if="store.mergeGenerated" class="finale-card">
      <div class="finale-head">
        <span class="done-badge">合并完成</span>
        <button class="btn-redo" @click="doMerge()">重新合稿</button>
      </div>
      <div class="finale-fields">
        <div class="f-row">
          <label>论文标题</label>
          <input v-model="store.mergedTitle" class="f-title" placeholder="论文标题" @input="onMetaInput" />
        </div>
        <div class="f-row">
          <label>摘要</label>
          <textarea v-model="store.mergedAbstract" class="f-area" rows="4" placeholder="摘要…" @input="onMetaInput"></textarea>
        </div>
        <div class="f-row">
          <label>关键词</label>
          <input v-model="store.mergedKeywords" class="f-input" placeholder="关键词1;关键词2;关键词3" @input="onMetaInput" />
        </div>
        <div class="f-row">
          <label>正文</label>
          <textarea v-model="mergedBody" class="f-area body" rows="18" placeholder="论文正文…"></textarea>
        </div>
        <div class="f-row">
          <label>参考文献</label>
          <textarea v-model="store.mergedReferences" class="f-area refs" rows="8" placeholder="[1] 作者.标题[J].期刊,年份." @input="onMetaInput"></textarea>
        </div>
      </div>
    </div>

    <!-- ═══ 导出 ═══ -->
    <div v-if="store.mergedFullText" class="export-card">
      <div class="export-row">
        <span>导出格式</span>
        <select v-model="exportFmt" class="fmt-select">
          <option value="md">Markdown</option>
          <option value="html">HTML(打印友好)</option>
          <option value="docx">Word(.docx)</option>
          <option value="pdf">PDF(先导出 Word)</option>
        </select>
        <button class="btn-export" :disabled="exportStatus === 'running'" @click="doExport" data-control="workflow:export">
          {{ exportStatus === "running" ? "导出中…" : "导出论文" }}
        </button>
        <button class="btn-preview" @click="store.exportFormat = 'preview'">预览全文</button>
        <button class="btn-back-ws" @click="router.push('/workflow/workspace')">返回工作台</button>
      </div>
      <!-- 后端按大纲树出文件(与上面的"拼文本"路径互补): Word 带大纲层级 + PPT 逐节点成片。
           这两个能力原先只有被弃用的 React 大纲面板在用, 搬到这里才有界面入口。 -->
      <div class="export-row">
        <span>按大纲导出</span>
        <button class="btn-preview" :disabled="docxBusy" @click="exportDocx" data-control="workflow:export-docx">
          {{ docxBusy ? "生成中…" : "Word(大纲版)" }}
        </button>
        <button class="btn-preview" :disabled="pptxBusy" @click="exportPptx" data-control="workflow:export-pptx">
          {{ pptxBusy ? "生成中…" : "PPT 汇报稿" }}
        </button>
      </div>
      <!-- V417 出站: 终稿送学术文本工作台继续精修(写作舱↔编辑器的连接) -->
      <div class="export-row">
        <span>继续加工</span>
        <button class="btn-preview" data-control="workflow:send-to-editor" @click="sendToEditor">
          送学术文本工作台
        </button>
      </div>
    </div>

    <!-- ═══ 逐章生成 / 论文要件(原先只有被弃用的 React 大纲面板有, 2026-09-13 搬过来) ═══ -->
    <div v-if="store.sections?.length" class="export-card">
      <div class="export-row">
        <span>论文要件</span>
        <button class="btn-preview" :disabled="!!componentBusy" @click="genComponent('abstract')" data-control="workflow:gen-abstract">
          {{ componentBusy === "abstract" ? "生成中…" : "生成摘要" }}
        </button>
        <button class="btn-preview" :disabled="!!componentBusy" @click="genComponent('keywords')" data-control="workflow:gen-keywords">
          {{ componentBusy === "keywords" ? "生成中…" : "生成关键词" }}
        </button>
        <button class="btn-preview" :disabled="!!componentBusy" @click="genComponent('conclusion')" data-control="workflow:gen-conclusion">
          {{ componentBusy === "conclusion" ? "生成中…" : "生成结论" }}
        </button>
      </div>
      <div class="chapter-list">
        <div v-for="s in [...store.sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))" :key="s.id" class="chapter-row">
          <span class="chapter-title" :style="{ paddingLeft: `${Math.max(s.level - 1, 0) * 14}px` }">{{ s.title }}</span>
          <span class="chapter-state">{{ s.content ? `${s.content.length} 字` : "未生成" }}</span>
          <button class="btn-preview" :disabled="!!chapterBusy" @click="genChapter(s.id)">
            {{ chapterBusy === s.id ? "生成中…" : s.content ? "重新生成" : "生成正文" }}
          </button>
        </div>
      </div>
    </div>

    <!-- 预览全文(简化版式) -->
    <div v-if="store.exportFormat === 'preview'" class="preview-card">
      <button class="preview-close" @click="store.exportFormat = 'md'">×</button>
      <div class="preview-paper">
        <h1>{{ store.mergedTitle }}</h1>
        <div class="preview-abstract"><strong>摘要</strong> {{ store.mergedAbstract }}</div>
        <p><strong>关键词：</strong>{{ store.mergedKeywords }}</p>
        <div class="preview-body markdown-body" v-html="mergedHtml"></div>
        <div class="preview-refs">
          <strong>参考文献</strong>
          <div class="markdown-body" v-html="refsHtml"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>

.workflow-page { width: 100%; box-sizing: border-box; }
.wf-h1 { margin: 0 0 4px; font-size: 22px; font-weight: 700; color: #E8EEF7; }
.wf-sub { margin: 0 0 16px; font-size: 13px; color: #8B9BB1; }
.rounds-card { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
/* 未合稿空态 */
.finalize-empty {
  text-align: center; padding: 40px 24px; margin-bottom: 16px;
  background: #11192C; border: 1px solid #222F44; border-radius: 12px;
}
.fe-icon {
  width: 64px; height: 64px; border-radius: 16px; margin: 0 auto 14px;
  background: #33240F; color: #E8B54A; display: grid; place-items: center;
}
.finalize-empty h3 { margin: 0 0 8px; font-size: 16px; color: #E8EEF7; }
.finalize-empty p { margin: 0 auto 18px; max-width: 420px; font-size: 13px; color: #8B9BB1; line-height: 1.7; }
.round-row {
  background: #11192C; border: 1px solid #222F44; border-radius: 12px;
  padding: 16px 18px;
}
.round-head { display: flex; align-items: flex-start; gap: 12px; }
.round-num { font-size: 20px; font-weight: 700; color: #E8B54A; }
.round-info { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.round-info strong { font-size: 15px; color: #E8EEF7; }
.round-info span { font-size: 12px; color: #8B9BB1; }
.round-actions { display: flex; gap: 7px; align-items: center; }
/* 合稿模式 tab + 降 AIGC 档位(2026-09-15) */
.merge-mode { display: flex; border: 1px solid #222F44; border-radius: 8px; overflow: hidden; }
.mm-tab {
  padding: 7px 14px; border: 0; background: #0E1729; color: #8B9BB1;
  font-size: 13px; cursor: pointer;
}
.mm-tab + .mm-tab { border-left: 1px solid #222F44; }
.mm-tab.on { background: #1E2A48; color: #E8EEF7; font-weight: 600; }
.mm-tab:disabled { opacity: 0.55; cursor: not-allowed; }
.tier-row { display: flex; align-items: center; gap: 6px; margin: 12px 0 0 22px; flex-wrap: wrap; }
.tier-label { font-size: 12.5px; color: #8B9BB1; }
.tier-btn {
  padding: 4px 12px; border: 1px solid #222F44; border-radius: 14px;
  background: #0E1729; color: #8B9BB1; font-size: 12.5px; cursor: pointer;
}
.tier-btn.on { background: #1E2A48; color: #E8B54A; border-color: #C9A23C; font-weight: 600; }
.tier-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.tier-hint { font-size: 11.5px; color: #7A8AA0; margin-left: 4px; }
.btn-round {
  padding: 7px 18px; border: 0; border-radius: 8px; background: #E8B54A;
  color: #F1F5F9; font-size: 13px; font-weight: 600; cursor: pointer;
}
.btn-round.ghost { background: #11192C; color: #E8B54A; border: 1px solid #C9A23C; }
.btn-round:disabled { opacity: 0.55; cursor: not-allowed; }
.merge-timeline { position: relative; margin: 18px 0 6px 30px; display: flex; flex-direction: column; gap: 10px; }
.mt-track { position: absolute; left: 7px; top: 6px; bottom: 6px; width: 2px; background: #1A2333; }
.mt-fill { width: 100%; background: #E8B54A; transition: height 0.3s; }
.mt-item { position: relative; display: flex; align-items: center; gap: 10px; padding-left: 2px; }
.mt-dot {
  width: 16px; height: 16px; border-radius: 50%; background: #1A2333;
  display: grid; place-items: center; font-size: 9px; color: #F1F5F9; z-index: 1; flex-shrink: 0;
}
.mt-item.done .mt-dot { background: #E8B54A; }
.mt-item.active .mt-dot { background: #11192C; border: 2px solid #E8B54A; color: #E8B54A; animation: spin-dot 1.2s linear infinite; }
@keyframes spin-dot { 50% { border-color: #fbbf24; } }
.mt-label { font-size: 12.5px; color: #8B9BB1; }
.mt-text { display: flex; flex-direction: column; gap: 1px; }
.mt-desc { font-size: 11px; color: #7A8AA0; }
.mt-item.done .mt-desc { color: #5F7288; }
.mt-item.done .mt-label { color: #E8EEF7; font-weight: 500; }
.merge-msg { margin-top: 8px; font-size: 12.5px; color: #E8B54A; }
.stream-block {
  margin-top: 10px; padding: 10px 14px; background: #11192Cbeb;
  border: 1px solid #3A3020; border-radius: 9px;
  font-size: 12.5px; color: #92400e; line-height: 1.7; white-space: pre-wrap;
  max-height: 220px; overflow-y: auto;
}
.review-result-card { margin-top: 10px; border: 1px solid #2E5C46; border-radius: 10px; background: #14281F; padding: 13px 16px; }
.rr-head { display: flex; align-items: center; gap: 10px; }
.rr-head strong { font-size: 14px; color: #166534; }
.rr-score { font-size: 18px; font-weight: 800; color: #5FD0B4; }
.rr-grade {
  font-size: 11px; background: #5FD0B4; color: #F1F5F9; padding: 2px 9px; border-radius: 8px; font-weight: 600;
}
.rr-comment { font-size: 12.5px; color: #DCE6F2; line-height: 1.7; margin: 6px 0; }
.rr-block { margin-top: 8px; }
.rr-block strong { font-size: 12px; color: #8B9BB1; }
.rr-block ul { margin: 4px 0 0; padding-left: 18px; }
.rr-block li { font-size: 12.5px; line-height: 1.7; color: #C7D2E0; }
.rr-check { margin-top: 6px; padding: 6px 9px; border-radius: 6px; background: #14281F; border: 1px solid #2E5C46; }
.rr-check.fail { background: #2a1416; border-color: #7f1d1d; }
.rr-check-name { font-size: 12px; font-weight: 600; color: #E8EEF7; }
.rr-check-flag { margin-left: 8px; font-size: 11px; color: #8B9BB1; }
.rr-check-detail { margin: 3px 0 0; font-size: 12px; line-height: 1.65; color: #C7D2E0; }
.rr-suggestions { font-size: 12px; color: #DCE6F2; }
.rr-suggestions ul { margin: 4px 0 0; padding-left: 18px; }
.rr-suggestions li { margin-bottom: 2px; line-height: 1.6; }
.revision-card { margin-top: 10px; padding: 10px 14px; background: #11192Cbeb; border: 1px solid #3A3020; border-radius: 9px; }
.revision-card p { margin: 0 0 8px; font-size: 12.5px; color: #92400e; }
.rev-actions { display: flex; gap: 8px; }
.btn-view-diff, .btn-adopt { padding: 5px 13px; border-radius: 7px; font-size: 12px; cursor: pointer; border: 0; }
.btn-view-diff { background: #11192C; border: 1px solid #222F44; color: #8B9BB1; }
.btn-adopt { background: #5FD0B4; color: #F1F5F9; font-weight: 600; }
.diff-block {
  margin-top: 10px; padding: 12px; background: #1e293b; border-radius: 9px; position: relative;
}
.diff-block pre {
  margin: 0; color: #222F44; font-size: 11.5px; line-height: 1.6; white-space: pre-wrap;
  font-family: ui-monospace, monospace; max-height: 240px; overflow-y: auto;
}
.btn-close-diff { position: absolute; top: 8px; right: 8px; background: #DCE6F2; color: #222F44; border: 0; border-radius: 5px; font-size: 11px; padding: 3px 9px; cursor: pointer; }
.finale-card { background: #11192C; border: 1px solid #222F44; border-radius: 12px; padding: 16px 18px; margin-bottom: 16px; }
.finale-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.done-badge { font-size: 12px; background: #3A3020; color: #E8B54A; padding: 3px 11px; border-radius: 9px; font-weight: 600; }
.btn-redo { padding: 5px 13px; border: 1px solid #222F44; border-radius: 7px; background: #11192C; color: #8B9BB1; font-size: 12px; cursor: pointer; }
.finale-fields { display: flex; flex-direction: column; gap: 12px; }
.f-row { display: flex; flex-direction: column; gap: 5px; }
.f-row label { font-size: 12.5px; font-weight: 600; color: #DCE6F2; }
.f-title { font-size: 17px; font-weight: 700; padding: 6px 10px; border: 0; border-bottom: 1px solid #222F44; }
.f-input { padding: 7px 10px; border: 1px solid #222F44; border-radius: 8px; font-size: 13px; }
.f-area {
  padding: 10px 12px; border: 1px solid #222F44; border-radius: 8px;
  font-size: 13.5px; line-height: 1.8; font-family: inherit; resize: vertical;
}
.f-area.body { font-size: 14px; min-height: 300px; }
.f-area.refs { font-size: 12px; }
.export-card {
  background: #11192C; border: 1px solid #222F44; border-radius: 12px;
  padding: 14px 18px; display: flex; align-items: center;
}
.export-row { display: flex; align-items: center; gap: 10px; width: 100%; flex-wrap: wrap; }
.export-row > span { font-size: 13px; color: #DCE6F2; font-weight: 600; }
.fmt-select { padding: 7px 10px; border: 1px solid #222F44; border-radius: 8px; font-size: 13px; background: #11192C; }
.btn-export { padding: 8px 22px; background: #5FD0B4; color: #F1F5F9; border: 0; border-radius: 8px; font-size: 13.5px; font-weight: 600; cursor: pointer; }
.btn-export:disabled { opacity: 0.55; cursor: not-allowed; }
.btn-preview { padding: 8px 16px; border: 1px solid #222F44; border-radius: 8px; background: #11192C; color: #DCE6F2; font-size: 13px; cursor: pointer; }
.btn-back-ws { margin-left: auto; padding: 8px 16px; border: 1px solid #222F44; border-radius: 8px; background: #1A2333; color: #8B9BB1; font-size: 13px; cursor: pointer; text-decoration: none; }
.chapter-list { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.chapter-row { display: flex; align-items: center; gap: 10px; padding: 4px 0; border-top: 1px solid #1B2537; }
.chapter-title { flex: 1; min-width: 0; font-size: 13px; color: #DCE6F2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chapter-state { flex: 0 0 auto; font-size: 12px; color: #7A8AA0; }
.chapter-row .btn-preview { padding: 5px 12px; font-size: 12px; }
.chapter-row .btn-preview:disabled { opacity: 0.55; cursor: not-allowed; }
.preview-card {
  position: fixed; inset: 0; z-index: 80; background: rgba(15, 23, 42, 0.5);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.preview-close { position: absolute; top: 16px; right: 20px; font-size: 22px; background: rgba(17,25,44,0.92); border: 0; border-radius: 50%; width: 36px; height: 36px; cursor: pointer; z-index: 2; }
.preview-paper {
  width: min(100%, 860px); max-height: 90vh; overflow-y: auto;
  background: #11192C; padding: 48px 64px; box-shadow: 0 20px 60px rgba(15, 23, 42, 0.3);
  font-family: SimSun, "Noto Serif SC", serif; font-size: 12pt; line-height: 1.8; color: #111;
}
.preview-paper h1 { text-align: center; font-size: 18pt; font-family: SimHei, sans-serif; }
.preview-abstract { margin: 16px 0; }
.preview-body p { text-indent: 2em; margin: 0.4em 0; text-align: justify; }
.preview-refs pre { white-space: pre-wrap; font-family: inherit; font-size: 10.5pt; }
</style>

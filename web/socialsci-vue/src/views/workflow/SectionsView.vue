<script setup lang="ts">
/**
 * SectionsView(Phase2 科研架构) — 还原自闭源 SectionsView-C4lM9Tih.js(L212-1595, 单组件纯消费页)
 * 页头统计/AI 分析横幅 3 态/3 步进度+打字机思考/变量卡+假设/章节树(aiSkill 写作指导)
 * 数据源: workbench 快照恢复 + skill-cards(后端 aiSkill 生成)轮询
 */
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useRouter } from "vue-router";
import { useWorkflowStore } from "./stores/workflow";
import type { Section } from "./stores/workflow";
import { listSkillCards, batchGenerateSkillCards, createTask, getTask } from "@/shared/tasks";
import { toast } from "@/shared/ui";
import { q } from "@/shared/api";
import PhaseProgressBar from "./PhaseProgressBar.vue";

const router = useRouter();
const store = useWorkflowStore();

// ── 打字机(闭源 L242-274: 20ms tick, chunk=clamp(8..40, ceil(剩余/20))) ──
const typewriterArea = ref<HTMLElement | null>(null);
const typeText = ref("");
let typeTimer: ReturnType<typeof setTimeout> | null = null;
let typeQueue = "";
let typeFull = "";

function startTypewriter(full: string) {
  typeFull = full || "";
  typeText.value = "";
  typeQueue = typeFull;
  stopTypewriter();
  const tick = () => {
    if (!typeQueue) return;
    const remain = typeQueue.length;
    const chunk = Math.min(40, Math.max(8, Math.ceil(remain / 20)));
    typeText.value += typeQueue.slice(0, chunk);
    typeQueue = typeQueue.slice(chunk);
    if (typeQueue) typeTimer = setTimeout(tick, 20);
  };
  tick();
}
function finishTypewriter() {
  stopTypewriter();
  typeText.value = typeFull;
  typeQueue = "";
}
function stopTypewriter() {
  if (typeTimer) {
    clearTimeout(typeTimer);
    typeTimer = null;
  }
}

// ── AI 分析状态 ──
const analyzing = ref(false);
const analyzeStep = ref(0); // 0 idle/1 变量识别/2 框架/3 skill
const analyzeMsg = ref("");
const analyzeFailed = ref(false);
const analyzeError = ref("");
const pollTimer = ref<ReturnType<typeof setInterval> | null>(null);
const activeJobId = ref("");

// ── 步骤(闭源 Q 表: 定性词表切换) ──
const isQual = computed(() => store.input.researchMethod === "qualitative" || (store.input.researchMethod || "").includes("qual"));
const steps = computed(() => [
  { key: 1, label: isQual.value ? "因素识别" : "变量识别" },
  { key: 2, label: "框架分析" },
  { key: 3, label: "Skill 生成" }
]);

// ── 派生统计(闭源 k/L/C/D/H/$) ──
const l1Count = computed(() => store.level1Sections.length);
const childCount = computed(() => store.sections.filter((s) => s.level === 2).length);
const withSkill = computed(() => store.level1Sections.filter((s) => s.aiSkill || s.skill_prompt).length);
const skillComplete = computed(() => withSkill.value > 0 && withSkill.value >= l1Count.value);
const missingCount = computed(() => Math.max(0, l1Count.value - withSkill.value));
const canConfirm = computed(() => !analyzing.value && l1Count.value > 0 && withSkill.value >= l1Count.value);

// ── 变量角色色(闭源 K L355-368 定量 5 色/定性词表) ──
const roleColor = (role: string): string => {
  const r = String(role ?? "");
  const qn: Record<string, string> = {
    "自变量": "#2563eb", "因变量": "#dc2626", "中介": "#E8B54A", "调节": "#7c3aed", "控制": "#6b7280",
    "x": "#2563eb", "y": "#dc2626", "mediator": "#E8B54A", "moderator": "#7c3aed", "control": "#6b7280",
    "影响因素": "#2563eb", "结果表现": "#dc2626", "中间机制": "#E8B54A", "情境条件": "#7c3aed", "背景因素": "#6b7280"
  };
  return qn[r] ?? "#2563eb";
};

// ── 恢复 + 启动分析 ──
async function startAnalysis(force = false) {
  if (analyzing.value) return; // 防双任务
  analyzing.value = true;
  analyzeFailed.value = false;
  analyzeError.value = "";
  try {
    const sectionsSeed = store.sections.length
      ? store.sections
      : parseOutlineToSections(store.input.outline, store.input.title);
    store.sections = sectionsSeed;
    await store.saveProject();
    // 创建 analyze 任务(后端泵执行) — 结果 structured 回填需后端 analyze 执行器产 skills
    const t = await createTask({
      title: store.input.title || "科研架构分析",
      projectId: store.taskId,
      module: "workflow",
      jobKind: "analyze",
      goal: store.input.title || "科研架构分析",
      phase: 2,
      phaseLabel: "科研架构"
    });
    activeJobId.value = t.id;
    pollJob();
  } catch (e) {
    analyzing.value = false;
    analyzeFailed.value = true;
    analyzeError.value = String((e as Error).message ?? e);
  }
}

/** 取消分析: 停轮询 + 后端任务 cancel(防旧 job 泵执行完覆盖; 刷新/重进时恢复续显) */
async function cancelAnalysis() {
  const jobId = activeJobId.value;
  stopPoll();
  analyzing.value = false;
  if (jobId) {
    try {
      await q(`/research/tasks/${jobId}/control`, { method: "POST", body: { action: "cancel" } }).catch(() => null);
    } catch { /* 容忍 */ }
  }
  toast("已取消分析", "info");
}

// ── 大纲文本 → sections 种子(1/2 级, 与 OutlineEditor 同正则) ──
function parseOutlineToSections(outline: string, topic: string): Section[] {
  const lines = String(outline ?? "").split("\n");
  const out: Section[] = [];
  const CN: Record<string, number> = {};
  "一二三四五六七八九十".split("").forEach((c, i) => (CN[c] = i));
  let parent: Section | null = null;
  let order = 0;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    let level = 0;
    let title = "";
    if (/^\d+\.\d+(\.\d+)*/.test(t)) { level = 2; title = t.replace(/^\d+(\.\d+)+\.?\s*/, ""); }
    else if (/^\d+[.、]\s*/.test(t)) { level = 1; title = t.replace(/^\d+[.、]\s*/, ""); }
    else if (/^第[一二三四五六七八九十百0-9]+章/.test(t)) { level = 1; title = t.replace(/^第[一二三四五六七八九十百0-9]+章[、.\s]*/, ""); }
    else if (/^[一二三四五六七八九十]+、/.test(t)) { level = 1; title = t.replace(/^[一二三四五六七八九十]+、\s*/, ""); }
    else if (/^（[一二三四五六七八九十]+）/.test(t)) { level = 2; title = t.replace(/^（[一二三四五六七八九十]+）\s*/, ""); }
    else if (/^\s{2,}/.test(raw)) { level = 2; title = t; }
    else { level = 1; title = t; }
    const sec: Section = { id: `sec_${Date.now()}_${order}`, title, level, order: order++, status: "pending" };
    if (level === 1) {
      parent = sec;
      out.push(sec);
    } else if (level === 2 && parent) {
      sec.parentId = parent.id;
      out.push(sec);
    } else {
      parent = sec;
      out.push(sec);
    }
  }
  if (!out.length && topic) out.push({ id: `sec_${Date.now()}_0`, title: topic, level: 1, order: 0, status: "pending" });
  return out;
}

// ── 任务轮询(泵执行进度; analyze 产 structured.skills/variables 回填 workbench) ──
function pollJob() {
  stopPoll();
  pollTimer.value = setInterval(async () => {
    try {
      const t = await getTask(activeJobId.value);
      if (!t) return;
      if (t.status === "done" || t.status === "completed") {
        stopPoll();
        // 回填: 后端 analyze 结果 → 变量/假设/框架 → 逐章写作指导 → 拉 skill-cards 合并
        // 注意: analyzing 保持 true 直到回填完成, 防窗口期用户重复点"重新分析"
        analyzeStep.value = 3;
        analyzeMsg.value = "分析完成, 正在回填写作指导...";
        finishTypewriter();
        await extractAnalysisResult(t);
        await generateWritingGuides();
        await store.loadProject();
        analyzing.value = false;
        toast("科研架构分析完成", "success");
      } else if (t.status === "failed" || t.status === "cancelled") {
        stopPoll();
        analyzing.value = false;
        analyzeFailed.value = true;
        analyzeError.value = "科研架构生成失败, 请重试";
      } else {
        // progress {stage,current,total} → 步骤推进
        const progress = (t as { progress?: { stage?: string; current?: number; total?: number } }).progress;
        if (progress?.stage) {
          if (progress.stage.includes("变量") || progress.stage.includes("因素")) analyzeStep.value = 1;
          else if (progress.stage.includes("框架")) analyzeStep.value = 2;
          else if (progress.stage.includes("Skill") || progress.stage.includes("skill")) analyzeStep.value = 3;
          analyzeMsg.value = String(progress.stage);
        } else {
          analyzeStep.value = analyzeStep.value || 1;
          analyzeMsg.value = "正在生成章节写作指导...";
        }
      }
    } catch { /* 容忍 */ }
  }, 800);
}
function stopPoll() {
  if (pollTimer.value) {
    clearInterval(pollTimer.value);
    pollTimer.value = null;
  }
}


/** analyze 结果提取: 变量/假设/逻辑流(后端 structured + stepAnalysisTexts 双源) */
async function extractAnalysisResult(t: { result?: unknown }) {
  try {
    const res = (t.result ?? {}) as { structured?: Record<string, unknown>; text?: string };
    const st = (res.structured ?? {}) as Record<string, unknown>;
    // 变量(后端 structured.variables 或 skill-cards 无独立变量源时为空)
    const vars = Array.isArray(st.variables) ? st.variables : null;
    if (vars && vars.length) {
      store.variables = vars.map((v) => {
        const it = v as Record<string, unknown>;
        return { name: String(it.name ?? it.var ?? ""), role: String(it.role ?? "控制"), description: it.description ? String(it.description) : undefined, measurement: it.measurement ? String(it.measurement) : undefined };
      });
    }
    // 假设: 从 step2 文本或 structured.hypotheses
    const sats = (st.stepAnalysisTexts ?? {}) as Record<string, unknown>;
    const rawText = [String(sats["2"] ?? st.step2Text ?? ""), String(res.text ?? "")].join("\n");
    const hs = parseHypotheses(rawText || null);
    if (hs.length) store.hypotheses = hs;
    // 逻辑流
    if (st.logicFlow) store.project.logicFlow = String(st.logicFlow);
    await store.saveProject();
  } catch { /* 容忍 */ }
}

/** 生成各一级章节写作指导(闭源 generateSkillsForSections: 后端逐章 LLM 生成 aiSkill) */
async function generateWritingGuides() {
  const l1 = store.level1Sections;
  if (!l1.length || !store.taskId) return;
  try {
    await batchGenerateSkillCards(store.taskId, l1.map((s) => ({ id: s.id, title: s.title, level: 1 })));
  } catch { /* 后端容忍 */ }
  await loadSkillCards();
}

async function loadSkillCards() {
  if (!store.taskId) return;
  try {
    const cards = await listSkillCards(store.taskId);
    if (!cards.length) return;
    const map = new Map<string, Record<string, unknown>>();
    for (const c of cards) {
      // DB 扁平行(snake_case) → aiSkill camelCase(对齐后端 generate 写 sections 节点结构)
      const flat = c as Record<string, unknown>;
      const camel: Record<string, unknown> = {
        type: flat.skill_type ?? flat.type,
        wordCount: Number(flat.word_count ?? flat.wordCount ?? 0),
        writingGoal: flat.writing_goal ?? flat.writingGoal ?? "",
        keyPoints: Array.isArray(flat.key_points) ? flat.key_points : Array.isArray(flat.keyPoints) ? flat.keyPoints : [],
        notes: flat.notes ?? "",
        connection: flat.connection ?? "",
        sectionTitle: flat.section_title ?? flat.sectionTitle ?? "",
        frameworkSource: flat.framework_source ?? flat.frameworkSource ?? "",
        chapterDraft: flat.chapter_draft ?? flat.chapterDraft ?? "",
        childSections: Array.isArray(flat.child_sections) ? flat.child_sections : Array.isArray(flat.childSections) ? flat.childSections : []
      };
      map.set(String(flat.section_id ?? flat.id ?? ""), camel);
    }
    for (const s of store.sections) {
      const card = map.get(s.id);
      if (card) {
        s.aiSkill = card;
        s.skill_prompt = String((card as Record<string, unknown>).skill_prompt ?? s.skill_prompt ?? "");
      }
    }
  } catch { /* 容忍 */ }
}

// ── 确认进入素材准备(闭源 Z() 门禁) ──
async function confirmSections() {
  if (!l1Count.value) {
    toast("请至少添加一个章节", "warning");
    return;
  }
  if (!skillComplete.value) {
    toast("科研架构尚未生成完整, 请先重新分析", "warning");
    return;
  }
  store.phase = 3;
  store.phaseLabel = "素材准备";
  await store.saveProject();
  void router.push("/workflow/materials");
}

// ── A2 假设解析(闭源 j() L281-321: 定性空; stepAnalysisTexts[2] ①json conceptModel ②行正则 ③兜底配对) ──
function parseHypotheses(text: string | undefined | null): string[] {
  const src = String(text ?? "");
  const out: string[] = [];
  if (!src.trim()) return out;
  // ① ```json conceptModel.hypotheses
  try {
    const m = src.match(/```json\s*([\s\S]*?)```/);
    if (m) {
      const j = JSON.parse(m[1]);
      const hs = j?.conceptModel?.hypotheses ?? j?.hypotheses;
      if (Array.isArray(hs)) {
        for (const h of hs) {
          const st = String(h?.statement ?? h?.text ?? "");
          if (st.trim()) out.push(st.trim() + (h?.logic ? `(${h.logic})` : ""));
        }
        if (out.length) return out;
      }
    }
  } catch { /* 落到下一级 */ }
  // ② 行正则
  const re = /^(H\d+[.、:：]|假设\d+[.、:：]|[（(]H\d+[)）])\s*(.+)$/gm;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(src)) !== null) {
    const body = mm[2].trim();
    if (body && body.length > 4) out.push(`${mm[1].replace(/[.、:：]/g, "")}: ${body}`);
  }
  if (out.length) return out;
  // ③ 兜底: 自变量/因变量配对(闭源 role=自变量/因变量)
  const x = store.variables.find((v) => ["自变量", "影响因素"].includes(v.role));
  const y = store.variables.find((v) => ["因变量", "结果表现"].includes(v.role));
  if (x && y) out.push(`${x.name} 对 ${y.name} 有显著影响`);
  return out;
}

// A3: 研究方法 pill(闭源 L1112-1116: 已选择/自动识别)
const methodPill = computed(() => {
  const mm = store.input.researchMethod;
  const labels: Record<string, string> = { qualitative: "定性研究", quantitative: "定量研究", mixed: "混合方法" };
  const chosen = labels[mm ?? ""];
  const manual = !!mm; // 用户在 Input 显式选择过(researchMethod 非启发式空)
  return { label: chosen || "研究方法未选择", auto: !manual && !!chosen };
});

// ── 章节树展示辅助 ──
function sectionNumber(i: number): string {
  const cn = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五"];
  return cn[i] ?? String(i + 1);
}
function wordCountBadge(s: Section): string | null {
  const wc = s.aiSkill?.wordCount ?? (s as { wordCount?: number }).wordCount;
  return wc ? `${wc} 字(Phase 1 分配)` : null;
}

onMounted(async () => {
  await store.loadProject().catch(() => null);
  // 活动 analyze job 恢复(取消/刷新后回来续显, 防重复建任务并发写)
  const recent = await (await import("@/shared/tasks")).listTasks({ module: "workflow", limit: 5 }).catch(() => []);
  const active = recent.find((t) => t.jobKind === "analyze" && ["queued", "running"].includes(t.status) && t.projectId === store.taskId);
  if (active) {
    activeJobId.value = active.id;
    analyzing.value = true;
    analyzeStep.value = 1;
    analyzeMsg.value = "正在继续上次的科研架构分析...";
    pollJob();
    return;
  }
  // 已有章节骨架(从 workbench 恢复) → 直接尝试拉 skill-cards; 无则空
  if (store.sections.length) {
    void loadSkillCards();
  } else if (store.input.title || store.input.outline) {
    store.sections = parseOutlineToSections(store.input.outline, store.input.title);
    await store.saveProject();
  }
});
onUnmounted(() => {
  stopPoll();
  stopTypewriter();
});
</script>

<template>
  <div class="workflow-page max-w-5xl mx-auto px-6 py-8 pb-16" data-assistant-phase2-sections-count="1">
    <PhaseProgressBar />
    <h1 class="wf-h1">科研架构</h1>
    <p class="wf-sub">{{ store.title || "未命名项目" }} — 确认科研架构后进入创作工作台。</p>
    <p class="wf-stats">共 {{ l1Count }} 章 · {{ childCount }} 个子节</p>

    <!-- AI 分析横幅(3 态) -->
    <div v-if="analyzeFailed" class="banner banner-fail">
      <div class="banner-head">
        <strong>科研架构生成失败</strong>
      </div>
      <p class="banner-body">{{ analyzeError }}</p>
      <button class="btn-red-sm" @click="startAnalysis(true)">重新生成</button>
    </div>

    <div v-else-if="analyzing" class="banner banner-thinking">
      <div class="banner-head">
        <strong>AI 正在分析中</strong>
        <button class="banner-cancel" @click="stopPoll(); analyzing = false">取消</button>
      </div>
      <div class="step-progress">
        <div v-for="(s, i) in steps" :key="s.key" class="step-item" :class="{ active: analyzeStep >= s.key, done: analyzeStep > s.key }">
          <span class="step-circle">{{ analyzeStep > s.key ? "✓" : i + 1 }}</span>
          <span class="step-label">{{ s.label }}</span>
        </div>
      </div>
      <div v-if="typeText || analyzeMsg" class="thinking-area">
        <div class="thinking-title">{{ analyzeMsg || "分析中" }} · Step {{ analyzeStep }}/3</div>
        <pre ref="typewriterArea" class="thinking-text">{{ typeText }}</pre>
      </div>
      <div v-else class="thinking-empty">准备分析...</div>
    </div>

    <div v-else-if="skillComplete" class="banner banner-done">
      <div class="banner-head"><strong>AI 分析完成</strong></div>
      <p class="banner-body">分析完成, 章节写作指导已生成</p>
    </div>

    <div v-else class="banner banner-idle">
      <div class="banner-head"><strong>AI 分析</strong></div>
      <p class="banner-body">AI 将识别研究变量/因素、分析框架并生成每章写作指导。</p>
      <button class="btn-red" @click="startAnalysis()">开始科研架构分析</button>
    </div>

    <!-- 缺失警告 -->
    <div v-if="missingCount > 0 && !analyzing" class="warn-bar">
      ⚠ 还有 {{ missingCount }} 章缺少写作指导, 当前科研架构尚未生成完整。
      <button class="btn-warn" @click="startAnalysis(true)">重新分析</button>
    </div>

    <!-- 变量卡网格 -->
    <section v-if="store.variables.length" class="var-grid">
      <div v-for="v in store.variables" :key="v.name" class="var-card">
        <span class="var-role" :style="{ background: roleColor(v.role) }">{{ v.role }}</span>
        <strong>{{ v.name }}</strong>
        <p v-if="v.description">{{ v.description }}</p>
        <p v-if="v.measurement" class="var-measure">{{ v.measurement }}</p>
      </div>
    </section>

    <!-- 研究逻辑 + 方法 pill(闭源 L1112-1116) -->
    <section v-if="store.project.logicFlow || methodPill.label !== '研究方法未选择'" class="logic-card">
      <div class="logic-row">
        <span class="logic-label">研究逻辑</span>
        <span v-if="store.project.logicFlow" class="logic-flow">{{ store.project.logicFlow }}</span>
        <span v-else class="logic-empty">待分析完成后展示</span>
        <span class="method-pill">{{ methodPill.label }}</span>
        <span v-if="methodPill.auto" class="auto-tag">已根据标题和目录自动识别</span>
        <span v-else-if="methodPill.label !== '研究方法未选择'" class="auto-tag">已由你选择</span>
      </div>
    </section>

    <!-- 研究假设 -->
    <section v-if="store.hypotheses.length && !isQual" class="hypo-card">
      <h3 class="sec-title">研究假设</h3>
      <div v-for="(h, i) in store.hypotheses" :key="i" class="hypo-item">
        <span class="hypo-badge">H{{ i + 1 }}</span>
        <span>{{ h }}</span>
      </div>
    </section>

    <!-- 章节树 -->
    <section class="tree-card">
      <h3 class="sec-title">章节结构</h3>
      <div v-if="!store.sections.length" class="tree-empty">暂无章节 — 请先在信息录入填写大纲</div>
      <div v-for="(s, i) in store.level1Sections" :key="s.id" class="level1-row">
        <div class="l1-head">
          <span class="l1-num">{{ sectionNumber(i) }}</span>
          <strong>{{ s.title || "未命名章节" }}</strong>
          <span v-if="s.aiSkill || s.skill_prompt" class="skill-badge">{{ store.input.sampleFiles.length ? "参考框架" : "AI 写作指导" }}</span>
          <span v-if="wordCountBadge(s)" class="wc-badge">{{ wordCountBadge(s) }}</span>
        </div>
        <!-- 写作指导详情 -->
        <div v-if="s.aiSkill" class="skill-detail">
          <template v-if="s.aiSkill.frameworkSource">
            <div class="fs-row amber"><strong>框架来源</strong>: {{ s.aiSkill.frameworkSource }}</div>
          </template>
          <div v-if="s.aiSkill.writingGoal" class="skill-block"><strong>写作目标</strong>: {{ s.aiSkill.writingGoal }}</div>
          <div v-if="s.aiSkill.keyPoints" class="skill-block">
            <strong>要点</strong>
            <ul><li v-for="(k, ki) in s.aiSkill.keyPoints" :key="ki">{{ k }}</li></ul>
          </div>
          <div v-if="s.aiSkill.connection" class="skill-block"><strong>衔接</strong>: {{ s.aiSkill.connection }}</div>
          <div v-if="s.aiSkill.notes" class="skill-block"><strong>注意</strong>: {{ s.aiSkill.notes }}</div>
        </div>
        <div v-else-if="analyzing" class="skill-pending">AI 正在分析该章节…</div>
        <div v-else class="skill-pending dim">该章写作指导尚未生成</div>
      </div>
    </section>

    <!-- 底部操作 -->
    <div class="wf-actions">
      <button class="btn-back" @click="router.push('/workflow/input')">返回修改</button>
      <button class="btn-primary" :disabled="!canConfirm" data-assistant-control="workflow_sections_confirm" @click="confirmSections">
        确认科研架构, 进入素材准备
      </button>
    </div>
  </div>
</template>

<style scoped>

.workflow-page { width: 100%; box-sizing: border-box; }
.wf-h1 { margin: 0 0 4px; font-size: 22px; font-weight: 700; color: #E8EEF7; }
.wf-sub { margin: 0; font-size: 13px; color: #8B9BB1; }
.wf-stats { margin: 8px 0 16px; font-size: 12.5px; color: #E8EEF7; background: #212C45; display: inline-block; padding: 3px 12px; border-radius: 12px; }
.banner { border-radius: 12px; padding: 14px 18px; margin-bottom: 14px; }
.banner-fail { background: #2A1C1C; border: 1px solid #3A2323; }
.banner-thinking { background: #1A2333; border: 1px solid #46587A; }
.banner-done { background: #14281F; border: 1px solid #2E5C46; }
.banner-idle { background: #11192C; border: 1px solid #222F44; }
.banner-head { display: flex; justify-content: space-between; align-items: center; }
.banner-head strong { font-size: 15px; }
.banner-fail .banner-head strong { color: #dc2626; }
.banner-thinking .banner-head strong { color: #DCE6F2; }
.banner-done .banner-head strong { color: #5FD0B4; }
.banner-body { font-size: 13px; color: #8B9BB1; margin: 6px 0; line-height: 1.6; }
.banner-cancel { border: 0; background: #212C45; color: #8B9BB1; padding: 3px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; }
.btn-red { padding: 7px 18px; background: #dc2626; color: #F1F5F9; border: 0; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
.btn-red-sm { padding: 4px 14px; background: #dc2626; color: #F1F5F9; border: 0; border-radius: 7px; font-size: 12px; cursor: pointer; }
.step-progress { display: flex; gap: 8px; margin: 12px 0; }
.step-item { display: flex; align-items: center; gap: 6px; }
.step-circle {
  width: 22px; height: 22px; border-radius: 50%;
  background: #222F44; color: #7A8AA0;
  display: grid; place-items: center; font-size: 11px;
}
.step-item.active .step-circle { background: #dc2626; color: #F1F5F9; }
.step-item.done .step-circle { background: #5FD0B4; color: #F1F5F9; }
.step-label { font-size: 12px; color: #8B9BB1; }
.step-item.active .step-label { color: #E8EEF7; font-weight: 600; }
.thinking-area { margin-top: 8px; }
.thinking-title { font-size: 12px; color: #8B9BB1; margin-bottom: 4px; }
.thinking-text {
  margin: 0; padding: 10px; background: #212C45; border-radius: 8px;
  font-family: ui-monospace, monospace; font-size: 11.5px; line-height: 1.6;
  color: #DCE6F2; white-space: pre-wrap; max-height: 140px; overflow-y: auto;
}
.thinking-empty { font-size: 12px; color: #7A8AA0; font-style: italic; padding: 10px; }
.warn-bar {
  background: #11192Cbeb; border: 1px solid #3A3020; color: #E8B54A;
  padding: 9px 14px; border-radius: 9px; font-size: 12.5px; margin-bottom: 14px;
  display: flex; align-items: center; gap: 10px;
}
.btn-warn { border: 0; background: #E8B54A; color: #F1F5F9; padding: 3px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; }
.var-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; margin-bottom: 16px; }
.var-card {
  background: #11192C; border: 1px solid #222F44; border-radius: 10px; padding: 12px;
  display: flex; flex-direction: column; gap: 6px;
}
.var-card:hover { border-color: #a5b4fc; }
.var-role { align-self: flex-start; color: #F1F5F9; font-size: 10.5px; padding: 2px 9px; border-radius: 8px; }
.var-card strong { font-size: 14px; color: #E8EEF7; }
.var-card p { margin: 0; font-size: 12px; color: #8B9BB1; line-height: 1.5; }
.var-measure { color: #7A8AA0 !important; font-size: 11.5px !important; }
.hypo-card, .tree-card {
  background: #11192C; border: 1px solid #222F44; border-radius: 12px;
  padding: 16px 18px; margin-bottom: 14px;
}
.sec-title { margin: 0 0 10px; font-size: 15px; color: #E8EEF7; }
.hypo-item { display: flex; gap: 8px; font-size: 13px; color: #DCE6F2; padding: 4px 0; align-items: baseline; }
.hypo-badge {
  background: #ede9fe; color: #7c3aed; font-size: 11px;
  padding: 1px 7px; border-radius: 7px; flex-shrink: 0; font-weight: 600;
}
.tree-empty { padding: 24px; text-align: center; color: #7A8AA0; font-size: 13px; }
.level1-row { border-bottom: 1px solid #212C45; padding: 10px 0; }
.level1-row:last-child { border-bottom: 0; }
.l1-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.l1-num {
  width: 24px; height: 24px; border-radius: 6px;
  background: #dc2626; color: #F1F5F9;
  display: grid; place-items: center; font-size: 12px; font-weight: 600;
  flex-shrink: 0;
}
.l1-head strong { font-size: 14px; color: #E8EEF7; }
.skill-badge { font-size: 10.5px; padding: 2px 8px; background: #1E2A48; color: #2563eb; border-radius: 8px; }
.wc-badge { font-size: 10.5px; padding: 2px 8px; background: #1E2A48; color: #2563eb; border: 1px solid #bfdbfe; border-radius: 8px; }
.skill-detail { margin: 8px 0 0 34px; display: flex; flex-direction: column; gap: 6px; }
.fs-row.amber { background: #11192Cbeb; border: 1px solid #3A3020; border-radius: 6px; padding: 5px 10px; font-size: 12px; color: #E8B54A; }
.skill-block { font-size: 12.5px; color: #DCE6F2; line-height: 1.6; }
.skill-block strong { color: #E8EEF7; }
.skill-block ul { margin: 4px 0 0; padding-left: 18px; }
.skill-pending { margin: 6px 0 0 34px; font-size: 12px; color: #8B9BB1; }
.skill-pending.dim { color: #7A8AA0; }
.wf-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
.btn-back {
  padding: 10px 22px; border: 1px solid #222F44; border-radius: 9px;
  background: #11192C; color: #8B9BB1; font-size: 14px; cursor: pointer;
}
.btn-primary {
  padding: 10px 26px; border: 0; border-radius: 9px;
  background: #dc2626; color: #F1F5F9; font-size: 14px; font-weight: 600; cursor: pointer;
}
.btn-primary:disabled { background: #46587A; cursor: not-allowed; }
</style>

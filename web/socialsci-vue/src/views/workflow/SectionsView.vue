<script setup lang="ts">
/**
 * SectionsView(Phase2 框架设计) — 还原自闭源 SectionsView-C4lM9Tih.js(L212-1595, 单组件纯消费页)
 * 页头统计/AI 分析横幅 3 态/3 步进度+打字机思考/变量卡+假设/章节树(aiSkill 写作指导)
 * 数据源: workbench 快照恢复 + skill-cards(后端 aiSkill 生成)轮询
 */
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useRouter } from "vue-router";
import { useWorkflowStore } from "./stores/workflow";
import type { Section } from "./stores/workflow";
import { listSkillCards, batchGenerateSkillCards, createTask, getTask } from "@/shared/tasks";
import { markWorkflowReady } from "@/shared/workflow-bridge";
import { toast } from "@/shared/ui";
import { q, describeTaskError } from "@/shared/api";
import WorkflowShell from "./WorkflowShell.vue";
import PhaseProgressBar from "./PhaseProgressBar.vue";
import EmptyState from "./EmptyState.vue";

const router = useRouter();
const store = useWorkflowStore();
/** 框架来源的四子字段(后端存的是对象; 旧数据里可能是纯字符串 → 统一成 {refFile: 原文} 兜底) */
function fsOf(sk: { frameworkSource?: unknown } | undefined):
  { refFile?: string; originalStructure?: string; variableMapping?: string; extractedModel?: string } | null {
  const fs = sk?.frameworkSource;
  if (!fs) return null;
  if (typeof fs === "string") return { refFile: fs };
  const o = fs as Record<string, unknown>;
  const out = {
    refFile: o.refFile ? String(o.refFile) : undefined,
    originalStructure: o.originalStructure ? String(o.originalStructure) : undefined,
    variableMapping: o.variableMapping ? String(o.variableMapping) : undefined,
    extractedModel: o.extractedModel ? String(o.extractedModel) : undefined,
  };
  return Object.values(out).some(Boolean) ? out : null;
}
/** 子节规划(闭源: {title, aim}[]) */
function childSecsOf(sk: { childSections?: unknown } | undefined): Array<{ title: string; aim?: string }> {
  const list = sk?.childSections;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && typeof c === "object")
    .map((c) => {
      const o = c as Record<string, unknown>;
      return { title: String(o.title ?? ""), ...(o.aim ? { aim: String(o.aim) } : {}) };
    })
    .filter((c) => c.title);
}
/** 闭源标签按"有没有参考文件"切换: 有 = 参考框架, 无 = AI 写作指导 */
const hasSampleFiles = computed(() => store.input.sampleFiles.length > 0);


// ── 打字机(闭源 L242-274: 20ms tick, chunk=clamp(8..40, ceil(剩余/20))) ──
const typewriterArea = ref<HTMLElement | null>(null);
const typeText = ref("");
let typeTimer: ReturnType<typeof setTimeout> | null = null;
let typeQueue = "";
let typeFull = "";
/**
 * 当前步要打的叙述。闭源打的是模型**流式增量**(skillStreamText), 我方后端是轮询 + 阶段,
 * 没有逐字流 —— 所以这里打的是**阶段叙述**, 每段只在阶段变化时重打一次。
 * 宁可如实展示"现在到哪一步了", 也不要留一个永远空白的 `<pre>` 让用户干等。
 */
const STAGE_NARRATION: Record<number, string> = {
  1: "正在识别研究变量: 解析论文主题与目录, 判定本研究涉及的自变量、因变量、中介/调节变量…",
  2: "正在构建研究框架: 梳理变量之间的逻辑关系, 形成研究主线与论证路径…",
  3: "正在生成章节写作指导: 为每一章写出写作目标、要点、衔接逻辑与字数分配…",
};
let lastNarration = "";

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
/** 失败横幅是**取消**还是**真失败** —— 两者标题与出路不同, 混说会让用户以为系统坏了 */
const analyzeCancelled = ref(false);
const pollTimer = ref<ReturnType<typeof setInterval> | null>(null);
const activeJobId = ref("");
// 写作指导单独重试: analyze 失败/取消时正文不会跑到 generateWritingGuides, 此前该章指导永久缺失
// → skillComplete 恒 false → "确认进入"永久置灰, 且界面不说原因(实测: 只能删库重来)
const guidesBusy = ref(false);

// ── 步骤(闭源 Q 表: 定性词表切换) ──
const isQual = computed(() => store.input.researchMethod === "qualitative" || (store.input.researchMethod || "").includes("qual"));
const steps = computed(() => [
  { key: 1, label: isQual.value ? "因素识别" : "变量识别" },
  { key: 2, label: "框架分析" },
  { key: 3, label: "逐章写作指导" }
]);

// ── 派生统计(闭源 k/L/C/D/H/$) ──
const l1Count = computed(() => store.level1Sections.length);
const childCount = computed(() => store.sections.filter((s) => s.level === 2).length);
const withSkill = computed(() => store.level1Sections.filter((s) => s.aiSkill || s.skill_prompt).length);
const skillComplete = computed(() => withSkill.value > 0 && withSkill.value >= l1Count.value);
const missingCount = computed(() => Math.max(0, l1Count.value - withSkill.value));
const canConfirm = computed(() => !analyzing.value && l1Count.value > 0 && withSkill.value >= l1Count.value);
/**
 * 完成态的三步骤。
 *
 * ⚠ 2026-09-24: 第三步从 "Skill 生成" 改成 "逐章写作指导" —— **刻意偏离闭源**
 *   (闭源原文就是 "Skill 生成", DOM 实拍里可见)。理由: 全站其余地方都说中文
 *   (工作台那套是"识别研究变量/构建研究框架/生成写作指导"), 只有这里露着英文术语,
 *   用户看不懂 "Skill" 指什么。改后与工作台的说法一致。
 */
const DONE_STEPS = ["变量识别", "框架分析", "逐章写作指导"];

// ── 变量角色色(闭源 K L355-368 定量 5 色/定性词表) ──
const roleColor = (role: string): string => {
  const r = String(role ?? "");
  const qn: Record<string, string> = {
    "自变量": "#4D84CB", "因变量": "#E0714F", "中介": "#D9A441", "调节": "#9B7BE0", "控制": "#8494AA",
    "x": "#4D84CB", "y": "#E0714F", "mediator": "#D9A441", "moderator": "#9B7BE0", "control": "#8494AA",
    "影响因素": "#4D84CB", "结果表现": "#E0714F", "中间机制": "#D9A441", "情境条件": "#9B7BE0", "背景因素": "#8494AA"
  };
  return qn[r] ?? "#2563eb";
};

// ── 恢复 + 启动分析 ──
async function startAnalysis(force = false) {
  if (analyzing.value) return; // 防双任务
  analyzing.value = true;
  analyzeFailed.value = false;
  analyzeCancelled.value = false;
  analyzeError.value = "";
  // 新一轮分析: 清空思考区与"已打过的叙述"标记, 否则复用上一轮的残留文本,
  //   用户会看到上一轮的阶段叙述挂在本轮进度条上(自相矛盾)
  lastNarration = "";
  stopTypewriter();
  typeText.value = "";
  try {
    const sectionsSeed = store.sections.length
      ? store.sections
      : parseOutlineToSections(store.input.outline, store.input.title);
    store.sections = sectionsSeed;
    await store.saveProject();
    // 创建 analyze 任务(后端泵执行) — 结果 structured 回填需后端 analyze 执行器产 skills
    const t = await createTask({
      title: store.input.title || "框架设计分析",
      projectId: store.taskId,
      module: "workflow",
      jobKind: "analyze",
      goal: store.input.title || "框架设计分析",
      phase: 2,
      phaseLabel: "框架设计"
    });
    activeJobId.value = t.id;
    pollJob();
  } catch (e) {
    analyzing.value = false;
    analyzeFailed.value = true;
    analyzeError.value = String((e as Error).message ?? e);
  }
}

/**
 * 取消分析: 停轮询 + 后端任务 cancel(防旧 job 泵执行完覆盖; 刷新/重进时恢复续显)。
 *
 * ⚠ 2026-09-17 修: 这里原来只 `analyzing = false` —— 横幅于是**退回了 idle**,
 *   而失败横幅里那句「框架设计分析已取消。可直接重试生成写作指导…」是**死代码**
 *   (只有 pollJob 收到 status='cancelled' 才会走到, 但取消时轮询已经被我们自己停了)。
 *   结果是用户点了取消 → 只弹个 toast 就回到"开始分析"的空态, 看不到"接下来能做什么":
 *   已经拿到的变量/章节结构还在, 却没有"只补写作指导"这个入口。
 *   改成落**失败横幅**(它本就有取消态文案与两条出路), 并再读一次任务状态兜底 ——
 *   取消是用户主动动作, 前端已经知道结果, 不必依赖那次轮询。
 */
async function cancelAnalysis() {
  const jobId = activeJobId.value;
  stopPoll();
  analyzing.value = false;
  if (jobId) {
    try {
      await q(`/research/tasks/${jobId}/control`, { method: "POST", body: { action: "cancel" } }).catch(() => null);
    } catch { /* 容忍 */ }
  }
  activeJobId.value = "";
  analyzeFailed.value = true;
  analyzeCancelled.value = true;
  analyzeError.value = "可直接重试生成写作指导, 或用「重新分析」重跑全流程。";
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
        toast("框架设计分析完成", "success");
      } else if (t.status === "failed" || t.status === "cancelled") {
        stopPoll();
        analyzing.value = false;
        analyzeFailed.value = true;
        // 轮询这条路径同样要区分"取消"与"真失败"(任务可能被别处取消)
        analyzeCancelled.value = t.status === "cancelled";
        analyzeError.value = analyzeCancelled.value
          ? "可直接重试生成写作指导, 或用「重新分析」重跑全流程。"
          : `${describeJobError(t)}。章节结构已保留, 可直接重试生成写作指导。`;
      } else {
        // progress {stage,current,total} → 步骤推进
        const progress = (t as { progress?: { stage?: string; current?: number; total?: number } }).progress;
        if (progress?.stage) {
          if (progress.stage.includes("变量") || progress.stage.includes("因素")) analyzeStep.value = 1;
          else if (progress.stage.includes("框架")) analyzeStep.value = 2;
          // 第 3 步的**关键词匹配**。同时认新旧两种 stage 文案 —— 后端换文案而服务没重启时,
      // 只认新词会让进度条卡在第 2 步(静默, 界面上只会"不动"), 认两种就没有这个窗口期。
      else if (/逐章写作指导|写作指导|Skill|skill/.test(progress.stage)) analyzeStep.value = 3;
          analyzeMsg.value = String(progress.stage);
        } else {
          analyzeStep.value = analyzeStep.value || 1;
          analyzeMsg.value = "正在生成章节写作指导...";
        }
        // 阶段叙述推进打字机。
        //
        // 2026-09-16: 此前 `startTypewriter()` **一次都没被调用过**(只有 finishTypewriter 在完成时调),
        //   所以思考区永远是空的 `<pre>` —— 用户盯着一个空盒子等几分钟。
        // 前提: 本轮给后端补了 progress.stage 回写(V6), 在此之前这里根本没有可读的阶段。
        // 说明: 我方后端是"轮询 + 阶段"而非闭源的逐字 SSE, 所以这里打字的是**阶段叙述**
        //   (每段只在变化时重打一次), 不是模型逐字输出 —— 不假装有流式。
        const narration = STAGE_NARRATION[analyzeStep.value];
        if (narration && narration !== lastNarration) {
          lastNarration = narration;
          startTypewriter(narration);
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

/** analyze 失败原因兜底(后端 error 是 {code,userMessage} JSON 串) */
function describeJobError(t: unknown): string {
  const msg = describeTaskError(t);
  return msg ? `: ${msg.slice(0, 120)}` : "";
}

/** 只生成写作指导(不动章节结构) — analyze 失败/取消后仍可补齐, 否则 skillComplete 永久为假 */
async function retryGuides() {
  if (guidesBusy.value) return;
  if (!store.taskId) { toast("请先完成选题界定", "warning"); return; }
  if (!store.level1Sections.length) { toast("暂无章节, 请先重新分析生成章节结构", "warning"); return; }
  guidesBusy.value = true;
  try {
    await generateWritingGuides();
    await store.loadProject();
    if (skillComplete.value) {
      analyzeFailed.value = false;
      toast("写作指导已补齐, 可以进入文献与资料了", "success");
    } else if (guidesResult.value.ok === 0) {
      // V417: 一条都没生成成功 → 说清原因, 别让用户反复点"重试"却不知道是模型/余额的问题
      toast(`写作指导生成失败${guidesResult.value.error ? `: ${guidesResult.value.error}` : "(模型不可用或余额不足)"}`, "error");
    } else {
      toast(`仍缺 ${missingCount.value} 章写作指导(本轮成功 ${guidesResult.value.ok}/${guidesResult.value.total}), 可再次重试`, "warning");
    }
  } finally {
    guidesBusy.value = false;
  }
}

/** V417: 上次写作指导批量生成的结果 —— 用于如实报告(此前全失败也弹绿色成功) */
const guidesResult = ref<{ ok: number; total: number; error?: string }>({ ok: 0, total: 0 });

/** 生成各一级章节写作指导(闭源 generateSkillsForSections: 后端逐章 LLM 生成 aiSkill) */
async function generateWritingGuides() {
  const l1 = store.level1Sections;
  if (!l1.length || !store.taskId) return;
  try {
    const r = await batchGenerateSkillCards(store.taskId, l1.map((s) => ({ id: s.id, title: s.title, level: 1 })));
    guidesResult.value = { ok: r.okCount ?? 0, total: l1.length };
  } catch (e) {
    guidesResult.value = { ok: 0, total: l1.length, error: String((e as Error).message ?? e).slice(0, 120) };
  }
  await loadSkillCards();
}

async function loadSkillCards() {
  if (!store.taskId) return;
  try {
    const cards = await listSkillCards(store.taskId);
    // V417: 原来这里 `if (!cards.length) return;` —— 卡片表可能为空(生成卡需 writingGoal,
    //   模型少给一个字段就整条不落库), 而节点里的 aiSkill 是独立分支、照样有值。
    //   直接 return 会让「节点有指导、界面空着」这种不一致永远修不回来。
    //   为空时交给上层 store.loadProject() 从节点回填, 这里不早退。
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

// ── 确认进入文献与资料(闭源 Z() 门禁) ──
async function confirmSections() {
  if (!l1Count.value) {
    toast("请至少添加一个章节", "warning");
    return;
  }
  if (!skillComplete.value) {
    toast("框架设计尚未生成完整, 请先重新分析", "warning");
    return;
  }
  // 2026-09-16: 确认架构时**发布 phase2_architecture 版本**。
  //   此前全仓没有这个标签的发布方(只有 phase3/phase4 有), 于是 `/versions/current` 里
  //   `phase2Version` 恒为 null、`phase2Stale` 恒 false —— 素材页那条"架构已失效, 请返回
  //   Phase 2 重新确认"的门禁**永远不可能触发**(后端算得对, 只是没人喂数据)。
  //   发布失败不阻断推进(版本是审计与门禁的底座, 不是主链的必要条件)。
  if (store.taskId) {
    await q(`/research/projects/${store.taskId}/publish`, { method: "POST", body: { label: "phase2_architecture" } })
      .catch(() => null);
  }
  store.setPhase(3);
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

/** 概览卡是否有内容 —— 三个分块全空时不渲染一张空卡 */
const hasOverview = computed(() =>
  store.variables.length > 0
  || (store.hypotheses.length > 0 && !isQual.value)
  || !!store.project.logicFlow
  || methodPill.value.label !== "研究方法未选择"
);

// ── 章节树展示辅助 ──
function sectionNumber(i: number): string {
  const cn = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五"];
  return cn[i] ?? String(i + 1);
}
/** 直接子节。优先 parentId; 后端 parseGoalToSections 落库时不写 parentId, 故按"顺序区间"兜底分组 */
function childrenOf(l1Id: string): Section[] {
  const all = store.sections;
  const idx = all.findIndex((x) => x.id === l1Id);
  if (idx < 0) return [];
  const end = all.findIndex((x, i) => i > idx && (x.level ?? 1) === 1);
  const slice = all.slice(idx + 1, end < 0 ? undefined : end);
  const direct = slice.filter((x) => x.parentId === l1Id);
  // 有显式 parentId 就信它(用户手改过的结构), 否则整段算本章子节
  return direct.length ? direct : slice.filter((x) => (x.level ?? 1) > 1);
}
function wordCountBadge(s: Section): string | null {
  const wc = s.aiSkill?.wordCount ?? (s as { wordCount?: number }).wordCount;
  return wc ? `${wc} 字(Phase 1 分配)` : null;
}

onMounted(async () => {
  markWorkflowReady();
  await store.loadProject().catch(() => null);
  // 活动 analyze job 恢复(取消/刷新后回来续显, 防重复建任务并发写)
  const recent = await (await import("@/shared/tasks")).listTasks({ module: "workflow", limit: 5 }).catch(() => []);
  const active = recent.find((t) => t.jobKind === "analyze" && ["queued", "running"].includes(t.status) && t.projectId === store.taskId);
  if (active) {
    activeJobId.value = active.id;
    analyzing.value = true;
    analyzeStep.value = 1;
    analyzeMsg.value = "正在继续上次的框架设计分析...";
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
  <WorkflowShell>
  <div
    class="workflow-page wf-page"
    :data-assistant-phase2-sections-count="String(l1Count)"
    :data-assistant-async-busy="(analyzing || guidesBusy) ? 'true' : 'false'"
    :data-assistant-async-reason="analyzeMsg || (guidesBusy ? '正在生成写作指导' : '')"
  >
    <PhaseProgressBar />
    <div class="wf-body">
    <div class="wf-head">
      <h1 class="wf-h1">框架设计</h1>
      <p class="wf-sub">{{ store.title || "未命名项目" }} — 确认框架设计后进入创作工作台。</p>
      <!-- 闭源原文: 「共 」+ N + 「 章 」+ (有子节 ? 「、N 个子节」)。无子节时不渲染后半段。 -->
      <p class="wf-stats">共 <span class="stats-num">{{ l1Count }}</span> 章<template v-if="childCount > 0">、{{ childCount }} 个子节</template></p>
    </div>

    <!-- AI 分析横幅(3 态) -->
    <div v-if="analyzeFailed" class="banner banner-fail">
      <div class="banner-head">
        <strong>{{ analyzeCancelled ? "框架设计分析已取消" : "框架设计生成失败" }}</strong>
      </div>
      <!-- 闭源: 「Step N 执行失败」+ detail —— 没有 Step 编号时用户不知道卡在哪一步。
           取消不是"失败", 前缀按状态换, 免得用户以为系统坏了。 -->
      <p class="banner-body">
        <span class="fail-step">Step {{ Math.max(1, analyzeStep) }} {{ analyzeCancelled ? "已取消" : "执行失败" }}</span>{{ analyzeError ? `：${analyzeError}` : "" }}
      </p>
      <div class="banner-actions">
        <!-- 同上: 这是**失败后重试**, 不是危险动作。红色留给删除类。 -->
        <button class="btn-primary-sm" data-control="workflow:retry-guides" :disabled="guidesBusy" @click="retryGuides">
          {{ guidesBusy ? "正在生成写作指导…" : "只重试生成写作指导" }}
        </button>
        <button class="btn-back-sm" @click="startAnalysis(true)" data-control="workflow:regen-sections">重新生成</button>
      </div>
    </div>

    <div v-else-if="analyzing" class="banner banner-thinking">
      <div class="banner-head">
        <strong>AI 正在分析中</strong>
        <button class="banner-cancel" data-control="workflow:cancel-analysis" @click="cancelAnalysis">取消</button>
      </div>
      <div class="step-progress">
        <!-- 圆三态(闭源 X()/Y() 语义): 已完成 ✓ / **当前步转圈** / 未到 数字。
             2026-09-16 修: 原先只有 ✓ 与数字两态 —— 当前正在跑的那一步长得跟没到的一模一样,
             用户看不出"现在卡在哪一步"、也看不出它还在动。 -->
        <div v-for="(s, i) in steps" :key="s.key" class="step-item" :class="{ active: analyzeStep >= s.key, done: analyzeStep > s.key }">
          <span class="step-circle" :class="{ spinning: analyzeStep === s.key && analyzing }">
            <template v-if="analyzeStep > s.key">✓</template>
            <template v-else-if="analyzeStep === s.key && analyzing"><span class="mini-spinner"></span></template>
            <template v-else>{{ i + 1 }}</template>
          </span>
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
      <!-- 2026-09-15: 完成态原先只有一句"分析完成", 三步骤进度条做完就消失。
           闭源源: 绿头横幅 + 一行三个带 ✓ 的步骤(变量识别/框架分析/逐章写作指导) + 「章节分析完成」。
           第三步闭源原名是 "Skill 生成", 我方改成中文(见 DONE_STEPS 的注释)。 -->
      <div class="banner-head">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.6">
          <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <strong>AI 分析完成</strong>
      </div>
      <div class="done-steps">
        <template v-for="(st, si) in DONE_STEPS" :key="st">
          <span v-if="si > 0" class="ds-sep">›</span>
          <span class="ds-item">
            <span class="ds-dot"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.2"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" /></svg></span>
            {{ st }}
          </span>
        </template>
      </div>
      <p class="banner-body">章节分析完成</p>
    </div>

    <div v-else class="banner banner-idle">
      <div class="banner-head"><strong>AI 分析</strong></div>
      <!-- 有章节但指导不全: 这是刷新/重进后最常见的状态(analyzeFailed 已被重置为 false),
           此时只给"开始分析"会把已经落库的章节结构重跑一遍。直接给补齐入口。 -->
      <p class="banner-body">
        {{ l1Count && !skillComplete ? `已有 ${l1Count} 章结构, 还差 ${missingCount} 章写作指导。` : "AI 将识别研究变量/因素、分析框架并生成每章写作指导。" }}
      </p>
      <div class="banner-actions">
        <!-- ⚠ V425 改色: 这两个原先都是 `.btn-red`(纯红 #dc2626)。
             它们在**正常状态**(AI 分析的空态横幅)里出现, 而红色在全站是"危险/删除"语义 ——
             用户看到的是"系统出问题了", 实际这是推荐下一步。
             现在按代价分档: 推荐的低代价路径(只补缺失的写作指导, 不动章节结构)用主色;
             更重的"重新分析(含章节结构)"用次级描边按钮 —— 两者本来就不该长得一样重。
             红色只留给**真危险**的动作(删除项目等)。 -->
        <button
          v-if="l1Count && !skillComplete"
          class="btn-primary"
          data-control="workflow:retry-guides"
          :disabled="guidesBusy"
          @click="retryGuides"
        >
          {{ guidesBusy ? "正在生成写作指导…" : `只生成写作指导(缺 ${missingCount} 章)` }}
        </button>
        <button class="btn-back" @click="startAnalysis()" data-control="workflow:start-analysis-2">{{ l1Count && !skillComplete ? "重新分析(含章节结构)" : "开始框架设计分析" }}</button>
      </div>
    </div>

    <!-- 缺失警告 -->
    <div v-if="missingCount > 0 && !analyzing" class="warn-bar">
      ⚠ 还有 {{ missingCount }} 章缺少写作指导, 当前框架设计尚未生成完整。
      <button class="btn-warn" @click="startAnalysis(true)" data-control="workflow:reanalyze">重新分析</button>
    </div>

    <!-- 科研框架概览(闭源: 一张卡收拢 ①变量识别 ②研究假设 ③研究逻辑+方法, 各带编号圆徽与「共 N 个」计数)
         2026-09-15 前这里是三个互不相干的平级 section, 没有卡头、没有编号、没有计数。 -->
    <!-- V424 两栏: 分析产物(左) + 章节结构(右)。
         原先概览卡与章节树一上一下满屏宽堆叠; 两者是「看框架」与「看章节」的关系,
         并排看才完整。与选题界定页、合稿页同一套两栏语言。 -->
    <!-- 科研框架概览 + 章节结构 —— **纵向堆叠的单栏**。
         ⚠ 2026-09-23 从两栏改回单栏。原先这里是 `.sec-cols`(概览左 / 章节树右)。
         核对逆向对象后改了: 闭源框架设计页的**页面级容器是 `max-w-5xl mx-auto` 单栏**,
         正文只有三个纵向堆叠的块(标题 / AI分析横幅 / 科研框架概览 / 章节结构 / 底部操作),
         **没有侧栏**(见 .claude/reverse-engineering/socialsci-com/deep/sections-dom.txt 的真实 DOM 实拍)。
         我们那套两栏是 2026-09-21 自己加的, 没有对照依据 —— 现在按你的要求改回来:
         章节结构放在科研框架概览**下方**, 与闭源顺序一致。 -->
    <section v-if="hasOverview" class="overview-card">
      <div class="ov-head">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9">
          <path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9c.4.3.6.8.7 1.3l.1.8h5.4l.1-.8c.1-.5.3-1 .7-1.3A6 6 0 0012 3z" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <h3>科研框架概览</h3>
      </div>

      <!-- ① 变量识别 -->
      <div v-if="store.variables.length" class="ov-block">
        <div class="ov-block-head">
          <span class="ov-num blue">1</span>
          <strong>变量识别</strong>
          <span class="ov-count">共 {{ store.variables.length }} 个</span>
        </div>
        <div class="var-grid">
          <div v-for="v in store.variables" :key="v.name" class="var-card">
            <div class="var-top">
              <span class="var-role" :style="{ background: roleColor(v.role) }">{{ v.role }}</span>
              <strong class="var-name">{{ v.name }}</strong>
            </div>
            <p v-if="v.description" class="var-desc">{{ v.description }}</p>
            <p v-if="v.measurement" class="var-measure">{{ v.measurement }}</p>
          </div>
        </div>
      </div>

      <!-- ② 研究假设 -->
      <div v-if="store.hypotheses.length && !isQual" class="ov-block">
        <div class="ov-block-head">
          <span class="ov-num purple">2</span>
          <strong>研究假设</strong>
          <span class="ov-count">共 {{ store.hypotheses.length }} 条</span>
        </div>
        <ul class="hypo-list">
          <li v-for="(h, i) in store.hypotheses" :key="i" class="hypo-item">
            <span class="hypo-badge">H{{ i + 1 }}</span>
            <span class="hypo-text">{{ h }}</span>
          </li>
        </ul>
      </div>

      <!-- ③ 研究逻辑 + 研究方法 -->
      <div v-if="store.project.logicFlow || methodPill.label !== '研究方法未选择'" class="ov-block">
        <div class="ov-block-head">
          <span class="ov-num blue">3</span>
          <strong>研究逻辑</strong>
        </div>
        <p v-if="store.project.logicFlow" class="logic-flow">{{ store.project.logicFlow }}</p>
        <EmptyState
          v-else
          size="sm"
          icon="⌘"
          title="研究逻辑待生成"
          hint="分析完成后，这里会展示变量之间的关系路径（自变量 → 中介 → 因变量），以及每章的论证主线。"
        />
        <div class="method-line">
          <span class="logic-label">研究方法</span>
          <span class="method-pill">{{ methodPill.label }}</span>
          <span v-if="methodPill.auto" class="auto-tag">已根据标题和目录自动识别</span>
          <span v-else-if="methodPill.label !== '研究方法未选择'" class="auto-tag">已由你选择</span>
        </div>
      </div>
    </section>
    <section class="tree-card">
      <h3 class="sec-title">章节结构</h3>
      <EmptyState
        v-if="!store.sections.length"
        icon="⊞"
        title="还没有章节结构"
        hint="回到「选题界定」填写研究框架（一级章节 + 二级子节），提交后这里会自动解析出章节树。"
        action="去填研究框架"
        @action="router.push('/workflow/input')"
      />
      <div v-for="(s, i) in store.level1Sections" :key="s.id" class="level1-row">
        <div class="l1-head">
          <span class="l1-num">{{ sectionNumber(i) }}</span>
          <strong>{{ s.title || "未命名章节" }}</strong>
          <span v-if="s.aiSkill || s.skill_prompt" class="skill-badge">{{ store.input.sampleFiles.length ? "参考框架" : "AI 写作指导" }}</span>
          <span v-if="wordCountBadge(s)" class="wc-badge">{{ wordCountBadge(s) }}</span>
        </div>
        <!-- 二级子节: 原先完全不渲染, 而页脚统计还写着"N 个子节" —— 用户看不到自己录进去的子节 -->
        <ul v-if="childrenOf(s.id).length" class="l2-list">
          <li v-for="(c, ci) in childrenOf(s.id)" :key="c.id" class="l2-row">
            <span class="l2-num">{{ sectionNumber(i) }}.{{ ci + 1 }}</span>
            <span class="l2-title">{{ c.title || "未命名子节" }}</span>
            <span v-if="c.aiSkill || c.skill_prompt" class="skill-badge sm">写作指导</span>
            <span v-if="wordCountBadge(c)" class="wc-badge">{{ wordCountBadge(c) }}</span>
          </li>
        </ul>
        <!-- 写作指导详情(逐字对照闭源 SectionsView-C4lM9Tih.js 的展开区 8 项):
             标签+type 徽 / 字数徽 / 框架来源(四子字段) / 草稿预览 / 写作目标 / 要点 / 衔接 / 注意 -->
        <div v-if="s.aiSkill" class="skill-detail">
          <div class="skill-head">
            <span class="skill-source-tag">{{ hasSampleFiles ? "参考框架" : "AI 写作指导" }}</span>
            <span v-if="s.aiSkill.type" class="skill-type-badge">{{ s.aiSkill.type }}</span>
            <span v-if="s.aiSkill.wordCount" class="wc-badge">{{ s.aiSkill.wordCount }} 字（Phase 1 分配）</span>
          </div>
          <!--
            ⚠ 2026-09-16 修: frameworkSource 是**对象**(四子字段), 原先当字符串插值 →
              渲染出 [object Object]。闭源逐子字段渲染: 文件 / 原文结构 / 变量替换 / 分析框架。
          -->
          <template v-if="fsOf(s.aiSkill)">
            <div class="fs-row amber">
              <strong>框架来源</strong>
              <p v-if="fsOf(s.aiSkill)?.refFile">文件：{{ fsOf(s.aiSkill)?.refFile }}</p>
              <p v-if="fsOf(s.aiSkill)?.originalStructure">原文结构：{{ fsOf(s.aiSkill)?.originalStructure }}</p>
              <p v-if="fsOf(s.aiSkill)?.variableMapping">变量替换：{{ fsOf(s.aiSkill)?.variableMapping }}</p>
              <p v-if="fsOf(s.aiSkill)?.extractedModel">分析框架：{{ fsOf(s.aiSkill)?.extractedModel }}</p>
            </div>
          </template>
          <!-- 草稿预览(闭源: 独立绿框, 与其它字段分开; 原先完全不渲染) -->
          <div v-if="s.aiSkill.chapterDraft" class="draft-box">
            <strong>草稿预览</strong>
            <p>{{ s.aiSkill.chapterDraft }}</p>
          </div>
          <div v-if="s.aiSkill.writingGoal" class="skill-block"><strong>写作目标</strong>: {{ s.aiSkill.writingGoal }}</div>
          <div v-if="s.aiSkill.keyPoints" class="skill-block">
            <strong>要点</strong>
            <ul><li v-for="(k, ki) in s.aiSkill.keyPoints" :key="ki">{{ k }}</li></ul>
          </div>
          <!-- 子节规划(闭源: 子节标题 + 任务说明; 原先完全不渲染) -->
          <div v-if="childSecsOf(s.aiSkill).length" class="skill-block">
            <strong>子节规划</strong>
            <ul><li v-for="(cs, ci) in childSecsOf(s.aiSkill)" :key="ci">{{ cs.title }}<span v-if="cs.aim" class="cs-aim"> — {{ cs.aim }}</span></li></ul>
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
      <button class="btn-back" data-control="workflow:back" @click="router.push('/workflow/input')">返回修改</button>
      <button class="btn-primary" :disabled="!canConfirm" data-control="workflow:confirm-sections" @click="confirmSections">
        确认框架设计, 进入文献与资料
      </button>
    </div>
    </div>
  </div>
</WorkflowShell>
</template>

<style scoped>

.workflow-page { width: 100%; box-sizing: border-box; }
/* 页头整体。闭源把 h1+p+统计行包在一个 `mb-8` 块里(= 整块下方 32px 留白)。
   我方原先是 h1 mb-4 / sub mb-0 / 统计 mt-8 mb-16 拼出来, 净距只有 24px ——
   比闭源少 8px, 而且 h1 与副标题之间被撑到 8px(闭源 text-sm mt-1 = 4px)。 */
.wf-head { margin-bottom: 32px; }
.wf-h1 { margin: 0; font-size: 22px; font-weight: 700; color: var(--wf-text); }
.wf-sub { margin: 4px 0 0; font-size: 13px; color: var(--wf-muted); }
.wf-stats { margin: 12px 0 0; font-size: 12.5px; color: var(--wf-muted); }
.stats-num { color: var(--wf-text); font-weight: 600; }
.fail-step { color: #E88A8A; font-weight: 600; margin-right: 2px; }
/* 闭源页面级块间距是 mb-6(24px); 原值 14px 明显更紧 */
.banner { border-radius: 12px; padding: 14px 18px; margin-bottom: 24px; }
.banner-fail { background: #2A1C1C; border: 1px solid #3A2323; }
.banner-thinking { background: var(--wf-raised); border: 1px solid var(--wf-line-hard); }
.banner-done { background: #14281F; border: 1px solid #2E5C46; }
.banner-idle { background: var(--wf-surface); border: 1px solid var(--wf-line); }
.banner-head { display: flex; justify-content: space-between; align-items: center; }
.banner-head strong { font-size: 15px; }
.banner-fail .banner-head strong { color: #dc2626; }
.banner-thinking .banner-head strong { color: #DCE6F2; }
.banner-done .banner-head strong { color: #5FD0B4; }
.banner-body { font-size: 13px; color: var(--wf-muted); margin: 6px 0; line-height: 1.6; }
.banner-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.banner-cancel { border: 0; background: var(--wf-line-soft); color: var(--wf-muted); padding: 3px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; }
/**
 * ⚠ V425 **删除**了 `.btn-red` / `.btn-red-sm`(原来的实心红 #dc2626)。
 *
 * 它们被用在"只生成写作指导 / 重新分析 / 重试"这类**构造性**动作上, 而红色在全站是
 * "危险/删除"语义 —— 用户看到横幅里一片红, 第一反应是"系统出问题了"。
 * 改后: 推荐路径用主色, 更重的动作用次级描边; 实心红只留给**真危险**(删除项目走
 * `.btn-danger-ghost`)。
 * 删样式而不是留着: 留着一定会有人再抄回去(那时红按钮会重新长满横幅)。
 */
/* 横幅内的小号按钮(与 .btn-primary / .btn-back 同色系, 只是尺寸小一档) */
.btn-primary-sm { padding: 4px 14px; border: 0; border-radius: 7px; background: #4D84CB; color: #F1F5F9; font-size: 12px; font-weight: 600; cursor: pointer; }
.btn-primary-sm:disabled { background: var(--wf-line-hard); cursor: not-allowed; }
.btn-back-sm { padding: 4px 14px; border: 1px solid var(--wf-line-strong); border-radius: 7px; background: var(--wf-surface); color: var(--wf-text-2); font-size: 12px; cursor: pointer; }
.btn-back-sm:hover { color: var(--wf-text); }
.step-progress { display: flex; gap: 8px; margin: 12px 0; }
.step-item { display: flex; align-items: center; gap: 6px; }
.step-circle {
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--wf-line); color: var(--wf-faint);
  display: grid; place-items: center; font-size: 11px;
}
.step-item.active .step-circle { background: #4D84CB; color: #F1F5F9; }
.step-item.done .step-circle { background: #5FD0B4; color: #F1F5F9; }
/* 当前步转圈: 让"正在跑"和"还没到"一眼可分 */
.step-circle.spinning { background: #4D84CB; color: #F1F5F9; box-shadow: 0 0 0 3px #1E2A48; }
.step-label { font-size: 12px; color: var(--wf-muted); }
.step-item.active .step-label { color: var(--wf-text); font-weight: 600; }
.thinking-area { margin-top: 8px; }
.thinking-title { font-size: 12px; color: var(--wf-muted); margin-bottom: 4px; }
.thinking-text {
  margin: 0; padding: 10px; background: var(--wf-line-soft); border-radius: 8px;
  font-family: ui-monospace, monospace; font-size: 11.5px; line-height: 1.6;
  color: #DCE6F2; white-space: pre-wrap; max-height: 140px; overflow-y: auto;
}
.thinking-empty { font-size: 12px; color: var(--wf-faint); font-style: italic; padding: 10px; }
.warn-bar {
  background: var(--wf-surface); border: 1px solid #3A3020; color: #E8B54A;
  padding: 9px 14px; border-radius: 9px; font-size: 12.5px; margin-bottom: 14px;
  display: flex; align-items: center; gap: 10px;
}
.btn-warn { border: 0; background: #E8B54A; color: #F1F5F9; padding: 3px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; }
/* 完成态: 绿头 + 三步骤进度条(闭源 ppb 语义: ✓ 圆 + 步骤名 + › 分隔) */
.banner-done .banner-head { gap: 8px; justify-content: flex-start; }
.done-steps {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 10px 0 6px; padding: 8px 12px;
  background: #0F1F1A; border: 1px solid #2E5C46; border-radius: 9px;
}
.ds-item { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #7FE3BD; font-weight: 500; }
.ds-dot {
  width: 18px; height: 18px; border-radius: 50%; background: #16a34a; color: #F1F5F9;
  display: grid; place-items: center; flex-shrink: 0;
}
.ds-sep { color: #2E5C46; font-size: 14px; }

/* 科研框架概览卡(闭源: 一张卡收 ①变量 ②假设 ③逻辑+方法) */
.overview-card {
  background: var(--wf-surface); border: 1px solid #2B2F52; border-radius: 12px;
  overflow: hidden; margin-bottom: 14px;
}
.ov-head {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 18px; background: #1A1E3A; border-bottom: 1px solid #2B2F52;
  color: #A5B4FC;
}
.ov-head h3 { margin: 0; font-size: 14px; font-weight: 600; color: #C7D2FE; }
.ov-block { padding: 14px 18px; border-bottom: 1px solid #1E2438; }
.ov-block:last-child { border-bottom: 0; }
.ov-block-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.ov-block-head strong { font-size: 12.5px; font-weight: 600; color: #DCE6F2; }
.ov-num {
  width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center;
  font-size: 10px; font-weight: 700; flex-shrink: 0;
}
.ov-num.blue { background: #16243F; color: #6FA8F5; }
.ov-num.purple { background: #241A3A; color: #B08CF0; }
.ov-count { font-size: 11.5px; color: var(--wf-faint); }
/* ⚠ 2026-09-23: 从 `auto-fill minmax(200px,1fr)` 改成**定 3 列**, 对齐闭源。
   闭源的变量卡网格是 `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`(见逆向资料的 DOM 实拍)。
   我们那套 auto-fill 在 1230px 的单栏里会铺出 **5 条窄卡**(每张刚过 200px),
   而闭源在同样的宽度下是 3 列 —— 卡片一窄, 里面的「变量名 + 测量方式」就挤成两三行。
   单栏化之前右列只有 461px, auto-fill 恰好只出 2 列, 所以这个偏差一直没暴露。 */
.var-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
@media (min-width: 1100px) { .var-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.var-card {
  background: var(--wf-surface-2); border: 1px solid var(--wf-line); border-radius: 10px; padding: 11px;
  display: flex; flex-direction: column; gap: 6px;
}
.var-card:hover { border-color: #4B5E8C; box-shadow: 0 1px 4px rgba(99, 102, 241, 0.12); }
.var-top { display: flex; align-items: center; gap: 8px; }
.var-role { color: #F1F5F9; font-size: 10.5px; padding: 2px 9px; border-radius: 8px; flex-shrink: 0; font-weight: 600; }
.var-name { font-size: 13.5px; color: var(--wf-text); }
.var-card p { margin: 0; font-size: 12px; color: var(--wf-muted); line-height: 1.5; }
/* 描述两行截断(闭源 line-clamp-2) —— 全量展开会把卡片撑成高矮不齐的一片 */
.var-desc {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.var-measure { color: var(--wf-faint) !important; font-size: 11.5px !important; }
.hypo-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.hypo-item { display: flex; gap: 8px; font-size: 12.5px; color: #C6D2E4; align-items: flex-start; line-height: 1.55; }
.hypo-badge {
  background: #241A3A; color: #B08CF0; font-size: 10.5px;
  padding: 1px 7px; border-radius: 7px; flex-shrink: 0; font-weight: 700;
  width: 20px; height: 20px; display: grid; place-items: center; box-sizing: border-box;
}
.hypo-text { padding-top: 1px; }
.logic-flow { margin: 0 0 10px; font-size: 12.5px; color: #8BA4F0; line-height: 1.65; overflow-wrap: break-word; }
.method-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 10px; border-top: 1px solid #1E2438; }
/* V424 两栏: 分析产物(左) + 章节结构(右)。章节结构需要更多横向空间(树 + 每章的写作指导),
   所以右侧给 1.25fr。窄屏(<1180)塌回单列。 */
/* ⚠ 2026-09-23: `.sec-cols` / `.sec-col-left` / `.sec-col-right` 已删除 —— 框架设计页改回**单栏**,
   章节结构直接排在科研框架概览下方(与闭源顺序一致)。那套两栏是 2026-09-21 自己加的,
   核对逆向对象发现闭源是 `max-w-5xl mx-auto` 单栏(见 .claude/reverse-engineering/.../sections-dom.txt)。
   单栏之后两栏那套 grid / 列内 gap 都不需要了, 卡片的垂直间距回到**卡片自己的 margin**。 */
.tree-card {
  background: var(--wf-surface); border: 1px solid var(--wf-line); border-radius: 12px;
  padding: 16px 18px;
  /* 闭源是 mb-6(24px), 但那是**卡片夹在中间**时的下距。单栏下它是最后一个块,
     下距交给页面底部(60px) —— 两栏时这条被 `.sec-cols .tree-card{margin-bottom:0}` 覆盖,
     现在那层没了, 归零写在原地。 */
  margin-bottom: 0;
}
.sec-title { margin: 0 0 10px; font-size: 15px; color: var(--wf-text); }
.tree-empty { padding: 24px; text-align: center; color: var(--wf-faint); font-size: 13px; }
.level1-row { border-bottom: 1px solid var(--wf-line-soft); padding: 10px 0; }
.level1-row:last-child { border-bottom: 0; }
.l1-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
/* 编号块(闭源: 一级 bg-red-100 text-red-700 浅红底红字, 二级 bg-gray-100 text-gray-600 灰底灰字;
   尺寸同为 w-10 h-8)。2026-09-15 修: 一级原为实心红底白字, 二级只有灰字没有底块。 */
.l1-num {
  width: 40px; height: 32px; border-radius: 8px;
  background: #2A1C1C; color: #E88A8A;
  display: grid; place-items: center; font-size: 13px; font-weight: 700;
  flex-shrink: 0;
}
.l1-head strong { font-size: 14px; color: var(--wf-text); }
.skill-badge { font-size: 10.5px; padding: 2px 8px; background: #1E2A48; color: #2563eb; border-radius: 8px; }
.skill-badge.sm { font-size: 10px; padding: 1px 6px; }
.wc-badge { font-size: 10.5px; padding: 2px 8px; background: #1E2A48; color: #2563eb; border: 1px solid #bfdbfe; border-radius: 8px; }
.l2-list { list-style: none; margin: 6px 0 0; padding: 0 0 0 6px; border-left: 2px solid var(--wf-line-soft); }
.l2-row { display: flex; align-items: center; gap: 8px; padding: 4px 0 4px 10px; flex-wrap: wrap; }
/* 二级编号块: 与一级同尺寸但灰底灰字(闭源 bg-gray-100 text-gray-600) */
.l2-num {
  width: 40px; height: 32px; border-radius: 8px;
  background: var(--wf-raised); color: #A8B4C4;
  display: grid; place-items: center; font-size: 11.5px; font-weight: 600;
  flex-shrink: 0; font-variant-numeric: tabular-nums;
}
.l2-title { font-size: 13px; color: #C6D2E4; }
.skill-detail { margin: 8px 0 0 34px; display: flex; flex-direction: column; gap: 6px; }
/* 2026-09-16: 补三处。原先 .fs-row.amber 的背景写成 `var(--wf-surface)beb` —— 8 位 hex 多打了 "beb",
   浏览器按非法值丢弃整条声明, 等于"框架来源"卡一直没有底色。 */
.skill-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.skill-source-tag { font-size: 12px; font-weight: 600; color: var(--wf-muted); }
.skill-type-badge {
  font-size: 10.5px; padding: 2px 8px; border-radius: 8px;
  background: var(--wf-raised); color: #9B8BD7; border: 1px solid #3A3355;
}
/* 草稿预览(闭源绿框): 与"框架来源"琥珀框并列, 视觉上是两块独立信息 */
.draft-box {
  background: #14281F; border: 1px solid #2E5C46; border-radius: 6px;
  padding: 6px 10px; font-size: 12px; color: #7DD3A8; line-height: 1.6;
}
.draft-box strong { color: #5FD0B4; display: block; margin-bottom: 2px; }
.draft-box p { margin: 0; white-space: pre-wrap; }
.cs-aim { color: var(--wf-muted); }
.fs-row.amber { background: var(--wf-surface); border: 1px solid #3A3020; border-radius: 6px; padding: 5px 10px; font-size: 12px; color: #E8B54A; }
.fs-row.amber p { margin: 2px 0 0; color: #DCE6F2; }
.skill-block { font-size: 12.5px; color: #DCE6F2; line-height: 1.6; }
.skill-block strong { color: var(--wf-text); }
.skill-block ul { margin: 4px 0 0; padding-left: 18px; }
.skill-pending { margin: 6px 0 0 34px; font-size: 12px; color: var(--wf-muted); }
.skill-pending.dim { color: var(--wf-faint); }
/* 动作行。闭源 `mt-8 pt-6 border-t`(= 32+24 上距 + 一条 1px 分隔线, gap-3=12px)。
   原值 margin-top:6px 且**无分隔线** —— 与「确认框架设计」上方那一大片内容连成一体,
   少了闭源那道"这是页面级操作、不是内容"的视觉分界。 */
.wf-actions {
  display: flex; gap: 12px;
  margin-top: 32px; padding-top: 24px;
  border-top: 1px solid var(--wf-line);
}
/* 主按钮不横贯整幅(与选题界定页统一): 实测原先 flex:1 让它撑到 1156px, 而动作行才 1274px */
.wf-actions { justify-content: flex-end; }
.wf-actions .btn-primary { min-width: 200px; }
/* 闭源按钮 `px-6 py-3 text-sm` = 24/12 + 固定 20px 行高 + 边框 = 46px 高(我方原 38px) */
.wf-actions .btn-primary,
.wf-actions .btn-back { padding: 12px 24px; line-height: 20px; }
.btn-back {
  padding: 10px 22px; border: 1px solid var(--wf-line); border-radius: 9px;
  background: var(--wf-surface); color: var(--wf-muted); font-size: 14px; cursor: pointer;
}
.btn-primary {
  padding: 10px 26px; border: 0; border-radius: 9px;
  background: #4D84CB; color: #F1F5F9; font-size: 14px; font-weight: 600; cursor: pointer;
}
.btn-primary:disabled { background: var(--wf-line-hard); cursor: not-allowed; }
</style>

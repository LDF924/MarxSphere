<script setup lang="ts">
/**
 * WorkspaceView(Phase4 文本创作) — 还原自闭源 WorkspaceView-Baf0x_1H.js(L735-2706, scope data-v-2b778b5d)
 * 三栏: 左章节导航(SectionNavItem 递归)/中正文编辑器+生成控制/右素材卡(MaterialCard)
 * 生成: 单节/批量 phase4_batch job → 泵 → 800ms 轮询 → nodes/sections 回读 content
 */
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useWorkflowStore } from "./stores/workflow";
import type { Section } from "./stores/workflow";
import { createTask, getTask, getNode, putNode } from "@/shared/tasks";
import { markWorkflowReady, sendMarkdownToEditor } from "@/shared/workflow-bridge";
import { toast, confirmDialog } from "@/shared/ui";
import { q, describeTaskError } from "@/shared/api";
import { renderMdWithLatex, loadKatex } from "@/shared/markdown";
import PhaseProgressBar from "./PhaseProgressBar.vue";

const router = useRouter();
const store = useWorkflowStore();

// ── 选中/展开状态 ──
const expandedIds = ref<Set<string>>(new Set());
const activeSecId = ref("");
const activeSection = computed(() => store.sections.find((s) => s.id === activeSecId.value) ?? null);
const childrenOf = (id: string) => store.sections.filter((s) => s.parentId === id);
const isExpanded = (id: string) => expandedIds.value.has(id);
function toggleExpand(id: string) {
  const next = new Set(expandedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedIds.value = next;
}
async function selectSection(s: Section) {
  // V417: 切章前若正在编辑且内容有改动 → 先问, 别静默丢弃。
  //   原实现直接 `editing=false; editText=""`(注释自己都写了"未保存草稿丢弃"),
  //   用户点一下别的章节, 整章改动就没了 —— 不可逆, 必须拦。
  if (editing.value && editText.value !== (activeSection.value?.content ?? "")) {
    const ok = await confirmDialog({
      title: "放弃未保存的修改?",
      message: `「${activeSection.value?.title ?? "当前章节"}」的正文有未保存的修改, 切换章节会丢弃它们。`,
      okText: "放弃并切换",
      cancelText: "留下继续编辑",
      danger: true,
    });
    if (!ok) return;
  }
  // 2026-09-16: 这里原有一行 `editing.value = false`。因为 editing 是 computed(写 mdTab),
  //   它的实际效果是**切章时把用户踢到「预览」** —— 闭源的 tab 是 MarkdownEditor 的局部
  //   状态、与章节无关, 切章保持在哪个 tab 是用户的选择, 不该被切章动作改掉。
  //   所以不要再动 mdTab; 切章只需换内容。
  // 解绑而不是写空串 —— 写空串会被防抖 watch 当成"用户把这一章清空了"(见 bindEditorTo 注释)
  editOwnerId = "";
  editBaseline = "";           // 同步解绑基线, 免得回填 watch 拿旧基线误判"用户没动过"
  if (bodyTimer) { clearTimeout(bodyTimer); bodyTimer = null; }
  activeSecId.value = s.id;
}
// 非空安全访问(模板闭包内 TS 收窄失效)
const activeId = computed(() => activeSection.value?.id ?? "");
// 选中章所属一级章索引(l2 子节 → 归属父一级)
const activeL1Idx = computed(() => {
  const sec = activeSection.value;
  if (!sec) return -1;
  if (sec.level === 1) return l1List.value.findIndex((s) => s.id === sec.id);
  const parent = store.sections.find((s) => s.id === sec.parentId);
  if (parent) return l1List.value.findIndex((s) => s.id === parent.id);
  return -1;
});

// ── 章导航辅助 ──
function cnOf(i: number): string {
  const CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十"];
  return CN[i] ?? String(i + 1);
}
/** 变量角色色(SectionsView 同款 5 色) */
function roleColor(role: string): string {
  const qn: Record<string, string> = {
    "自变量": "#2563eb", "因变量": "#dc2626", "中介": "#E8B54A", "调节": "#7c3aed", "控制": "#6b7280",
    "x": "#2563eb", "y": "#dc2626", "mediator": "#E8B54A", "moderator": "#7c3aed", "control": "#6b7280",
    "影响因素": "#2563eb", "结果表现": "#dc2626", "中间机制": "#E8B54A", "情境条件": "#7c3aed", "背景因素": "#6b7280"
  };
  return qn[String(role ?? "")] ?? "#2563eb";
}
function secStatusDot(s: Section): { cls: string; title: string } {
  const st = s.status ?? "";
  if (st === "generated" || (s.content && s.content.length > 50)) return { cls: "dot-done", title: "已生成" };
  if (st === "generating") return { cls: "dot-generating", title: "生成中" };
  return { cls: "", title: "待生成" };
}
const l1List = computed(() => store.level1Sections);
const genCount = computed(() => l1List.value.filter((s) => s.content && s.content.length > 50).length);
const pendingCount = computed(() => l1List.value.filter((s) => !(s.content && s.content.length > 50)).length);
const progressPct = computed(() => (l1List.value.length ? Math.round((genCount.value / l1List.value.length) * 100) : 0));

// V417: 写作指导批量生成的结果(成功数/总数/错误) —— 用于如实报告, 不再无条件报成功
const skillCardResult = ref<{ ok: number; total: number; error?: string }>({ ok: 0, total: 0 });
// V417: 当前正在跑章的生成任务 id —— 后端 /tasks/:id/control 早支持 cancel, 但前端一直没有入口,
//   章节生成可能要几分钟, 用户只能干等。
const activeGenTaskId = ref("");

// ── 生成状态 ──
const generating = ref(false);
const generateMode = ref<"single" | "batch">("single");
const genStage = ref("");
const genProgress = ref<{ current?: number; total?: number }>({});
let poll: ReturnType<typeof setInterval> | null = null;

function statusText(): string {
  if (generating.value) {
    if (generateMode.value === "batch") return `正在批量生成章节 ${genProgress.value.current ?? 0}/${genProgress.value.total ?? 0}…`;
    return genStage.value || "正在生成章节内容…";
  }
  if (busy.value) return busyText.value;
  return "就绪";
}
/**
 * 页面忙态(闭源: batchGenerating || sectionGenerating || materialGenerating || skillThinking || mainAIThinking)。
 * 2026-09-15 前只看 generating —— "素材生成中""结构化分析中"时界面表现为空闲,
 * 用户能同时发起第二次生成(会撞任务)。少掉的聚合位由 genDlg.busy(素材)与 aiThinking(结构化分析)补上。
 * 注: genDlg/aiThinking 在文件后段声明, computed 惰性求值, 此处引用是安全的。
 */
const busy = computed(() => generating.value || genDlg.value.busy || aiThinking.value);
const busyText = computed(() => {
  if (generating.value) return generateMode.value === "batch" ? "正在批量生成章节" : "正在生成章节内容";
  if (genDlg.value.busy) return "正在生成素材";
  if (aiThinking.value) return "正在结构化分析";
  return "当前操作处理中";
});

// ── 单节生成(闭源 me()) ──
async function generateSection() {
  const sec = activeSection.value;
  if (!sec) return;
  if (generating.value) {
    toast(statusText() + ", 请等待完成后再操作", "warning");
    return;
  }
  if (!store.taskId) {
    toast("请先创建并保存工作流任务", "warning");
    return;
  }
  const l1 = sec.level === 1 ? sec : store.sections.find((s) => s.id === sec.parentId);
  if (!l1) return;
  // 子节随父章节一起生成(闭源规则)
  const targets = [l1.id, ...childrenOf(l1.id).map((c) => c.id)];
  generating.value = true;
  generateMode.value = "single";
  genStage.value = "执行智能体开始思考…";
  try {
    const t = await createTask({
      title: `生成章节: ${l1.title}`,
      projectId: store.taskId,
      module: "workflow",
      jobKind: "phase4_batch",
      goal: store.input.title,
      phase: 4,
      phaseLabel: "文本创作",
      inputSnapshot: {
        sections: store.sections.filter((s) => targets.includes(s.id)).map((s) => ({
          id: s.id, title: s.title, level: s.level,
          skill_prompt: s.skill_prompt && s.skill_prompt.trim() ? s.skill_prompt : (s.aiSkill ? JSON.stringify(s.aiSkill) : "")
        }))
      }
    });
    // 立即标记 generating(UI 状态)
    for (const s of store.sections) if (targets.includes(s.id)) s.status = "generating";
    pollTask(t.id, async () => {
      await refreshSections();
      const target = store.sections.find((s) => s.id === l1.id);
      toast(`「${l1.title}」生成完成`, "success");
      if (target) target.status = "generated";
    });
  } catch (e) {
    generating.value = false;
    toast(`生成失败: ${(e as Error).message}`, "error");
  }
}

// ── 批量生成全部(闭源 Me(): 深快照+覆盖确认) ──
async function generateAll() {
  const targets = l1List.value;
  if (!targets.length) return;
  if (generating.value) {
    toast(statusText() + ", 请等待完成后再操作", "warning");
    return;
  }
  if (targets.every((s) => s.content && s.content.length > 50)) {
    const ok = window.confirm("所有章节已有正文。重新生成将覆盖当前内容, 确定要继续吗?");
    if (!ok) return;
  }
  // 深快照(供失败回滚)
  const snapshot = JSON.parse(JSON.stringify(store.sections));
  localStorage.setItem("wf_batch_snapshot", JSON.stringify(snapshot));
  generating.value = true;
  generateMode.value = "batch";
  genProgress.value = { current: 0, total: targets.length };
  try {
    const t = await createTask({
      title: `批量生成全部章节(${targets.length})`,
      projectId: store.taskId,
      module: "workflow",
      jobKind: "phase4_batch",
      goal: store.input.title,
      phase: 4,
      phaseLabel: "文本创作",
      inputSnapshot: {
        sections: store.sections.map((s) => ({
          id: s.id, title: s.title, level: s.level,
          skill_prompt: s.skill_prompt && s.skill_prompt.trim() ? s.skill_prompt : (s.aiSkill ? JSON.stringify(s.aiSkill) : "")
        }))
      }
    });
    for (const s of store.sections) s.status = "generating";
    pollTask(t.id, async () => {
      await refreshSections();
      generating.value = false;
      localStorage.removeItem("wf_batch_snapshot");
      toast(`批量生成完成, 共 ${targets.length} 个章节`, "success");
    }, true);
  } catch (e) {
    // 整批还原(闭源失败路径)
    const snapRaw = localStorage.getItem("wf_batch_snapshot");
    let restored = false;
    if (snapRaw) {
      try {
        store.sections = JSON.parse(snapRaw);
        // V417: 必须**写回服务端**。原来只改本地内存, 服务端还是生成后的内容,
        //   下一次 refreshSections 就把"恢复"覆盖掉 —— 界面上那句"已恢复"是假的。
        await putNode(store.taskId, "sections", { sections: store.sections });
        restored = true;
      } catch { /* 忽略 */ }
    }
    localStorage.removeItem("wf_batch_snapshot");
    generating.value = false;
    toast(
      restored
        ? `批量生成失败: ${(e as Error).message}, 已恢复生成前的章节和内容`
        : `批量生成失败: ${(e as Error).message}(未能恢复生成前内容)`,
      "error");
  }
}

/** 停止当前章节生成: 调后端 cancel(任务真的停下, 不再回写节点) */
async function stopGeneration() {
  const id = activeGenTaskId.value;
  stopPoll();
  generating.value = false;
  activeGenTaskId.value = "";
  for (const s of store.sections) if (s.status === "generating") s.status = s.content ? "generated" : "pending";
  if (!id) { toast("已停止等待(任务可能已结束)", "info"); return; }
  try {
    await q(`/research/tasks/${id}/control`, { method: "POST", body: { action: "cancel" } });
    toast("已停止生成", "info");
  } catch {
    toast("已停止等待, 但后端取消失败(任务可能仍在跑)", "warning");
  }
}

// ── 回滚批量(闭源 Fe/Ae) ──
async function rollbackBatch() {
  const ok = window.confirm("回滚到批量生成前的内容? 当前全部章节正文将被覆盖。");
  if (!ok) return;
  // V417: 原实现 `.catch(() => null)` 把 404 吞掉后**无条件**弹"已回滚" ——
  //   而后端只在"上一次批量生成"留了 batch:pre 锚点, 单章生成没有锚点 → 404。
  //   用户以为回滚成功, 实际服务端一个字都没动。必须如实报告。
  try {
    await q(`/research/projects/${store.taskId}/nodes/sections/undo-batch`, { method: "POST" });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    toast(/没有可回滚|404/.test(msg) ? "没有可回滚的批量记录(单章生成不留锚点)" : `回滚失败: ${msg}`, "error");
    return;
  }
  await refreshSections();
  toast("已回滚到批量生成前的内容", "success");
}

// ── 任务轮询(泵执行; 成功回读 sections) ──
function pollTask(taskId: string, onDone: () => Promise<void>, isBatch = false) {
  stopPoll();
  activeGenTaskId.value = taskId;
  poll = setInterval(async () => {
    try {
      const t = await getTask(taskId);
      if (!t) return;
      const prog = (t.progress ?? {}) as { stage?: string; current?: number; total?: number };
      genStage.value = prog.stage ?? "";
      genProgress.value = { current: prog.current ?? genProgress.value.current, total: prog.total ?? genProgress.value.total };
      if (t.status === "done" || t.status === "completed") {
        stopPoll();
        activeGenTaskId.value = "";
        await onDone();
        // V417: 清掉残留的 generating 标记。phase4_batch 是"逐章 try/catch 后整体成功"
        //   (research-exec-engine.runChapterBatch), 某章失败时任务照样 done →
        //   onDone 只把当前这一章标成 generated, 其余 targets 永久停在 generating,
        //   左栏黄点一直闪、pendingCount 算错、按钮文案也错。
        for (const s of store.sections) {
          if (s.status === "generating") s.status = s.content ? "generated" : "pending";
        }
        if (!isBatch) generating.value = false;
        await store.saveProject();
      } else if (t.status === "failed" || t.status === "cancelled") {
        stopPoll();
        activeGenTaskId.value = "";
        generating.value = false;
        for (const s of store.sections) if (s.status === "generating") s.status = "pending";
        // 带上后端 error(原来只说"请重试", 用户不知道为什么失败, 重试还是失败)
        const why = describeTaskError(t);
        toast(why ? `章节生成失败: ${why}` : "章节生成失败, 请重试", "error");
      }
    } catch { /* 容忍 */ }
  }, 800);
}
function stopPoll() {
  if (poll) {
    clearInterval(poll);
    poll = null;
  }
}

// ── sections 回读(nodes/sections payload.sections[]) ──
// 注意: 后端把 aiSkill 写作指导也写在同一个节点里(见 chapter-skill-service.generateChapterSkillCard),
// 原实现只搬 content → 刷新/切页/store 重建后 aiSkill 丢失 → generateAll 的 skill_prompt 传空
// → 正文变成裸生成, 写作指导静默失效。这里必须一并回填。
function mergeFreshSection(current: Section, fresh: Section): Section {
  const next: Section = { ...current };
  if (fresh.content) {
    next.content = fresh.content;
    next.status = "generated" as const;
  }
  if (fresh.aiSkill) {
    next.aiSkill = fresh.aiSkill;
    // skill_prompt 优先用显式值, 否则和后端同规则(JSON.stringify(aiSkill))还原
    next.skill_prompt = fresh.skill_prompt && fresh.skill_prompt.trim()
      ? fresh.skill_prompt
      : current.skill_prompt && current.skill_prompt.trim()
        ? current.skill_prompt
        : JSON.stringify(fresh.aiSkill);
  } else if (fresh.skill_prompt) {
    next.skill_prompt = fresh.skill_prompt;
  }
  if (fresh.structuredSummary) next.structuredSummary = fresh.structuredSummary;
  if (fresh.wordCount) next.wordCount = fresh.wordCount;
  return next;
}

async function refreshSections() {
  if (!store.taskId) return;
  try {
    const node = await getNode(store.taskId, "sections");
    const list = node?.sections;
    if (Array.isArray(list)) {
      const merged = store.sections.map((s) => {
        const fresh = (list as Section[]).find((x) => x.id === s.id);
        return fresh ? mergeFreshSection(s, fresh) : s;
      });
      // 新出现但本地没有的(后端生成的)
      for (const f of list as Section[]) {
        if (!merged.find((m) => m.id === f.id) && f.content) merged.push({ ...f, status: "generated" as const });
      }
      store.sections = merged;
    }
  } catch { /* 空容忍 */ }
}

/** V417: structuredSummary 是 `【关键结论】…\n\n【关键数据】…` 文本(非对象), 拆成块渲染 */const summaryBlocks = computed(() => {
  const raw = String(activeSection.value?.structuredSummary ?? "").trim();
  if (!raw) return [];
  return raw.split(/\n\s*\n(?=【)/).map((chunk) => {
    const m = /^【(.+?)】\s*([\s\S]*)$/.exec(chunk.trim());
    return m ? { title: m[1], body: m[2].trim() } : { title: "要点", body: chunk.trim() };
  }).filter((b) => b.body);
});

/**
 * 正文渲染 —— 2026-09-15: 原先预览态是 `<pre>{{ content }}</pre>`, 生成出来的 markdown
 * (标题/列表/表格/公式)全以源码形式砸在用户脸上, 表格尤其致命(整块 |---| 字符)。
 * shared/markdown.ts 的 renderMd/renderMdWithLatex 早就写好了, 但 workflow 全线一次都没调用过。
 */
const activeContentHtml = computed(() => {
  const md = String(activeSection.value?.content ?? "");
  return md ? renderMdWithLatex(md) : "";
});

// ── 正文编辑(本地预览; 保存到 store) ──
/** V417 出站: 本章正文 → 学术文本工作台(复用评审侧已验证的 skf_doc_handoff 交接) */
function sendSectionToEditor() {
  const sec = activeSection.value;
  if (!sec?.content || sec.content.length < 50) { toast("本章正文为空, 请先生成", "warning"); return; }
  const title = `${store.title || "未命名论文"} · ${sec.title}`;
  if (sendMarkdownToEditor(sec.content, title)) toast("已送往学术文本工作台, 将新建文档", "success");
  // 2026-09-17 修: 原提示写的是"localStorage 不可用或已满" —— 这条通道**根本不碰 localStorage**
  //   (见 workflow-bridge 的注释: 该路是 postMessage → React 外壳中转)。真实失败原因只有一个:
  //   没有父窗口(独立打开 /soc/ 子应用而不是从外壳嵌进来), 或跨源拿不到 parent。
  //   报错指向错的组件, 排查会被带偏(本轮探针就在这里绕了一圈)。
  else toast("发送失败: 需要从平台外壳中打开写作舱(独立打开子应用时无法转发)", "error");
}
/**
 * 编辑/预览双 tab(闭源 MarkdownEditor)。正文编辑始终可用 —— 所以 editText 跟随当前章。
 *
 * ⚠ 2026-09-16 修 bug: 这里原来把 `editing` 做成 computed(读 mdTab==='write', 写 mdTab),
 *   而 selectSection() 会执行 `editing.value = false` —— 副作用是**点任意章节(包括当前章)
 *   都把正文区从「编辑」踢到「预览」**。用户每点一次章节树就得手动切回来。
 *   对照闭源 MarkdownEditor: 那个 tab 是组件内部的 `x("write")` 局部状态, 没有 watch、
 *   与章节无任何关系, 切章不会重置。所以这里跟进: `editing` 就是 mdTab 本身,
 *   切章路径不再去动它。
 */
const mdTab = ref<"write" | "preview">("write");
const editText = ref("");
/** 编辑态开关(= 在写 tab); 保留这个名字是因为模板与 saveEdit 都在用 */
const editing = computed({
  get: () => mdTab.value === "write",
  set: (v: boolean) => { mdTab.value = v ? "write" : "preview"; },
});
/** 有未保存改动(写 tab 下当前章正文与编辑框不一致) */
const editDirty = computed(() => {
  const sec = activeSection.value;
  if (!sec) return false;
  return editText.value !== (sec.content ?? "");
});

/**
 * 正文 500ms 防抖落库(闭源 O=Ze(()=>e.saveProject(),500), content 一变更就排程)。
 * 2026-09-15 补: 原先只有点「保存修改」才写, 用户敲完直接切页/刷新, 整章改动就没了 ——
 *   而界面上"未保存"三个字很容易被忽略。写节点(不是只写快照), 理由见 saveEdit 的注释。
 *
 * ⚠ 2026-09-16 修 bug: `editText` 必须连同**它属于哪一章**一起记。
 *   切章时 selectSection() 在同一个同步块里先 `editText=""` 再 `activeSecId=s.id`,
 *   而 watch 回调是**微任务**, 执行时 activeSecId 已经是新章 —— 于是"清空编辑框"被当成
 *   "把新章正文改成空串", 静默清空了刚切过去那一章的正文(实测: 快照里某章 content 变成 0 字)。
 *   现在以 owningId 为准, 切章时先把 owningId 置空, 任何残留的回调都会被丢弃。
 */
let bodyTimer: ReturnType<typeof setTimeout> | null = null;
/** editText 当前承载的是哪一章的正文; 为空表示编辑框正在被重置, 此时的变更一律忽略 */
let editOwnerId = "";
/**
 * 编辑框当前承载的**原始内容**(由 `bindEditorTo` 维护)。
 * 用来判断"用户有没有真的动过编辑框" —— 判断依据必须是 `editText !== editBaseline`,
 * **不能**用 `editDirty`(它拿 `sec.content` 比, 而生成回填改的正是 `sec.content`)。详见下方回填 watch。
 */
let editBaseline = "";
watch(editText, (v) => {
  if (!editOwnerId) return;                     // 编辑框正在重置, 不是用户输入
  const sec = store.sections.find((s) => s.id === editOwnerId);
  if (!sec) return;
  if (v === (sec.content ?? "")) return;
  if (bodyTimer) clearTimeout(bodyTimer);
  bodyTimer = setTimeout(() => void persistBody(editOwnerId, v), 500);
});
/** 把编辑框切到指定章节(所有切章路径都必须走它, 别直接赋值 editText) */
function bindEditorTo(sectionId: string, content: string) {
  if (bodyTimer) { clearTimeout(bodyTimer); bodyTimer = null; }
  editOwnerId = "";            // 先声明"这是重置", watch 里的那次回调会被丢弃
  editText.value = content;
  editBaseline = content;      // 记下"编辑框当前承载的就是这个值"(见下方回填 watch)
  editOwnerId = sectionId;
}
async function persistBody(sectionId: string, next: string) {
  const sec = store.sections.find((s) => s.id === sectionId);
  if (!sec) return;
  sec.content = next;
  sec.status = "generated";
  try {
    await putNode(store.taskId, "sections", { sections: store.sections });
  } catch {
    /* 节点写失败由 saveEdit 的显式路径兜底并提示 */
  }
}

async function saveEdit() {
  const sec = activeSection.value;
  if (!sec) return;
  sec.content = editText.value;
  sec.status = "generated";
  editing.value = false;
  // V417: 必须**落 sections 节点**, 不能只写 workbench 快照。
  //   原来只 saveProject() → 之后任何一次生成都会 refreshSections(),
  //   而它用节点里的旧 content 无条件覆盖本地 → 用户手改的正文静默回退(实测路径:
  //   mergeFreshSection 的 `if (fresh.content) next.content = fresh.content`)。
  //   节点是章节正文的真源, 编辑就得写节点。
  try {
    await putNode(store.taskId, "sections", { sections: store.sections });
  } catch {
    toast("保存到服务端失败, 仅本地生效(刷新可能丢失)", "error");
  }
  await store.saveProject();
}

// ── 素材卡(右栏; 绑当前节/全部) ──
const materials = ref<Array<Record<string, unknown>>>([]);
const materialFilter = ref("all");
/** 素材归属的章节 id 集合 —— 后端 sectionIds 是数组(可一素材多章), sectionId 是单值旧形态 */
function sectionIdsOf(m: Record<string, unknown>): string[] {
  const arr = m.sectionIds;
  if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === "string");
  const one = m.sectionId;
  return typeof one === "string" && one ? [one] : [];
}
const filteredMaterials = computed(() => {
  const f = materialFilter.value;
  // 2026-09-15: 原先只按类型筛, 不看当前章 —— 右栏永远列全库素材, "这个素材是为哪章准备的"这层
  //   语义丢失, 用户得自己在几十条里找。当前章(含其子节)之外的素材不再混进来。
  const cur = activeSection.value;
  const scope = cur ? [cur.id, ...store.sections.filter((s) => s.parentId === cur.id).map((s) => s.id)] : [];
  return materials.value.filter((m) => {
    if (f !== "all" && catOfKind(String(m.kind ?? "")) !== f) return false;
    if (!cur) return true;
    const ids = sectionIdsOf(m);
    // 未关联章节的素材照常显示(发布门禁会拦), 否则用户看不到它们就没法去关联
    return ids.length === 0 || ids.some((id) => scope.includes(id));
  });
});
async function loadMaterials() {
  if (!store.taskId) return;
  try {
    const r = await q<{ materials?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>> }>(`/research/materials?projectId=${store.taskId}`);
    materials.value = r.materials ?? r.items ?? [];
  } catch {
    materials.value = [];
  }
}
async function insertMaterialContent(m: Record<string, unknown>) {
  const sec = activeSection.value;
  if (!sec) return;
  const content = String(m.contentMd ?? m.content ?? "");
  sec.content = (sec.content ?? "") + "\n\n" + content;
  await store.saveProject();
  toast("素材已插入到章节尾部", "success");
}

/** 素材类型 → 图标/中文标签/主色(闭源 MaterialCard 9 类映射) */
const KIND_META: Record<string, { icon: string; label: string; color: string; bg: string }> = {
  theory: { icon: "💡", label: "理论", color: "#B08CF0", bg: "#241A3A" },
  citation: { icon: "📚", label: "文献", color: "#6FA8F5", bg: "#16243F" },
  literature: { icon: "📚", label: "文献", color: "#6FA8F5", bg: "#16243F" },
  data_result: { icon: "📊", label: "数据", color: "#5FD0B4", bg: "#14291F" },
  data: { icon: "📊", label: "数据", color: "#5FD0B4", bg: "#14291F" },
  table: { icon: "📋", label: "表格", color: "#4FC9D6", bg: "#0F2A2E" },
  figure: { icon: "🖼", label: "图表", color: "#EF7FBF", bg: "#33172A" },
  chart: { icon: "🖼", label: "图表", color: "#EF7FBF", bg: "#33172A" },
  case: { icon: "🏛", label: "案例", color: "#E8A84A", bg: "#33240F" },
  method: { icon: "⚙", label: "方法", color: "#8C93F0", bg: "#1B1F42" },
  file: { icon: "📎", label: "附件", color: "#A8B4C4", bg: "#1A2333" },
  document: { icon: "📎", label: "附件", color: "#A8B4C4", bg: "#1A2333" },
};
const kindMeta = (k: string) => KIND_META[k] ?? KIND_META.file;
/**
 * 原始 kind → 闭源筛选器的概念类别。
 *
 * 后端真实写入的 kind 比筛选器多(图片上传写 `figure`、附件写 `file`、表格写 `table`),
 * 直接拿原始 kind 当筛选项值会出现"选得出却永远筛不出"(2026-09-16 实测:
 * `figure`/`file` 两个选项恒空)。这里把多对一收敛到闭源的 6 类,
 * 未收录的一律归 "case"(不丢素材, 也不会出现空选项)。
 */
const FILTER_CATS: Record<string, string> = {
  theory: "theory",
  citation: "citation", literature: "citation",
  data_result: "data", data: "data", table: "data",
  case: "case", figure: "case", chart: "case", file: "case", document: "case", note: "case",
};
const catOfKind = (k: string): string => FILTER_CATS[k] ?? "case";
const kindIcon = (k: string) => kindMeta(k).icon;
const kindLabel = (k: string) => kindMeta(k).label;
const kindColor = (k: string) => kindMeta(k).color;
const kindBg = (k: string) => kindMeta(k).bg;
const matWords = (m: Record<string, unknown>) => String(m.contentMd ?? m.content ?? "").replace(/\s/g, "").length;
const matLinked = (m: Record<string, unknown>) => {
  const ids = m.sectionIds;
  return (Array.isArray(ids) && ids.length > 0) || !!m.sectionId;
};

/** 从素材库移除(右侧栏的 ✕; 与「插入」不同, 这是真删库里的记录) */
async function removeMaterialFromLib(m: Record<string, unknown>) {
  const id = String(m.id ?? "");
  if (!id) return;
  const ok = await confirmDialog({ title: "删除素材", message: `确定从素材库删除「${String(m.title ?? "")}」?`, okText: "删除", danger: true });
  if (!ok) return;
  try {
    await q(`/research/materials/${id}`, { method: "DELETE" });
    await loadMaterials();
    toast("素材已删除", "success");
  } catch (e) {
    toast(`删除失败: ${describeTaskError({ error: (e as Error).message })}`, "error");
  }
}

/** 回滚本次批量里**已成功**的那些章(保留失败章的原状) —— 闭源两个回滚按钮中的第二个 */
async function rollbackBatchKeep() {
  const ok = await confirmDialog({
    title: "回滚本次成功章节?",
    message: `将把本次已生成的 ${genProgress.value.current ?? 0} 章正文还原为生成前的内容, 未完成的章不受影响。`,
    okText: "回滚", danger: true,
  });
  if (!ok) return;
  await rollbackBatch();
}

// ── C3 素材生成弹窗(闭源: 类型 select + 生成要求 + 流式结果 → 保存到素材库) ──
const genDlg = ref({ open: false, type: "theory", prompt: "", busy: false, preview: "", err: "" });
const GEN_TYPES = [
  { key: "theory", label: "理论素材" },
  { key: "data", label: "数据素材" },
  { key: "case", label: "案例素材" },
  { key: "method", label: "方法素材" },
  { key: "literature", label: "文献素材" }
];
const GEN_KIND: Record<string, string> = { theory: "theory", data: "data_result", case: "note", method: "note", literature: "citation" };
function openGenDlg() { genDlg.value = { open: true, type: "theory", prompt: "", busy: false, preview: "", err: "" }; }
function closeGenDlg() {
  if (genDlg.value.busy) return;
  genDlg.value.open = false;
}
/** 生成: 同步素材生成端点(POST /research/materials/generate → LLM 落库 count 条) */
async function runMaterialGen() {
  const d = genDlg.value;
  if (!d.prompt.trim()) { toast("请输入生成要求", "warning"); return; }
  const l1 = activeSection.value && activeSection.value.level === 1
    ? activeSection.value
    : activeSection.value
      ? store.sections.find((s) => s.id === activeSection.value!.parentId)
      : null;
  if (!l1) { toast("请先在左侧选择一个章节", "warning"); return; }
  d.busy = true;
  d.err = "";
  d.preview = "";
  try {
    const r = await q<{ materials?: Array<{ id?: string; title?: string; kind?: string }> }>(`/research/materials/generate`, {
      method: "POST",
      body: {
        projectId: store.taskId,
        targetSectionId: l1.id,
        sectionTitle: l1.title,
        count: 3,
        topic: d.prompt,
        prompt: `素材类型: ${GEN_TYPES.find((t) => t.key === d.type)?.label ?? d.type}; 生成要求: ${d.prompt}`
      }
    });
    const list = r.materials ?? [];
    if (!list.length) { d.err = "AI 未能生成素材, 请重试"; d.busy = false; return; }
    d.preview = list.map((m, i) => `${i + 1}. ${m.title ?? "素材"}${m.kind ? `（${m.kind}）` : ""}`).join("\n");
  } catch (e) {
    d.err = String((e as { message?: string }).message ?? e);
  } finally {
    d.busy = false;
  }
}
/** 保存: 素材已在后端落库 → 关闭 + 刷新右栏素材库 */
async function saveGenMaterial() {
  genDlg.value.open = false;
  genDlg.value.preview = "";
  await loadMaterials();
  toast("素材已保存到素材库", "success");
}

// ── C4 字数徽标(闭源 SectionGenerator: 已生成 N 字, 生成中按流式字符数实时) ──
const activeWords = computed(() => {
  const sec = activeSection.value;
  if (!sec?.content) return 0;
  return String(sec.content).replace(/\s/g, "").length;
});
const secWordBadge = computed(() => {
  const words = activeWords.value;
  if (generating.value && generateMode.value === "single") return "生成中…";
  return words ? `已生成 ${words} 字` : "";
});

// ── 进合稿门禁(闭源 je()) ──
async function enterFinalize() {
  if (!l1List.value.length) {
    toast("请先确认章节清单, 再进入合并定稿", "warning");
    return;
  }
  if (pendingCount.value > 0) {
    toast(`还有 ${pendingCount.value} 个一级章节未完成, 全部完成后再进入合并定稿`, "warning");
    return;
  }
  store.setPhase(5);
  // 2026-09-15: 把本轮正文发布成 phase4_text 版本 —— 合稿前的"Phase 4 已完成"凭证。
  //   此前没有任何地方写过 phase4 版本, /versions/current 的 phase4Version 恒为 null,
  //   闭源那条"请先完成当前 Phase 4 正文生成, 再进行合稿"的门禁根本无从触发。
  await q(`/research/projects/${store.taskId}/publish`, { method: "POST", body: { label: "phase4_text" } }).catch(() => null);
  void router.push("/workflow/finalize");
}

watch(
  () => store.sections.map((s) => s.id).join(","),
  () => {
    if (store.phase === 4) void store.saveProject();
  }
);

/** 切章时把编辑框同步到新章的正文, 否则会把上一章的内容带过去(编辑态是常驻的) */
watch(activeSecId, (id) => {
  bindEditorTo(id, String(activeSection.value?.content ?? ""));
  bindThinkTo(id, String(activeSection.value?.skill_prompt ?? ""));
});

/**
 * 当前章的正文**在 store 里被更新后**, 编辑框必须跟着回填。
 *
 * ⚠ 2026-09-20 修的真缺陷(用户可见): `editText` 原先只有两个绑定时机 ——
 *   `watch(activeSecId)`(切章)与初次挂载。而「执行智能体开始思考」生成完成后,
 *   `pollTask` → `refreshSections()` 只更新了 `store.sections`, **`activeSecId` 没变**,
 *   于是**编辑框不会被重新绑定**: 后端约 40 秒就把正文写进了 `research_nodes.sections`,
 *   而界面上的正文框还是空的, 用户得先切到别的章再切回来才看得到。
 *   (实测诊断: 页脚「1283 字 未保存 保存修改」= store 已有正文, 而 textarea 长度 0。)
 *
 * ⚠⚠ 判断"用户有没有在编辑"**不能用 `editDirty`** —— 它的定义是
 *   `editText !== sec.content`, 而这里修改的正是 `sec.content`, 所以那一刻 `editDirty`
 *   恰好变成 true, 守卫会把自己挡在门外(我第一版就是这么写的, 修了两次都没生效)。
 *   正确的判据是拿**第三个数**做基线: `editBaseline` = "编辑框当前承载的是哪份内容",
 *   由 `bindEditorTo` 维护。只有 `editText !== editBaseline` 才说明**用户真的动过**。
 */
watch(
  () => activeSection.value?.content ?? "",
  (next) => {
    const id = activeSecId.value;
    if (!id) return;
    if (editText.value !== editBaseline) return; // 用户有未提交的输入 → 绝不覆盖
    if (editText.value === next) return;         // 已经一致
    bindEditorTo(id, next);
  }
);

/**
 * 主控智能体思考(闭源: 每章一个可编辑的写作思路 textarea, 预填该章写作指导)。
 * 存到 section.skill_prompt —— 生成章节时 runChapterBatch 会优先用它(见后端 buildChapterPrompt)。
 * 500ms 防抖落库(闭源同款): 逐字敲时不该每键一次请求, 但也不能只在失焦时才存 ——
 *   用户写完直接点「执行智能体开始思考」, 那次生成就得用上刚写的内容。
 *
 * ⚠ 归属必须显式记(与 editOwnerId 同因): 切章时 `thinkPrompt = 新章的指导` 这一下会给 watch
 *   排一个"把新章指导写进**旧章**"的定时器 —— 定时器执行时 activeSection 已经变了。
 */
const thinkPrompt = ref("");
let thinkTimer: ReturnType<typeof setTimeout> | null = null;
let thinkOwnerId = "";
watch(thinkPrompt, () => {
  if (!thinkOwnerId) return;                    // 正在重置, 不是用户输入
  const sec = store.sections.find((s) => s.id === thinkOwnerId);
  if (!sec) return;
  const next = thinkPrompt.value.trim();
  if (String(sec.skill_prompt ?? "") === next) return;
  if (thinkTimer) clearTimeout(thinkTimer);
  thinkTimer = setTimeout(() => void persistThinkPrompt(thinkOwnerId, next), 500);
});
/** 把思考框切到指定章节(所有切章路径都走它) */
function bindThinkTo(sectionId: string, value: string) {
  if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; }
  thinkOwnerId = "";
  thinkPrompt.value = value;
  thinkOwnerId = sectionId;
}
async function persistThinkPrompt(sectionId: string, next: string) {
  const sec = store.sections.find((s) => s.id === sectionId);
  if (!sec) return;
  sec.skill_prompt = next;
  try {
    await putNode(store.taskId, "sections", { sections: store.sections });
  } catch {
    toast("写作思路保存失败, 仅本地生效", "error");
  }
}
/** 离开页面前把未落库的防抖内容冲掉 */
onUnmounted(() => {
  if (thinkTimer) {
    clearTimeout(thinkTimer);
    // 归属必须用 thinkOwnerId —— 不能用 activeSection(它是"当前选中的章"), 切章后两者不同。
    //   实测竞态: 切章时 selectSection 先解绑 editText, 随后 watch(activeSecId) 调 bindEditorTo
    //   把 editText 换成新章正文; 若本函数在两者之间执行, bodyTimer 的"旧章内容"就被算给了新章
    //   (且会覆盖掉新章写入)。thinkPrompt 是同样的问题。
    const owner = thinkOwnerId || activeSection.value?.id || "";
    const sec = store.sections.find((s) => s.id === owner);
    if (sec) {
      const next = thinkPrompt.value.trim();
      if (String(sec.skill_prompt ?? "") !== next) sec.skill_prompt = next;
      void store.saveProject();
    }
  }
  // 正文同样: 离开页面前把未落库的防抖内容冲掉, 否则最后 500ms 内敲的字丢失
  if (bodyTimer) {
    clearTimeout(bodyTimer);
    // 同理以 editOwnerId 为准; 它为空说明编辑框正在被重置, 没有属于它的未落库内容
    const sec = editOwnerId ? store.sections.find((s) => s.id === editOwnerId) : null;
    if (sec && editText.value !== (sec.content ?? "")) void persistBody(sec.id, editText.value);
  }
  // 防抖 watch 是组件作用域创建的, 组件卸载后不应再落库(闭源的 watch 随组件销毁)
  if (bodyTimer) { clearTimeout(bodyTimer); bodyTimer = null; }
  if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; }
});

/** 状态胶囊三色(闭源: 待生成灰 / 生成中琥珀 / 已生成绿) */
const secHasContent = computed(() => {
  const c = activeSection.value?.content ?? "";
  return c.length > 50;
});
const genPill = computed(() => {
  if (generating.value && generateMode.value === "single") return { text: "生成中…", cls: "pill-generating" };
  return secHasContent.value ? { text: "已生成", cls: "pill-done" } : { text: "待生成", cls: "pill-pending" };
});

// ── C2 主控 AI — 结构化分析面板(闭源 WorkspaceView L36269+: 折叠卡片盖中央区) ──
const aiPanelOpen = ref(false);
const aiThinking = ref(false);
const aiStepMsg = ref("");
const aiStep = ref(0); // 0=未开始/1 识别研究变量/2 构建研究框架/3 生成写作指导
const aiStepDetail = ref("");
const aiJobId = ref("");
let aiPoll: ReturnType<typeof setInterval> | null = null;
const ANALYSIS_STEPS: Array<{ no: number; label: string }> = [
  { no: 1, label: "识别研究变量" },
  { no: 2, label: "构建研究框架" },
  { no: 3, label: "生成写作指导" }
];
/** 已完成结构化分析(sections 有 aiSkill/写作指导 或 store 有逻辑流/变量) */
const aiDone = computed(() => {
  if (store.variables.length || store.project.logicFlow) return true;
  if (!store.sections.length) return false;
  return store.sections.filter((s) => s.aiSkill || s.skill_prompt).length >= store.level1Sections.length * 0.6;
});
function aiPanelOpenToggle() {
  if (!store.level1Sections.length) {
    toast("请先确认章节清单, 再开始结构化分析", "warning");
    return;
  }
  aiPanelOpen.value = !aiPanelOpen.value;
}
function closeAiPanel() { aiPanelOpen.value = false; }
function stopAiPoll() {
  if (aiPoll) { clearInterval(aiPoll); aiPoll = null; }
}

/** 开始/重新分析(闭源 ue()=generateSkillsForSections): analyze job 泵 → 变量/框架/写作指导回填 */
async function runStructuredAnalysis() {
  if (!store.taskId) { toast("请先完成信息录入", "warning"); return; }
  if (!store.level1Sections.length) { toast("请先确认章节清单", "warning"); return; }
  if (aiThinking.value) return;
  aiThinking.value = true;
  aiPanelOpen.value = true;
  aiStep.value = 0;
  aiStepMsg.value = "正在分析论文结构...";
  aiStepDetail.value = "";
  try {
    const t = await createTask({
      title: store.input.title || "结构化分析",
      projectId: store.taskId,
      module: "workflow",
      jobKind: "analyze",
      goal: store.input.title || "结构化分析",
      phase: 2,
      phaseLabel: "科研架构"
    });
    aiJobId.value = t.id;
    pollAnalyzeJob(t.id);
  } catch (e) {
    aiThinking.value = false;
    aiStepMsg.value = "";
    toast("结构化分析失败: " + String((e as Error).message ?? e), "error");
  }
}
function pollAnalyzeJob(taskId: string) {
  stopAiPoll();
  aiPoll = setInterval(async () => {
    try {
      const t = await getTask(taskId);
      if (!t) return;
      const prog = (t.progress ?? {}) as { stage?: string; current?: number; total?: number };
      if (prog.stage) {
        if (prog.stage.includes("变量") || prog.stage.includes("因素")) { aiStep.value = 1; aiStepDetail.value = String(prog.stage); }
        else if (prog.stage.includes("框架")) { aiStep.value = 2; aiStepDetail.value = String(prog.stage); }
        else if (prog.stage.includes("指导") || prog.stage.toLowerCase().includes("skill")) { aiStep.value = 3; aiStepDetail.value = String(prog.stage); }
        aiStepMsg.value = String(prog.stage);
      } else {
        aiStep.value = aiStep.value || 1;
        aiStepMsg.value = "正在生成章节写作指导...";
      }
      if (t.status === "done" || t.status === "completed") {
        stopAiPoll();
        aiThinking.value = false;
        aiStep.value = 3;
        aiStepMsg.value = "结构化分析完成";
        aiStepDetail.value = "";
        await finishStructuredAnalysis(t);
      } else if (t.status === "failed" || t.status === "cancelled") {
        stopAiPoll();
        aiThinking.value = false;
        aiStepMsg.value = "分析失败, 请重试";
        toast("结构化分析失败, 请重试", "error");
      }
    } catch { /* 容忍 */ }
  }, 800);
}

/** 分析完成回填(同 SectionsView 语义): 变量/逻辑流 → 逐章 aiSkill 写作指导 → saveProject */
async function finishStructuredAnalysis(t: { result?: unknown }) {
  try {
    const res = (t.result ?? {}) as { structured?: Record<string, unknown>; text?: string };
    const st = (res.structured ?? {}) as Record<string, unknown>;
    const vars = Array.isArray(st.variables) ? st.variables : null;
    if (vars && vars.length) {
      store.variables = vars.map((v) => {
        const it = v as Record<string, unknown>;
        return { name: String(it.name ?? it.var ?? ""), role: String(it.role ?? "控制"), description: it.description ? String(it.description) : undefined, measurement: it.measurement ? String(it.measurement) : undefined };
      });
    }
    if (st.logicFlow) store.project.logicFlow = String(st.logicFlow);
    await store.saveProject();
  } catch { /* 容忍 */ }
  // 逐章写作指导(skill-cards 批量; V417: 不再无条件谎报成功)
  try {
    const { batchGenerateSkillCards } = await import("@/shared/tasks");
    const r = await batchGenerateSkillCards(store.taskId, store.level1Sections.map((s) => ({ id: s.id, title: s.title, level: 1 })));
    skillCardResult.value = { ok: r.okCount ?? 0, total: store.level1Sections.length };
  } catch (e) {
    skillCardResult.value = { ok: 0, total: store.level1Sections.length, error: String((e as Error).message ?? e).slice(0, 120) };
  }
  await reloadSkillCards();
  await store.saveProject();
  // 只有真生成了才报成功; 全失败/部分失败都如实说, 别让用户对着空白指导卡以为是自己的问题
  const sc = skillCardResult.value;
  if (sc.ok > 0 && sc.ok >= sc.total) {
    toast("结构化分析完成, 各章节写作指导已生成", "success");
  } else if (sc.ok > 0) {
    toast(`结构化分析完成, 但只生成了 ${sc.ok}/${sc.total} 章写作指导${sc.error ? `(${sc.error})` : ""}`, "warning");
  } else {
    toast(`结构化分析完成, 但写作指导全部生成失败${sc.error ? `: ${sc.error}` : "(模型不可用或余额不足)"}`, "error");
  }
}
async function reloadSkillCards() {
  try {
    const { listSkillCards } = await import("@/shared/tasks");
    const cards = await listSkillCards(store.taskId);
    const map = new Map<string, Record<string, unknown>>();
    for (const c of cards) {
      const flat = c as Record<string, unknown>;
      map.set(String(flat.section_id ?? flat.id ?? ""), flat);
    }
    let changed = false;
    for (const s of store.sections) {
      const flat = map.get(s.id);
      if (!flat) continue;
      if (!s.aiSkill) { s.aiSkill = {} as Record<string, unknown>; }
      const before = JSON.stringify(s.aiSkill);
      s.aiSkill = {
        type: flat.skill_type ?? (s.aiSkill as Record<string, unknown>).type,
        wordCount: Number(flat.word_count ?? (s.aiSkill as Record<string, unknown>).wordCount ?? 0),
        writingGoal: flat.writing_goal ?? (s.aiSkill as Record<string, unknown>).writingGoal ?? "",
        keyPoints: Array.isArray(flat.key_points) ? flat.key_points : Array.isArray(flat.keyPoints) ? flat.keyPoints : (s.aiSkill as Record<string, unknown>).keyPoints ?? [],
        notes: flat.notes ?? (s.aiSkill as Record<string, unknown>).notes ?? "",
        connection: flat.connection ?? (s.aiSkill as Record<string, unknown>).connection ?? "",
        sectionTitle: flat.section_title ?? flat.sectionTitle ?? "",
        frameworkSource: flat.framework_source ?? (s.aiSkill as Record<string, unknown>).frameworkSource ?? "",
        chapterDraft: flat.chapter_draft ?? (s.aiSkill as Record<string, unknown>).chapterDraft ?? "",
        childSections: Array.isArray(flat.child_sections) ? flat.child_sections : Array.isArray(flat.childSections) ? flat.childSections : (s.aiSkill as Record<string, unknown>).childSections ?? []
      };
      const after = JSON.stringify(s.aiSkill);
      if (before !== after) changed = true;
      s.skill_prompt = String((s.aiSkill as Record<string, unknown>).skill_prompt ?? flat.skill_prompt ?? "");
    }
    if (changed) void store.saveProject();
  } catch { /* 容忍 */ }
}

onMounted(async () => {
  markWorkflowReady();
  // 公式渲染器是懒加载单例(katex 缺失时 renderMd 会原样输出公式源码, 不报错)
  void loadKatex();
  await store.loadProject().catch(() => null);
  await loadMaterials();
  // 直进本页(硬刷新后 URL 落在 #/workflow/workspace)时 store 是空的 —— 没有 keep-alive,
  // 而 SectionsView 才是平时填 store.sections 的那一环。不回读的话左栏显示"暂无章节"。
  if (!store.sections.length && store.taskId) await refreshSections();
  if (store.sections.length) {
    // 默认展开全部一级
    expandedIds.value = new Set(store.level1Sections.map((s) => s.id));
    const first = store.level1Sections[0];
    if (first) {
      activeSecId.value = first.id;
      bindEditorTo(first.id, String(first.content ?? ""));
      bindThinkTo(first.id, String(first.skill_prompt ?? ""));
    }
  }
  // 写作指导也只在 SectionsView 拉过。直进本页会漏 → 批量生成时 skill_prompt 传空(裸生成)
  if (store.taskId && !store.level1Sections.some((s) => s.aiSkill || s.skill_prompt)) {
    void reloadSkillCards();
  }
  // 分析中的 job 恢复(活动 analyze 任务 → 面板续显)
  const recent = await (await import("@/shared/tasks")).listTasks({ module: "workflow", limit: 5 }).catch(() => []);
  const active = recent.find((t) => t.jobKind === "analyze" && ["queued", "running"].includes(t.status) && t.projectId === store.taskId);
  if (active) {
    aiJobId.value = active.id;
    aiThinking.value = true;
    aiStepMsg.value = "正在继续上次的结构化分析...";
    aiPanelOpen.value = true;
    pollAnalyzeJob(active.id);
  }
});
onUnmounted(() => { stopPoll(); stopAiPoll(); });
</script>

<template>
  <div
    class="ws-page-root"
    :data-assistant-async-busy="(generating || aiThinking) ? 'true' : 'false'"
    :data-assistant-async-reason="statusText() !== '就绪' ? statusText() : (aiThinking ? '正在结构化分析' : '')"
  >
    <PhaseProgressBar />
    <div class="workspace-container wf-layout">
    <!-- 左: 章节导航 -->
    <aside class="left-rail">
      <div class="rail-head">
        <strong>章节导航</strong>
        <span class="rail-count">{{ genCount }}/{{ l1List.length }}</span>
      </div>
      <div class="rail-progress"><div class="rail-progress-fill" :style="{ width: progressPct + '%' }"></div></div>
      <div v-if="!l1List.length" class="rail-empty">暂无章节 — 请先完成信息录入与科研架构</div>
      <div v-else class="nav-list">
        <div v-for="(s, i) in l1List" :key="s.id" class="nav-l1" :class="{ active: activeSecId === s.id }" @click="selectSection(s)">
          <div class="nav-row">
            <button class="nav-toggle" @click.stop="toggleExpand(s.id)">{{ isExpanded(s.id) ? "▼" : "▶" }}</button>
            <span class="nav-num">{{ cnOf(i) }}</span>
            <span class="nav-title">{{ s.title || "未命名章节" }}</span>
            <span class="nav-dot" :class="secStatusDot(s).cls" :title="secStatusDot(s).title"></span>
          </div>
          <div v-if="s.content && s.content.length > 50" class="nav-words">{{ s.content.replace(/\s/g, "").length }} 字</div>
          <div v-if="isExpanded(s.id)" class="nav-children">
            <div
              v-for="c in childrenOf(s.id)"
              :key="c.id"
              class="nav-l2"
              :class="{ active: activeSecId === c.id }"
              @click="selectSection(c)"
            >
              <span class="nav-num2">{{ i + 1 }}.{{ childrenOf(s.id).indexOf(c) + 1 }}</span>
              <span class="nav-title">{{ c.title || "未命名子节" }}</span>
              <span class="nav-dot" :class="secStatusDot(c).cls"></span>
            </div>
          </div>
        </div>
      </div>
      <!-- 结构化指导开关(闭源顺序: 章节树**之后**、底部按钮之前)。2026-09-15 修: 原先放在树之上。 -->
      <button v-if="l1List.length" class="workflow-outline-primary" :class="{ on: aiPanelOpen }" @click="aiPanelOpenToggle" data-control="workflow:toggle-ai-panel">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9c.4.3.6.8.7 1.3l.1.8h5.4l.1-.8c.1-.5.3-1 .7-1.3A6 6 0 0012 3z" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        {{ aiPanelOpen ? "关闭结构化指导" : "结构化指导" }}
      </button>
      <div class="rail-footer">
        <!-- 智能全局思考(闭源三态文案: 生成中显示进度 / 全生成完显示"重新生成全部" / 否则"智能全局思考") -->
        <button class="btn-think-all" :disabled="generating" data-control="workflow:generate-all" @click="generateAll">
          {{ generating && generateMode === 'batch'
            ? `生成中 (${genProgress.current ?? 0}/${genProgress.total ?? 0})`
            : l1List.length && pendingCount === 0 ? "重新生成全部" : "智能全局思考" }}
        </button>
        <button class="btn-back-sm" data-control="workflow:back" @click="router.push('/workflow/materials')">返回素材准备</button>
        <!-- 闭源: 未全部完成时不可进入合稿, 文案带未完成章数 -->
        <button
          class="btn-finalize-all"
          :disabled="pendingCount > 0 || generating"
          data-control="workflow:enter-finalize"
          @click="enterFinalize"
        >{{ pendingCount > 0 ? `还有 ${pendingCount} 章未完成` : "进入合并定稿" }}</button>
      </div>
    </aside>

    <!-- 中: 正文区 -->
    <main class="center-main">
      <!-- C2 主控 AI 面板(闭源: 覆盖中央区; 分析中步骤态/完成态变量+逻辑流+写作指导卡/空闲灯泡态) -->
      <div v-if="aiPanelOpen" class="ai-panel">
        <div class="ai-panel-head">
          <span class="ai-panel-title">主控 AI — 结构化分析</span>
          <div class="ai-panel-actions">
            <button v-if="!aiThinking" class="ai-reanalyze" :disabled="generating" @click="runStructuredAnalysis" data-control="workflow:reanalyze">重新分析</button>
            <button class="ai-close" @click="closeAiPanel">关闭</button>
          </div>
        </div>
        <div class="ai-panel-body">
          <!-- 分析中: spinner + 3 步进度 -->
          <div v-if="aiThinking" class="ai-thinking">
            <div class="ai-spin-row">
              <span class="ai-spinner"></span>
              <span>{{ aiStepMsg || "正在分析..." }}</span>
            </div>
            <div class="ai-steps">
              <div v-for="stp in ANALYSIS_STEPS" :key="stp.no" class="ai-step" :class="aiStep > stp.no ? 'done' : aiStep === stp.no ? 'current' : 'todo'">
                <span class="ai-step-mark">{{ aiStep > stp.no ? "✓" : aiStep === stp.no ? String(stp.no) : "·" }}</span>
                <span>{{ stp.label }}</span>
                <span v-if="aiStepDetail && aiStep === stp.no" class="ai-step-detail">{{ aiStepDetail }}</span>
              </div>
            </div>
            <div v-if="store.variables.length" class="ai-partial">
              <div class="ai-partial-label">已识别变量（{{ store.variables.length }} 个）</div>
              <div class="ai-partial-chips">
                <span v-for="v in store.variables" :key="v.name" class="var-mini"><i class="var-dot" :style="{ background: roleColor(v.role) }"></i>{{ v.name }}</span>
              </div>
            </div>
          </div>
          <!-- 完成态: 变量胶囊 + 章节逻辑关系 + 各章节写作指导卡 -->
          <div v-else-if="store.variables.length || store.project.logicFlow || aiDone" class="ai-done">
            <div v-if="store.variables.length" class="done-block">
              <div class="done-label">研究变量（{{ store.variables.length }} 个）</div>
              <div class="done-chips">
                <span v-for="v in store.variables" :key="v.name" class="var-pill">{{ v.name }}({{ v.role }})</span>
              </div>
            </div>
            <div v-if="store.project.logicFlow" class="done-block">
              <div class="logic-label">章节逻辑关系</div>
              <p class="logic-text">{{ store.project.logicFlow }}</p>
            </div>
            <div class="done-block">
              <div class="guide-label">各章节写作指导</div>
              <div v-if="store.sections.filter((s) => s.aiSkill).length" class="guide-cards">
                <div v-for="s in store.sections.filter((x) => x.aiSkill)" :key="s.id" class="guide-card">
                  <div class="guide-head">
                    <span class="guide-title">{{ s.title }}</span>
                    <span class="guide-type">{{ (s.aiSkill as Record<string, unknown>).type }}</span>
                  </div>
                  <p class="guide-goal">{{ String((s.aiSkill as Record<string, unknown>).writingGoal ?? "") }}</p>
                  <div v-if="Array.isArray((s.aiSkill as Record<string, unknown>).keyPoints) && ((s.aiSkill as Record<string, unknown>).keyPoints as unknown[]).length" class="guide-points">
                    <div v-for="(kp, ki) in ((s.aiSkill as Record<string, unknown>).keyPoints as unknown[]).slice(0, 5)" :key="ki" class="guide-point">{{ ki + 1 }}. {{ kp }}</div>
                  </div>
                </div>
              </div>
              <p v-else class="guide-empty">点击「重新分析」为各章节生成写作指导</p>
            </div>
          </div>
          <!-- 空闲灯泡态 -->
          <div v-else class="ai-idle">
            <svg class="ai-bulb" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
            <p class="ai-idle-text">尚未进行结构化分析</p>
            <button class="ai-start" :disabled="busy" @click="runStructuredAnalysis" data-control="workflow:start-analysis">开始分析（变量、框架、写作指导）</button>
          </div>
        </div>
      </div>
      <template v-if="activeSection">
        <div class="sec-head">
          <span class="sec-num-big">{{ cnOf(Math.max(0, activeL1Idx)) }}</span>
          <div class="sec-title-box">
            <h2>{{ activeSection.title }}</h2>
            <div class="sec-chips">
              <span v-for="c in childrenOf(activeSection.id)" :key="c.id" class="chip">{{ c.title }}</span>
            </div>
          </div>
          <div class="sec-actions">
            <button
              v-if="activeSection.content && activeSection.content.length > 50"
              class="btn-edit"
              data-control="workflow:section-to-editor"
              @click="sendSectionToEditor"
            >送编辑器</button>
          </div>
        </div>

        <!-- 主控智能体思考(闭源: 可编辑 textarea, 预填本章写作指导) -->
        <div class="think-block">
          <div class="think-head">
            <label class="think-label">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9c.4.3.6.8.7 1.3l.1.8h5.4l.1-.8c.1-.5.3-1 .7-1.3A6 6 0 0012 3z" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              主控智能体思考
            </label>
            <span class="think-hint">主控智能体思考而成，可手动补充修改</span>
          </div>
          <textarea
            v-model="thinkPrompt"
            class="think-input"
            rows="3"
            placeholder="本章的写作思路…(留空则用系统生成的写作指导)"
            data-control="workflow:section-think"
          ></textarea>
        </div>

        <!-- 生成控制(闭源: 状态胶囊 + 执行/取消/重新思考并排) -->
        <div class="gen-block">
          <div class="gen-title-row">
            <h4>{{ activeSection.title }}</h4>
            <span class="sec-status-pill" :class="genPill.cls">{{ genPill.text }}</span>
          </div>
          <div class="gen-btn-row">
            <button
              v-if="!generating"
              class="btn-gen-main"
              data-control="workflow:generate-section"
              @click="generateSection"
            >{{ secHasContent ? "重新思考" : "执行智能体开始思考" }}</button>
            <template v-else>
              <button class="btn-gen-main" disabled>
                <span class="mini-spinner"></span>正在思考...
              </button>
              <button class="btn-gen-cancel" data-control="workflow:stop-generation" @click="stopGeneration">取消</button>
            </template>
          </div>
        </div>

        <!-- 正文: 编辑 / 预览 双 tab(闭源 MarkdownEditor 形态) -->
        <div class="md-block">
          <div class="md-tabs" role="tablist">
            <button
              class="md-tab" :class="{ on: mdTab === 'write' }" role="tab" :aria-pressed="mdTab === 'write'"
              data-control="workflow:md-write" @click="mdTab = 'write'"
            >编辑</button>
            <button
              class="md-tab" :class="{ on: mdTab === 'preview' }" role="tab" :aria-pressed="mdTab === 'preview'"
              data-control="workflow:md-preview" @click="mdTab = 'preview'"
            >预览</button>
          </div>
          <div class="editor-area">
            <textarea v-if="mdTab === 'write'" v-model="editText" class="content-textarea" placeholder="章节正文…"></textarea>
            <div v-else class="content-view markdown-body">
              <p v-if="!activeSection.content" class="content-empty">
                该章节尚未生成正文 — 点击上方「执行智能体开始思考」生成内容。
              </p>
              <div v-else class="content-html" v-html="activeContentHtml"></div>
            </div>
          </div>
          <div class="md-foot">
            <span>{{ activeWords }} 字</span>
            <span class="md-save-state">{{ editDirty ? "未保存" : "已同步" }}</span>
            <button v-if="mdTab === 'write' && editDirty" class="btn-save" data-control="workflow:save-section" @click="saveEdit">保存修改</button>
          </div>
          <!-- V417: 生成时后端正则抽取的结论/数据/论点/遗留 —— 原先存了但从没显示过 -->
          <details v-if="summaryBlocks.length" class="summary-box">
            <summary>写作要点速览（自动抽取）</summary>
            <div v-for="b in summaryBlocks" :key="b.title" class="summary-block">
              <strong>{{ b.title }}</strong>
              <p>{{ b.body }}</p>
            </div>
          </details>
        </div>
      </template>
      <div v-else class="center-empty">
        <p>← 从左侧选择章节开始创作</p>
      </div>
    </main>
    <!-- 右: 素材卡 -->
    <aside class="right-rail">
      <div class="rail-head">
        <strong>素材库</strong>
        <div class="rail-head-right">
          <span class="rail-count">{{ materials.length }}</span>
          <button class="mat-gen-btn" :disabled="busy" @click="openGenDlg" data-control="workflow:open-gen-dialog">＋ 生成</button>
        </div>
      </div>
      <!--
        素材分类筛选项 —— 与闭源同语义(全部/理论/数据/案例/方法/文献), 但取值走 `cat` 这个
        **归一化后**的键, 不是原始 kind。
        2026-09-16 修: 原先直接拿原始 kind 值当 option value(`data_result`/`figure`/`file`),
        有两个问题 ——
          ① 后端真实写入的 kind 有 `figure`(图片上传/图表导入)与 `file`(附件), 但它们**不在**
             WorkspaceView 的 MATERIAL_KINDS 里(见下), 选中即恒空列表;
          ② 与素材页手风琴用的同一类素材, 两处分类口径不一致。
        现在筛选项值走 `catOfKind()` 归一化, 保证"选得出但筛不出"不可能发生。
      -->
      <select v-model="materialFilter" class="mat-filter">
        <option value="all">全部素材</option>
        <option value="theory">理论</option>
        <option value="data">数据</option>
        <option value="case">案例</option>
        <option value="method">方法</option>
        <option value="citation">文献</option>
      </select>
      <div v-if="!filteredMaterials.length" class="rail-empty">
        <p>暂无素材</p>
        <p class="rail-empty-sub">点击上方「生成」按钮创建</p>
      </div>
      <div v-else class="mat-scroll">
        <div v-for="m in filteredMaterials" :key="String(m.id ?? m.title)" class="mat-mini">
          <!-- 顶色条(闭源按类型 9 色) -->
          <div class="mat-mini-bar" :style="{ background: kindColor(String(m.kind ?? '')) }"></div>
          <div class="mat-mini-inner">
            <span class="mat-mini-icon" :style="{ background: kindBg(String(m.kind ?? '')) }">{{ kindIcon(String(m.kind ?? '')) }}</span>
            <div class="mat-mini-body">
              <strong>{{ String(m.title ?? "未命名素材").slice(0, 30) }}</strong>
              <div class="mat-mini-meta">
                <span class="mat-kind-pill" :style="{ background: kindBg(String(m.kind ?? '')), color: kindColor(String(m.kind ?? '')) }">{{ kindLabel(String(m.kind ?? "")) }}</span>
                <span class="mat-mini-words">{{ matWords(m) }} 字</span>
                <span v-if="matLinked(m)" class="mat-linked" title="已关联到章节">
                  <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" /></svg>已关联
                </span>
              </div>
            </div>
            <!-- hover 才出现的插入/删除(闭源 group-hover) -->
            <div class="mat-mini-ops">
              <button class="mat-op-icon" title="插入到章节" data-control="workflow:insert-material" @click="insertMaterialContent(m)">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" stroke-linecap="round" /></svg>
              </button>
              <button class="mat-op-icon danger" title="从素材库移除" data-control="workflow:remove-material" @click="removeMaterialFromLib(m)">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" /></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="rail-footer-col">
        <button v-if="generating && generateMode === 'batch'" class="btn-rollback" @click="rollbackBatch" data-control="workflow:rollback-batch">全部回滚</button>
        <button v-if="generating && generateMode === 'batch' && genProgress.current" class="btn-rollback-keep" @click="rollbackBatchKeep" data-control="workflow:rollback-keep">回滚本次成功 ({{ genProgress.current }})</button>
      </div>
    </aside>

    <!-- C3 素材生成弹窗(Teleport; 类型 select + 生成要求 + 流式结果 + 保存) -->
    <Teleport to="body">
      <div v-if="genDlg.open" class="modal-mask" @click.self="closeGenDlg">
        <div class="modal-card">
          <h3 class="modal-title">生成素材</h3>
          <div class="modal-body">
            <div class="f-row">
              <label class="f-label">素材类型</label>
              <select v-model="genDlg.type" class="f-input">
                <option v-for="t in GEN_TYPES" :key="t.key" :value="t.key">{{ t.label }}</option>
              </select>
            </div>
            <div class="f-row">
              <label class="f-label">生成要求</label>
              <textarea v-model="genDlg.prompt" rows="3" class="f-textarea" placeholder="描述需要生成的素材内容..."></textarea>
            </div>
            <p v-if="genDlg.err" class="gen-err">⚠ {{ genDlg.err }}</p>
            <div class="gen-actions">
              <button class="gen-run" :disabled="genDlg.busy || !genDlg.prompt.trim()" @click="runMaterialGen" data-control="workflow:run-material-gen">
                {{ genDlg.busy ? "思考中..." : "执行智能体开始思考" }}
              </button>
              <button class="gen-cancel" @click="closeGenDlg">取消</button>
            </div>
            <!-- 流式结果预览 -->
            <div v-if="genDlg.preview" class="gen-result">
              <pre class="gen-result-body">{{ genDlg.preview }}</pre>
              <button class="gen-save" @click="saveGenMaterial" data-control="workflow:save-material">保存到素材库</button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
    </div>
  </div>
</template>

<style scoped>
/* 闭源 .app-root--workspace{height:100vh;height:100dvh} —— 后者覆盖前者;
   移动端地址栏收起时 100vh 大于可视高度, 底栏会被推出视口 */
.ws-page-root { height: 100vh; height: 100dvh; width: 100%; max-width: 100%; display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box; }
.wf-layout { display: flex; gap: 0; flex: 1; min-height: 0; }
/* 闭源两栏都是 `w-72`(288px) —— 我方原左 260 / 右 240, 各窄 28/48px */
.left-rail {
  width: 288px; flex-shrink: 0; border-right: 1px solid #222F44;
  display: flex; flex-direction: column; background: #11192C; overflow-y: auto;
}
.rail-head { display: flex; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #212C45; }
.rail-head strong { font-size: 13.5px; color: #E8EEF7; }
.rail-count { font-size: 11px; color: #7A8AA0; background: #212C45; padding: 2px 8px; border-radius: 9px; }
/* 左栏进度条(闭源 h-1.5 圆角) */
.rail-progress { height: 6px; background: #212C45; border-radius: 999px; overflow: hidden; }
.rail-progress-fill { height: 100%; background: #dc2626; border-radius: 999px; transition: width 0.4s; }
.rail-empty { padding: 26px 14px; text-align: center; color: #7A8AA0; font-size: 12px; }
.nav-list { flex: 1; padding: 6px; overflow-y: auto; }
.nav-l1 { border-radius: 7px; padding: 5px 7px; cursor: pointer; }
.nav-l1:hover { background: #1A2333; }
.nav-l1.active { background: #2A1C1C; border-left: 2px solid #dc2626; }
.nav-row { display: flex; align-items: center; gap: 6px; }
.nav-toggle { width: 16px; height: 16px; border: 0; background: none; color: #7A8AA0; font-size: 8px; cursor: pointer; padding: 0; }
.nav-num {
  width: 20px; height: 20px; border-radius: 5px; background: #dc2626; color: #F1F5F9;
  display: grid; place-items: center; font-size: 11px; font-weight: 600; flex-shrink: 0;
}
.nav-title { flex: 1; font-size: 12.5px; color: #DCE6F2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-dot { width: 7px; height: 7px; border-radius: 50%; background: #222F44; flex-shrink: 0; }
.nav-dot.dot-done { background: #5FD0B4; }
.nav-dot.dot-generating { background: #E8B54A; animation: blink 1.2s infinite; }
@keyframes blink { 50% { opacity: 0.3; } }
.nav-words { font-size: 10.5px; color: #7A8AA0; padding-left: 28px; }
.nav-children { padding-left: 22px; }
.nav-l2 { display: flex; align-items: center; gap: 5px; padding: 3px 5px; border-radius: 5px; cursor: pointer; font-size: 12px; }
.nav-l2:hover { background: #212C45; }
.nav-l2.active { background: #2A1C1C; }
.nav-num2 { color: #8B9BB1; font-size: 10.5px; min-width: 28px; }
.rail-footer { padding: 10px; border-top: 1px solid #212C45; display: flex; flex-direction: column; gap: 7px; }
.btn-back-sm { border: 0; background: #1A2333; color: #8B9BB1; padding: 7px; border-radius: 7px; font-size: 12px; cursor: pointer; text-align: left; }
.btn-primary-sm {
  border: 0; background: #1e293b; color: #F1F5F9; padding: 8px; border-radius: 7px;
  font-size: 12.5px; font-weight: 600; cursor: pointer;
}
/*
 * 中央列 —— 闭源是 `flex-1 overflow-y-auto` + 内容 `max-w-4xl mx-auto px-8 py-6`。
 * 2026-09-16 修: 我方原先只有 padding, **没有 max-width 约束** —— 宽屏下正文行宽拉满,
 *   中文长行极难读(闭源用 896px 上限 + 居中)。
 */
.center-main { flex: 1; min-width: 0; display: flex; flex-direction: column; background: #11192C; padding: 16px 24px; overflow-y: auto; }
.center-main > * { width: 100%; max-width: 896px; margin-left: auto; margin-right: auto; }
.sec-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
.sec-num-big {
  width: 30px; height: 30px; border-radius: 7px; background: #dc2626; color: #F1F5F9;
  display: grid; place-items: center; font-size: 14px; font-weight: 700; flex-shrink: 0; margin-top: 2px;
}
.sec-title-box { flex: 1; min-width: 0; }
.sec-title-box h2 { margin: 0 0 5px; font-size: 17px; color: #E8EEF7; }
.sec-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip {
  font-size: 10.5px; padding: 2px 9px; background: #212C45; color: #8B9BB1; border-radius: 9px;
}
.sec-actions { display: flex; gap: 7px; flex-shrink: 0; }
.btn-edit, .btn-save {
  padding: 6px 12px; border: 1px solid #222F44; border-radius: 7px; background: #11192C;
  color: #8B9BB1; font-size: 12px; cursor: pointer;
}
.btn-save { border-color: #2B4A73; color: #6FA8F5; }
.editor-area { flex: 1; min-height: 0; display: flex; }
.content-textarea {
  flex: 1; resize: none; border: 1px solid #222F44; border-radius: 10px; padding: 14px;
  font-size: 14px; line-height: 1.9; font-family: inherit;
}
.content-view { flex: 1; overflow-y: auto; }
.content-empty { padding: 60px 20px; text-align: center; color: #7A8AA0; font-size: 13px; }
/* 渲染后的正文: 版口与编辑态一致, 表格/引用等由全局 .markdown-body 接管 */
.content-html { padding: 8px 4px; font-size: 14px; line-height: 1.9; color: #E8EEF7; }
.content-html :deep(> :first-child) { margin-top: 0; }
.center-empty { display: grid; place-items: center; height: 100%; color: #7A8AA0; font-size: 14px; }
.summary-box {
  margin: 10px 0 0; border: 1px solid #222F44; border-radius: 8px;
  background: #11192C; padding: 8px 12px;
}
.summary-box summary { cursor: pointer; font-size: 12.5px; color: #8B9BB1; }
.summary-block { margin-top: 8px; }
.summary-block strong { display: block; font-size: 12px; color: #5FD0B4; margin-bottom: 3px; }
.summary-block p { margin: 0; font-size: 12.5px; line-height: 1.7; color: #C7D2E0; white-space: pre-wrap; }
.right-rail {
  width: 288px; flex-shrink: 0; border-left: 1px solid #222F44;
  display: flex; flex-direction: column; background: #141E33;
}
.mat-filter { margin: 8px 10px; padding: 5px 8px; border: 1px solid #222F44; border-radius: 7px; font-size: 12px; background: #11192C; }
.mat-scroll { flex: 1; overflow-y: auto; padding: 0 8px; display: flex; flex-direction: column; gap: 6px; }
.mat-mini {
  position: relative; overflow: hidden; padding: 0;
  background: #11192C; border: 1px solid #212C45; border-radius: 9px;
}
.mat-mini:hover { border-color: #B06A6A; box-shadow: 0 2px 8px rgba(220, 38, 38, 0.05); }
/* 顶色条(按素材类型 9 色) */
.mat-mini-bar { height: 3px; width: 100%; }
.mat-mini-inner { display: flex; align-items: flex-start; gap: 8px; padding: 9px 10px; }
.mat-mini-icon {
  width: 26px; height: 26px; border-radius: 7px; flex-shrink: 0;
  display: grid; place-items: center; font-size: 13px;
}
.mat-mini-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.mat-mini-body strong { font-size: 11.5px; color: #E8EEF7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mat-mini-meta { display: flex; align-items: center; gap: 6px; font-size: 10px; color: #7A8AA0; flex-wrap: wrap; }
.mat-kind-pill { padding: 1px 6px; border-radius: 7px; font-size: 9.5px; font-weight: 600; }
.mat-mini-words { color: #7A8AA0; }
.mat-linked { display: inline-flex; align-items: center; gap: 2px; color: #E8B54A; }
/* 插入/删除:hover 才出现(闭源 group-hover:opacity-100) */
.mat-mini-ops {
  display: flex; flex-direction: column; gap: 3px; flex-shrink: 0;
  opacity: 0; transition: opacity 0.15s;
}
.mat-mini:hover .mat-mini-ops { opacity: 1; }
.mat-op-icon {
  width: 22px; height: 22px; display: grid; place-items: center;
  border: 0; border-radius: 6px; background: transparent; color: #8B9BB1; cursor: pointer;
}
.mat-op-icon:hover { background: #212C45; color: #E8EEF7; }
.mat-op-icon.danger:hover { background: #2A1C1C; color: #dc2626; }
.rail-footer-col { padding: 9px; border-top: 1px solid #222F44; display: flex; flex-direction: column; gap: 6px; }
.btn-rollback-keep {
  padding: 6px; border: 1px solid #1E3A5F; border-radius: 7px; background: #0F2137;
  color: #6FA8F5; font-size: 11.5px; cursor: pointer;
}

/* 主控智能体思考(可编辑) */
.think-block { margin-bottom: 14px; }
.think-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 5px; }
.think-label { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; color: #6FA8F5; }
.think-hint { font-size: 11px; color: #7A8AA0; }
.think-input {
  width: 100%; box-sizing: border-box; padding: 9px 12px;
  border: 1px solid #222F44; border-radius: 9px; background: #0E1729;
  color: #DCE6F2; font-size: 12.5px; line-height: 1.65; font-family: inherit;
  outline: none; resize: none;
}
.think-input:focus { border-color: #4B5E8C; }

/* 生成控制(状态胶囊 + 按钮并排) */
.gen-block { margin-bottom: 14px; }
.gen-title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.gen-title-row h4 { margin: 0; font-size: 13.5px; font-weight: 600; color: #E8EEF7; }
.sec-status-pill { font-size: 10.5px; padding: 2px 10px; border-radius: 10px; font-weight: 600; }
.pill-pending { background: #1A2333; color: #A8B4C4; }
.pill-generating { background: #33240F; color: #E8B54A; }
.pill-done { background: #14291F; color: #5FD0B4; }
.gen-btn-row { display: flex; gap: 8px; }
.btn-gen-main {
  flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  padding: 9px 16px; border: 0; border-radius: 9px; background: #1e293b;
  color: #F1F5F9; font-size: 13px; font-weight: 500; cursor: pointer;
}
.btn-gen-main:hover:not(:disabled) { background: #334155; }
.btn-gen-main:disabled { opacity: 0.75; cursor: default; }
.btn-gen-cancel {
  padding: 9px 18px; border-radius: 9px; background: #11192C;
  border: 1px solid #dc2626; color: #E88A8A; font-size: 13px; cursor: pointer;
}
.btn-gen-cancel:hover { background: #2A1C1C; }

/* 编辑/预览双 tab */
.md-block { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.md-tabs { display: inline-flex; border: 1px solid #222F44; border-radius: 9px; overflow: hidden; width: fit-content; margin-bottom: 8px; }
.md-tab {
  padding: 6px 16px; border: 0; background: #0E1729; color: #8B9BB1;
  font-size: 12px; font-weight: 500; cursor: pointer;
}
.md-tab + .md-tab { border-left: 1px solid #222F44; }
.md-tab.on { background: #1e293b; color: #F1F5F9; }
.md-foot { display: flex; align-items: center; gap: 10px; margin-top: 6px; font-size: 11.5px; color: #7A8AA0; }
.md-save-state { color: #7A8AA0; }
.md-foot .btn-save { margin-left: auto; }
/* 结构化指导开关(闭源 workflow-outline-primary: 白底蓝边) */
.workflow-outline-primary {
  width: calc(100% - 12px); margin: 0 6px 8px; padding: 7px 10px;
  display: flex; align-items: center; gap: 7px;
  border: 1px solid #2B4A73; border-radius: 8px; background: #0E1729;
  color: #6FA8F5; font-size: 12px; font-weight: 500; cursor: pointer;
  flex-shrink: 0;
}
.workflow-outline-primary:hover { background: #16243F; border-color: #4B7BB5; }
.workflow-outline-primary.on { background: #16243F; border-color: #4B7BB5; color: #9CC5F5; }
/* 左栏三态底部按钮 */
.btn-think-all {
  padding: 8px; border: 0; border-radius: 7px; background: #1e293b; color: #F1F5F9;
  font-size: 12px; font-weight: 500; cursor: pointer;
}
.btn-think-all:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-finalize-all {
  padding: 8px; border: 0; border-radius: 7px; background: #dc2626; color: #F1F5F9;
  font-size: 12px; font-weight: 600; cursor: pointer;
}
.btn-finalize-all:disabled { background: #212C45; color: #7A8AA0; cursor: not-allowed; }
.mini-spinner {
  width: 12px; height: 12px; border: 2px solid #46587A; border-top-color: #F1F5F9;
  border-radius: 50%; display: inline-block; animation: mspin 0.8s linear infinite;
}
@keyframes mspin { to { transform: rotate(360deg); } }
.btn-batch {
  padding: 8px; border: 0; border-radius: 7px; background: #1e293b; color: #F1F5F9;
  font-size: 12px; font-weight: 600; cursor: pointer;
}
.btn-batch:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-rollback {
  padding: 6px; border: 1px solid #3A2323; border-radius: 7px; background: #2A1C1C;
  color: #dc2626; font-size: 11.5px; cursor: pointer;
}

/* C2 主控 AI — 结构化分析面板 */
.rail-ai-toggle {
  width: 100%; margin: 0 0 6px; padding: 7px 10px; border: 1px solid #222F44;
  border-radius: 8px; background: #11192C; color: #8B9BB1; font-size: 12px;
  font-weight: 500; cursor: pointer; text-align: left;
}
.rail-ai-toggle:hover { border-color: #B06A6A; }
.rail-ai-toggle.on { background: #2A1C1C; border-color: #B06A6A; color: #dc2626; }
.ai-panel {
  position: absolute; inset: 0; z-index: 20; background: #1A2333;
  display: flex; flex-direction: column; overflow: hidden;
}
.ai-panel-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 13px 18px; border-bottom: 1px solid #222F44; background: #11192C;
}
.ai-panel-title { font-size: 14px; font-weight: 600; color: #DCE6F2; }
.ai-panel-actions { display: flex; align-items: center; gap: 12px; }
.ai-reanalyze { font-size: 12px; color: #DCE6F2; border: 0; background: #212C45; padding: 4px 10px; border-radius: 6px; cursor: pointer; }
.ai-reanalyze:disabled { opacity: 0.5; cursor: not-allowed; }
.ai-close { font-size: 12px; color: #8B9BB1; border: 0; background: none; cursor: pointer; }
.ai-close:hover { color: #8B9BB1; }
.ai-panel-body { flex: 1; overflow-y: auto; padding: 18px 22px; }
.ai-spin-row { display: flex; align-items: center; gap: 10px; font-size: 13px; color: #DCE6F2; margin-bottom: 14px; }
.ai-spinner {
  width: 20px; height: 20px; border: 2.5px solid #94a3b8; border-top-color: transparent;
  border-radius: 50%; animation: aispin 0.8s linear infinite; flex-shrink: 0;
}
@keyframes aispin { to { transform: rotate(360deg); } }
.ai-steps { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.ai-step {
  display: flex; align-items: center; gap: 8px; font-size: 12.5px;
  padding: 9px 13px; border-radius: 9px; border: 1px solid;
}
.ai-step.done { background: #14281F; border-color: #2E5C46; color: #15803d; }
.ai-step.current { background: #2A1C1C; border-color: #3A2323; color: #E06B6B; }
.ai-step.todo { background: #1A2333; border-color: #222F44; color: #8B9BB1; }
.ai-step-mark {
  width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center;
  font-size: 11px; background: currentColor; color: #F1F5F9; flex-shrink: 0;
}
.ai-step.done .ai-step-mark { background: #16a34a; }
.ai-step.current .ai-step-mark { background: #dc2626; }
.ai-step.todo .ai-step-mark { background: transparent; color: inherit; border: 1px solid #46587A; }
.ai-step-detail { margin-left: auto; font-size: 11px; opacity: 0.8; }
.ai-partial { border-top: 1px dashed #222F44; padding-top: 12px; }
.ai-partial-label { font-size: 12px; font-weight: 600; color: #DCE6F2; margin-bottom: 8px; }
.ai-partial-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.var-mini { font-size: 12px; color: #2563eb; display: inline-flex; align-items: center; gap: 5px; }
.var-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.ai-done { display: flex; flex-direction: column; gap: 16px; }
.done-block { display: flex; flex-direction: column; gap: 6px; }
.done-label { font-size: 13px; font-weight: 600; color: #DCE6F2; }
.done-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.var-pill { font-size: 12px; padding: 3px 10px; background: #1C3A2C; color: #15803d; border-radius: 8px; }
.logic-label { font-size: 12.5px; font-weight: 600; color: #E8B54A; }
.logic-text { margin: 0; font-size: 12.5px; color: #DCE6F2; line-height: 1.7; }
.guide-label { font-size: 13px; font-weight: 600; color: #8B9BB1; }
.guide-cards { display: flex; flex-direction: column; gap: 9px; }
.guide-card { padding: 12px 14px; background: #11192C; border: 1px solid #222F44; border-radius: 10px; }
.guide-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; gap: 10px; }
.guide-title { font-size: 13px; font-weight: 600; color: #E8EEF7; }
.guide-type {
  font-size: 10px; color: #dc2626; background: #2A1C1C; padding: 1.5px 8px; border-radius: 8px; flex-shrink: 0;
}
.guide-goal { margin: 0; font-size: 12px; color: #8B9BB1; line-height: 1.6; }
.guide-points { margin-top: 6px; display: flex; flex-direction: column; gap: 2px; }
.guide-point { font-size: 11px; color: #8B9BB1; }
.guide-empty { font-size: 12px; color: #7A8AA0; }
.ai-idle { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; height: 100%; min-height: 260px; }
.ai-bulb { width: 48px; height: 48px; color: #222F44; margin-bottom: 8px; }
.ai-idle-text { font-size: 14px; color: #8B9BB1; margin-bottom: 14px; }
.ai-start {
  padding: 9px 18px; border: 0; border-radius: 8px; background: #dc2626; color: #F1F5F9;
  font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.ai-start:disabled { background: #46587A; cursor: not-allowed; }
.center-main { position: relative; }

/* C3 素材生成弹窗 + C4 字数徽标 */
.rail-head-right { display: flex; align-items: center; gap: 7px; }
.mat-gen-btn {
  border: 1px solid #9bb8d8; background: #11192C; color: #759FD7;
  font-size: 11px; padding: 2px 9px; border-radius: 7px; cursor: pointer;
}
.mat-gen-btn:hover { background: #161F33; }
.mat-gen-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.rail-empty-sub { font-size: 11px; color: #46587A; margin: 3px 0 0; }
.modal-mask { position: fixed; inset: 0; z-index: 90; /* 2026-09-16: 深色主题下 20% 黑几乎不可见, 弹层与页面无分离感(闭源是浅色底所以 20% 够用) */
  background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; }
.modal-card { width: 480px; max-width: 94vw; background: #11192C; border-radius: 14px; padding: 18px 22px; box-shadow: 0 20px 60px rgba(15, 23, 42, 0.25); }
.modal-title { margin: 0 0 14px; font-size: 17px; font-weight: 700; color: #E8EEF7; }
.modal-body { display: flex; flex-direction: column; gap: 13px; }
.f-row { display: flex; flex-direction: column; gap: 5px; }
.f-label { font-size: 13px; font-weight: 600; color: #DCE6F2; }
.f-input { padding: 8px 12px; border: 1px solid #46587A; border-radius: 8px; font-size: 13px; }
.f-textarea { padding: 8px 12px; border: 1px solid #46587A; border-radius: 8px; font-size: 13px; font-family: inherit; resize: vertical; }
.gen-err { margin: 0; font-size: 12px; color: #dc2626; }
.gen-actions { display: flex; gap: 10px; }
.gen-run {
  flex: 1; padding: 9px 0; border: 0; border-radius: 8px; background: #dc2626;
  color: #F1F5F9; font-size: 13px; font-weight: 600; cursor: pointer;
}
.gen-run:disabled { background: #46587A; cursor: not-allowed; }
.gen-cancel { padding: 9px 18px; border: 1px solid #46587A; border-radius: 8px; background: #11192C; color: #8B9BB1; font-size: 13px; cursor: pointer; }
.gen-result { border-top: 1px solid #212C45; padding-top: 12px; display: flex; flex-direction: column; gap: 9px; }
.gen-result-body {
  margin: 0; padding: 11px 13px; background: #1A2333; border: 1px solid #222F44; border-radius: 8px;
  font-family: inherit; font-size: 12.5px; color: #DCE6F2; line-height: 1.7;
  white-space: pre-wrap; max-height: 200px; overflow-y: auto;
}
.gen-save {
  width: 100%; padding: 8px 0; border: 0; border-radius: 8px; background: #16a34a;
  color: #F1F5F9; font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.sec-words {
  font-size: 11px; color: #5FD0B4; background: #14281F; border: 1px solid #2E5C46;
  padding: 4px 10px; border-radius: 8px; align-self: center;
}
</style>

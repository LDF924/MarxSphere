<script setup lang="ts">
/**
 * LibraryHome 审稿库 — 还原自闭源 LibraryHome-CugeBZHb.js(L:1924-2089) + 期刊/标准子组件
 * tab: 期刊库/标准库; 期刊: 列表(搜索/分类筛选)+新增/AI 智能解析投稿须知(前端正则 6 类归槽)
 * 标准: 列表(维度/准则计数/默认+内置徽标)+新增/编辑(维度行)
 */
import { ref, computed, onMounted } from "vue";
import { listJournals, createJournal, deleteJournal, updateJournal, listStandards, createStandard, updateStandard, deleteStandard, setDefaultStandard, parseJournalText, parseSubmissionGuideLocally, parseStandardText, parseStandardLocally, batchParseJournals, splitPreviewJournalText, getReviewStats, reparseJournalRules } from "./reviewApi";
import type { JournalRecord, StandardRecord, BatchParseResult, ReviewStats } from "./reviewApi";
import { toast, confirmDialog } from "@/shared/ui";

// ── 期刊库 ──
const journals = ref<JournalRecord[]>([]);
const journalSearch = ref("");
const journalFilter = ref("全部");
const activeTab = ref<"journal" | "standard">("journal");
const journalTab = ref<"list" | "parse" | "batch" | "compare" | "create" | "edit">("list");
const journalForm = ref<JournalRecord>({ name: "", category: "", structuredRules: {} });
const journalEditId = ref<string | null>(null);
const parsing = ref(false);
const parseSource = ref("");
const saveLoading = ref(false);

// ── 批量补规则(2026-09-12) ── 期刊全库 80 本里配了规则的几乎为 0, 一本一本粘是纯苦力。
//    这里一次粘多刊, 先切分预览(不烧 token)确认切得对, 再逐刊 AI 解析入库。
const batchSource = ref("");
const batchOverwrite = ref(false);
const batchSplitting = ref(false);
const batchRunning = ref(false);
const batchBlocks = ref<Array<{ name: string; chars: number; preview: string }>>([]);
const batchResult = ref<BatchParseResult | null>(null);

// ── 期刊对比(2026-09-12) ── 投稿选刊时最需要的是"几本并排看要求差异"
const compareIds = ref<string[]>([]);

// ── 使用统计反哺(2026-09-12) ── 卡片上的 useCount 只说"用得多不多", 说不出
//    "用它审出来多少分、常出哪类问题"。统计口径见后端 reviewStats 注释。
const stats = ref<ReviewStats | null>(null);
const statsOpen = ref(false);
const SEVERITY_LABEL: Record<string, string> = { major: "重大问题", minor: "次要问题", suggestion: "建议" };
async function loadStats() {
  try { stats.value = await getReviewStats(); } catch { stats.value = null; }
}
/** 严重度条: 按最大值归一算宽度(比例条不需要绝对刻度) */
function sevPct(n: number): number {
  const list = stats.value?.overall.severity ?? [];
  const max = Math.max(1, ...list.map((s) => s.count));
  return Math.round((n / max) * 100);
}

const CATEGORIES = ["CSSCI", "北大核心", "SCI", "SSCI", "学位论文", "普通期刊", "其他"];
/** 库分级 → 面板分类: 后端叫 level, 面板下拉叫 category, 取值也不一致("北核" vs "北大核心") */
const LEVEL_TO_CATEGORY: Record<string, string> = {
  // 期刊全库(cjournal_journals)用的是简称, 面板分类用完整名 —— 必须都映射到 CATEGORIES 里存在的值,
  // 否则该刊在分类下拉里永远是"没有这个分类"(既筛不出来, 计数也不计它)
  "南核": "CSSCI", "北核": "北大核心", "C扩": "CSSCI", "C刊": "CSSCI",
  "CSSCI": "CSSCI", "北大核心": "北大核心", "SCI": "SCI", "SSCI": "SSCI",
  "AMI": "CSSCI", "WJCI": "SCI", "学位论文": "学位论文", "普通期刊": "普通期刊",
};
function journalCategory(j: JournalRecord): string {
  const raw = String(j.category ?? j.level ?? "").trim();
  return LEVEL_TO_CATEGORY[raw] ?? raw;
}
const journalSort = ref<"name" | "useCount" | "rules">("useCount");
const filteredJournals = computed(() => {
  const list = journals.value.filter((j) => {
    const kw = journalSearch.value.trim().toLowerCase();
    if (kw && !(j.name ?? "").toLowerCase().includes(kw) && !journalCategory(j).toLowerCase().includes(kw)) return false;
    if (journalFilter.value !== "全部" && journalCategory(j) !== journalFilter.value) return false;
    return true;
  });
  // 排序: 默认按使用频次(常用的排前面, 免得每次翻找); 规则完备度次之
  const ruleCount = (j: JournalRecord) => rulesBadge(j.structuredRules).length;
  return [...list].sort((a, b) => {
    if (journalSort.value === "name") return String(a.name ?? "").localeCompare(String(b.name ?? ""), "zh-CN");
    if (journalSort.value === "rules") return ruleCount(b) - ruleCount(a);
    return (b.useCount ?? 0) - (a.useCount ?? 0) || ruleCount(b) - ruleCount(a);
  });
});
/** 分类计数: 让筛选器带上数量, 不用点进去才知道有没有 */
const categoryCounts = computed(() => {
  const m = new Map<string, number>();
  for (const j of journals.value) {
    const c = journalCategory(j) || "其他";
    m.set(c, (m.get(c) ?? 0) + 1);
  }
  return m;
});
/** 库概览: 顶部统计条用 */
const journalStats = computed(() => {
  const total = journals.value.length;
  const configured = journals.value.filter((j) => rulesBadge(j.structuredRules).length > 0).length;
  const verified = journals.value.filter((j) => j.isVerified).length;
  return { total, configured, verified, unconfigured: total - configured };
});
/**
 * 规则覆盖率 + 未配规则清单。
 * 由来(2026-09-12): 统计条原来只有"待补规则 80"这个裸数字, 用户不知道该补哪几本、从哪下手。
 *   这里把数字变成"进度 + 可直接开补的清单", 批量补规则按它排序(按分级/名称, 便于一次粘一批)。
 */
const coverage = computed(() => {
  const total = journals.value.length || 1;
  const pct = Math.round((journalStats.value.configured / total) * 100);
  const missing = journals.value
    .filter((j) => rulesBadge(j.structuredRules).length === 0)
    .sort((a, b) => journalCategory(a).localeCompare(journalCategory(b), "zh-CN")
      || String(a.name ?? "").localeCompare(String(b.name ?? ""), "zh-CN"));
  return { pct, missing, hasMissing: journalStats.value.unconfigured > 0 };
});

async function doBatchSplit() {
  if (!batchSource.value.trim()) return;
  batchSplitting.value = true;
  try {
    const r = await splitPreviewJournalText(batchSource.value);
    batchBlocks.value = r.blocks ?? [];
    // 一块 = 一刊: 让用户知道"我粘的这一大段会被当成几本刊"
    if (!batchBlocks.value.length) toast("没切出内容, 请检查粘贴的文本", "warning");
  } catch (e) {
    toast(`切分预览失败: ${(e as Error).message}`, "error");
  } finally {
    batchSplitting.value = false;
  }
}

async function doBatchParse() {
  if (!batchSource.value.trim()) return;
  batchRunning.value = true;
  batchResult.value = null;
  try {
    const r = await batchParseJournals(batchSource.value, batchOverwrite.value);
    batchResult.value = r;
    const s = r.summary;
    toast(s.ok > 0 ? `解析完成: 成功 ${s.ok} 本(新建 ${s.created}), 失败 ${s.failed} 本` : "全部失败, 请看下面的逐条原因",
      s.ok > 0 ? "success" : "error");
    await loadJournals();
  } catch (e) {
    toast(`批量解析失败: ${(e as Error).message}`, "error");
  } finally {
    batchRunning.value = false;
  }
}

function openBatch() {
  batchSource.value = "";
  batchBlocks.value = [];
  batchResult.value = null;
  batchOverwrite.value = false;
  journalTab.value = "batch";
}

// ── 期刊对比 ──
function toggleCompare(j: JournalRecord) {
  const id = j.id ?? j.name ?? "";
  const i = compareIds.value.indexOf(id);
  if (i >= 0) { compareIds.value.splice(i, 1); return; }
  // 上限 3 本: 再多列宽就挤成豆腐块, 反而看不出差异
  if (compareIds.value.length >= 3) { toast("最多同时对比 3 本", "warning"); return; }
  compareIds.value.push(id);
}
const compareJournals = computed(() => {
  const byId = new Map(journals.value.map((j) => [j.id ?? j.name ?? "", j]));
  return compareIds.value.map((id) => byId.get(id)).filter(Boolean) as JournalRecord[];
});
/** 对比表的一行: 每个维度在几本刊之间的差异 */
function compareRow(label: string, pick: (j: JournalRecord) => string): { label: string; cells: string[]; differs: boolean } {
  const cells = compareJournals.value.map((j) => pick(j) || "—");
  return { label, cells, differs: new Set(cells).size > 1 };
}
const compareRows = computed(() => {
  if (compareJournals.value.length < 2) return [];
  return [
    compareRow("分级", (j) => journalCategory(j)),
    compareRow("主办单位", (j) => String(j.org ?? "")),
    compareRow("收录范围", (j) => String(j.scope ?? "")),
    compareRow("字数要求", (j) => {
      const w = j.structuredRules?.wordCount;
      return w?.min ? `${w.min}-${w.max}${w.unit ?? "字"}` : "";
    }),
    compareRow("格式要求", (j) => (j.structuredRules?.formatRules ?? []).join("; ")),
    compareRow("审稿关注点", (j) => (j.structuredRules?.reviewFocus ?? []).join("; ")),
    compareRow("引文规范", (j) => {
      const c = j.structuredRules?.citationRules ?? [];
      const rf = j.structuredRules?.referenceFormat;
      return [...c, rf ? String(rf) : ""].filter(Boolean).join("; ");
    }),
    compareRow("结构要求", (j) => (j.structuredRules?.structureRequirements ?? []).join("; ")),
    compareRow("禁用项", (j) => (j.structuredRules?.forbiddenItems ?? []).join("; ")),
    compareRow("规则条数", (j) => String(rulesBadge(j.structuredRules).length)),
  ].filter((r) => r.cells.some((c) => c !== "—"));
});
function openCompare() {
  journalTab.value = "compare";
}

// ── 规则来源标注 + 一键回退重解析(2026-09-12) ──
// AI 抽歪一条时, 用户改了以后就丢了"原文→规则"的对应; ai_source_text 留住了当初喂进去的原文,
// 所以能原样重抽。手工填的刊没有原文可退 —— 按钮置灰并说明, 不假装能用。
const reparsingId = ref<string | null>(null);
async function doReparse(j: JournalRecord) {
  if (!j.id || reparsingId.value) return;
  const ok = await confirmDialog({
    message: `用当初的投稿须知原文重新解析「${j.name}」的规则?\n\n当前规则会被覆盖。`,
    title: "回退重解析", okText: "重新解析",
  });
  if (!ok) return;
  reparsingId.value = j.id;
  try {
    const r = await reparseJournalRules(j.id);
    if (r.ok) {
      toast(`重解析完成: ${r.ruleCount ?? 0} 条规则`, "success");
      await loadJournals();
    } else {
      toast(r.error ?? "重解析失败", "warning");
    }
  } catch (e) {
    toast(`重解析失败: ${(e as Error).message}`, "error");
  } finally {
    reparsingId.value = null;
  }
}
/** 展开的卡片(看完整规则, 不再只给计数) */
const expandedId = ref<string | null>(null);
function toggleExpand(j: JournalRecord) {
  const id = j.id ?? j.name ?? "";
  expandedId.value = expandedId.value === id ? null : id;
}
/** 规则明细: 展开时逐条列出原文, 而不是只显示"N 条要求" */
const ruleDetails = (r: JournalRecord["structuredRules"] | undefined): Array<{ label: string; items: string[] }> => {
  if (!r) return [];
  const out: Array<{ label: string; items: string[] }> = [];
  if (r.wordCount?.min) out.push({ label: "字数", items: [`${r.wordCount.min}-${r.wordCount.max}${r.wordCount.unit ?? "字"}`] });
  if (r.formatRules?.length) out.push({ label: "格式要求", items: r.formatRules });
  if (r.reviewFocus?.length) out.push({ label: "审稿关注点", items: r.reviewFocus });
  if (r.citationRules?.length) out.push({ label: "引文规范", items: r.citationRules });
  if (r.referenceFormat) out.push({ label: "引用格式", items: [String(r.referenceFormat)] });
  if (r.languageStyle?.length) out.push({ label: "语言风格", items: r.languageStyle });
  if (r.structureRequirements?.length) out.push({ label: "结构要求", items: r.structureRequirements });
  if (r.forbiddenItems?.length) out.push({ label: "禁用项", items: r.forbiddenItems });
  if (r.specialNotes?.length) out.push({ label: "特别说明", items: r.specialNotes });
  return out;
};

async function loadJournals() {
  try {
    const r = await listJournals();
    journals.value = (r.data ?? r.journals ?? []).map((j) => (typeof j === "string" ? { id: j, name: j } : j));
  } catch {
    journals.value = [];
  }
}

function openParse() {
  journalTab.value = "parse";
  parseSource.value = "";
  journalForm.value = { name: "", category: "" };
}
function openCreate() {
  journalTab.value = "create";
  journalForm.value = { name: "", category: "CSSCI", structuredRules: {} };
}
/** 全库题录 → 补配规则: 预填名称/分类进"新增期刊"表单, 保存后成为自建条目(名字相同则不重复) */
function openAdopt(j: JournalRecord) {
  journalEditId.value = null;
  journalForm.value = { name: j.name, category: journalCategory(j) || "其他", structuredRules: {} };
  journalTab.value = "create";
  parseSource.value = "";
}
function openEdit(j: JournalRecord) {
  journalEditId.value = j.id ?? null;
  journalForm.value = { ...j, structuredRules: j.structuredRules ? JSON.parse(JSON.stringify(j.structuredRules)) : {} };
  journalTab.value = "edit";
}

async function doParse() {
  if (!parseSource.value.trim()) return;
  parsing.value = true;
  try {
    // AI 辅助解析(后端) → 兜底前端正则 6 类归槽
    const rules = parseSubmissionGuideLocally(parseSource.value);
    const r = await parseJournalText(parseSource.value);
    const sr = r.data?.structuredRules;
    // 后端返回 AI 四类规则就直接用; 空壳(解析失败)才回落到本地正则结果
    const hasAi = !!sr && [sr.formatRules, sr.reviewFocus, sr.citationRules].some((a) => Array.isArray(a) && a.length);
    journalForm.value = {
      name: r.data?.name ?? journalForm.value.name ?? "",
      category: r.data?.category || journalForm.value.category || "其他",
      structuredRules: hasAi ? { ...sr } : { ...rules },
      submissionGuideText: parseSource.value,
    };
    journalTab.value = "create";
    toast(hasAi ? "AI 解析完成, 请核对字段" : "已按本地规则解析(未识别到 AI 结果), 请核对字段", hasAi ? "success" : "warning");
  } catch (e) {
    // 后端不通/解析失败: 本地正则仍能给出基础规则, 不让整个流程死在这
    journalForm.value = {
      name: journalForm.value.name ?? "", category: journalForm.value.category || "其他",
      structuredRules: { ...parseSubmissionGuideLocally(parseSource.value) },
      submissionGuideText: parseSource.value,
    };
    journalTab.value = "create";
    // 区分"AI 不可用"与"登录过期/网络断了"——后者提示"已用本地规则"会误导用户
    const st = (e as { status?: number })?.status;
    const hint = st === 401 ? "登录已过期, 请重新登录后再试"
      : st === undefined ? "AI 服务连不上, 已用本地规则填充"
      : `AI 解析不可用(${(e as Error).message})`;
    toast(hint, "warning");
  } finally {
    parsing.value = false;
  }
}

async function saveJournal() {
  if (!journalForm.value.name?.trim()) {
    toast("请填写刊物名称", "warning");
    return;
  }
  saveLoading.value = true;
  try {
    // 编辑时只发后端认的字段: 回传整行会把 level/parsed_rules/updated_at 等一起塞进更新语句
    const body = {
      name: journalForm.value.name.trim(),
      category: journalForm.value.category || "其他",
      structuredRules: journalForm.value.structuredRules ?? {},
      submissionGuideText: journalForm.value.submissionGuideText ?? "",
    };
    if (journalTab.value === "edit" && journalEditId.value) {
      await updateJournal(journalEditId.value, body);
      toast("期刊已更新", "success");
    } else {
      await createJournal(body);
      toast("期刊已添加", "success");
    }
    journalTab.value = "list";
    journalEditId.value = null;
    await loadJournals();
  } catch (e) {
    toast(`保存失败: ${(e as Error).message}`, "error");
  } finally {
    saveLoading.value = false;
  }
}

async function removeJournal(j: JournalRecord) {
  if (!j.id) return;
  const ok = await confirmDialog({ message: `确定删除「${j.name}」?`, title: "删除期刊", okText: "删除", danger: true });
  if (!ok) return;
  await deleteJournal(j.id).catch(() => null);
  toast("已删除", "success");
  await loadJournals();
}

// 结构化规则展示
const rulesBadge = (r: JournalRecord["structuredRules"] | undefined): string[] => {
  if (!r) return [];
  const out: string[] = [];
  if (r.wordCount?.min) out.push(`${r.wordCount.min}-${r.wordCount.max}${r.wordCount.unit ?? "字"}`);
  if (r.formatRules?.length) out.push(`${r.formatRules.length} 条格式要求`);
  if (r.reviewFocus?.length) out.push(`${r.reviewFocus.length} 项审稿关注点`);
  if (r.citationRules?.length) out.push("引文规范要求");
  if (r.referenceFormat) out.push("引用格式要求");
  if (r.languageStyle?.length) out.push("语言风格");
  if (r.structureRequirements?.length) out.push("结构要求");
  if (r.forbiddenItems?.length) out.push("禁用项");
  if (r.specialNotes?.length) out.push(`特别说明 ${r.specialNotes.length} 条`);
  return out;
};

// ── 标准库 ──
const standards = ref<StandardRecord[]>([]);
const stdTab = ref<"list" | "create" | "edit">("list");
const stdForm = ref<StandardRecord>({ name: "", scope: "全部学科", description: "", dimensions: [] });
const stdParseOn = ref(false);
const importOn = ref(false);
const stdParseSrc = ref("");
const stdEditId = ref<string | null>(null);
const SCOPE_OPTIONS = ["全部学科", "社科", "理工", "医学", "自定义"];
const stdSearch = ref("");
const stdExpandedId = ref<string | null>(null);

// ── 标准模板与导入导出(2026-09-12) ──
// 由来: 标准只能一本本手搓; 同事之间要共用一套评分细则也只能截图发。这里给两条最快路径:
//   ① 内置学科模板(社科实证/人文思辨/马理论), 一键起手改;
//   ② JSON 导入导出, 文件级传递(导出结构带版本号, 将来改形状能识别)。
const TEMPLATE_VERSION = 1;
const BUILTIN_TEMPLATES: StandardRecord[] = [
  {
    name: "社科实证(通用)",
    scope: "社科",
    description: "面向问卷调查/面板数据的实证论文, 强调方法透明与因果识别。",
    dimensions: [
      { name: "选题与理论贡献", weight: 3, description: "问题意识是否清晰, 相对既有文献的增量在哪里", criteria: [{ title: "研究问题明确" }, { title: "理论对话充分" }] },
      { name: "研究设计", weight: 4, description: "识别策略能否支撑因果结论", criteria: [{ title: "识别策略合理" }, { title: "样本与抽样交代完整" }] },
      { name: "变量与测量", weight: 3, description: "变量操作化与测量效度", criteria: [{ title: "核心变量操作化清晰" }, { title: "信效度检验" }] },
      { name: "实证结果与稳健性", weight: 4, description: "结果呈现与稳健性检验", criteria: [{ title: "基准回归完整" }, { title: "稳健性/异质性检验" }] },
      { name: "文献与写作规范", weight: 2, description: "综述质量与格式引用", criteria: [{ title: "引文规范" }, { title: "图表规范" }] },
    ],
  },
  {
    name: "人文思辨(通用)",
    scope: "全部学科",
    description: "面向理论思辨/文本阐释类论文, 强调论证自洽与文本细读。",
    dimensions: [
      { name: "问题意识与立意", weight: 4, description: "选题的思想价值与时代针对性", criteria: [{ title: "问题真且重要" }, { title: "立意不落俗套" }] },
      { name: "文本依据", weight: 4, description: "对原典/材料的占有与细读", criteria: [{ title: "文本引用准确" }, { title: "版本交代清楚" }] },
      { name: "论证严密性", weight: 4, description: "概念界定、推理链条、反驳回应", criteria: [{ title: "概念界定清晰" }, { title: "无逻辑跳跃" }] },
      { name: "思想创新", weight: 3, description: "是否有独立见解而非综述堆砌", criteria: [{ title: "有原创判断" }] },
      { name: "学术规范", weight: 2, description: "注释体例与学术伦理", criteria: [{ title: "注释规范" }] },
    ],
  },
  {
    name: "马克思主义理论(通用)",
    scope: "社科",
    description: "面向马理论学科论文, 强调经典依据与现实观照的统一。",
    dimensions: [
      { name: "经典文本依据", weight: 4, description: "对马克思主义经典著作的准确引用与阐释", criteria: [{ title: "引文准确" }, { title: "不望文生义" }] },
      { name: "理论阐释深度", weight: 4, description: "对原理的学理化阐释", criteria: [{ title: "原理阐释到位" }, { title: "有理论增量" }] },
      { name: "现实问题联结", weight: 4, description: "理论与中国现实的结合度", criteria: [{ title: "有problem-driven的问题" }, { title: "对策有针对性" }] },
      { name: "立场与方法", weight: 3, description: "研究方法与政治立场", criteria: [{ title: "方法自觉" }, { title: "立场鲜明" }] },
      { name: "学术规范", weight: 2, description: "文献综述与注释规范", criteria: [{ title: "综述充分" }, { title: "注释规范" }] },
    ],
  },
];
const importError = ref("");
const importPreview = ref<StandardRecord[] | null>(null);
const stdImportSrc = ref("");
const importing = ref(false);

/** 导出为 JSON 文件(带版本号与来源, 便于同事间传递与将来迁移) */
function exportStandard(s: StandardRecord) {
  const payload = {
    kind: "marxsphere.review.standard",
    version: TEMPLATE_VERSION,
    exportedAt: new Date().toISOString().slice(0, 10),
    standard: {
      name: s.name,
      scope: s.scope ?? "全部学科",
      description: s.description ?? "",
      dimensions: (s.dimensions ?? []).map((d) => ({
        name: d.name,
        weight: Number(d.weight) || 1,
        description: d.description ?? "",
        criteria: d.criteria ?? [],
      })),
    },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${String(s.name ?? "标准").replace(/[\\/:*?"<>|]/g, "_")}.standard.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器来不及下载, 延后释放
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("已导出 JSON", "success");
}

/** 导出全部标准(换机器/备份用) */
function exportAllStandards() {
  if (!standards.value.length) { toast("标准库为空", "warning"); return; }
  const payload = {
    kind: "marxsphere.review.standard-set",
    version: TEMPLATE_VERSION,
    exportedAt: new Date().toISOString().slice(0, 10),
    standards: standards.value.map((s) => ({
      name: s.name, scope: s.scope ?? "全部学科", description: s.description ?? "",
      dimensions: (s.dimensions ?? []).map((d) => ({ name: d.name, weight: Number(d.weight) || 1, description: d.description ?? "", criteria: d.criteria ?? [] })),
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `审稿标准库-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`已导出 ${standards.value.length} 套标准`, "success");
}

/** 解析导入文本: 同时接受单标准与标准集两种结构, 结构不对时给出可读原因而不是"导入失败" */
function parseStandardImport(text: string): { ok: true; list: StandardRecord[] } | { ok: false; error: string } {
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { return { ok: false, error: "不是合法 JSON(检查是否复制完整, 有没有多余字符)" }; }
  const o = obj as { kind?: string; standards?: unknown[]; standard?: unknown; dimensions?: unknown; name?: unknown };
  const rawList = Array.isArray(o.standards) ? o.standards : o.standard ? [o.standard] : (o.dimensions || o.name) ? [o] : [];
  if (!rawList.length) return { ok: false, error: "没找到标准数据(需要 standard / standards / 或直接是一个带 dimensions 的标准对象)" };
  const list: StandardRecord[] = [];
  for (const raw of rawList) {
    const r = raw as { name?: unknown; scope?: unknown; description?: unknown; dimensions?: unknown };
    const name = String(r.name ?? "").trim();
    if (!name) return { ok: false, error: "某个标准缺 name 字段" };
    const dimsRaw = Array.isArray(r.dimensions) ? r.dimensions : [];
    const dims = dimsRaw
      .map((d) => {
        const dd = d as { name?: unknown; weight?: unknown; description?: unknown; criteria?: unknown };
        return {
          name: String(dd.name ?? "").trim(),
          weight: Number(dd.weight) || 1,
          description: String(dd.description ?? ""),
          criteria: Array.isArray(dd.criteria) ? dd.criteria : [],
        };
      })
      .filter((d) => d.name);
    if (!dims.length) return { ok: false, error: `「${name}」没有任何有效维度(每个维度至少要 name)` };
    list.push({ name, scope: String(r.scope ?? "全部学科"), description: String(r.description ?? ""), dimensions: dims });
  }
  return { ok: true, list };
}

function onImportFile(file: File) {
  importError.value = "";
  importPreview.value = null;
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result ?? "");
    stdImportSrc.value = text;
    const r = parseStandardImport(text);
    if (r.ok) importPreview.value = r.list;
    else importError.value = r.error;
  };
  reader.onerror = () => { importError.value = "文件读取失败"; };
  reader.readAsText(file, "utf-8");
}

function doImportPaste() {
  importError.value = "";
  importPreview.value = null;
  if (!stdImportSrc.value.trim()) { importError.value = "请先粘贴 JSON"; return; }
  const r = parseStandardImport(stdImportSrc.value);
  if (r.ok) importPreview.value = r.list;
  else importError.value = r.error;
}

async function confirmImport() {
  if (!importPreview.value?.length) return;
  importing.value = true;
  let ok = 0;
  const failed: string[] = [];
  for (const s of importPreview.value) {
    // 同名重名时追加序号而不是拒绝: 用户明确点了导入, 静默丢弃更糟
    const dup = standards.value.some((x) => x.name === s.name);
    const name = dup ? `${s.name}(导入)` : s.name;
    try {
      await createStandard({ ...s, name });
      ok++;
    } catch (e) {
      failed.push(`${s.name}: ${(e as Error).message}`);
    }
  }
  importing.value = false;
  await loadStandards();
  importPreview.value = null;
  stdImportSrc.value = "";
  if (failed.length) toast(`导入 ${ok} 套, 失败 ${failed.length} 套 — ${failed[0]}`, "warning");
  else toast(`已导入 ${ok} 套标准`, "success");
}

function applyTemplate(tpl: StandardRecord) {
  stdEditId.value = null;
  stdForm.value = {
    ...JSON.parse(JSON.stringify(tpl)),
    // 模板是起手式, 名字加后缀避免与已有条目混淆(用户可改)
    name: tpl.name,
  };
  stdTab.value = "create";
  toast("已载入模板, 按需修改后保存", "success");
}
const filteredStandards = computed(() => {
  const kw = stdSearch.value.trim().toLowerCase();
  if (!kw) return standards.value;
  return standards.value.filter((s) =>
    String(s.name ?? "").toLowerCase().includes(kw)
    || String(s.scope ?? "").toLowerCase().includes(kw)
    || String(s.description ?? "").toLowerCase().includes(kw)
    || (s.dimensions ?? []).some((d) => String(d.name ?? "").toLowerCase().includes(kw)));
});
/**
 * 权重合计。库里两种权重并存: 整档(标准库 1-5 / 闭源 3-5)与归一化(0-1 小数, 如 0.2=20%)。
 * 混着求和会把 0.2 显示成"权重合计 0.2"这种没有意义的数字 —— 分开算、分别标注。
 */
function weightInfo(s: StandardRecord): { value: string } | null {
  const ws = (s.dimensions ?? []).map((d) => Number(d.weight) || 0).filter((w) => w > 0);
  if (!ws.length) return null;
  const normalized = ws.every((w) => w <= 1);
  const sum = ws.reduce((a, b) => a + b, 0);
  const shown = normalized
    ? `${Math.round(sum * 100)}%`          // 0.2 → 20%
    : String(Math.round(sum * 10) / 10);
  return { value: shown };
}
function toggleStdExpand(s: StandardRecord) {
  const id = s.id ?? s.name ?? "";
  stdExpandedId.value = stdExpandedId.value === id ? null : id;
}

async function loadStandards() {
  try {
    const r = await listStandards();
    standards.value = (r.data ?? r.standards ?? []).map((s) => (typeof s === "string" ? { id: s, name: s } : s));
  } catch {
    standards.value = [];
  }
}
function openStdCreate() {
  stdTab.value = "create";
  stdForm.value = { name: "", scope: "全部学科", description: "", dimensions: [{ name: "", weight: 3, description: "" }] };
}
function openStdParse() {
  stdTab.value = "list";
  stdParseOn.value = true;
  stdParseSrc.value = "";
}
function openImport() {
  stdTab.value = "list";
  stdParseOn.value = false;
  importOn.value = true;
  importError.value = "";
  importPreview.value = null;
  stdImportSrc.value = "";
}
/** 评分标准原文 → 维度行(后端 AI 优先, 不可用则本地正则归槽) */
async function doStdParse() {
  if (!stdParseSrc.value.trim()) return;
  parsing.value = true;
  try {
    const local = parseStandardLocally(stdParseSrc.value);
    let dims: Array<{ name: string; weight?: number; description?: string }> = [];
    let usedAi = false;
    try {
      const r = await parseStandardText(stdParseSrc.value);
      const ai = (r.dimensions ?? []).filter((d) => d.name?.trim());
      if (ai.length) { dims = ai.map((d) => ({ name: d.name, weight: d.weight ?? 3, description: d.criteria ?? "" })); usedAi = true; }
    } catch { /* 回落本地 */ }
    if (!dims.length) dims = local.map((d) => ({ name: d.name, weight: d.weight ?? 3, description: d.criteria ?? "" }));
    if (!dims.length) {
      toast("没能从原文里识别出维度 — 请按「维度名 + 分值」分行粘贴", "warning");
      return;
    }
    stdEditId.value = null;
    stdForm.value = {
      name: stdForm.value.name || "",
      scope: stdForm.value.scope || "全部学科",
      description: stdParseSrc.value.slice(0, 500),
      dimensions: dims,
    };
    stdParseOn.value = false;
    stdTab.value = "create";
    toast(`${usedAi ? "AI" : "本地规则"}解析出 ${dims.length} 个维度, 请核对名称与分值`, usedAi ? "success" : "warning");
  } finally {
    parsing.value = false;
  }
}
function openStdEdit(s: StandardRecord) {
  stdEditId.value = s.id ?? null;
  stdForm.value = {
    ...s,
    dimensions: s.dimensions?.length ? s.dimensions.map((d) => ({ ...d })) : [{ name: "", weight: 3, description: "" }]
  };
  stdTab.value = "edit";
}
function addDimension() {
  stdForm.value.dimensions = [...(stdForm.value.dimensions ?? []), { name: "", weight: 3, description: "" }];
}
function updDim(i: number, patch: Partial<{ name: string; weight: number; description: string }>) {
  const arr = [...(stdForm.value.dimensions ?? [])];
  arr[i] = { ...arr[i], ...patch };
  stdForm.value.dimensions = arr;
}
function delDim(i: number) {
  const arr = [...(stdForm.value.dimensions ?? [])];
  arr.splice(i, 1);
  stdForm.value.dimensions = arr;
}
async function saveStandard() {
  if (!stdForm.value.name?.trim()) {
    toast("请填写标准名称", "warning");
    return;
  }
  const dims = (stdForm.value.dimensions ?? []).filter((d) => d.name?.trim());
  if (!dims.length) {
    toast("请至少添加一个审查维度", "warning");
    return;
  }
  saveLoading.value = true;
  try {
    const body: StandardRecord = { ...stdForm.value, dimensions: dims };
    if (stdTab.value === "edit" && stdEditId.value) await updateStandard(stdEditId.value, body);
    else await createStandard(body);
    toast("标准已保存", "success");
    stdTab.value = "list";
    stdEditId.value = null;
    await loadStandards();
  } catch (e) {
    toast(`保存失败: ${(e as Error).message}`, "error");
  } finally {
    saveLoading.value = false;
  }
}
async function removeStandard(s: StandardRecord) {
  if (!s.id) return;
  const ok = await confirmDialog({ message: `确定删除「${s.name}」?`, title: "删除标准", okText: "删除", danger: true });
  if (!ok) return;
  await deleteStandard(s.id).catch(() => null);
  toast("已删除", "success");
  await loadStandards();
}
async function toggleDefault(s: StandardRecord) {
  if (!s.id) return;
  await setDefaultStandard(s.id, !s.isDefault).catch(() => null);
  await loadStandards();
}

onMounted(() => {
  void loadJournals();
  void loadStandards();
  void loadStats();
});
</script>

<template>
  <div class="lib-page">
    <div class="lib-head">
      <router-link to="/review" class="back-link">← 返回审稿</router-link>
      <h1>审稿库</h1>
      <div class="lib-tabs">
        <button :class="{ active: activeTab === 'journal' }" @click="activeTab = 'journal'; journalTab = 'list'">期刊库</button>
        <button :class="{ active: activeTab === 'standard' }" @click="activeTab = 'standard'; stdTab = 'list'">标准库</button>
      </div>
    </div>

    <!-- ═══ 期刊列表 ═══ -->
    <div v-if="activeTab === 'journal' && journalTab === 'list'" class="list-pane">
      <div class="stat-strip">
        <div class="stat-cell"><span class="stat-num">{{ journalStats.total }}</span><span class="stat-label">收录期刊</span></div>
        <div class="stat-cell"><span class="stat-num ok">{{ journalStats.configured }}</span><span class="stat-label">已配规则</span></div>
        <div class="stat-cell"><span class="stat-num warn">{{ journalStats.unconfigured }}</span><span class="stat-label">待补规则</span></div>
        <div class="stat-cell"><span class="stat-num">{{ journalStats.verified }}</span><span class="stat-label">已人工核对</span></div>
      </div>

      <!-- 使用统计反哺: useCount 只说"用得多不多", 这里补上"审出来多少分、常出哪类问题" -->
      <div v-if="stats && stats.overall.total" class="stats-panel">
        <div class="sp-head">
          <span class="sp-title">审稿统计</span>
          <span class="sp-sub">{{ stats.overall.total }} 次审稿 · {{ stats.overall.scored }} 次有评分</span>
          <button class="sp-toggle" @click="statsOpen = !statsOpen">{{ statsOpen ? "收起 ▲" : "展开 ▲" }}</button>
        </div>
        <div class="sp-row">
          <div class="sp-cell">
            <span class="sp-num">{{ stats.overall.avgScore ?? "—" }}</span>
            <span class="sp-label">平均分</span>
          </div>
          <div v-for="g in stats.overall.grades.slice(0, 5)" :key="g.grade" class="sp-cell">
            <span class="sp-num sm">{{ g.count }}</span>
            <span class="sp-label">等级 {{ g.grade }}</span>
          </div>
        </div>
        <div v-if="statsOpen" class="sp-detail">
          <div class="sp-block">
            <strong>问题严重度分布</strong>
            <div v-for="s in stats.overall.severity" :key="s.severity" class="sev-row">
              <span class="sev-name">{{ SEVERITY_LABEL[s.severity] ?? s.severity }}</span>
              <span class="sev-track"><span class="sev-fill" :class="'sev-' + s.severity" :style="{ width: sevPct(s.count) + '%' }"></span></span>
              <span class="sev-num">{{ s.count }}</span>
            </div>
          </div>
          <div class="sp-block">
            <strong>高发问题维度 TOP {{ stats.overall.topIssueDimensions.length }}</strong>
            <div class="dim-freq">
              <span v-for="d in stats.overall.topIssueDimensions" :key="d.name" class="freq-chip">
                {{ d.name }}<em>{{ d.count }}</em>
              </span>
            </div>
          </div>
          <div v-if="stats.journals.length" class="sp-block">
            <strong>各刊审稿均分(仅统计明确选了该刊的任务)</strong>
            <div class="jr-row" v-for="j in stats.journals" :key="j.id">
              <span class="jr-name">{{ j.name }}</span>
              <span class="jr-meta">{{ j.jobs }} 次</span>
              <span class="jr-score">{{ j.avgScore ?? "—" }}</span>
            </div>
          </div>
          <span class="sp-note">
            注: 期刊层只统计"任务确实绑定了该刊"的记录; 未选刊的任务仍计入上方全局统计。
          </span>
        </div>
      </div>

      <div class="coverage-bar">
        <div class="cv-head">
          <span class="cv-title">规则覆盖率</span>
          <span class="cv-pct" :class="{ full: coverage.pct >= 100 }">{{ coverage.pct }}%</span>
          <span class="cv-note">
            {{ journalStats.configured }} / {{ journalStats.total }} 本已配规则
            <template v-if="coverage.hasMissing"> · 还有 {{ journalStats.unconfigured }} 本待补</template>
          </span>
          <button v-if="coverage.hasMissing" class="primary-btn sm" @click="openBatch()">批量补规则</button>
        </div>
        <div class="cv-track"><div class="cv-fill" :style="{ width: coverage.pct + '%' }"></div></div>
        <div v-if="coverage.hasMissing" class="cv-missing">
          <span class="cv-missing-label">待补清单(点刊名直接补):</span>
          <button v-for="j in coverage.missing.slice(0, 12)" :key="j.id ?? j.name" class="missing-chip" :title="journalCategory(j)" @click="openAdopt(j)">
            {{ j.name }}
          </button>
          <span v-if="coverage.missing.length > 12" class="cv-more">…另有 {{ coverage.missing.length - 12 }} 本</span>
        </div>
      </div>

      <div class="pane-toolbar">
        <input v-model="journalSearch" class="search-input" placeholder="搜索期刊名或分类…" />
        <span v-if="journals.length" class="hint-inline">卡片可展开看完整规则明细</span>
        <select v-model="journalFilter" class="filter-select">
          <option value="全部">全部({{ journals.length }})</option>
          <option v-for="c in CATEGORIES" :key="c" :value="c">{{ c }}({{ categoryCounts.get(c) ?? 0 }})</option>
        </select>
        <select v-model="journalSort" class="filter-select" title="排序方式">
          <option value="useCount">按使用频次</option>
          <option value="rules">按规则完备度</option>
          <option value="name">按名称</option>
        </select>
        <button class="primary-btn" @click="openCreate()">新增期刊</button>
        <button class="ghost-btn" @click="openParse()">AI 智能解析</button>
        <button class="ghost-btn" :disabled="!journals.length" @click="openCompare()">
          期刊对比<template v-if="compareIds.length">({{ compareIds.length }})</template>
        </button>
      </div>
      <div v-if="!filteredJournals.length" class="list-empty">
        {{ journals.length ? "没有符合条件的期刊 — 换个关键词或分类试试" : "期刊库还是空的。粘贴任一期刊的投稿须知, 用「AI 智能解析」自动提取字数/引用/结构要求, 比手工填快得多。" }}
      </div>
      <div class="lib-grid">
        <div v-for="j in filteredJournals" :key="j.id ?? j.name" class="lib-card">
          <div class="card-head">
            <label class="cmp-pick" :title="'加入对比: ' + j.name">
              <input type="checkbox" :checked="compareIds.includes(j.id ?? j.name ?? '')" @change="toggleCompare(j)" />
            </label>
            <strong>{{ j.name }}</strong>
            <div class="card-badges">
              <span v-if="j.isCatalog" class="badge b-blue">期刊全库</span>
              <span v-else-if="j.isBuiltIn" class="badge b-blue">内置</span>
              <span v-else-if="j.isVerified" class="badge b-green">✓ 已验证</span>
              <span v-else class="badge b-amber">待确认</span>
              <span v-if="journalCategory(j)" class="badge b-gray">{{ journalCategory(j) }}</span>
              <span v-if="rulesBadge(j.structuredRules).length && j.ruleSource === 'ai'" class="badge b-ai" title="规则由 AI 从投稿须知抽取, 可一键回退重解析">AI 抽取</span>
              <span v-else-if="rulesBadge(j.structuredRules).length && j.ruleSource === 'manual'" class="badge b-manual" title="规则由人工填写或编辑过; 回退重解析会覆盖, 故不提供">人工填写</span>
            </div>
          </div>
          <div v-if="j.isCatalog && (j.org || j.topicTags?.length)" class="card-meta">
            <span v-if="j.org" class="meta-org" :title="j.org">{{ j.org }}</span>
            <span v-for="t in (j.topicTags ?? []).slice(0, 3)" :key="t" class="meta-tag">{{ t }}</span>
          </div>
          <div v-if="rulesBadge(j.structuredRules).length" class="rules-chips">
            <span v-for="r in rulesBadge(j.structuredRules)" :key="r" class="rule-chip">{{ r }}</span>
            <button class="expand-btn" @click="toggleExpand(j)">
              {{ expandedId === (j.id ?? j.name) ? "收起明细 ▲" : "查看明细 ▼" }}
            </button>
          </div>
          <div v-else-if="j.isCatalog" class="card-muted">
            期刊全库题录 — 尚无投稿规则。点「补配规则」贴该刊投稿须知, 或用「AI 智能解析」自动提取。
          </div>
          <div v-else class="card-muted">未配置投稿要求 — 点「编辑」补规则, 或用「AI 智能解析」从投稿须知提取</div>
          <div v-if="expandedId === (j.id ?? j.name) && ruleDetails(j.structuredRules).length" class="rule-detail">
            <div v-for="g in ruleDetails(j.structuredRules)" :key="g.label" class="rule-group">
              <span class="rule-group-label">{{ g.label }}</span>
              <ul>
                <li v-for="(it, k) in g.items" :key="k">{{ it }}</li>
              </ul>
            </div>
          </div>
          <div class="card-actions">
            <span v-if="(j.useCount ?? 0) > 0" class="use-count">已用 {{ j.useCount }} 次</span>
            <a v-if="j.officialSite" class="mini-btn" :href="j.officialSite" target="_blank" rel="noopener noreferrer">官网</a>
            <button v-if="j.isCatalog" class="mini-btn" @click="openAdopt(j)">补配规则</button>
            <button v-else class="mini-btn" @click="openEdit(j)">编辑</button>
            <button
              v-if="j.canReparse"
              class="mini-btn"
              :disabled="reparsingId === j.id"
              title="用当初的投稿须知原文重新抽一遍规则(会覆盖当前规则)"
              @click="doReparse(j)"
            >{{ reparsingId === j.id ? "重解析中…" : "回退重解析" }}</button>
            <button v-if="!j.isBuiltIn && !j.isCatalog" class="mini-btn danger" @click="removeJournal(j)">删除</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ 批量补规则 ═══ -->
    <div v-else-if="activeTab === 'journal' && journalTab === 'batch'" class="form-pane">
      <h3>批量补规则</h3>
      <p class="form-hint">
        一次粘贴多家期刊的投稿须知。用「《刊名》投稿须知 / 征稿启事 / 投稿指南 / 来稿要求」这样的标题行分隔;
        正文里提到别的刊名不会被误切。先点「切分预览」确认切得对不对, 再提交解析(切分不烧 token)。
      </p>
      <textarea v-model="batchSource" class="form-textarea big" placeholder="《中国社会科学》投稿须知&#10;1. 字数不超过 2 万字&#10;2. 摘要 300 字以内&#10;&#10;《哲学研究》征稿启事&#10;1. 字数 8000-15000 字&#10;2. 需附英文摘要"></textarea>
      <label class="form-check">
        <input type="checkbox" v-model="batchOverwrite" />
        <span>覆盖已有规则(默认跳过已配规则的刊物, 不覆盖你手工调过的内容)</span>
      </label>
      <div v-if="batchBlocks.length" class="batch-blocks">
        <strong>切分结果({{ batchBlocks.length }} 刊):</strong>
        <div v-for="(b, i) in batchBlocks" :key="i" class="batch-block">
          <span class="bb-name">{{ b.name || "(未识别刊名, 提交后会生成待命名条目)" }}</span>
          <span class="bb-chars">{{ b.chars }} 字</span>
          <div class="bb-preview">{{ b.preview }}…</div>
        </div>
      </div>
      <div v-if="batchResult" class="batch-result">
        <strong>
          解析结果: 成功 {{ batchResult.summary.ok }} · 失败 {{ batchResult.summary.failed }} · 新建 {{ batchResult.summary.created }}
        </strong>
        <div v-for="(r, i) in batchResult.results" :key="i" class="br-row" :class="{ bad: !r.ok }">
          <span class="br-name">{{ r.name }}</span>
          <span v-if="r.ok" class="br-ok">{{ r.created ? "已新建" : "已更新" }} · {{ r.ruleCount }} 条规则</span>
          <span v-else class="br-err">{{ r.error }}</span>
        </div>
      </div>
      <div class="form-actions">
        <button class="ghost-btn" @click="journalTab = 'list'">返回列表</button>
        <button class="ghost-btn" :disabled="!batchSource.trim() || batchSplitting" @click="doBatchSplit">
          {{ batchSplitting ? "切分中…" : "切分预览" }}
        </button>
        <button class="primary-btn" :disabled="!batchSource.trim() || batchRunning" @click="doBatchParse">
          {{ batchRunning ? "解析入库中…(逐刊调用 AI, 请稍候)" : "开始解析入库" }}
        </button>
      </div>
    </div>

    <!-- ═══ 期刊对比 ═══ -->
    <div v-else-if="activeTab === 'journal' && journalTab === 'compare'" class="form-pane">
      <h3>期刊对比</h3>
      <p class="form-hint">在列表里勾选 2-3 本刊, 这里并排看要求差异(不同项已高亮)。</p>
      <div v-if="compareJournals.length < 2" class="list-empty">
        请返回列表勾选至少 2 本期刊。当前已选 {{ compareJournals.length }} 本。
      </div>
      <template v-else>
        <div class="cmp-table-wrap">
          <table class="cmp-table">
            <thead>
              <tr>
                <th class="cmp-label-col">对比项</th>
                <th v-for="j in compareJournals" :key="j.id ?? j.name">
                  {{ j.name }}
                  <button class="cmp-remove" title="移出对比" @click="toggleCompare(j)">×</button>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in compareRows" :key="row.label" :class="{ 'cmp-differs': row.differs }">
                <td class="cmp-label-col">{{ row.label }}</td>
                <td v-for="(c, i) in row.cells" :key="i">{{ c }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="hint-inline">高亮行 = 各刊要求存在差异, 投稿前重点看这几行。</p>
      </template>
      <div class="form-actions">
        <button class="ghost-btn" @click="journalTab = 'list'">返回列表</button>
        <button class="ghost-btn" @click="compareIds = []">清空选择</button>
      </div>
    </div>

    <!-- ═══ AI 解析投稿须知 ═══ -->
    <div v-else-if="activeTab === 'journal' && journalTab === 'parse'" class="form-pane">
      <h3>解析投稿须知</h3>
      <p class="form-hint">粘贴期刊官网的投稿须知原文, AI 将自动识别字数要求、引用格式、结构要求等规则。</p>
      <textarea v-model="parseSource" class="form-textarea big" placeholder="粘贴投稿须知原文…"></textarea>
      <div class="form-actions">
        <button class="ghost-btn" @click="journalTab = 'list'">取消</button>
        <button class="primary-btn" :disabled="!parseSource.trim() || parsing" @click="doParse">
          {{ parsing ? "解析中…" : "智能解析" }}
        </button>
      </div>
    </div>

    <!-- ═══ 期刊表单(新增/编辑) ═══ -->
    <div v-else-if="activeTab === 'journal' && (journalTab === 'create' || journalTab === 'edit')" class="form-pane">
      <h3>{{ journalTab === 'edit' ? '编辑期刊' : '新增期刊' }}</h3>
      <div class="form-row">
        <label>刊物名称 *</label>
        <input v-model="journalForm.name" class="form-input" placeholder="例如: 中国社会科学" />
      </div>
      <div class="form-row">
        <label>分类 *</label>
        <select :value="CATEGORIES.includes(journalCategory(journalForm)) ? journalCategory(journalForm) : '其他'" class="form-input" @change="journalForm.category = ($event.target as HTMLSelectElement).value">
          <option v-for="c in CATEGORIES" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div class="form-row">
        <label>核心审稿要点</label>
        <textarea v-model="journalForm.submissionGuideText" class="form-textarea" placeholder="一行一条, AI 会自动识别: 字数区间/引用格式/结构要求/禁用项…"></textarea>
      </div>
      <div v-if="journalForm.structuredRules && Object.keys(journalForm.structuredRules).length" class="parsed-rules">
        <strong>已识别规则(供预览):</strong>
        <div v-for="r in rulesBadge(journalForm.structuredRules)" :key="r" class="rule-chip">{{ r }}</div>
      </div>
      <div class="form-actions">
        <button class="ghost-btn" @click="journalTab = 'list'">取消</button>
        <button class="primary-btn" :disabled="saveLoading || !journalForm.name?.trim()" @click="saveJournal">保存</button>
      </div>
    </div>

    <!-- ═══ 标准导入 JSON ═══ -->
    <div v-if="activeTab === 'standard' && importOn && stdTab === 'list'" class="form-pane">
      <h3>导入审核标准</h3>
      <p class="form-hint">
        支持三种结构: 单套标准({name, dimensions})、标准集({standards:[…]})、或本应用导出的文件。
        导入前会先校验并预览, 确认后再写库。
      </p>
      <div class="form-row">
        <label>选择文件</label>
        <input
          type="file"
          accept=".json,application/json"
          class="form-input"
          @change="(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) onImportFile(f); }"
        />
      </div>
      <div class="form-row">
        <label>或粘贴 JSON</label>
        <textarea v-model="stdImportSrc" class="form-textarea" placeholder='{"name":"我的标准","dimensions":[{"name":"创新性","weight":4}]}'></textarea>
      </div>
      <div v-if="importError" class="import-err">解析失败: {{ importError }}</div>
      <div v-if="importPreview" class="import-preview">
        <strong>校验通过: 将导入 {{ importPreview.length }} 套标准</strong>
        <div v-for="(s, i) in importPreview" :key="i" class="ip-row">
          <span class="ip-name">{{ s.name }}</span>
          <span class="ip-meta">{{ s.scope || "全部学科" }} · {{ (s.dimensions ?? []).length }} 维</span>
          <span class="ip-dims">{{ (s.dimensions ?? []).map((d) => d.name).join(" / ") }}</span>
        </div>
      </div>
      <div class="form-actions">
        <button class="ghost-btn" @click="importOn = false">取消</button>
        <button class="ghost-btn" :disabled="!stdImportSrc.trim()" @click="doImportPaste">校验粘贴内容</button>
        <button class="primary-btn" :disabled="!importPreview?.length || importing" @click="confirmImport">
          {{ importing ? "导入中…" : `确认导入${importPreview?.length ? ` (${importPreview.length})` : ""}` }}
        </button>
      </div>
    </div>

    <!-- ═══ 评分标准 AI 解析 ═══ -->
    <div v-if="activeTab === 'standard' && stdParseOn && stdTab === 'list'" class="form-pane">
      <h3>AI 解析评分标准</h3>
      <p class="form-hint">粘贴评审细则原文(建议「维度名 + 分值」分行), AI 会拆成维度与权重; 识别不到时自动改用本地规则。</p>
      <textarea v-model="stdParseSrc" class="form-textarea big" placeholder="例如: 创新性 20分 / 论证严谨性 30分 / 文献综述 25分 / 写作规范 25分"></textarea>
      <div class="form-actions">
        <button class="ghost-btn" @click="stdParseOn = false">取消</button>
        <button class="primary-btn" :disabled="!stdParseSrc.trim() || parsing" @click="doStdParse">
          {{ parsing ? "解析中…" : "智能解析" }}
        </button>
      </div>
    </div>

    <!-- ═══ 标准列表 ═══ -->
    <div v-if="activeTab === 'standard' && stdTab === 'list'" class="list-pane">
      <div class="stat-strip">
        <div class="stat-cell"><span class="stat-num">{{ standards.length }}</span><span class="stat-label">个标准</span></div>
        <div class="stat-cell"><span class="stat-num ok">{{ standards.filter((x) => x.isDefault).length }}</span><span class="stat-label">已设默认</span></div>
        <div class="stat-cell"><span class="stat-num">{{ standards.filter((x) => x.isBuiltIn).length }}</span><span class="stat-label">内置</span></div>
        <div class="stat-cell"><span class="stat-num">{{ standards.reduce((a, x) => a + (x.dimensions?.length ?? 0), 0) }}</span><span class="stat-label">维度总数</span></div>
      </div>
      <div class="pane-toolbar">
        <input v-model="stdSearch" class="search-input" placeholder="搜索标准名/维度/适用范围…" />
        <span v-if="standards.length" class="hint-inline">卡片可展开看全部维度</span>
        <button class="ghost-btn" @click="openStdParse()">AI 解析评分标准</button>
        <button class="ghost-btn" @click="openImport()">导入 JSON</button>
        <button v-if="standards.length" class="ghost-btn" @click="exportAllStandards()">导出全部</button>
        <button class="primary-btn" @click="openStdCreate()">创建审核标准</button>
      </div>

      <!-- 内置学科模板: 一键起手, 免得从空白维度表开始搓 -->
      <div class="tpl-strip">
        <span class="tpl-label">学科模板(点一下载入表单):</span>
        <button v-for="t in BUILTIN_TEMPLATES" :key="t.name" class="tpl-chip" :title="t.description" @click="applyTemplate(t)">
          {{ t.name }}<span class="tpl-dims">{{ (t.dimensions ?? []).length }} 维</span>
        </button>
      </div>

      <div v-if="!filteredStandards.length" class="list-empty">
        {{ standards.length ? "没有匹配的标准 — 换个关键词试试" : "还没有自定义标准。可直接用上面的学科模板起手, 或点「AI 解析评分标准」粘贴原文生成维度。" }}
      </div>
      <div class="lib-grid">
        <div v-for="s in filteredStandards" :key="s.id ?? s.name" class="lib-card">
          <div class="card-head">
            <strong>{{ s.name }}</strong>
            <div class="card-badges">
              <span v-if="s.isDefault" class="badge b-green">默认</span>
              <span v-if="s.isBuiltIn" class="badge b-blue">内置</span>
              <span v-else class="badge b-amber">待确认</span>
            </div>
          </div>
          <div class="card-muted">
            {{ s.scope || "全部学科" }} · {{ s.dimensions?.length ?? 0 }} 个维度
            <span v-if="weightInfo(s)" class="weight-sum" title="各维度权重合计">权重合计 {{ weightInfo(s)!.value }}</span>
          </div>
          <div v-if="s.dimensions?.length" class="dim-preview">
            <span v-for="(d, di) in s.dimensions.slice(0, 4)" :key="di" class="dim-chip" :title="d.description || ''">
              {{ d.name }}<em v-if="d.weight">·{{ d.weight }}</em>
            </span>
            <span v-if="s.dimensions.length > 4" class="dim-more">+{{ s.dimensions.length - 4 }}</span>
            <button class="expand-btn" @click="toggleStdExpand(s)">
              {{ stdExpandedId === (s.id ?? s.name) ? "收起 ▲" : "全部维度 ▼" }}
            </button>
          </div>
          <div v-if="stdExpandedId === (s.id ?? s.name)" class="rule-detail">
            <div v-for="(d, di) in s.dimensions" :key="di" class="rule-group">
              <span class="rule-group-label">{{ d.name }}<em v-if="d.weight"> · 权重 {{ d.weight }}</em></span>
              <ul v-if="d.description"><li>{{ d.description }}</li></ul>
            </div>
          </div>
          <div v-if="s.description" class="card-desc">{{ s.description.slice(0, 120) }}</div>
          <div class="card-actions">
            <button class="mini-btn" @click="openStdEdit(s)">编辑</button>
            <button class="mini-btn" title="导出为 JSON 文件, 可发给同事或换机器用" @click="exportStandard(s)">导出</button>
            <button v-if="!s.isDefault && !s.isBuiltIn" class="mini-btn" @click="toggleDefault(s)">设为默认</button>
            <button v-if="!s.isBuiltIn" class="mini-btn danger" @click="removeStandard(s)">删除</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ 标准表单 ═══ -->
    <div v-if="activeTab === 'standard' && (stdTab === 'create' || stdTab === 'edit')" class="form-pane">
      <h3>{{ stdTab === 'edit' ? '编辑审核标准' : '创建审核标准' }}</h3>
      <div class="form-row">
        <label>标准名称 *</label>
        <input v-model="stdForm.name" class="form-input" placeholder="例如: 社科期刊通用审稿标准" />
      </div>
      <div class="form-row">
        <label>适用范围</label>
        <select v-model="stdForm.scope" class="form-input">
          <option v-for="o in SCOPE_OPTIONS" :key="o" :value="o">{{ o }}</option>
        </select>
      </div>
      <div class="form-row">
        <label>说明</label>
        <textarea v-model="stdForm.description" class="form-textarea" placeholder="标准说明(可选)"></textarea>
      </div>
      <div class="dimensions-block">
        <label>审查维度</label>
        <div v-for="(d, i) in stdForm.dimensions" :key="d.name || 'dim-' + i" class="dim-row">
          <input v-model="d.name" class="dim-name" placeholder="维度名(如: 选题与意义)" @input="updDim(i, { name: ($event.target as HTMLInputElement).value })" />
          <input v-model.number="d.weight" type="number" min="1" max="5" class="dim-weight" title="权重 1-5" @input="updDim(i, { weight: Number(($event.target as HTMLInputElement).value) })" />
          <input v-model="d.description" class="dim-desc" placeholder="描述/评分要点" @input="updDim(i, { description: ($event.target as HTMLInputElement).value })" />
          <button class="dim-del" @click="delDim(i)">✕</button>
        </div>
        <button class="ghost-btn" @click="addDimension">+ 添加维度</button>
      </div>
      <div class="form-actions">
        <button class="ghost-btn" @click="stdTab = 'list'">取消</button>
        <button class="primary-btn" :disabled="saveLoading" @click="saveStandard">{{ saveLoading ? "保存中…" : "保存" }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lib-page {
  max-width: 1080px;
  margin: 0 auto;
  padding: 24px;
  font-family: PingFang SC, Microsoft YaHei, sans-serif;
  /* 同 ReviewView: 外层 .soc-shell 是 100vh + overflow:hidden, 页面自身必须成为滚动容器 */
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
.lib-head { display: flex; align-items: center; gap: 16px; margin-bottom: 18px; }
.back-link { color: #7EB0E8; text-decoration: none; font-size: 13px; }
.lib-head h1 { margin: 0; font-size: 20px; color: #E8EEF7; }
.lib-tabs { display: flex; margin-left: auto; background: #212C45; border-radius: 8px; padding: 3px; }
.lib-tabs button {
  padding: 6px 18px; border: 0; border-radius: 6px; background: transparent;
  font-size: 13px; color: #8B9BB1; cursor: pointer;
}
.lib-tabs button.active { background: #11192C; color: #E8EEF7; font-weight: 600; box-shadow: 0 1px 3px rgba(15,23,42,.08); }
.pane-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.pane-toolbar strong { font-size: 15px; color: #E8EEF7; margin-right: auto; }
.search-input {
  padding: 7px 12px; border: 1px solid #222F44; border-radius: 8px;
  font-size: 13px; width: 220px; background: #11192C;
}
.filter-select {
  padding: 7px 10px; border: 1px solid #222F44; border-radius: 8px; font-size: 12.5px; background: #11192C;
}
.primary-btn {
  padding: 7px 16px; background: #4D84CB; color: #F1F5F9; border: 0; border-radius: 8px;
  font-size: 13px; font-weight: 600; cursor: pointer;
}
.primary-btn:hover { background: #5D94DB; }
.primary-btn:disabled { background: #46587A; cursor: not-allowed; }
.primary-btn:disabled:hover { background: #46587A; }
.ghost-btn {
  padding: 7px 14px; border: 1px solid #222F44; border-radius: 8px; background: #11192C;
  color: #8B9BB1; font-size: 13px; cursor: pointer;
}
.ghost-btn:hover { border-color: #4D84CB; color: #7EB0E8; }
.list-empty { padding: 40px; text-align: center; color: #7A8AA0; font-size: 13px; }
/* 概览统计条: 先给结论(收了多少/多少配了规则), 再让用户决定要不要往下翻 */
.stat-strip {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 14px;
}
.stat-cell {
  background: #11192C; border: 1px solid #222F44; border-radius: 10px;
  padding: 10px 14px; display: flex; flex-direction: column; gap: 2px;
}
.stat-num { font-size: 20px; font-weight: 700; color: #E8EEF7; line-height: 1.1; }
.stat-num.ok { color: #5FD0B4; }
.stat-num.warn { color: #E8B54A; }
.stat-label { font-size: 11px; color: #7A8AA0; }
/* 全库题录的元信息: 主办单位 + 主题标签(选刊时最需要的两项) */
.card-meta { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; font-size: 11px; }
.meta-org { color: #8B9BB1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.meta-tag { color: #A9CDF5; background: #16233A; border-radius: 8px; padding: 1px 7px; font-size: 10.5px; }
a.mini-btn { text-decoration: none; display: inline-flex; align-items: center; }
/* 卡片内可展开明细: 原来只给"N 条要求"这种计数, 用户看不到到底是什么要求 */
.expand-btn {
  border: 0; background: transparent; color: #7EB0E8; font-size: 11px;
  cursor: pointer; padding: 2px 4px; margin-left: auto;
}
.expand-btn:hover { color: #A9CDF5; text-decoration: underline; }
.rule-detail {
  border-top: 1px dashed #222F44; margin-top: 6px; padding-top: 8px;
  display: flex; flex-direction: column; gap: 7px; max-height: 240px; overflow-y: auto;
}
.rule-group { font-size: 11.5px; }
.rule-group-label { color: #A9BBD0; font-weight: 600; }
.rule-group-label em { color: #7A8AA0; font-weight: 400; font-style: normal; }
.rule-group ul { margin: 3px 0 0; padding-left: 18px; color: #8B9BB1; line-height: 1.55; }
/* 标准卡片的维度预览: 一屏看清这个标准审什么 */
.dim-preview { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.dim-chip {
  font-size: 10.5px; padding: 2px 8px; border-radius: 10px;
  background: #16233A; color: #A9CDF5; border: 1px solid #22375C;
}
.dim-chip em { font-style: normal; color: #7EB0E8; }
.dim-more { font-size: 10.5px; color: #7A8AA0; }
.weight-sum { font-size: 10.5px; color: #7A8AA0; margin-left: 6px; }
.lib-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.lib-card {
  background: #11192C; border: 1px solid #222F44; border-radius: 12px; padding: 14px;
  display: flex; flex-direction: column; gap: 8px;
  transition: border-color .15s, background .15s;
}
.lib-card:hover { border-color: #2E4A74; background: #131C30; }
.hint-inline { font-size: 11px; color: #7A8AA0; }
.card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.card-head strong { font-size: 14px; color: #E8EEF7; }
.card-badges { display: flex; gap: 4px; flex-wrap: wrap; }
.badge { font-size: 10px; padding: 1px 7px; border-radius: 8px; }
.b-blue { background: #1E2A48; color: #2563eb; }
.b-green { background: #14281F; color: #5FD0B4; }
.b-amber { background: #2A2418; color: #E8B54A; }
.b-gray { background: #212C45; color: #8B9BB1; }
/* 规则来源: 与"分类/验证"徽标区分开 —— 它回答的是"这条规则能不能退回重抽" */
.b-ai { background: #1B2E3A; color: #6EC8E8; }
.b-manual { background: #2A2130; color: #B79BD6; }
.rules-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.rule-chip {
  font-size: 10.5px; padding: 2px 8px; border: 1px solid #222F44; border-radius: 10px;
  background: #1A2333; color: #8B9BB1;
}
.card-muted { font-size: 12px; color: #7A8AA0; }
.card-desc { font-size: 12px; color: #8B9BB1; line-height: 1.5; }
.card-actions { display: flex; gap: 6px; align-items: center; margin-top: auto; }
.use-count { font-size: 11px; color: #7A8AA0; margin-right: auto; }
.mini-btn {
  padding: 3px 10px; border: 1px solid #222F44; border-radius: 6px; background: #11192C;
  font-size: 11.5px; color: #8B9BB1; cursor: pointer;
}
.mini-btn:hover { border-color: #4D84CB; color: #7EB0E8; }
.mini-btn.danger:hover { border-color: #dc2626; color: #dc2626; }
.form-pane {
  background: #11192C; border: 1px solid #222F44; border-radius: 14px;
  padding: 22px; max-width: 720px;
}
.form-pane h3 { margin: 0 0 6px; font-size: 16px; color: #E8EEF7; }
.form-hint { font-size: 12.5px; color: #8B9BB1; margin: 0 0 12px; }
.form-row { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
.form-row label { font-size: 13px; font-weight: 600; color: #DCE6F2; }
.form-input {
  padding: 8px 12px; border: 1px solid #222F44; border-radius: 8px; font-size: 13px; background: #11192C;
}
.form-textarea {
  padding: 8px 12px; border: 1px solid #222F44; border-radius: 8px; font-size: 13px;
  font-family: inherit; min-height: 90px; resize: vertical; line-height: 1.6;
}
.form-textarea.big { min-height: 240px; }
.form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.parsed-rules { margin: 8px 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.parsed-rules strong { font-size: 12px; color: #DCE6F2; }
.dimensions-block { margin: 8px 0; }
.dimensions-block > label { font-size: 13px; font-weight: 600; color: #DCE6F2; display: block; margin-bottom: 6px; }
.dim-row { display: flex; gap: 6px; margin-bottom: 6px; }
.dim-name { flex: 1.2; padding: 6px 9px; border: 1px solid #222F44; border-radius: 6px; font-size: 12.5px; }
.dim-weight { width: 56px; padding: 6px 9px; border: 1px solid #222F44; border-radius: 6px; font-size: 12.5px; }
.dim-desc { flex: 2; padding: 6px 9px; border: 1px solid #222F44; border-radius: 6px; font-size: 12.5px; }
.dim-del { border: 0; background: transparent; color: #dc2626; cursor: pointer; }

/* ── 规则覆盖率(2026-09-12) ── */
.coverage-bar { margin: 0 0 14px; padding: 12px 14px; border: 1px solid #222F44; border-radius: 10px; background: #131C2E; }
.cv-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.cv-title { font-size: 13px; font-weight: 600; color: #DCE6F2; }
.cv-pct { font-size: 18px; font-weight: 700; color: #4D84CB; }
.cv-pct.full { color: #5FD0B4; }
.cv-note { font-size: 12px; color: #8B9BB1; flex: 1; }
.primary-btn.sm { padding: 4px 12px; font-size: 12.5px; }
.cv-track { height: 8px; border-radius: 5px; background: #1B2438; overflow: hidden; }
.cv-fill { height: 100%; border-radius: 5px; background: linear-gradient(90deg, #4D84CB, #7EB0E8); transition: width .3s ease; }
.cv-missing { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.cv-missing-label { font-size: 12px; color: #8B9BB1; }
.missing-chip {
  padding: 3px 9px; font-size: 12px; border: 1px dashed #3A4A66; border-radius: 12px;
  background: transparent; color: #A9BBD3; cursor: pointer; max-width: 180px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.missing-chip:hover { border-color: #E8B54A; color: #E8B54A; border-style: solid; }
.cv-more { font-size: 12px; color: #7A8AA0; }

/* ── 期刊对比 ── */
.cmp-pick { display: flex; align-items: center; margin-right: 6px; cursor: pointer; }
.cmp-pick input { cursor: pointer; accent-color: #4D84CB; }
.cmp-table-wrap { overflow-x: auto; border: 1px solid #222F44; border-radius: 10px; }
.cmp-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.cmp-table th, .cmp-table td { padding: 9px 11px; text-align: left; vertical-align: top; border-bottom: 1px solid #1D2739; color: #C7D3E3; }
.cmp-table thead th { background: #162034; color: #E8EEF7; font-weight: 600; position: relative; white-space: nowrap; }
.cmp-table tbody tr:last-child td { border-bottom: 0; }
.cmp-label-col { width: 110px; color: #8B9BB1 !important; background: #131C2E; white-space: nowrap; }
.cmp-table tr.cmp-differs td { background: rgba(232, 181, 74, .07); }
.cmp-table tr.cmp-differs .cmp-label-col { color: #E8B54A !important; }
.cmp-remove { margin-left: 6px; border: 0; background: transparent; color: #7A8AA0; cursor: pointer; font-size: 14px; line-height: 1; }
.cmp-remove:hover { color: #dc2626; }

/* ── 批量补规则 ── */
.form-check { display: flex; align-items: center; gap: 7px; margin: 10px 0; font-size: 12.5px; color: #C7D3E3; }
.form-check input { accent-color: #4D84CB; }
.batch-blocks { margin: 12px 0; padding: 12px 14px; border: 1px solid #222F44; border-radius: 10px; background: #131C2E; }
.batch-blocks > strong { font-size: 12.5px; color: #DCE6F2; }
.batch-block { margin-top: 9px; padding: 8px 10px; border-left: 2px solid #4D84CB; background: #162034; border-radius: 0 6px 6px 0; }
.bb-name { font-size: 12.5px; font-weight: 600; color: #7EB0E8; margin-right: 8px; }
.bb-chars { font-size: 11.5px; color: #7A8AA0; }
.bb-preview { margin-top: 4px; font-size: 11.5px; color: #8B9BB1; line-height: 1.5; }
.batch-result { margin: 12px 0; padding: 12px 14px; border: 1px solid #222F44; border-radius: 10px; background: #131C2E; }
.batch-result > strong { font-size: 13px; color: #DCE6F2; }
.br-row { display: flex; gap: 10px; align-items: baseline; margin-top: 7px; font-size: 12.5px; }
.br-name { color: #C7D3E3; min-width: 140px; }
.br-ok { color: #5FD0B4; }
.br-err { color: #E8B54A; }

/* ── 学科模板 + 标准导入导出(2026-09-12) ── */
.tpl-strip {
  display: flex; flex-wrap: wrap; gap: 7px; align-items: center;
  margin: 0 0 14px; padding: 10px 12px; border: 1px dashed #2A3A55;
  border-radius: 9px; background: rgba(77, 132, 203, .04);
}
.tpl-label { font-size: 12px; color: #8B9BB1; }
.tpl-chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px;
  border: 1px solid #2A3A55; border-radius: 14px; background: #162034;
  color: #C7D3E3; font-size: 12.5px; cursor: pointer; transition: all .15s;
}
.tpl-chip:hover { border-color: #4D84CB; color: #7EB0E8; }
.tpl-dims { font-size: 10.5px; color: #7A8AA0; }
.import-err {
  margin: 10px 0; padding: 9px 12px; border-radius: 8px;
  border: 1px solid rgba(232, 181, 74, .35); background: rgba(232, 181, 74, .08);
  color: #E8B54A; font-size: 12.5px;
}
.import-preview { margin: 12px 0; padding: 12px 14px; border: 1px solid #222F44; border-radius: 10px; background: #131C2E; }
.import-preview > strong { font-size: 12.5px; color: #5FD0B4; }
.ip-row { margin-top: 9px; padding: 8px 10px; border-left: 2px solid #4D84CB; background: #162034; border-radius: 0 6px 6px 0; }
.ip-name { font-size: 12.5px; font-weight: 600; color: #7EB0E8; margin-right: 8px; }
.ip-meta { font-size: 11.5px; color: #7A8AA0; }
.ip-dims { display: block; margin-top: 4px; font-size: 11.5px; color: #8B9BB1; }

/* ── 使用统计反哺(2026-09-12) ── */
.stats-panel { margin: 0 0 14px; padding: 12px 14px; border: 1px solid #222F44; border-radius: 10px; background: #131C2E; }
.sp-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.sp-title { font-size: 13px; font-weight: 600; color: #DCE6F2; }
.sp-sub { font-size: 12px; color: #8B9BB1; flex: 1; }
.sp-toggle { border: 0; background: transparent; color: #7EB0E8; font-size: 12px; cursor: pointer; }
.sp-toggle:hover { color: #4D84CB; }
.sp-row { display: flex; flex-wrap: wrap; gap: 8px; }
.sp-cell {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 8px 14px; border: 1px solid #222F44; border-radius: 8px; background: #162034; min-width: 76px;
}
.sp-num { font-size: 19px; font-weight: 700; color: #7EB0E8; line-height: 1.1; }
.sp-num.sm { font-size: 16px; color: #C7D3E3; }
.sp-label { font-size: 11px; color: #7A8AA0; }

.sp-detail { margin-top: 14px; display: flex; flex-direction: column; gap: 14px; }
.sp-block > strong { display: block; margin-bottom: 8px; font-size: 12.5px; color: #DCE6F2; }
.sev-row { display: flex; align-items: center; gap: 9px; margin-bottom: 6px; }
.sev-name { width: 68px; font-size: 12px; color: #A9BBD3; flex-shrink: 0; }
.sev-track { flex: 1; height: 8px; border-radius: 5px; background: #1B2438; overflow: hidden; }
.sev-fill { display: block; height: 100%; border-radius: 5px; transition: width .3s ease; }
.sev-major { background: linear-gradient(90deg, #C0553F, #E08A6E); }
.sev-minor { background: linear-gradient(90deg, #B08A3A, #E8B54A); }
.sev-suggestion { background: linear-gradient(90deg, #3F7A6A, #5FD0B4); }
.sev-num { width: 34px; text-align: right; font-size: 12px; color: #8B9BB1; }
.dim-freq { display: flex; flex-wrap: wrap; gap: 6px; }
.freq-chip {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px;
  border-radius: 11px; border: 1px solid rgba(77, 132, 203, .3);
  background: rgba(77, 132, 203, .1); font-size: 12px; color: #A9C6E8;
}
.freq-chip em { font-style: normal; font-size: 10.5px; color: #7A8AA0; }
.jr-row { display: flex; align-items: baseline; gap: 10px; padding: 4px 0; font-size: 12.5px; border-bottom: 1px solid #1B2438; }
.jr-row:last-child { border-bottom: 0; }
.jr-name { flex: 1; color: #C7D3E3; }
.jr-meta { font-size: 11.5px; color: #7A8AA0; }
.jr-score { font-weight: 600; color: #7EB0E8; min-width: 40px; text-align: right; }
.sp-note { font-size: 11px; color: #7A8AA0; line-height: 1.5; }
</style>

/**
 * stages.ts — 科研阶段的**唯一真源**（前端 /soc 子应用侧）。
 *
 * 由来（2026-09-26）：阶段模型此前散在 12 处硬编码里，其中 **8 处改了不报错**：
 *
 *   | 位置 | 改错的后果 |
 *   |---|---|
 *   | `stores/workflow.ts` 的 setPhase 三元链 | **无 default** → phase=6 写成「统稿定稿」 |
 *   | `PhaseProgressBar` 的 `Math.min(5, …)` | 硬夹 → 新节点永远不会变 active |
 *   | `PhaseProgressBar` 的 nodeMetric | 按 key 硬编码, 末尾 `return ""` → 静默无计数 |
 *   | `WorkflowShell` 的 Alt+N | 用**数组下标反推**阶段号 → 快捷键跳错页 |
 *   | 各页 `setPhase(N)` / `publish(label)` | 推进点写死号 |
 *   | `server.ts` 的 stageNodeKeys | stale 表只覆盖 phase2-4, phase5 恒 false |
 *
 * 收敛到本表后，加阶段的改动点从"十几处、半数静默"变成"本表 + 后端镜像"。
 *
 * ## 本批范围（2026-09-26）
 *
 * 批 2 做的是**真源化 + 重编号**（阶段构成未动，号从 1..5 挪到 1,2,4,5,6，迁移 157 已落库）。
 * 批 3 把 `ph=3`「研究实施」补上 —— 编号早已为它留好，加它**不需要再动任何已有数据**。
 *
 * ## 阶段表（2026-09-26 用户拍板「紧凑编号」）
 *
 *   1 选题界定 · 2 框架设计 · 3 研究实施 · 4 文献与资料 · 5 章节写作 · 6 统稿定稿
 *
 * 「研究实施」只对**定量/混合**显示（见 `appliesTo`）。
 * 定性研究看到的是 1→2→4→5→6 的**跳号**，这是有意接受的：
 * 阶段号表达"第几步"的显示顺序，不是数组下标。
 *
 * 「评审与返修」**不在本表** —— 它是循环（投出去→意见回来→改→再投），
 * 线性进度条表达不了，单独做成「投稿与返修」区。
 *
 * ⚠ 与后端 `src/services/research-stages.ts` 是同一张表的两个副本，
 *   由 `test/research-stages.test.ts` 锁住「阶段号 ↔ 中文名」一致。
 */

/** 研究类型 —— 取自 `input.researchMethod`，空值按定量处理（与既有 inferMethod 的兜底一致） */
export type ResearchType = "qualitative" | "quantitative" | "mixed";

/**
 * 阶段内部的一步。
 *
 * 由来(2026-09-28, 用户要求"能执行每一个环节里的每一步"):
 *   画布上原来只有**宏观节点**(选题界定/框架设计/…), 而一个阶段内部其实有若干步。
 *   参考产品把这一步做成 PHASE 卡片里的编号子列表(①②③④), 还能单跑。
 *
 * ⚠ **每个 `capabilityId` 都必须是 `capability-registry.ts` 里真实存在的 id** ——
 *   编一个不存在的 id, 界面上看着像能跑, 点下去必然失败, 而且失败在几百毫秒之后,
 *   看不出是"这一步本来就不支持"还是"跑挂了"。所以:
 *     · 有真能力可挂的 → 填 capabilityId, 画布上可以**单步执行**;
 *     · 没有的 → **不填**, 只给 `pageHint`, 让人去所属阶段页做(那里本来就能做,
 *       只是它走的是"建 job + 轮询"而不是同步端点, 不是一条能挂到 DAG 上的形状)。
 *   宁可少列几步, 不留假的可执行项。
 *
 * 判断"有没有真支撑"的依据(不是拍脑袋):
 *   · 框架设计那三步 —— 后端 `research-exec-engine.ts:355/375/486` 实写
 *     「变量识别 / 框架分析 / 逐章写作指导」, 前端 `SectionsView` 用 `progress.stage` 真驱动;
 *   · 其余各步 —— 见各视图真实调用的接口(汇总在 capabilities 里能对上的那些)。
 */
export interface StageStepDef {
  /** 稳定键, 用于"单跑这一步"与埋点 */
  key: string;
  /** 中文名 —— 与阶段页上显示的**逐字一致**, 免得同一件事两处叫两个名 */
  label: string;
  /**
   * 挂到哪个编排能力上。有值 = 画布上可以单步执行。
   * 必须是 `capability-registry.ts` 里真实存在的 id。
   */
  capabilityId?: string;
  /**
   * 单步执行时给该能力的参数(渲染前是模板, 可含 `{{inputs}}`)。
   * 只对**参数能确定**的步写 —— 参数不确定的(如章节正文要选哪一章)留给人在节点详情里填。
   */
  params?: Record<string, unknown>;
  /** 没有 capabilityId 时: 去哪个阶段页做这件事(路由) */
  pageHint?: string;
}

export interface StageDef {
  /** 阶段号（1..6，跳过 3 是允许的） */
  ph: number;
  /** 节点键 / 路由尾段 —— 路由是 `/workflow/${key}`，但 `input` 与 `finalize` 是历史命名 */
  key: string;
  /** 中文名，与后端 research-stages.ts 必须逐字一致 */
  title: string;
  /** 路由路径 */
  path: string;
  /** 哪些研究类型能看到这一步。缺省 = 全都看得到 */
  appliesTo?: ResearchType[];
  /** 这个阶段内部的步骤(见 StageStepDef)。空/缺省 = 不细分 */
  steps?: readonly StageStepDef[];
}

export const STAGES: readonly StageDef[] = Object.freeze([
  {
    ph: 1, key: "input", title: "选题界定", path: "/workflow/input",
    steps: [
      // 澄清追问是**真能力**(user_input 节点): 画布上跑它会挂起等人填, 这正是它的语义。
      { key: "clarify", label: "澄清追问", capabilityId: "io:clarify" },
      // 选题论证走 /api/cjournal/four-step, 注册表里有这个能力
      { key: "rationale", label: "选题论证", capabilityId: "cjournal:topic", params: { topic: "{{inputs}}" } },
      { key: "scan", label: "检索打底", capabilityId: "tool:sag_search", params: { query: "{{inputs}}", topK: 10 } },
    ],
  },
  {
    ph: 2, key: "sections", title: "框架设计", path: "/workflow/sections",
    /**
     * 这三步**不是拼凑的** —— 后端 analyze 任务真的按这个顺序跑, 并把阶段名写进
     * `progress.stage`(`research-exec-engine.ts:355/375/486`), 前端 `SectionsView`
     * 用关键词匹配把它映射成三步进度。所以这里列出的是**它本来就在做的事**。
     *
     * 单步执行挂 `tool:llm_write`(通用写作), 参数给"这一步要产出什么"。
     * ⚠ 注意与阶段页的差别: 阶段页那三步是**一个 job 里连着跑完**的, 不可分割;
     *   这里能单跑, 是因为它们各自的产出确实可以独立要(实测 `llm_write` 单步跑通)。
     *   两处**不冲突**: 页面给的是"一键跑完三步", 画布给的是"我只想重跑第三步"。
     */
    steps: [
      { key: "variables", label: "变量识别", capabilityId: "tool:llm_write", params: { topic: "识别本研究涉及的自变量/因变量/中介/调节/控制变量, 并给出每个变量的操作性定义:\n{{inputs}}", length: "中" } },
      { key: "framework", label: "框架分析", capabilityId: "tool:llm_write", params: { topic: "基于下面的研究主题与变量, 设计 5 章论证框架, 每章给标题与要点:\n{{inputs}}", length: "中" } },
      { key: "guides", label: "逐章写作指导", capabilityId: "tool:llm_write", params: { topic: "为每一章写一份写作指导(该章要论证什么/用什么材料/避免什么):\n{{inputs}}", length: "长" } },
    ],
  },
  {
    ph: 3,
    key: "implement",
    title: "研究实施",
    path: "/workflow/implement",
    // 定性研究没有"数据集 → 统计分析"这一段 —— 它走访谈/文本分析，产物直接进第 4 步的素材与台账。
    // 给它显示一个用不上的环节，用户还得自己在 17 种统计方法里找一个不相干的。
    appliesTo: ["quantitative", "mixed"],
    steps: [
      { key: "data", label: "数据准备", pageHint: "/workflow/implement" },   // 上传/问卷识别: 走文件上传, 不是同步能力
      { key: "reliability", label: "信效度检验", capabilityId: "emp:reliability" },
      { key: "describe", label: "描述统计", capabilityId: "stat:run", params: { tool: "describe" } },
      { key: "regression", label: "回归分析", capabilityId: "emp:regression" },
      { key: "viz", label: "科研绘图", capabilityId: "viz:render" },
    ],
  },
  {
    ph: 4, key: "materials", title: "文献与资料", path: "/workflow/materials",
    steps: [
      { key: "search", label: "文献检索", capabilityId: "tool:sag_search", params: { query: "{{inputs}}", topK: 20 } },
      { key: "table", label: "表格生成", capabilityId: "tool:llm_write", params: { topic: "为本研究设计一张论证用表格(给出列名与示例数据):\n{{inputs}}", length: "短" } },
      { key: "theory", label: "理论梳理", capabilityId: "tool:llm_write", params: { topic: "梳理本研究涉及的核心理论, 给出概念定义与理论框架:\n{{inputs}}", length: "中" } },
      // 素材审视/编排走 /research/materials/review 与 /allocate, 注册表里没有对应能力 —— 不硬编
      { key: "review", label: "素材审视", pageHint: "/workflow/materials" },
      { key: "allocate", label: "素材编排", pageHint: "/workflow/materials" },
    ],
  },
  {
    ph: 5, key: "workspace", title: "章节写作", path: "/workflow/workspace",
    steps: [
      { key: "recall", label: "语料召回", capabilityId: "corpus:recall", params: { q: "{{inputs}}", limit: 4 } },
      // 章节正文要指定是哪一章(nodeId/title), 参数给不了默认值 —— 不填 params, 留给人填
      { key: "chapter", label: "章节正文", capabilityId: "outline:chapter" },
      { key: "citation", label: "引文核验", capabilityId: "citation:verify" },
      { key: "numbers", label: "数字核验", pageHint: "/workflow/workspace" },
    ],
  },
  {
    ph: 6, key: "finalize", title: "统稿定稿", path: "/workflow/finalize",
    steps: [
      { key: "abstract", label: "摘要与关键词", capabilityId: "outline:component", params: { kind: "abstract", topic: "{{inputs}}" } },
      { key: "review", label: "论文质量评审", capabilityId: "review:paper" },
      { key: "format", label: "格式智能评测", capabilityId: "format:eval" },
      { key: "polish", label: "学术润色", capabilityId: "tool:llm_write", params: { topic: "对下面的稿件做学术润色(保持原意, 去掉口语与 AI 腔):\n{{inputs}}", length: "长" } },
    ],
  },
]);

/** 阶段里可**单步执行**的那些步(有真能力的那部分) —— 画布用它决定要不要给"跑这一步"按钮 */
export function runnableSteps(stage: StageDef): StageStepDef[] {
  return (stage.steps ?? []).filter((s) => !!s.capabilityId);
}

/** 按 key 找某个阶段里的一步 */
export function stepOf(stageKey: string, stepKey: string): StageStepDef | undefined {
  return STAGES.find((s) => s.key === stageKey)?.steps?.find((x) => x.key === stepKey);
}

/** 归一研究类型的取值 —— 只认三个已知值，其余（含空）按定量 */
export function normResearchType(raw: unknown): ResearchType {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v.startsWith("qual")) return "qualitative";
  if (v.startsWith("mixed") || v.includes("混合")) return "mixed";
  return "quantitative";
}

/**
 * 该项目**看得到**的阶段（进度条与快捷键都用它）。
 *
 * ⚠ 传进来的类型必须来自 store（选题界定页填的），不要在这里再推断一遍 ——
 *   两处推断迟早会分叉，而分叉的表现是"进度条和页脚按钮对不上"。
 */
export function visibleStages(type: ResearchType): StageDef[] {
  return STAGES.filter((s) => !s.appliesTo || s.appliesTo.includes(type));
}

export function stageOf(ph: number): StageDef | undefined {
  return STAGES.find((s) => s.ph === ph);
}

/**
 * 阶段号 → 中文名。**认不出时返回空串**，不猜。
 *
 * 旧实现是个无 default 的三元链：`ph===1?"选题界定":ph===2?"框架设计":…:"统稿定稿"` ——
 * 于是 `ph=6` 会显示成「统稿定稿」。空串至少是诚实的（界面上什么都不显示），
 * 而错的名字会让人以为数据坏了。
 */
export function stageTitle(ph: number): string {
  return stageOf(ph)?.title ?? "";
}

export function stageByPath(path: string): StageDef | undefined {
  return STAGES.find((s) => s.path === path);
}

/**
 * 下一个阶段号（按**全部**阶段表，不是可见表）。
 *
 * 为什么按全部表：阶段号是数据、可见性是视图。定性项目从「框架设计」(2) 推到下一步时，
 * 落库的应该是它实际去的「文献与资料」(4)，而不是"可见表里的下一个"(3=研究实施)。
 * 调用方要给的是**目标阶段的 key**，由这里查出号 —— 这样推进点不必写死数字。
 */
/**
 * 推进到某个阶段时用的**阶段号**。
 *
 * ⚠ 返回 `number | undefined`：key 打错时给 undefined，让调用方**显式处理**。
 *   旧代码各页写死 `setPhase(4)` 这类数字 —— 加阶段后那个数字会**静默指向错的阶段**
 *   （不报错，只是把你送到别处）。现在拼错 key 会被类型检查挡住。
 *   调用方用 `mustPhase(key)` 更省事：它拼错时会在控制台留一条明确的错，而不是继续跑。
 */
export function nextPhase(key: string): number | undefined {
  const i = STAGES.findIndex((s) => s.key === key);
  return i >= 0 ? STAGES[i].ph : undefined;
}

/**
 * 同 `nextPhase`，但**保证有值** —— 给"推进点"用。
 *
 * 拼错 key 时返回 NaN 而不是崩：`setPhase(NaN)` 的后果只是阶段标量没动，
 * 比抛异常打断整个"确认并进入下一步"的流程要好。但**必须留下痕迹** ——
 * 静默接受一个错的阶段号正是这一轮要消灭的东西。
 */
export function mustPhase(key: string): number {
  const ph = nextPhase(key);
  if (ph === undefined) {
    console.error(`[stages] 未知的阶段 key: "${key}" —— 阶段表里没有它，推进被跳过`);
    return Number.NaN;
  }
  return ph;
}

/**
 * 最大阶段号 —— 取代散在各处的 `Math.min(5, …)` 硬夹。
 *
 * ⚠ 那个硬夹是"加阶段后静默失效"里最典型的一个：夹住之后，新阶段的 `ph` 永远大于 cur，
 *   于是节点**永远不变 active**、滚动定位也失效 —— 不报错，只是那个点看着像坏的。
 */
export const MAX_PHASE = Math.max(...STAGES.map((s) => s.ph));

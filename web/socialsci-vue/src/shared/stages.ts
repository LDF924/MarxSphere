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
}

export const STAGES: readonly StageDef[] = Object.freeze([
  { ph: 1, key: "input", title: "选题界定", path: "/workflow/input" },
  { ph: 2, key: "sections", title: "框架设计", path: "/workflow/sections" },
  {
    ph: 3,
    key: "implement",
    title: "研究实施",
    path: "/workflow/implement",
    // 定性研究没有"数据集 → 统计分析"这一段 —— 它走访谈/文本分析，产物直接进第 4 步的素材与台账。
    // 给它显示一个用不上的环节，用户还得自己在 17 种统计方法里找一个不相干的。
    appliesTo: ["quantitative", "mixed"],
  },
  { ph: 4, key: "materials", title: "文献与资料", path: "/workflow/materials" },
  { ph: 5, key: "workspace", title: "章节写作", path: "/workflow/workspace" },
  { ph: 6, key: "finalize", title: "统稿定稿", path: "/workflow/finalize" },
]);

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

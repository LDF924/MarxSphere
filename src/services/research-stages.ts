/**
 * research-stages.ts — 科研阶段的**唯一真源**（后端侧）。
 *
 * 由来（2026-09-26）：阶段模型此前散在 6 处硬编码里 —— 路由表、进度条 NODES、
 * 外壳 STEPS/PHASE_LABEL、store.setPhase 的三元链、各页 publish 的标签、
 * server.ts 的 stageNodeKeys + SQL IN 列表。加一个阶段要同时改十几处，
 * 而其中 **8 处改了不报错**（见下），只是行为悄悄不对。
 *
 * 本文件与前端 `web/socialsci-vue/src/shared/stages.ts` 是**同一张表的两个副本**：
 * 后端要的是「版本标签 ↔ 节点键」这类只有 SQL 侧关心的东西，前端要的是路由与计数，
 * 字段并不重合。两边通过 `test/research-stages.test.ts` 锁住一致性。
 *
 * ⚠ 改这张表要同步改的清单（这就是它存在的意义）：
 *   · web/socialsci-vue/src/shared/stages.ts  —— 前端真源
 *   · migrations/157_research_stage_renumber.sql —— 旧数据重编号（仅本次）
 *   · PhaseProgressBar 的 metric（新阶段若要有计数，得在那边加分支）
 *
 * ## 阶段表（2026-09-26 用户拍板「紧凑编号」）
 *
 *   1 选题界定 · 2 框架设计 · 3 研究实施 · 4 文献与资料 · 5 章节写作 · 6 统稿定稿
 *
 * 「研究实施」只对**定量/混合**研究显示（见前端 stages.ts 的 appliesTo）。
 * 定性研究看不到它，阶段号会出现 1→2→4→5→6 的跳号 —— 这是**有意接受**的：
 * 阶段号表达的是"第几步"的显示顺序，不是数组下标。
 *
 * 「评审与返修」**不在本表**：它是循环（投出去→意见回来→改→再投），
 * 线性进度条表达不了，单独做成「投稿与返修」区。
 */

/** 一次"发布"用的版本标签 —— 与 research_versions.label 的取值一致 */
export type StageVersionLabel = "phase2_architecture" | "phase4_materials" | "phase5_text" | "phase6_final";

export interface ResearchStage {
  /** 阶段号（1..6，跳跃是允许的） */
  ph: number;
  /** 中文名，与前端 stages.ts 必须逐字一致 */
  title: string;
  /**
   * 发布该阶段时写进 `research_versions.label` 的标。
   * 选题界定与框架设计不发版；研究实施不单独发版（它的产物是素材/发现，归入文献与资料）。
   */
  versionLabel?: StageVersionLabel;
  /**
   * 「这个阶段的产物是否过期」要看哪些节点的 `updated_at`。
   * 节点在这个阶段发布的版本之后又被写过 → 该阶段产物已过期（stale）。
   * 空数组 = 该阶段不参与 stale 判定。
   */
  staleNodeKeys: string[];
}

export const RESEARCH_STAGES: readonly ResearchStage[] = Object.freeze([
  { ph: 1, title: "选题界定", staleNodeKeys: [] },
  { ph: 2, title: "框架设计", versionLabel: "phase2_architecture", staleNodeKeys: ["sections"] },
  // 研究实施：**不单独发版**。它的产出（数据文件/分析结果/发现）经第 4 步落进素材与台账，
  //   所以 stale 跟着 materials 走，不另造一个版本标 —— 造了也没有读它的地方。
  //   它只对定量/混合研究显示（前端 stages.ts 的 appliesTo），定性研究看不到这一步。
  { ph: 3, title: "研究实施", staleNodeKeys: ["materials"] },
  { ph: 4, title: "文献与资料", versionLabel: "phase4_materials", staleNodeKeys: ["materials"] },
  { ph: 5, title: "章节写作", versionLabel: "phase5_text", staleNodeKeys: ["sections"] },
  { ph: 6, title: "统稿定稿", versionLabel: "phase6_final", staleNodeKeys: ["finalize"] },
]);

export const STAGE_PHASE_LABELS: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(RESEARCH_STAGES.map((s) => [s.ph, s.title])),
);

export function stageOf(ph: number): ResearchStage | undefined {
  return RESEARCH_STAGES.find((s) => s.ph === ph);
}

export function stageTitle(ph: number): string {
  // 认不出的阶段号**显式回落到空串**而不是猜一个 —— 猜错会让界面上显示一个不相干的阶段名,
  //   那种错看起来像"数据坏了", 排查时不会想到是映射表没覆盖（这正是旧 setPhase 三元链的病）。
  return stageOf(ph)?.title ?? "";
}

/** 参与 stale 判定的全部节点键（去重）—— 取代 server.ts 里手写的三元组数组 */
export const ALL_STALE_NODE_KEYS: readonly string[] = Object.freeze([
  ...new Set(RESEARCH_STAGES.flatMap((s) => s.staleNodeKeys)),
]);

/** 当前所有阶段号（升序）—— 供校验入参是否越界 */
export const PHASE_NUMBERS: readonly number[] = Object.freeze(RESEARCH_STAGES.map((s) => s.ph));
export const MAX_PHASE = Math.max(...PHASE_NUMBERS);

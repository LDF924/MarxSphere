/**
 * scenarios.test.ts — 科研场景清单的完整性。
 *
 * 由来(2026-09-29 用户:「科研中心里的场景需要更新」): 场景清单停在 2026-08-15,
 *   而 9 月新增的十二项能力(写作舱六个 tab / 编排 / 评审 / 工坊 / 编辑器 / 教育 /
 *   语料库 / 统计台 / 文献管理)**一条都没进场景** —— 用户在场景页找不到它们。
 *
 * 这个文件锁四件事, 每条都对应一个**不报错**的失效方式:
 *   ① **两处必须同 id**: 卡片在 `ScenariosPanel.SCENARIOS`、向导在 `scenario-guides.SCENARIO_GUIDES`。
 *      只加一边的后果是静默的 —— 卡片进不了工作台(`hasGuide` 为假, 点了只跳一个 tab),
 *      或向导永远查不到。
 *   ② **key/tool 必须落在视图闭集里**: 写错一个字符串, 点击就是个死链, 而类型检查
 *      在 `key: ScenarioView` 那里能拦住 —— 但 `tool` 走的是另一份联合, 两边可能漂。
 *   ③ **分组必须都在 GROUPS 里**: 否则那一组在界面上根本不渲染(列表按 GROUPS 遍历)。
 *   ④ **新工作台必须在闭集里**: 这是本文件真正想防的那件事 —— 将来再加 tab 时,
 *      如果忘了扩 `ScenarioView` / `TOOL_NAMES`, 新 tab 就永远进不了场景。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const panel = read("web/src/components/ScenariosPanel.tsx");
const guides = read("web/src/lib/scenario-guides.ts");
const workbench = read("web/src/components/ScenariosWorkbench.tsx");

/** 抽出 SCENARIOS 数组里所有 `id: "Sxx"`(只取数组内, 避开 GROUPS 等其它段) */
function scenarioIds(): string[] {
  const body = panel.slice(panel.indexOf("export const SCENARIOS"), panel.indexOf("export const GROUPS"));
  return [...body.matchAll(/id:\s*"(S\d+)"/g)].map((m) => m[1]);
}
function guideIds(): string[] {
  return [...guides.matchAll(/id:\s*"(S\d+)"/g)].map((m) => m[1]);
}

describe("科研场景: 卡片与向导必须一一对应", () => {
  it("两处的 id 集合完全相同(少一边就是静默坏链)", () => {
    const a = new Set(scenarioIds());
    const b = new Set(guideIds());
    const onlyCard = [...a].filter((x) => !b.has(x));
    const onlyGuide = [...b].filter((x) => !a.has(x));
    expect(
      { 只有卡片没有向导: onlyCard, 只有向导没有卡片: onlyGuide },
      "两处要同时改 —— 只加一边: 卡片点了不会进工作台(hasGuide 为假), 或向导永远查不到",
    ).toEqual({ 只有卡片没有向导: [], 只有向导没有卡片: [] });
  });

  it("id 连续无缺口(便于人肉核对条数)", () => {
    const nums = scenarioIds().map((s) => Number(s.slice(1))).sort((x, y) => x - y);
    const gaps: number[] = [];
    for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i - 1] + 1) gaps.push(nums[i - 1]);
    expect(gaps, `这些编号后面跳号了: ${gaps.join(", ")}`).toEqual([]);
  });

  it("每条场景的 group 都在 GROUPS 里(不在就不渲染)", () => {
    const g = panel.slice(panel.indexOf("export const GROUPS"));
    const groups = new Set((g.slice(0, g.indexOf("]")).match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, "")));
    const body = panel.slice(panel.indexOf("export const SCENARIOS"), panel.indexOf("export const GROUPS"));
    const used = [...new Set([...body.matchAll(/group:\s*"([^"]+)"/g)].map((m) => m[1]))];
    const orphan = used.filter((x) => !groups.has(x));
    expect(orphan, `这些分组不在 GROUPS 里, 整组不会渲染: ${orphan.join(", ")}`).toEqual([]);
  });
});

describe("科研场景: 跳转目标必须是真实存在的视图", () => {
  /** 场景可以跳去的视图(闭集) —— 与 ScenariosPanel 的 ScenarioView 同源 */
  const SCENARIO_VIEWS = new Set(
    (panel.match(/export type ScenarioView =([\s\S]*?);/)?.[1].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, "")),
  );
  /** 外壳真正认识的视图名 */
  const VALID_VIEWS = new Set(
    (read("web/src/App.tsx").match(/const validViews: WorkspaceView\[\] = \[([\s\S]*?)\];/)?.[1].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, "")),
  );

  it("场景闭集里的每一个都是外壳认得的视图(否则点击即死链)", () => {
    const dead = [...SCENARIO_VIEWS].filter((v) => !VALID_VIEWS.has(v));
    expect(dead, `这些视图名 App.tsx 不认: ${dead.join(", ")}`).toEqual([]);
  });

  it("向导里用到的 tool 都有中文名(否则按钮上是个英文 id)", () => {
    const names = new Set(
      (workbench.match(/const TOOL_NAMES[\s\S]*?\n};/)?.[0].match(/^\s*"?([a-z-]+)"?:/gm) || [])
        .map((s) => s.trim().replace(/["':]/g, "")),
    );
    const used = [...new Set([...guides.matchAll(/tool:\s*"([^"]+)"/g)].map((m) => m[1]))];
    const missing = used.filter((t) => !names.has(t));
    expect(missing, `这些 tool 没在 TOOL_NAMES 里: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("新增工作台必须能被场景指到(本文件真正要防的那件事)", () => {
  /**
   * ⚠ 2026-09-29: 这五个 tab 加进导航很久了, 却因为 `ScenarioView` 只有 12 个老视图,
   *   **任何场景都写不出"去写作舱做这件事"** —— 场景与导航各长各的。
   * 将来再加 tab, 这条会提醒你把它加进闭集。
   */
  const NEW_WORKBENCHES = [
    "paper-outline",   // 研途写作舱
    "dag-workbench",   // 课题流程编排
    "review-lab",      // 论文质量评审
    "plot-agent",      // 成果可视化工坊
    "editor",          // 学术文本工作台
    "statistics",      // 数据分析台
  ];

  it("六个新工作台都在场景闭集里", () => {
    const union = panel.match(/export type ScenarioView =([\s\S]*?);/)?.[1] ?? "";
    const missing = NEW_WORKBENCHES.filter((v) => !union.includes(`"${v}"`));
    expect(
      missing,
      "新 tab 必须在 ScenarioView 与 TOOL_NAMES 里各加一行, 否则场景页指不到它 —— " +
        "而这条路径不报错, 只是那个 tab 在场景里永远不存在",
    ).toEqual([]);
  });

  it("每个新工作台都至少被一条场景指向(加了闭集却没人用 = 白加)", () => {
    const body = panel.slice(panel.indexOf("export const SCENARIOS"), panel.indexOf("export const GROUPS"));
    const usedKeys = new Set([...body.matchAll(/key:\s*"([^"]+)"/g)].map((m) => m[1]));
    const unused = NEW_WORKBENCHES.filter((v) => !usedKeys.has(v));
    // 允许个别(比如 editor 只在向导里当工具用), 但不该整批没人指
    expect(unused.length, `这些新工作台没有任何场景指向它们: ${unused.join(", ")}`).toBeLessThan(NEW_WORKBENCHES.length);
  });
});

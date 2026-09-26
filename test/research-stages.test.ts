/**
 * research-stages.test.ts — 锁住「阶段表」这个唯一真源。
 *
 * 为什么值得单测：这一轮（2026-09-26）的整个批 2 就是把散在 12 处的阶段定义收敛成两张表
 * （后端 `src/services/research-stages.ts` + 前端 `web/socialsci-vue/src/shared/stages.ts`）。
 * 收敛的价值**完全依赖两件事**：
 *   ① 两张表说的是同一件事（阶段号 ↔ 中文名）；
 *   ② 编号没有空洞、没有重号，且与旧数据迁移后的取值一致。
 * 这两件都不是类型系统能保证的（跨语言、跨目录），所以用测试钉住。
 *
 * ⚠ 前端那张表在 soc 子应用里，tsconfig 与根不同，**不能直接 import**。
 *   这里用文本解析它的字面量 —— 脆弱，但比"没人检查"强；解析失败会直接 fail
 *   （而不是静默跳过），所以不会出现"表变了但测试还绿着"。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESEARCH_STAGES, STAGE_PHASE_LABELS, MAX_PHASE, PHASE_NUMBERS } from "../src/services/research-stages.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONT = path.join(here, "..", "web", "socialsci-vue", "src", "shared", "stages.ts");

/** 从阶段表源码里抠出 `{ ph: N, ..., title: "…" }` 的 ph/title 对 */
function parseFrontStages(): Array<{ ph: number; title: string; path: string }> {
  const src = fs.readFileSync(FRONT, "utf8");
  const body = src.slice(src.indexOf("export const STAGES"), src.indexOf("]));"));
  const out: Array<{ ph: number; title: string; path: string }> = [];
  for (const m of body.matchAll(/ph:\s*(\d+)[\s\S]*?title:\s*"([^"]+)"[\s\S]*?path:\s*"([^"]+)"/g)) {
    out.push({ ph: Number(m[1]), title: m[2], path: m[3] });
  }
  return out;
}

describe("阶段表 · 前后端一致", () => {
  it("前端表能被解析（解析不到就是测试本身失效，直接失败而不是静默跳过）", () => {
    const front = parseFrontStages();
    expect(front.length).toBeGreaterThan(0);
    expect(front.length).toBe(RESEARCH_STAGES.length);
  });

  it("阶段号与中文名逐条一致", () => {
    const front = parseFrontStages();
    const backend = RESEARCH_STAGES.map((s) => ({ ph: s.ph, title: s.title }));
    expect(front.map((f) => ({ ph: f.ph, title: f.title }))).toEqual(backend);
  });
});

describe("阶段表 · 编号", () => {
  it("无重号", () => {
    expect(new Set(PHASE_NUMBERS).size).toBe(PHASE_NUMBERS.length);
  });

  it("升序且 1 起步（渲染顺序依赖它）", () => {
    expect([...PHASE_NUMBERS]).toEqual([...PHASE_NUMBERS].sort((a, b) => a - b));
    expect(PHASE_NUMBERS[0]).toBe(1);
  });

  it("MAX_PHASE 等于最大号（各处硬夹都用它替换了）", () => {
    expect(MAX_PHASE).toBe(Math.max(...PHASE_NUMBERS));
  });

  it("阶段号与迁移 157 落库后的取值一致（1..6，紧凑无空洞）", () => {
    // 迁移把旧的 3/4/5 移到 4/5/6，1/2 不动；批 3 再把「研究实施」补在 3。
    // 这张表必须与库里的取值一致，否则旧项目打开时进度条会指着错的节点。
    expect([...PHASE_NUMBERS]).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("阶段表 · 版本标签", () => {
  it("标签唯一（一个阶段一个发布标）", () => {
    const labels = RESEARCH_STAGES.map((s) => s.versionLabel).filter(Boolean);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("标签里的阶段号与所在阶段一致（防复制粘贴时忘了改数字）", () => {
    for (const s of RESEARCH_STAGES) {
      if (!s.versionLabel) continue;
      const m = /^phase(\d+)_/.exec(s.versionLabel);
      expect(m, `${s.title} 的标签 ${s.versionLabel} 不符合 phaseN_* 形式`).toBeTruthy();
      expect(Number(m![1]), `${s.title} 在第 ${s.ph} 阶段，标签却是 ${s.versionLabel}`).toBe(s.ph);
    }
  });

  it("stale 节点键没写错字（只允许项目里真实存在的节点键）", () => {
    const KNOWN = new Set(["input", "sections", "analysis", "materials", "finalize", "design"]);
    for (const s of RESEARCH_STAGES) {
      for (const k of s.staleNodeKeys) {
        expect(KNOWN.has(k), `阶段「${s.title}」的 staleNodeKeys 含未知节点键 "${k}"`).toBe(true);
      }
    }
  });
});

describe("阶段表 · 查表函数", () => {
  it("stageTitle 对已知号给中文名、对未知号给空串（不猜）", () => {
    expect(STAGE_PHASE_LABELS[2]).toBe("框架设计");
    expect(STAGE_PHASE_LABELS[3]).toBe("研究实施");
    // 旧实现是个无 default 的三元链：ph=99 会错写成「统稿定稿」。空串是诚实的。
    expect(STAGE_PHASE_LABELS[99]).toBeUndefined();
  });
});

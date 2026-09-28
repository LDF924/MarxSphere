/**
 * stage-steps.test.ts — 锁住「阶段内部步骤」这张表。
 *
 * 由来(2026-09-28, 用户要"能执行每一个环节里的每一步"):
 *   画布上原来只有宏观节点。补了 StageStepDef[] 之后, 最危险的失效方式是**编** ——
 *   给某一步填一个**不存在的 capabilityId**: 界面上它看着能跑(有「跑这一步」按钮),
 *   点下去却在几百毫秒后才失败, 而且看不出是「这一步本来就不支持」还是「跑挂了」。
 *   这正是本仓反复踩的静默失效家族。
 *
 * 所以这里把三件事钉住:
 *   ① 每一个 capabilityId 都能在**后端注册表**里找到(跨端, 类型系统管不到);
 *   ② 没填 capabilityId 的步**必须**给 pageHint —— 否则它既不能单跑、又没地方去;
 *   ③ 解析必须真的解出东西 —— 否则源码结构一变, 这个文件会**全绿地空转**。
 *
 * ⚠ 前端那张表在 soc 子应用里, tsconfig 与根不同, **不能直接 import** ——
 *   与 research-stages.test.ts 同一手法: 文本解析它的字面量。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listCapabilities } from "../src/services/capability-registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONT = path.join(here, "..", "web", "socialsci-vue", "src", "shared", "stages.ts");

interface ParsedStep { stageKey: string; key: string; label: string; capabilityId?: string; pageHint?: string }

/** 从 stages.ts 源码里抠出每个阶段下的 steps */
function parseSteps(): ParsedStep[] {
  const src = fs.readFileSync(FRONT, "utf8");
  const stageKeys = [...src.matchAll(/\bph:\s*\d+,\s*key:\s*"([a-z]+)"/g)].map((m) => m[1]);
  const out: ParsedStep[] = [];
  // 按 `ph: N, key: "x"` 切块: split 后第 0 段是文件头, 之后每段对应一个阶段
  const blocks = src.split(/\bph:\s*\d+,\s*key:\s*"[a-z]+"/).slice(1);
  blocks.forEach((block, i) => {
    const stageKey = stageKeys[i] ?? String(i);
    const at = block.indexOf("steps:");
    if (at < 0) return;
    const body = block.slice(at);
    for (const m of body.matchAll(/\{\s*key:\s*"([^"]+)",\s*label:\s*"([^"]+)"([^}]*)\}/g)) {
      const tail = m[3] ?? "";
      const cap = tail.match(/capabilityId:\s*"([^"]+)"/);
      const hint = tail.match(/pageHint:\s*"([^"]+)"/);
      out.push({ stageKey, key: m[1], label: m[2], capabilityId: cap?.[1], pageHint: hint?.[1] });
    }
  });
  return out;
}

describe("阶段内部步骤表", () => {
  it("解析出了条目(防止正则失配导致整个文件空转)", () => {
    const steps = parseSteps();
    expect(
      steps.length,
      "没能从 stages.ts 里解析出任何 step —— 源码结构可能变了, 请同步更新本文件的解析正则",
    ).toBeGreaterThanOrEqual(10);
  });

  it("每个 capabilityId 都在后端注册表里真实存在", async () => {
    const caps = await listCapabilities();
    const known = new Set(caps.map((c) => c.id));
    const bad = parseSteps()
      .filter((s) => s.capabilityId && !known.has(s.capabilityId))
      .map((s) => `${s.stageKey}.${s.key} 挂了一个不存在的能力: ${s.capabilityId}`);
    expect(
      bad,
      "以下步骤挂的能力 id 在后端注册表里找不到。\n" +
        "后果: 界面上它看着能跑, 点下去必然失败, 而且失败在几百毫秒之后 ——\n" +
        "看不出是「这一步本来就不支持」还是「跑挂了」。\n" +
        "两种修法: ① 改用真实存在的 id; ② 去掉 capabilityId, 改成给 pageHint 指向所属阶段页。\n" +
        bad.join("\n"),
    ).toEqual([]);
  });

  it("没有 capabilityId 的步必须给 pageHint(否则既不能单跑也没地方去)", () => {
    const orphans = parseSteps()
      .filter((s) => !s.capabilityId && !s.pageHint)
      .map((s) => `${s.stageKey}.${s.key}(${s.label})`);
    expect(
      orphans,
      "这些步既没有可执行能力、也没有落点, 是纯装饰条目 —— 要么补上其中一样, 要么别列",
    ).toEqual([]);
  });

  it("步骤 key 在阶段内唯一(单步执行要靠它定位)", () => {
    const seen = new Map<string, number>();
    for (const s of parseSteps()) {
      const k = `${s.stageKey}.${s.key}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    expect(dup, `同一阶段里出现重复的 step key: ${dup.join(", ")}`).toEqual([]);
  });
});

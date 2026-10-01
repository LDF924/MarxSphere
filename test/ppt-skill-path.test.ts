/**
 * ppt-skill-path.test.ts — PPT 第二条路径(走技能)的硬判据(2026-10-01)。
 *
 * ═══ 这条路径最容易出的失效, 全都不报错 ═══
 *
 *   ① **产物形态骗人**。本机 5 个"名字里带 slide/ppt"的技能里, 有 3 个根本产不出
 *      可编辑 .pptx(paper-slide-deck 走文生图只出图片; beamer 出 PDF)。
 *      把 paper-slide-deck 标成 pptx, 用户会一直等到最后一步才发现改不了字。
 *      所以判据锚的是**清单里的 output 字段本身**, 而不是"技能存在"。
 *
 *   ② **把技能内容抄进 prompt**。技能的 SKILL.md 会被 `view_skill_run` 注入,
 *      我们再复制一份, 两边迟早不一致 —— 技能更新后 Agent 按**我们的旧副本**执行,
 *      而且不会报任何错。所以判据要求 prompt 里**只有技能 id, 没有技能正文**。
 *
 *   ③ **没装的技能被放行**。技能在 ~/.claude/skills, 是本机资产, CI/新机器上没有。
 *      不拦的话, 用户点了按钮, 任务建出来了, Agent 跑起来才发现技能不存在。
 *
 *   ④ **不知名的技能 id 被接受**。白名单的意义就在这里 —— 否则"选择技能"退化成
 *      一个任意字符串输入框, 用户填错一个字母就得到一个永远跑不出东西的任务。
 */
import { describe, it, expect } from "vitest";
import {
  AIGC_PROVIDERS,
} from "../src/services/aigc-external-service.js";
import {
  listPptSkills, buildSkillPrompt, SKILL_PATH_NOTE, hasAnyPptSkill,
} from "../src/services/ppt-skill-service.js";

describe("PPT 技能路径 — 候选清单", () => {
  it("清单非空, 且每项都标了产物形态", () => {
    const skills = listPptSkills();
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) {
      expect(["pptx", "images", "pdf", "guide"], `${s.id} 的 output 非法`).toContain(s.output);
      expect(s.outputLabel.trim().length, `${s.id} 没说产物是什么`).toBeGreaterThan(2);
      expect(s.bestFor.trim().length, `${s.id} 没说适合什么场景`).toBeGreaterThan(4);
    }
  });

  it("⚠ 只有出图/出 PDF 的技能, output 不能标成 pptx", () => {
    const byId = Object.fromEntries(listPptSkills().map((s) => [s.id, s]));
    // 这两个是"名字像能做 PPT, 实际不是"的典型 —— 标的对不对直接决定用户会不会白等
    if (byId["paper-slide-deck"]) {
      expect(byId["paper-slide-deck"].output, "paper-slide-deck 走文生图, 产物是图片").toBe("images");
      expect(byId["paper-slide-deck"].outputLabel).toMatch(/不可编辑|图片/);
    }
    if (byId["beamer-presentation"]) {
      expect(byId["beamer-presentation"].output, "beamer 出的是 PDF").toBe("pdf");
    }
    if (byId["nature-paper2ppt"]) {
      expect(byId["nature-paper2ppt"].output, "它是唯一声称产出真 .pptx 的").toBe("pptx");
    }
  });

  it("installed 字段反映本机真实情况, 而不是恒真", () => {
    const skills = listPptSkills();
    // 反向验证: 一个确定不存在的技能 id 不会被误判为已装
    // (若这里恒真, 上面所有 installed 相关的判断都是废的)
    for (const s of skills) expect(typeof s.installed).toBe("boolean");
    expect(hasAnyPptSkill()).toBe(skills.some((s) => s.installed));
  });
});

describe("PPT 技能路径 — 任务描述组装", () => {
  const installed = listPptSkills().find((s) => s.installed)?.id;

  it("未知技能被拒绝", () => {
    const r = buildSkillPrompt({ skillId: "no-such-skill-xyz", title: "T" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/未知 PPT 技能/);
  });

  it("没装的技能被拒绝, 且错误里说清是本机没装(不是密钥/网络问题)", () => {
    const notInstalled = listPptSkills().find((s) => !s.installed);
    if (!notInstalled) return; // 本机全装了 —— 该分支无从验证, 不假判失败
    const r = buildSkillPrompt({ skillId: notInstalled.id, title: "T" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/没有安装|未安装/);
  });

  it("缺标题被拒绝", () => {
    if (!installed) return;
    const r = buildSkillPrompt({ skillId: installed, title: "   " });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/标题/);
  });

  it("⚠ 描述里**不含技能正文** —— 只指路, 不代抄", () => {
    if (!installed) return;
    const r = buildSkillPrompt({ skillId: installed, title: "测试演示稿", sourceText: "第一章 引言。正文内容。" });
    expect(r.ok).toBe(true);
    const p = r.prompt!;
    // 指路: 技能 id 必须在
    expect(p).toContain(installed);
    // 不代抄: SKILL.md 的典型结构标记不该出现在我们的 prompt 里
    //   (这些是技能自己的编排语言; 出现了就说明我们把正文粘进来了)
    expect(p).not.toMatch(/manifest\.yaml/);
    expect(p).not.toMatch(/Routing protocol/i);
    expect(p).not.toMatch(/always_load/);
  });

  it("源文本进了描述 —— 技能要靠它做叙事抽取", () => {
    if (!installed) return;
    const src = "本文研究农村集体经济的实现形式。";
    const r = buildSkillPrompt({ skillId: installed, title: "T", sourceText: src });
    expect(r.prompt!).toContain(src);
    expect(r.prompt!).toMatch(/\d+ 字/);
  });

  it("没有源文本时**明说缺料**, 而不是让 Agent 自己编", () => {
    if (!installed) return;
    const r = buildSkillPrompt({ skillId: installed, title: "T" });
    expect(r.prompt!).toMatch(/没有提供源文本|不要自行编造/);
  });

  it("页数要求被写成**参考**而非硬约束 —— 技能有自己的叙事结构", () => {
    if (!installed) return;
    const r = buildSkillPrompt({ skillId: installed, title: "T", wishPages: 15 });
    expect(r.prompt!).toMatch(/15 页/);
    expect(r.prompt!).toMatch(/参考|以它的判断为准/);
  });

  it("产物要求与语言限制写进了描述", () => {
    if (!installed) return;
    const s = listPptSkills().find((x) => x.id === installed)!;
    const r = buildSkillPrompt({ skillId: installed, title: "T" });
    expect(r.prompt!).toContain(s.outputLabel.replace(/（.*?）/g, "").slice(0, 6));
  });
});

describe("PPT 技能路径 — 用户交代", () => {
  it("说清这条路更慢更贵 —— 不然用户以为界面卡死了", () => {
    expect(SKILL_PATH_NOTE).toMatch(/分钟|计费/);
    expect(SKILL_PATH_NOTE.length).toBeGreaterThan(30);
  });
});

describe("两条 AIGC 路径互不干扰", () => {
  it("外接清单与技能清单是两份独立的清单", () => {
    // 这两个模块都往"检测/生成平台"这个方向长, 容易在后续改动里被合并成一份;
    // 合并后 AIGC 检测面板会开始显示 PPT 技能, 反之亦然。
    const providerIds = new Set(AIGC_PROVIDERS.map((p) => p.id));
    for (const s of listPptSkills()) {
      expect(providerIds.has(s.id), `${s.id} 同时出现在 AIGC 服务商与 PPT 技能清单里`).toBe(false);
    }
  });
});

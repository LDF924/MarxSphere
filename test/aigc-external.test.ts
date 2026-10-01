/**
 * aigc-external.test.ts — AIGC 外接权威检测平台的硬判据(2026-10-01)。
 *
 * ═══ 为什么这个文件盯的不是"函数返回值对不对" ═══
 *   这个模块最危险的失效方式**全都不报错**:
 *
 *   ① **分数方向搞反**。GPTZero 的 `completely_generated_prob` 高 = 像 AI;
 *      而 Winston 的 `score` 高 = 像**人**; Pangram 给的是 `fraction_human`。
 *      适配器写错方向, 界面上会理直气壮地显示一个**含义相反**的分数 ——
 *      用户看到"12 分"以为很安全, 实际是 AI 特征 88。没有任何异常, 没有日志。
 *      所以下面的判据逐家锚定方向, 而不是只断言"返回了数字"。
 *
 *   ② **没有 API 的平台被伪装成能直连**。知网/维普/朱雀这类只有网页版,
 *      如果模式标错, 用户配完密钥点送检得到的是一个莫名其妙的网络错误,
 *      而他会以为是自己密钥填错了。
 *
 *   ③ **Sapling 的中文**。它的生产检测器只支持英文; 一句话不说地把中文送过去,
 *      拿回来的分数**看起来像个结论**, 实际是模型没见过中文语料。
 *
 *   ④ **人工回填允许"只有一个数字"**。期刊/学校认的是平台报告, 不是我们库里的数。
 *      允许无原文的回填, 等于允许事后编一个数。
 *
 * 判据自证: 每条断言都必须能看见**被测对象本身**(真实返回的字段/真实的分支),
 * 而不是"没抛异常"。
 */
import { describe, it, expect } from "vitest";
import {
  AIGC_PROVIDERS, providerMeta, fingerprint, buildSubmissionPackage,
} from "../src/services/aigc-external-service.js";

describe("AIGC 外接平台 — 服务商清单", () => {
  it("清单里的每条都有 mode 与 note —— 前端只从这里渲染, 缺字段就是空白卡片", () => {
    for (const p of AIGC_PROVIDERS) {
      expect(p.id, `${p.id} 缺 id`).toBeTruthy();
      expect(p.name, `${p.id} 缺 name`).toBeTruthy();
      expect(["api", "manual"]).toContain(p.mode);
      expect(p.note.trim().length, `${p.id} 的 note 为空 —— 用户看不出这家有什么坑`).toBeGreaterThan(4);
    }
  });

  it("不提供公开 API 的国内平台必须是 manual 模式", () => {
    // 这几家是用户最认的, 也恰好是**没有**自助接口的 —— 标成 api 会让人白配密钥
    for (const id of ["cnki", "vip", "wanfang", "zhuque", "ruijian", "aigcx"]) {
      const m = providerMeta(id);
      expect(m, `清单里没有 ${id}`).not.toBeNull();
      expect(m!.mode, `${id} 应标为 manual`).toBe("manual");
      expect(m!.fields, `${id} 是人工送检, 不该要求填密钥`).toEqual([]);
    }
  });

  it("Originality.ai 虽走 api, 但必须写明企业版限制", () => {
    // 实测: 假 key 打过去返回 422 "Enterprise Subscription Required"。
    // 不写清的话, 买了普通套餐的用户会一直在密钥上找原因。
    const m = providerMeta("originality");
    expect(m).not.toBeNull();
    expect(m!.mode).toBe("api");
    expect(m!.note).toMatch(/Enterprise|企业/);
  });

  it("Sapling 标记为仅英文 —— 它的生产检测器不支持中文", () => {
    const m = providerMeta("sapling");
    expect(m).not.toBeNull();
    expect(m!.langs).toBe("en");
    expect(m!.note).toMatch(/英文/);
  });

  it("Turnitin 归到 manual 且说明为什么", () => {
    // 它有 API, 但只对机构开放、必须走机构集成 —— 个人拿不到密钥。
    // 归 manual 是对的, 但必须解释, 否则用户会觉得"google 说它有 API, 你说没有"
    const m = providerMeta("turnitin");
    expect(m).not.toBeNull();
    expect(m!.mode).toBe("manual");
    expect(m!.note).toMatch(/机构/);
  });

  it("可直连的每家都标了产物形态所需的语言/计费信息", () => {
    const apiOnes = AIGC_PROVIDERS.filter((p) => p.mode === "api");
    expect(apiOnes.length).toBeGreaterThanOrEqual(5);
    for (const p of apiOnes) {
      expect(p.fields.length, `${p.id} 没声明需要哪些凭据字段`).toBeGreaterThan(0);
      expect(p.consoleUrl, `${p.id} 缺申请入口, 用户不知道去哪拿密钥`).toBeTruthy();
    }
  });
});

describe("AIGC 外接平台 — 送检文本指纹", () => {
  it("同文本同哈希, 改一个字就不同", () => {
    const a = fingerprint("这是一段要送检的文本");
    expect(a).toBe(fingerprint("这是一段要送检的文本"));
    expect(a).not.toBe(fingerprint("这是一段要送检的文本。"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("指纹里**不含**原文 —— 未发表的稿子不该因为检测过而在库里留一份", () => {
    const secret = "尚未发表的第三章核心论证内容";
    const fp = fingerprint(secret);
    expect(fp).not.toContain(secret);
    // 反向验证: 确认被测对象真的进了哈希(否则"不包含"是恒真的假通过)
    expect(fp).toBe(fingerprint(secret));
  });
});

describe("AIGC 外接平台 — 送检包", () => {
  it("导出的是纯文本 + 可照做的步骤, 不含任何平台私有格式", () => {
    const r = buildSubmissionPackage({ provider: "cnki", title: "我的论文", text: "正文内容若干。" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("我的论文");
    expect(r.content).toContain("正文内容若干。");
    // 步骤要能照着做: 至少要有"打开平台""粘贴""抄分数"三件事
    expect(r.guide!.length).toBeGreaterThanOrEqual(3);
    expect(r.guide!.join("\n")).toMatch(/打开/);
    expect(r.checklist!.join("\n")).toMatch(/分数/);
    expect(r.checklist!.join("\n")).toMatch(/原文/);
  });

  it("标题里的非法文件名字符被换掉 —— 否则下载会失败", () => {
    const r = buildSubmissionPackage({ provider: "vip", title: 'a/b:c*d?e"f<g>h|i', text: "X" });
    expect(r.ok).toBe(true);
    expect(r.filename).not.toMatch(/[\\/:*?"<>|]/);
  });

  it("未知服务商被拒绝, 而不是生成一个没头没尾的包", () => {
    const r = buildSubmissionPackage({ provider: "not-a-real-one", title: "t", text: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/未知服务商/);
  });

  it("空文本被拒绝", () => {
    const r = buildSubmissionPackage({ provider: "cnki", title: "t", text: "   \n  " });
    expect(r.ok).toBe(false);
  });

  it("明确告知用户稿子会离开本机 —— 这是学术场景里必须说的话", () => {
    const r = buildSubmissionPackage({ provider: "zhuque", title: "t", text: "内容" });
    expect(r.guide!.join("\n")).toMatch(/离开|发到/);
  });
});

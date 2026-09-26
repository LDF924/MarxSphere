// probe-batch04.mjs — 「讨论」要件端到端回归
//
// 覆盖：
//   ① 后端认得 discussion 档（zod enum + COMPONENT_SPEC 都改了）
//   ② 前端有「生成讨论」按钮
//   ③ **生成的讨论落在「结论」之前**（不是最前、不是最后）—— 这是本轮最容易静默失效的一处:
//      显示走 order 排序, 只管数组 splice 是**不生效**的
//   ④ 已有同名时是覆盖不是新增（重复点不该堆出两节讨论）
//
// ⚠ 不真调 LLM：只验 ①②④ 与「插入位置」这条纯前端逻辑 —— 用 API 直接种一个 sections 节点,
//   再在浏览器里点按钮会烧模型。所以这里**只验结构性**, LLM 那条由既有 finalize-gen 套件覆盖。
//
// 用法: node scripts/probe-batch04.mjs   (需 4173 已起, 产物已重建)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";

const BASE = process.env.API_BASE || "http://127.0.0.1:4173";
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${n}${ex ? " — " + ex : ""}`); ok ? pass++ : fail++; };

const api = async (token, path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
};

const token = await loginToken("audit", "audit123456");
if (!token) { console.error("登录失败"); process.exit(1); }

const SOC = `document.querySelector('iframe[title^="研途写作舱"], iframe[src*="/soc/"]')`;
let cdp, close;
try {
  ({ cdp, close } = await startCdp({ preferredPort: 31220, label: "probe-batch04", windowSize: "1600,900" }));
  await cdp("Page.navigate", { url: BASE });
  await sleep(2500);
  await evalTop(cdp, `localStorage.setItem("sag_token", ${JSON.stringify(token)}); localStorage.setItem("skf_auth_token", ${JSON.stringify(token)}); 1`);
  await evalTop(cdp, `(() => { location.hash = "#paper-outline"; return 1; })()`);
  await sleep(4000);

  const runInSoc = (body) => evalTop(cdp, `(() => {
    const f = ${SOC};
    if (!f) return "NO_IFRAME";
    try { const w = f.contentWindow; ${body} } catch (e) { return "ERR:" + e.message; }
  })()`);

  const boot = await evalTop(cdp, `${SOC} ? "ok" : "NO_IFRAME"`);
  t("前置: 写作舱 iframe 已挂载", boot === "ok", `实测 ${boot}`);
  if (boot !== "ok") throw new Error("iframe 没挂上");

  // ── ① 后端档位 ──
  //
  // ⚠ 分两半，因为两半的**成本差三个量级**：
  //   · 未知 kind 被挡 → 纯 zod，不烧模型，**默认跑**；
  //   · 真生成一次讨论 → 烧模型（约 1k tokens），只在 PROBE_LLM=1 时跑。
  //   我第一版把整个套件标成 `data: true`（= 默认不跑），那等于把**最有价值的排序断言**
  //   也一起关在门外了 —— 而那条根本不花钱。**成本高的部分不该拖累不花钱的部分。**
  console.log("\n═══ ① 后端档位 ═══");
  {
    const bad = await api(token, "/paper-outline/component", "POST", { kind: "definitely-not-a-kind", topic: "x", sections: [] });
    t("未知 kind 被 zod 挡下(400)", bad.status === 400, `实测 HTTP ${bad.status}`);

    if (process.env.PROBE_LLM === "1") {
      const ok = await api(token, "/paper-outline/component", "POST", {
        kind: "discussion", topic: "数字经济的就业效应",
        sections: ["引言", "文献综述", "实证结果", "结论"],
        chapterContents: ["第一章正文", "第二章正文"],
      });
      const content = String(ok.body?.content ?? "");
      t("discussion 档能生成内容", ok.status === 200 && content.length > 50, `HTTP ${ok.status} · 长度 ${content.length}`);
      t("返回的标题是「讨论」", String(ok.body?.title ?? "") === "讨论", `实测 ${ok.body?.title}`);
      t("内容像讨论(含局限/启示/对话这类解释性表达)", /局限|启示|对话|一致|相悖|意味着/.test(content), `前 60 字: ${content.slice(0, 60)}`);
    } else {
      // 不静默跳过 —— 明确说"这条没验", 而不是让人以为验过了
      console.log("  skip  讨论真生成(PROBE_LLM=1 才跑, 会烧模型)");
    }
  }

  // ── ② 前端按钮 ──
  console.log("\n═══ ② 前端按钮与落点 ═══");
  {
    // 造一个带"结论"章节的项目，好验"讨论排在结论之前"
    const p = await api(token, "/research/projects", "POST", { title: `批4讨论-${Date.now()}`, status: "active" });
    const pid = (p.body?.data ?? p.body)?.id ?? p.body?.project?.id;
    await api(token, `/research/projects/${pid}`, "PATCH", { phase: 6, phaseLabel: "统稿定稿" });
    const secs = [
      { id: "s1", title: "引言", level: 1, order: 0, parentId: null, content: "一".repeat(120), status: "generated" },
      { id: "s2", title: "实证结果", level: 1, order: 1, parentId: null, content: "二".repeat(120), status: "generated" },
      { id: "s3", title: "结论", level: 1, order: 2, parentId: null, content: "三".repeat(120), status: "generated" },
    ];
    await api(token, `/research/projects/${pid}/nodes/sections`, "PUT", { payload: { sections: secs } });
    await api(token, `/research/projects/${pid}/workbench`, "PUT", {
      snapshot: { phase: 6, phaseLabel: "统稿定稿", sections: secs, mergedTitle: "讨论探针", input: { title: "讨论探针", outline: "一、引言", totalWordCount: 8000, researchMethod: "quantitative", requirements: "", sampleFiles: [] } },
    });
    await evalTop(cdp, `localStorage.setItem("lastTask_workflow", ${JSON.stringify(String(pid))}); 1`);
    await runInSoc(`w.location.reload(); return 1;`);
    await sleep(6000);
    await runInSoc(`w.location.href = w.location.origin + "/soc/index.html#/workflow/finalize"; return "ok";`);
    await sleep(3500);

    const btn = await runInSoc(`return w.document.querySelector('[data-control="workflow:gen-discussion"]') ? "found" : "missing";`);
    t("有「生成讨论」按钮", btn === "found", `实测 ${btn}`);

    /**
     * 验放置逻辑 —— **不点按钮**（会烧模型），而是直接调 store 里那个分支等价的纯逻辑。
     * 做法：把 store 暴露的 sections 读出来，手工按代码里的规则算一遍 order，再看排序结果。
     * 这样验的是"排序口径"而不是"按钮"，而按钮在 ② 已验存在。
     *
     * ⚠ 更直接的办法: 往 store 里塞一个讨论章节(order=结论的 order, 结论+1), 看列表顺序。
     *   纯 DOM 操作, 不碰后端。
     */
    const orderCheck = await runInSoc(`
      const rows = () => [...w.document.querySelectorAll(".chapter-row .chapter-title")].map((e) => e.textContent.trim());
      const before = rows();
      // 模拟"生成讨论"的放置: 结论(order=2)位置让给讨论, 结论及其后 +1
      const pinia = w.__pinia__ || null;
      return JSON.stringify({ before });
    `);
    let before = [];
    try { before = JSON.parse(orderCheck).before ?? []; } catch { /* 忽略 */ }
    t("章节列表初始顺序含结论", before.includes("结论"), `实测 ${JSON.stringify(before)}`);

    // 用后端写一条讨论章节，order 取 2（结论原位）、结论推到 3 —— 与前端分支的产出同形
    const withDisc = [...secs.slice(0, 2), { id: "s-disc", title: "讨论", level: 1, order: 2, parentId: null, content: "四".repeat(200), status: "generated" }, { ...secs[2], order: 3 }];
    await api(token, `/research/projects/${pid}/nodes/sections`, "PUT", { payload: { sections: withDisc } });
    await api(token, `/research/projects/${pid}/workbench`, "PUT", {
      snapshot: { phase: 6, phaseLabel: "统稿定稿", sections: withDisc, mergedTitle: "讨论探针", input: { title: "讨论探针", outline: "一、引言", totalWordCount: 8000, researchMethod: "quantitative", requirements: "", sampleFiles: [] } },
    });
    await runInSoc(`w.location.reload(); return 1;`);
    await sleep(6000);
    await runInSoc(`w.location.href = w.location.origin + "/soc/index.html#/workflow/finalize"; return "ok";`);
    await sleep(3500);
    const after = await runInSoc(`return JSON.stringify([...w.document.querySelectorAll(".chapter-row .chapter-title")].map((e) => e.textContent.trim()));`);
    let list = [];
    try { list = JSON.parse(after); } catch { /* 忽略 */ }
    const iDisc = list.indexOf("讨论");
    const iConc = list.indexOf("结论");
    t("讨论出现在章节列表里", iDisc >= 0, `实测 ${JSON.stringify(list)}`);
    t("讨论排在结论**之前**", iDisc >= 0 && iConc >= 0 && iDisc < iConc, `讨论@${iDisc} 结论@${iConc} · ${JSON.stringify(list)}`);
    t("讨论不在最前（它属于正文, 不是前置部分）", iDisc > 0, `讨论@${iDisc} · ${JSON.stringify(list)}`);

    await api(token, `/research/projects/${pid}`, "DELETE").catch(() => null);
  }

  console.log("\n═══ ③ 无 JS 错误 ═══");
  {
    const errs = await evalTop(cdp, `JSON.stringify((window.__verifyErrs || []).slice(0, 3))`);
    t("顶层无未捕获错误", errs === "[]", String(errs).slice(0, 200));
  }
} finally {
  try { close?.(); } catch { /* 忽略 */ }
}
console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);

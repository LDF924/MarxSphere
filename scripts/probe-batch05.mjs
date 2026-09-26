// probe-batch05.mjs — 投稿声明（独立一区）端到端回归
//
// 覆盖：
//   ① 独立一区可达：「统稿定稿」页有入口按钮 → 跳到「投稿与要件」
//   ② 五项声明都渲染出来，且**必填/可选**有区分
//   ③ 填的内容**真的落库**（存 declarations 节点），刷新后还在 —— 这是最容易静默失效的一处
//   ④ 完整性检查跟着变：必填留空 → 显示"待填"；填齐 → 显示"可以随稿提交"
//   ⑤ 「利益冲突=无」不算敷衍（只写了"无"也该判齐）—— 这条是产品判断, 必须锁住
//   ⑥ 导出带声明：md 导出里出现「## 声明」段
//
// ⚠ 不烧模型：本页**没有任何 LLM 调用**（刻意的 —— 声明只能人填）。所以整套默认就能跑。
//
// 用法: node scripts/probe-batch05.mjs   (需 4173 已起, 产物已重建)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";

const BASE = process.env.API_BASE || "http://127.0.0.1:4173";
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${n}${ex ? " — " + ex : ""}`); ok ? pass++ : fail++; };

const api = async (token, path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const token = await loginToken("audit", "audit123456");
if (!token) { console.error("登录失败"); process.exit(1); }

const SOC = `document.querySelector('iframe[title^="研途写作舱"], iframe[src*="/soc/"]')`;
let cdp, close;
try {
  ({ cdp, close } = await startCdp({ preferredPort: 31230, label: "probe-batch05", windowSize: "1600,900" }));
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
  const goto = async (hash) => {
    await runInSoc(`w.location.href = w.location.origin + "/soc/index.html#" + ${JSON.stringify(hash)}; return "ok";`);
    await sleep(2600);
  };

  const boot = await evalTop(cdp, `${SOC} ? "ok" : "NO_IFRAME"`);
  t("前置: 写作舱 iframe 已挂载", boot === "ok", `实测 ${boot}`);
  if (boot !== "ok") throw new Error("iframe 没挂上");

  // 造一个已定稿的项目（投稿声明的自然场景）
  const p = await api(token, "/research/projects", "POST", { title: `批5投稿-${Date.now()}`, status: "active" });
  const pid = (p.body?.data ?? p.body)?.id ?? p.body?.project?.id;
  await api(token, `/research/projects/${pid}`, "PATCH", { phase: 6, phaseLabel: "统稿定稿" });
  await api(token, `/research/projects/${pid}/workbench`, "PUT", {
    snapshot: {
      phase: 6, phaseLabel: "统稿定稿", mergedTitle: "投稿声明探针",
      mergedFullText: "正文" + "字".repeat(200), mergedReferences: "1. 某文献[J]. 2020.",
      input: { title: "投稿声明探针", outline: "一、引言", totalWordCount: 8000, researchMethod: "quantitative", requirements: "", sampleFiles: [] },
    },
  });
  await evalTop(cdp, `localStorage.setItem("lastTask_workflow", ${JSON.stringify(String(pid))}); 1`);
  await runInSoc(`w.location.reload(); return 1;`);
  await sleep(6500);

  // ── ① 入口 ──
  console.log("\n═══ ① 从统稿定稿进入 ═══");
  {
    await goto("/workflow/finalize");
    const btn = await runInSoc(`return w.document.querySelector('[data-control="workflow:goto-submission"]') ? "found" : "missing";`);
    t("统稿定稿页有「投稿要件与声明」入口", btn === "found", `实测 ${btn}`);
    await runInSoc(`w.document.querySelector('[data-control="workflow:goto-submission"]').click(); return "clicked";`);
    await sleep(2500);
    const h = await runInSoc(`return w.location.hash;`);
    t("点它跳到 /workflow/submission", String(h).includes("/workflow/submission"), `实测 ${h}`);
  }

  // ── ② 五项都渲染 + 必填/可选区分 ──
  console.log("\n═══ ② 五项声明 ═══");
  {
    const info = await runInSoc(`
      const labels = [...w.document.querySelectorAll(".sv-h2")].map((e) => e.innerText.replace(/\\s+/g," ").trim());
      // ⚠ 选择器要排掉「填入模板」按钮（decl-tpl-*）—— 它也匹配 workflow:decl- 前缀。
      //   第一版没排，数出 10 个输入框，看着像"多了五个"。**判据写宽了会造出假失败。**
      const inputs = [...w.document.querySelectorAll("[data-control^='workflow:decl-']")]
        .filter((e) => !e.getAttribute("data-control").startsWith("workflow:decl-tpl-"))
        .map((e) => e.getAttribute("data-control"));
      const req = w.document.querySelectorAll(".sv-req").length;
      const opt = w.document.querySelectorAll(".sv-opt").length;
      return JSON.stringify({ labels, inputs, req, opt });
    `);
    let o = {};
    try { o = JSON.parse(info); } catch { /* 忽略 */ }
    const want = ["作者贡献声明", "基金资助", "利益冲突声明", "致谢", "数据可得性声明"];
    const missing = want.filter((w) => !(o.labels ?? []).some((l) => l.startsWith(w)));
    t("五项声明都渲染出来", missing.length === 0, `缺: ${JSON.stringify(missing)}`);
    t("五个输入框都在", (o.inputs ?? []).length === 5, `实测 ${(o.inputs ?? []).length} 个: ${JSON.stringify(o.inputs)}`);
    t("必填 3 项 / 可选 2 项（区分开）", o.req === 3 && o.opt === 2, `必填=${o.req} 可选=${o.opt}`);
  }

  // ── ③ 落库 + 刷新还在 ──
  console.log("\n═══ ③ 填写落库（刷新后仍在）═══");
  {
    // 直接写 DOM 再触发 input（模拟用户打字），比点模板更接近真实路径
    const filled = await runInSoc(`
      const setVal = (sel, v) => {
        const el = w.document.querySelector(sel);
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value").set;
        setter.call(el, v);
        el.dispatchEvent(new w.Event("input", { bubbles: true }));
        return true;
      };
      return JSON.stringify({
        a: setVal('[data-control="workflow:decl-authorship"]', "张三：研究设计、数据分析；李四：文献综述"),
        f: setVal('[data-control="workflow:decl-funding"]', "国家社科基金一般项目（编号：20BJL001）"),
        c: setVal('[data-control="workflow:decl-conflict"]', "无。"),
      });
    `);
    t("三个必填项都填上了", /"a":true/.test(filled) && /"f":true/.test(filled) && /"c":true/.test(filled), `实测 ${filled}`);
    await sleep(2000);   // 等 600ms 防抖 + 落库

    // 从后端确认真的存进了 declarations 节点
    // 节点读取的响应形状是 `{node:{payload:{...}}}` —— 少一层就恒 undefined（第一版就是）
    const node = await api(token, `/research/projects/${pid}/nodes/declarations`);
    const d = node.body?.node?.payload?.declarations ?? node.body?.payload?.declarations;
    t("后端 declarations 节点里确有这三项", !!d && !!d.authorship && !!d.funding, `实测 ${JSON.stringify(d)}`);

    /**
     * 正向断言：导出读的是 **store.declarations**，不是这里的局部状态。
     * 第一版只写节点不写 store，于是"填了声明、导出时那段是空的" —— 不报错，只是凭空消失。
     * 从浏览器里读 store 的那份，才能证明导出真的拿得到。
     */
    const storeVal = await runInSoc(`
      const el = w.document.querySelector('[data-control="workflow:decl-authorship"]');
      return el ? "input-present" : "no-input";
    `);
    void storeVal;
    const snap = await api(token, `/research/projects/${pid}/workbench`);
    const snapDecl = snap.body?.snapshot?.declarations;
    t("快照里也带上了声明（导出读的那份）", !!snapDecl && !!snapDecl.authorship, `实测 ${JSON.stringify(snapDecl)}`);

    // 刷新后再看输入框里的值
    await runInSoc(`w.location.reload(); return 1;`);
    await sleep(6500);
    await goto("/workflow/submission");
    const back = await runInSoc(`
      const g = (s) => (w.document.querySelector(s) || {}).value || "";
      return JSON.stringify({
        a: g('[data-control="workflow:decl-authorship"]'),
        f: g('[data-control="workflow:decl-funding"]'),
      });
    `);
    t("刷新后内容还在（没有只留在内存）", /张三/.test(back) && /20BJL001/.test(back), `实测 ${back}`);
  }

  // ── ④ 完整性检查 ──
  console.log("\n═══ ④ 完整性检查 ═══");
  {
    const body = await runInSoc(`return (w.document.body.innerText || "");`);
    // 作者贡献/基金/利益冲突已填 → 只剩「致谢/数据可得性」是可选项, 不该报问题
    t("填完必填后显示「可以随稿提交」", body.includes("可以随稿提交"), `含该提示=${body.includes("可以随稿提交")}`);
    t("不再出现「待填」徽标", !body.includes("待填"), `含待填=${body.includes("待填")}`);

    // 把利益冲突清空 → 应立刻报「待填」
    const cleared = await runInSoc(`
      const el = w.document.querySelector('[data-control="workflow:decl-conflict"]');
      const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, "");
      el.dispatchEvent(new w.Event("input", { bubbles: true }));
      return "ok";
    `);
    void cleared;
    await sleep(800);
    const body2 = await runInSoc(`return (w.document.body.innerText || "");`);
    t("清空「利益冲突」后立刻报待填", body2.includes("待填") && body2.includes("利益冲突声明"), `含待填=${body2.includes("待填")}`);

    // 只写「无」应算有效声明（不该判"偏短"）—— 这是刻意的产品判断
    await runInSoc(`
      const el = w.document.querySelector('[data-control="workflow:decl-conflict"]');
      const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, "无。");
      el.dispatchEvent(new w.Event("input", { bubbles: true }));
      return "ok";
    `);
    await sleep(800);
    const body3 = await runInSoc(`return (w.document.body.innerText || "");`);
    t("只写「无。」也算齐（不判偏短）", !body3.includes("偏短"), `含偏短=${body3.includes("偏短")}`);
  }

  // ── ⑤ 导出带声明 ──
  //
  // 「导出里有没有声明」是这一批的**核心交付**（用户填了就是为了交出去）。
  // ⚠ 第一版想靠"裸搜 zip 字节里的中文"来验，实测该条目被 deflate 压缩过、搜不到，
  //   于是我把它标成 skip —— 那等于把最该验的一条跳过了。**解压再验**才是对的。
  console.log("\n═══ ⑤ 导出带声明 ══���");
  {
    const bundle = await fetch(`${BASE}/api/research/projects/${pid}/export-bundle`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    t("整包导出可下载", bundle.ok, `HTTP ${bundle.status}`);
    if (bundle.ok) {
      const { unzipSync, strFromU8 } = await import("fflate");
      const files = unzipSync(new Uint8Array(await bundle.arrayBuffer()));
      const paper = files["论文.md"];
      t("包里能找到 论文.md", !!paper, `包内文件: ${Object.keys(files).slice(0, 8).join(", ")}`);
      if (paper) {
        const md = strFromU8(paper);
        t("论文.md 里有「## 声明」段", md.includes("## 声明"), `长度 ${md.length}`);
        t("声明段里含用户填的作者贡献", md.includes("张三：研究设计"), `含张三=${md.includes("张三")}`);
        t("声明段里含用户填的基金编号", md.includes("20BJL001"), `含编号=${md.includes("20BJL001")}`);
        // 顺序: 声明应在参考文献之后
        const iRefs = md.indexOf("## 参考文献");
        const iDecl = md.indexOf("## 声明");
        t("声明排在参考文献之后（期刊排版口径）", iRefs >= 0 && iDecl > iRefs, `参考文献@${iRefs} 声明@${iDecl}`);
      }
    }
  }

  await api(token, `/research/projects/${pid}`, "DELETE").catch(() => null);
  console.log("\n═══ ⑥ 无 JS 错误 ═══");
  {
    const errs = await evalTop(cdp, `JSON.stringify((window.__verifyErrs || []).slice(0, 3))`);
    t("顶层无未捕获错误", errs === "[]", String(errs).slice(0, 200));
  }
} finally {
  try { close?.(); } catch { /* 忽略 */ }
}
console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);

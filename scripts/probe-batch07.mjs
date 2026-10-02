// probe-batch07.mjs — 申报与审查(开题/基金/伦理/预注册)端到端回归
//
// ⚠ **分两组**:
//   · 默认组(**不烧模型**): 区可达 / 四类页签 / 节次结构 / 空态 / 入口接线 —— 秒级;
//   · PROBE_LLM=1: 真生成一份(七节逐节调 LLM, 一分钟以上) + 落库 + 手改 + 刷新仍在。
//   这个切法与 batch04 同源: **成本高的部分不该拖累不花钱的部分**。
//
// 为什么默认组值得单列: 这一批最容易静默失效的是**节次表** ——
//   `PROPOSAL_SPECS` 是后端真源, 前端只渲染 `/proposals/specs` 的返回。
//   若哪天前端自己写死一份, 两边就会漂移(界面上写着 7 节、后端按 6 节生成), 且**不报错**。
//   所以默认组直接比"界面渲染的节数"与"接口返回的节数"。
//
// 用法:
//   node scripts/probe-batch07.mjs            # 接线(默认, 不烧模型)
//   PROBE_LLM=1 node scripts/probe-batch07.mjs  # 加上真生成
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";

const BASE = process.env.API_BASE || "http://127.0.0.1:4173";
const WITH_LLM = process.env.PROBE_LLM === "1";
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
let pid = "";
try {
  ({ cdp, close } = await startCdp({ preferredPort: 31232, label: "probe-batch07", windowSize: "1600,1000" }));
  await cdp("Page.navigate", { url: BASE });
  await sleep(2500);
  await evalTop(cdp, `localStorage.setItem("sag_token", ${JSON.stringify(token)}); localStorage.setItem("skf_auth_token", ${JSON.stringify(token)}); localStorage.setItem('sag_onboarding_done_v1','1'); 1`);
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

  const p = await api(token, "/research/projects", "POST", { title: `批7申报-${Date.now()}`, status: "active" });
  pid = (p.body?.data ?? p.body)?.id ?? p.body?.project?.id ?? "";
  t("前置: 建得出测试项目", !!pid, `pid=${pid}`);
  await evalTop(cdp, `localStorage.setItem("lastTask_workflow", ${JSON.stringify(String(pid))}); 1`);
  await runInSoc(`w.location.reload(); return 1;`);
  await sleep(6500);

  // ── ① 入口接线 ──
  console.log("\n═══ ① 从框架设计页进入 ═══");
  {
    await goto("/workflow/sections");
    const btn = await runInSoc(`return w.document.querySelector('[data-control="workflow:goto-proposals"]') ? "found" : "missing";`);
    t("框架设计页有「申报与审查」入口", btn === "found", `实测 ${btn}`);
    await runInSoc(`w.document.querySelector('[data-control="workflow:goto-proposals"]').click(); return "ok";`);
    await sleep(2500);
    const h = await runInSoc(`return w.location.hash;`);
    t("点它跳到 /workflow/proposals", String(h).includes("/workflow/proposals"), `实测 ${h}`);
  }

  // ── ② 四类页签 ──
  console.log("\n═══ ② 四类文书页签 ═══");
  const specRes = await api(token, "/research/proposals/specs");
  const specs = specRes.body?.specs ?? [];
  {
    t("接口返回四类文书", specs.length === 4, `实测 ${specs.length}: ${specs.map((s) => s.key).join(",")}`);
    const keys = specs.map((s) => s.key).join(",");
    t("四类就是 proposal/grant/ethics/prereg", keys === "proposal,grant,ethics,prereg", `实测 ${keys}`);

    const ui = await runInSoc(`
      const tabs = [...w.document.querySelectorAll(".pp-tab")].map((e) => e.getAttribute("data-control"));
      return JSON.stringify(tabs);
    `);
    let tabs = [];
    try { tabs = JSON.parse(String(ui)); } catch { /* 忽略 */ }
    t("界面渲染出四个页签", tabs.length === 4, `实测 ${JSON.stringify(tabs)}`);
    const want = ["workflow:pp-tab-proposal", "workflow:pp-tab-grant", "workflow:pp-tab-ethics", "workflow:pp-tab-prereg"];
    t("页签与后端四类一一对应", want.every((x) => tabs.includes(x)), `实测 ${JSON.stringify(tabs)}`);
  }

  // ── ③ 节次结构(默认组最该锁的一条) ──
  console.log("\n═══ ③ 节次结构 ═══");
  {
    const byKey = new Map(specs.map((s) => [s.key, s]));
    // 开题 7 节 / 基金 7 节 / 伦理 7 节 / 预注册 7 节 —— 每一类都是受理方材料清单的顺序
    for (const [k, n] of [["proposal", 7], ["grant", 7], ["ethics", 7], ["prereg", 7]]) {
      const s = byKey.get(k);
      t(`${s?.cn ?? k} 有 ${n} 节`, (s?.sections ?? []).length === n, `实测 ${(s?.sections ?? []).length} 节`);
    }
    // 每一节都要有标题与写法说明 —— 缺 spec 等于模型自己编结构
    const bad = specs.flatMap((s) => (s.sections ?? []).filter((x) => !x.title || !x.spec).map((x) => `${s.key}:${x.title}`));
    t("每一节都有标题与写法说明", bad.length === 0, `缺: ${JSON.stringify(bad)}`);
    // 面向对象要写明 —— 它决定语气, 缺了会写成给同行看的口吻
    const noAud = specs.filter((s) => !s.audience).map((s) => s.key);
    t("每一类都写了面向谁", noAud.length === 0, `缺: ${JSON.stringify(noAud)}`);

    // 界面按当前页签渲染的节次, 与接口一致(防前端写死一份)
    const shown = await runInSoc(`
      const txt = (w.document.querySelector(".pp-audience") || {}).innerText || "";
      const m = txt.match(/共\\s*(\\d+)\\s*节/);
      return m ? m[1] : "missing";
    `);
    t("界面显示的节数与接口一致", String(shown) === String((specs[0]?.sections ?? []).length), `界面 ${shown} / 接口 ${(specs[0]?.sections ?? []).length}`);
  }

  // ── ④ 空态(不烧模型) ──
  console.log("\n═══ ④ 未生成时的空态 ═══");
  {
    const empty = await runInSoc(`return w.document.querySelector(".pp-empty") ? "shown" : "missing";`);
    t("未生成时显示空态提示", empty === "shown", `实测 ${empty}`);
    const noDoc = await runInSoc(`return w.document.querySelector('[data-control="workflow:pp-doc"]') ? "present" : "absent";`);
    t("空态下不渲染正文块", noDoc === "absent", `实测 ${noDoc}`);
    const btn = await runInSoc(`
      const b = w.document.querySelector('[data-control="workflow:pp-generate"]');
      return b ? b.innerText.trim() : "missing";
    `);
    t("生成按钮在且写着「生成」", String(btn).includes("生成"), `实测 ${JSON.stringify(btn)}`);
  }

  // ── ⑤ 真生成(仅 PROBE_LLM=1) ──
  if (WITH_LLM) {
    console.log("\n═══ ⑤ 真生成一份(烧模型) ═══");
    {
      // 先把研究设计与假设喂进去, 验"上下文自动带上"
      await api(token, `/research/projects/${pid}/nodes/design`, "PUT", {
        payload: { methodId: "ols", identifyId: "none", dataSources: ["CGSS 2021"], ethics: ["匿名化处理"] },
      });
      await api(token, `/research/projects/${pid}/hypotheses`, "PUT", {
        hypotheses: [{ code: "H1", text: "教育年限正向影响收入", verdict: "pending" }],
      });

      const t0 = Date.now();
      const gen = await api(token, `/research/projects/${pid}/proposals/generate`, "POST", { kind: "proposal" });
      const secs = Math.round((Date.now() - t0) / 1000);
      t("生成接口返回 ok", gen.body?.ok === true, `HTTP ${gen.status} ${String(gen.body?.error ?? "").slice(0, 120)}`);
      const content = String(gen.body?.content ?? "");
      t("正文非空", content.length > 800, `${content.length} 字 · ${secs}s`);
      t("含全部七节标题", ["一、", "二、", "三、", "四、", "五、", "六、", "七、"].every((x) => content.includes(x)),
        `缺: ${["一、", "二、", "三、", "四、", "五、", "六、", "七、"].filter((x) => !content.includes(x)).join("")}`);
      t("没有「本节未能生成」的占位", !content.includes("本节未能生成"), `含占位=${content.includes("本节未能生成")}`);
      // 上下文真的被用上: 设计里的方法/数据源应出现在正文里
      t("带上了研究设计(数据源)", content.includes("CGSS") || content.includes("2021"), `含 CGSS/2021=${content.includes("CGSS")}`);
      t("带上了假设台账", /H1/.test(content), `含 H1=${/H1/.test(content)}`);

      // 落库
      const back = await api(token, `/research/projects/${pid}/proposals`);
      t("已落库 proposal 节点", !!String(back.body?.proposals?.proposal?.content ?? "").length, `keys=${Object.keys(back.body?.proposals ?? {}).join(",")}`);

      // ⚠ 生成「基金申报」不得把已生成的「开题报告」冲掉(读改写, 不是整节点覆盖)
      const gen2 = await api(token, `/research/projects/${pid}/proposals/generate`, "POST", { kind: "grant" });
      t("第二类也能生成", gen2.body?.ok === true, String(gen2.body?.error ?? "").slice(0, 100));
      const back2 = await api(token, `/research/projects/${pid}/proposals`);
      const has1 = !!String(back2.body?.proposals?.proposal?.content ?? "").length;
      const has2 = !!String(back2.body?.proposals?.grant?.content ?? "").length;
      t("⚠ 生成第二类没冲掉第一类", has1 && has2, `proposal=${has1} grant=${has2}`);

      /**
       * 剩下两类(伦理/预注册)也真跑一遍。
       *
       * ⚠ 它们与上面两类**走同一个 generateProposal**, 差别只在 spec —— 但"同一条代码路径"
       *   恰恰是本仓反复栽跟头的假设(批7 的 proposal/grant 能过不代表另两类能)。
       *   这两份是交给**伦理委员会**的材料, 缺一节就是材料不齐, 值得多花一次调用。
       */
      for (const k of ["ethics", "prereg"]) {
        const g = await api(token, `/research/projects/${pid}/proposals/generate`, "POST", { kind: k });
        const c = String(g.body?.content ?? "");
        const cn = k === "ethics" ? "伦理审查材料" : "预注册方案";
        t(`${cn} 能生成且七节齐全`,
          g.body?.ok === true && c.length > 800 && ["一、", "二、", "三、", "四、", "五、", "六、", "七、"].every((x) => c.includes(x))
          && !c.includes("本节未能生成"),
          `ok=${g.body?.ok} ${c.length} 字 缺=[${["一、", "二、", "三、", "四、", "五、", "六、", "七、"].filter((x) => !c.includes(x)).join("")}]`);
      }
      const back4 = await api(token, `/research/projects/${pid}/proposals`);
      const keys4 = Object.keys(back4.body?.proposals ?? {}).filter((k) => String(back4.body.proposals[k]?.content ?? "").length);
      t("四类互不覆盖, 都在库里", keys4.length === 4, `实测 ${JSON.stringify(keys4)}`);

      // 刷新后仍在 + 可手改
      await runInSoc(`w.location.href = w.location.origin + "/soc/index.html#/workflow/proposals"; return 1;`);
      await sleep(3000);
      await runInSoc(`w.location.reload(); return 1;`);
      await sleep(6500);
      await goto("/workflow/proposals");
      const shown = await runInSoc(`return w.document.querySelectorAll(".pp-dot").length;`);
      t("刷新后四份都标着已生成", Number(shown) === 4, `实测 ${shown}`);

      /**
       * ⚠ 点完**要等一帧**再查 —— 第一版把"点击"与"查文本框"写在同一个 evalTop 里,
       *   而 Vue 的 v-if 切换要等下一个 tick 才渲染, 于是恒 missing。
       *   这是**探针的自证问题不是产品问题**: 紧接着那条"手改的内容真的落库"是过的,
       *   而它只有在编辑器真的存在时才可能通过。
       */
      await runInSoc(`w.document.querySelector('[data-control="workflow:pp-edit"]').click(); return "clicked";`);
      await sleep(700);
      const edited = await runInSoc(`return w.document.querySelector('[data-control="workflow:pp-editor"]') ? "editor" : "missing";`);
      t("点编辑切到可改文本框", edited === "editor", `实测 ${edited}`);
      await sleep(300);
      if (edited !== "editor") throw new Error("编辑器没出现, 后续手改断言会假通过");
      await runInSoc(`
        const ta = w.document.querySelector('[data-control="workflow:pp-editor"]');
        const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value").set;
        setter.call(ta, ta.value + "\\n\\n【人工补充】本节由申请人改写。");
        ta.dispatchEvent(new w.Event("input", { bubbles: true }));
        w.document.querySelector('[data-control="workflow:pp-save"]').click();
        return "ok";
      `);
      await sleep(2200);
      const after = await api(token, `/research/projects/${pid}/proposals`);
      t("手改的内容真的落库", String(after.body?.proposals?.proposal?.content ?? "").includes("人工补充"),
        `含=${String(after.body?.proposals?.proposal?.content ?? "").includes("人工补充")}`);

      // 合集导出
      const exp = await api(token, `/research/projects/${pid}/proposals/export`);
      const expMd = String(exp.body?.markdown ?? "");
      t("合集导出含四类", ["开题报告", "基金申报书", "伦理审查材料", "预注册方案"].every((x) => expMd.includes(x)),
        `长度 ${expMd.length} 缺=[${["开题报告", "基金申报书", "伦理审查材料", "预注册方案"].filter((x) => !expMd.includes(x)).join(",")}]`);
    }
  } else {
    console.log("\n(跳过 ⑤ 真生成 —— 设 PROBE_LLM=1 启用)");
  }

  // ── ⑥ 无 JS 错误 ──
  console.log("\n═══ ⑥ 无 JS 错误 ═══");
  {
    const errs = await evalTop(cdp, `JSON.stringify((window.__verifyErrs || []).slice(0, 3))`);
    t("顶层无未捕获错误", errs === "[]", String(errs).slice(0, 200));
  }
} finally {
  if (pid) await api(token, `/research/projects/${pid}`, "DELETE").catch(() => null);
  try { close?.(); } catch { /* 忽略 */ }
}
console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);

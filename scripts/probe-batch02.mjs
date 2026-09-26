// probe-batch02.mjs — 阶段模型真源化 + 重编号（157 迁移）+ 按研究类型条件显示
//
// 覆盖：
//   ① 进度条节点与真源一致 —— **定量 6 个 / 定性 5 个**（「研究实施」只对定量·混合显示）
//   ② 旧项目打开后落在**正确**的阶段（不是"号对了名错了"）—— 迁移的核心风险
//   ③ Alt+数字 跳到**真源说的那一页**（旧实现用数组下标反推阶段号，加阶段会静默跳错）
//
// 用法: node scripts/probe-batch02.mjs   (需 4173 已起, 且产物已重建)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";

const BASE = process.env.API_BASE || "http://127.0.0.1:4173";
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${n}${ex ? " — " + ex : ""}`); ok ? pass++ : fail++; };

const api = async (token, path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.ok ? r.json().catch(() => ({})) : { __status: r.status };
};

const token = await loginToken("audit", "audit123456");
if (!token) { console.error("登录失败"); process.exit(1); }

const SOC = `document.querySelector('iframe[title^="研途写作舱"], iframe[src*="/soc/"]')`;
let cdp, close;
try {
  ({ cdp, close } = await startCdp({ preferredPort: 31210, label: "probe-batch02", windowSize: "1600,900" }));
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
    await sleep(2400);
  };

  const boot = await evalTop(cdp, `${SOC} ? "ok" : "NO_IFRAME"`);
  t("前置: 写作舱 iframe 已挂载", boot === "ok", `实测 ${boot}`);
  if (boot !== "ok") throw new Error("iframe 没挂上");

  // ── ① 进度条节点 = 真源（含按研究类型的条件显示） ──
  console.log("\n═══ ① 进度条节点与真源一致（含按研究类型分岔）═══");
  await checkStageBranching();

  /**
   * 2026-09-26 批 3：加「研究实施」(ph=3) 后，进度条**按研究类型分岔**。
   * 这是这个功能的核心，只验一种等于没验 —— 所以两种都验，并验"另一种确实看不到"。
   */
  async function checkStageBranching() {
    const makeProject = async (method) => {
      const p = await api(token, "/research/projects", "POST", { title: `批3类型-${method}-${Date.now()}`, status: "active" });
      const id = (p?.data ?? p)?.id ?? p?.project?.id;
      await api(token, `/research/projects/${id}`, "PATCH", { phase: 1, phaseLabel: "选题界定" });
      await api(token, `/research/projects/${id}/workbench`, "PUT", {
        snapshot: { phase: 1, phaseLabel: "选题界定", input: { title: "类型探针", outline: "一、引言", totalWordCount: 5000, researchMethod: method, requirements: "", sampleFiles: [] } },
      });
      return id;
    };
    const readNodes = async () => {
      const raw = await runInSoc(`
        const els = [...w.document.querySelectorAll(".ppb-node")];
        return JSON.stringify(els.map((e) => ({ ph: e.getAttribute("data-phase"), label: (e.querySelector(".ppb-label-text") || {}).textContent || "" })));
      `);
      try { return JSON.parse(raw); } catch { return []; }
    };
    const prev = await evalTop(cdp, `localStorage.getItem("lastTask_workflow")`);

    const qid = await makeProject("quantitative");
    await evalTop(cdp, `localStorage.setItem("lastTask_workflow", ${JSON.stringify(String(qid))}); 1`);
    await runInSoc(`w.location.reload(); return 1;`);
    await sleep(6500);
    await goto("/workflow/input");
    const qNodes = await readNodes();
    const qLabels = qNodes.map((n) => n.label);
    t("定量研究看到 6 个节点（含研究实施）", qNodes.length === 6, `实测 ${qNodes.length}：${JSON.stringify(qLabels)}`);
    t("阶段号 1..6（连续）", JSON.stringify(qNodes.map((n) => Number(n.ph))) === JSON.stringify([1, 2, 3, 4, 5, 6]), `实测 ${JSON.stringify(qNodes.map((n) => Number(n.ph)))}`);
    t("研究实施在第 3 位",
      JSON.stringify(qLabels) === JSON.stringify(["选题界定", "框架设计", "研究实施", "文献与资料", "章节写作", "统稿定稿"]),
      `实测 ${JSON.stringify(qLabels)}`);
    await api(token, `/research/projects/${qid}`, "DELETE").catch(() => null);

    const kid = await makeProject("qualitative");
    await evalTop(cdp, `localStorage.setItem("lastTask_workflow", ${JSON.stringify(String(kid))}); 1`);
    await runInSoc(`w.location.reload(); return 1;`);
    await sleep(6500);
    await goto("/workflow/input");
    const kNodes = await readNodes();
    const kLabels = kNodes.map((n) => n.label);
    t("定性研究只看到 5 个节点", kNodes.length === 5, `实测 ${kNodes.length}：${JSON.stringify(kLabels)}`);
    t("定性研究**看不到**「研究实施」", !kLabels.includes("研究实施"), `实测 ${JSON.stringify(kLabels)}`);
    t("定性研究阶段号 1,2,4,5,6（跳号是设计如此）",
      JSON.stringify(kNodes.map((n) => Number(n.ph))) === JSON.stringify([1, 2, 4, 5, 6]),
      `实测 ${JSON.stringify(kNodes.map((n) => Number(n.ph)))}`);
    await api(token, `/research/projects/${kid}`, "DELETE").catch(() => null);

    await evalTop(cdp, prev ? `localStorage.setItem("lastTask_workflow", ${JSON.stringify(prev)}); 1` : `localStorage.removeItem("lastTask_workflow"); 1`);
  }

  // ── ② 迁移后形状的项目落在正确阶段 ──
  //
  // ⚠ 为什么不直接用库里那些真实项目：用户列表接口**只返回自己的项目**，
  //   而迁移后 phase=4 的 26 个项目属于别的账号 —— 用 audit 的 token 根本看不到它们。
  //   （本轮第二版就是这么误判的："phase 分布=[0,1,2]" 让我以为迁移没生效，
  //    而 DB 层一查，26 个 phase=4 好好躺在那里。**观测范围 ≠ 事实**。）
  //
  // 所以这里**精确复刻迁移产出的形状**来验：迁移同时改两处 ——
  //   · `research_projects.phase` 列
  //   · `workbench_snapshot.phase` 副本
  // 而前端**读的是快照那一份**（stores/workflow.ts 的 `snap.phase`）。
  // 只写列不写快照，前端就会落到"未开始" —— 这正是本轮第一版踩的坑。
  console.log("\n═══ ② 迁移后形状的项目落在正确阶段 ═══");
  {
    const p = await api(token, "/research/projects", "POST", { title: `批2阶段-${Date.now()}`, status: "active", phase: 4, phaseLabel: "文献与资料" });
    const pid = (p?.data ?? p)?.id ?? p?.project?.id;
    /**
     * ⚠ 建项目那条路由**不落 phase** —— 实测 `POST {phase:4}` 之后列表接口回的是 `phase:0`
     *   （既有行为，与本次迁移无关）。而项目栏读的是**项目列**、进度条读的是**快照**，
     *   于是只建不补的话，两处会显示成不同的阶段，看起来像"迁移把数据搞裂了"。
     *   补一次 PATCH 让两处一致 —— 这也是真实项目的样子（前端 saveProject 会写 PATCH）。
     */
    await api(token, `/research/projects/${pid}`, "PATCH", { phase: 4, phaseLabel: "文献与资料" });
    // 再补上快照副本 —— 与迁移 157 的 ⑤ 那条 update 产出同形
    await api(token, `/research/projects/${pid}/workbench`, "PUT", {
      snapshot: { phase: 4, phaseLabel: "文献与资料", input: { title: "批2阶段探针", outline: "一、引言", totalWordCount: 5000, researchMethod: "quantitative", requirements: "", sampleFiles: [] } },
    });
    const prev = await evalTop(cdp, `localStorage.getItem("lastTask_workflow")`);
    await evalTop(cdp, `localStorage.setItem("lastTask_workflow", ${JSON.stringify(String(pid))}); 1`);
    await runInSoc(`w.location.reload(); return 1;`);
    await sleep(6500);
    const active = await runInSoc(`
      const el = w.document.querySelector(".ppb-node.active");
      return el ? (el.getAttribute("data-phase") + "|" + ((el.querySelector(".ppb-label-text") || {}).textContent || "")) : "none";
    `);
    t("phase=4 的项目进度条停在「文献与资料」", active === "4|文献与资料", `实测 ${active}`);

    /**
     * 项目栏那条断言**不能靠"整栏文本里包含某词"** —— 这个库里有 160+ 个探针项目，
     * 列表按更新时间倒序，刚建的项目挤不进前几屏；而"整栏含该词"会**假通过**
     * （别的项目碰巧是那个阶段）。改成**从 DOM 找到本项目的条目、读它自己的那行**。
     */
    const railLine = await runInSoc(`
      const items = [...w.document.querySelectorAll(".wfs-item")];
      const hit = items.find((e) => e.getAttribute("data-control") === "workflow:proj-" + ${JSON.stringify(String(pid))});
      return hit ? (hit.querySelector(".wfs-item-meta") || {}).innerText || "" : "NOT_IN_LIST";
    `);
    t("项目栏本项目条目显示「文献与资料」（同一个 stageTitle）",
      String(railLine).includes("文献与资料"), `实测 「${String(railLine).replace(/\n/g, " ")}」`);

    await api(token, `/research/projects/${pid}`, "DELETE").catch(() => null);
    await evalTop(cdp, prev ? `localStorage.setItem("lastTask_workflow", ${JSON.stringify(prev)}); 1` : `localStorage.removeItem("lastTask_workflow"); 1`);
  }

  // ── ③ Alt+N 写入的阶段号 = 该键位对应的**真源号** ──
  //
  // ⚠ 断言的对象是**落库的 phase**，不是跳转到哪一页 —— 这一点我第一版搞错了。
  //   旧实现 `want = STEPS.findIndex(...) + 1` 算的是**下标+1**，而路由用的是 `STEPS[i].route`
  //   （所以**页面是跳对的**）。错的是写进 store.phase / PATCH 到项目列的那个**数字** ——
  //   它记的是"第几个键位"而不是"第几阶段"。断言 hash 根本测不到这个 bug。
  //   现在验：在 stage 1 的项目上按 Alt+3，落库的 phase 必须等于**第 3 个可见阶段的 ph**。
  console.log("\n═══ ③ Alt+N 写入的阶段号 = 真源号 ═══");
  {
    const p = await api(token, "/research/projects", "POST", { title: `批3键盘-${Date.now()}`, status: "active" });
    const pid = (p?.data ?? p)?.id ?? p?.project?.id;
    await api(token, `/research/projects/${pid}`, "PATCH", { phase: 1, phaseLabel: "选题界定" });
    // 定量（默认类型）→ 可见表是 1,2,3,4,5,6 → 第 3 个键位对应 ph=3
    await api(token, `/research/projects/${pid}/workbench`, "PUT", {
      snapshot: { phase: 1, phaseLabel: "选题界定", input: { title: "键盘探针", outline: "一、引言", totalWordCount: 5000, researchMethod: "quantitative", requirements: "", sampleFiles: [] } },
    });
    const prev = await evalTop(cdp, `localStorage.getItem("lastTask_workflow")`);
    await evalTop(cdp, `localStorage.setItem("lastTask_workflow", ${JSON.stringify(String(pid))}); 1`);
    await runInSoc(`w.location.reload(); return 1;`);
    await sleep(6000);
    await goto("/workflow/input");

    await runInSoc(`w.dispatchEvent(new KeyboardEvent("keydown", { key: "3", altKey: true, bubbles: true })); return "sent";`);
    await sleep(2500);
    const h3 = await runInSoc(`return w.location.hash;`);
    t("Alt+3 跳到第 3 个可见阶段「研究实施」", String(h3).includes("/workflow/implement"), `实测 hash=${h3}`);
    // 等 PATCH 落库（setPhase 里是 async 的，不 await）
    await sleep(1500);
    const after = await api(token, `/research/projects/${pid}`);
    const proj = (after?.project ?? after?.data ?? {});
    t("落库的 phase = 3（真源给的号，不是键位序号）",
      Number(proj.phase) === 3, `实测 phase=${proj.phase} label=${proj.phase_label}`);

    await api(token, `/research/projects/${pid}`, "DELETE").catch(() => null);
    await evalTop(cdp, prev ? `localStorage.setItem("lastTask_workflow", ${JSON.stringify(prev)}); 1` : `localStorage.removeItem("lastTask_workflow"); 1`);
  }

  // ── ③b 定性研究：Alt+3 应指向「文献与资料」(ph=4)，因为没有研究实施 ──
  console.log("\n═══ ③b 定性研究的键位映射（跳号）═══");
  {
    const p = await api(token, "/research/projects", "POST", { title: `批3键盘定性-${Date.now()}`, status: "active" });
    const pid = (p?.data ?? p)?.id ?? p?.project?.id;
    await api(token, `/research/projects/${pid}`, "PATCH", { phase: 1, phaseLabel: "选题界定" });
    await api(token, `/research/projects/${pid}/workbench`, "PUT", {
      snapshot: { phase: 1, phaseLabel: "选题界定", input: { title: "键盘探针定性", outline: "一、引言", totalWordCount: 5000, researchMethod: "qualitative", requirements: "", sampleFiles: [] } },
    });
    const prev = await evalTop(cdp, `localStorage.getItem("lastTask_workflow")`);
    await evalTop(cdp, `localStorage.setItem("lastTask_workflow", ${JSON.stringify(String(pid))}); 1`);
    await runInSoc(`w.location.reload(); return 1;`);
    await sleep(6000);
    await goto("/workflow/input");

    await runInSoc(`w.dispatchEvent(new KeyboardEvent("keydown", { key: "3", altKey: true, bubbles: true })); return "sent";`);
    await sleep(2500);
    const h3 = await runInSoc(`return w.location.hash;`);
    t("定性研究 Alt+3 跳到「文献与资料」(跳过了研究实施)", String(h3).includes("/workflow/materials"), `实测 hash=${h3}`);
    await sleep(1500);
    const after = await api(token, `/research/projects/${pid}`);
    const proj = (after?.project ?? after?.data ?? {});
    t("落库 phase = 4（定性没有第 3 步）", Number(proj.phase) === 4, `实测 phase=${proj.phase} label=${proj.phase_label}`);

    await api(token, `/research/projects/${pid}`, "DELETE").catch(() => null);
    await evalTop(cdp, prev ? `localStorage.setItem("lastTask_workflow", ${JSON.stringify(prev)}); 1` : `localStorage.removeItem("lastTask_workflow"); 1`);
  }

  console.log("\n═══ ③c 研究实施页真的渲染出来（不只是 hash 变了）═══");
  {
    /**
     * ⚠ 必须**自带一个定量项目** —— 上一节刚把 store 留在定性项目上（5 个节点、没有 ph=3），
     *   而 store 不会因为 localStorage 指针被恢复就自动重载。我第一版没做这步，
     *   拿到 `none` 就以为"节点没渲染" —— 实际是**当前项目看不到这个阶段**，功能完全正常。
     *   （隔离诊断里 taskId=null 时节点列表含 `{ph:"3", cls:"ppb-node viewing"}`，已确认。）
     */
    const p = await api(token, "/research/projects", "POST", { title: `批3页面-${Date.now()}`, status: "active" });
    const pid = (p?.data ?? p)?.id ?? p?.project?.id;
    await api(token, `/research/projects/${pid}`, "PATCH", { phase: 1, phaseLabel: "选题界定" });
    await api(token, `/research/projects/${pid}/workbench`, "PUT", {
      snapshot: { phase: 1, phaseLabel: "选题界定", input: { title: "页面探针", outline: "一、引言", totalWordCount: 5000, researchMethod: "quantitative", requirements: "", sampleFiles: [] } },
    });
    await evalTop(cdp, `localStorage.setItem("lastTask_workflow", ${JSON.stringify(String(pid))}); 1`);
    await runInSoc(`w.location.reload(); return 1;`);
    await sleep(6000);

    await goto("/workflow/implement");
    let body = "";
    for (let i = 0; i < 10; i++) {
      await sleep(1200);
      body = String(await runInSoc(`return (w.document.body.innerText || "");`));
      if (body.length > 300) break;
    }
    t("页面有内容（不是空白）", body.length > 300, `正文长度=${body.length}`);
    // hash 变了但页面是白屏 —— 这是"路由改了、视图没接上"的典型假通过
    t("渲染出「研究实施」标题", body.includes("研究实施"), `正文首段=${body.slice(0, 60)}`);
    t("有「研究设计回顾」区（承接第 2 步的产出）", body.includes("研究设计回顾"), `含该词=${body.includes("研究设计回顾")}`);
    t("有「研究台账」区（结果落到这里供正文引用）", body.includes("研究台账"), `含该词=${body.includes("研究台账")}`);
    const ctrls = await runInSoc(`return String(w.document.querySelectorAll('[data-control^="workflow:implement"]').length);`);
    t("有可被科研助手调用的动作埋点", Number(ctrls) >= 3, `实测 ${ctrls} 个`);
    /**
     * ⚠ 这里断言的是 **viewing** 不是 active —— active 跟的是**项目阶段**，不是"我在看哪一页"。
     *   本项目阶段是 1，所以在看 implement 这一页时它的状态是第四态 viewing
     *   （"正在查看但不是当前阶段"）。我第一版按 active 断言，得到 `4|文献与资料` 就判失败 ——
     *   又是"判据没对准被测对象"。要验的是：这一页对应的节点**被认出来了**。
     */
    const nav = await runInSoc(`
      const el = w.document.querySelector('.ppb-node[data-phase="3"]');
      if (!el) return "none";
      const label = (el.querySelector(".ppb-label-text") || {}).textContent || "";
      return el.classList.contains("viewing") ? ("viewing|" + label) : (el.className + "|" + label);
    `);
    t("进度条把这一页认作「研究实施」第 3 节点（viewing 态）", nav === "viewing|研究实施", `实测 ${nav}`);
    await api(token, `/research/projects/${pid}`, "DELETE").catch(() => null);
  }

  console.log("\n═══ ④ 无 JS 错误 ═══");
  {
    const errs = await evalTop(cdp, `JSON.stringify((window.__verifyErrs || []).slice(0, 3))`);
    t("顶层无未捕获错误", errs === "[]", String(errs).slice(0, 200));
  }
} finally {
  try { close?.(); } catch { /* 忽略 */ }
}
console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);

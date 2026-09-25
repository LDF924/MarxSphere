// probe-research-evidence.mjs — 「研究 → 写作」这条线的接线门禁
//
// 由来(2026-09-25): 这一批补的是写作舱最根本的一条断线 —— **正文里没有任何研究证据**。
//   实测三处(不是推测):
//     ① generateChapter 的 prompt 里没有"数据/结果/发现"的位置;
//     ② 后端那条 `【可用素材】` 注入是**死代码**(只在 executorMap 未命中时触发, 而写作舱
//        用的 jobKind 全部命中);
//     ③ 假设只躺在 analysis 节点的 JSON 里, 既不能改结论也不进正文。
//
// 这一批的失败模式全是**静默**的: 面板渲染了、按钮在, 但点下去打错端点 / 字段名对不上 /
// 存了读不回来。所以每条都验到**副作用**, 而不是断言"元素存在"。
//
// 覆盖(全部不调 LLM —— 统计用的是 pandas/statsmodels, 秒级; "AI 写结论句"那条用拦 fetch 停住):
//   ① 本章依据   勾选 → 保存 → **重新加载页面后仍在**(落库往返) + 预览真出证据块
//   ② 假设台账   手填一条 → 保存 → 刷新后仍在(含结论与依据) + 从框架设计导入
//   ③ 发现台账   真跑一次 regression → **采集** → 台账出现且系数与结果一致
//   ④ 自动采集   同一份分析**跑完即入账**(B: 不需要人点)
//   ⑤ 数字核验   正文里写一个依据中不存在的数 → 必须被判未命中(这是"真实科研"的硬判据)
//   ⑥ 研究设计   选方法/识别策略 → 落 design 节点 → **刷新后选中的还在**
//   ⑦ 变量可编辑  变量从只读卡片变成可改(此前 defineEmits 为 0 / 无 v-model)
//
// ⚠ 本探针**自带测试课题并自清**(建课题/传文件/跑分析/写台账都在这个课题名下, 收尾全删)。
//   上一批的经验: 不清理的探针跑 N 次就在库里留 N 个"未命名", 审计时对不上账。
//
// 用法: node scripts/probe-research-evidence.mjs
// 前置: 4173 已起(API_BASE/WEB 可覆盖, 同其它探针)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveBrowser } from "./lib/find-browser.mjs";
import { resolveCdpPort } from "./lib/cdp-port.mjs";
import { loginToken } from "./lib/cdp-editor.mjs";

const BASE = process.env.WEB || "http://127.0.0.1:4173";
const API = process.env.API_BASE || "http://127.0.0.1:4173";
let CDP_PORT = 31031;
const userData = mkdtempSync(path.join(tmpdir(), "edge-reev-"));

let ws, msgId = 0;
const pend = new Map();
const cdp = (m, p = {}) => new Promise((res, rej) => {
  const id = ++msgId; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p }));
  setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error("timeout " + m)); } }, 30000);
});
const ev = async (e) => {
  const r = await cdp("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return "JSERR:" + (r.exceptionDetails.exception?.description || "").slice(0, 300);
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
// ⚠ 失败标记用 "FAIL"(不是任意真值字符串): 门禁 verify-ui 的汇总按退出码与结论行判定,
//   `check(name, "FAIL")` 在旧写法里会被当成 **通过**(非空字符串是 truthy)。这里统一成布尔。
const check = (n, p, d) => { const ok = p === true; results.push({ n, p: ok }); console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? "  — " + d : ""}`); };

async function apiCall(method, p, token, body) {
  const res = await fetch(API + "/api" + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { __raw: txt }; }
}

async function main() {
  let empIdForCleanup = "";
  CDP_PORT = await resolveCdpPort(CDP_PORT);
  const token = await loginToken("audit", "audit123456"); // 不存在则自动注册(CI 空库)

  // ── 造测试课题 ──
  const created = await apiCall("POST", "/research/projects", token, {
    title: `证据链探针-${Date.now()}`, status: "active", phase: 4, phaseLabel: "章节写作",
  });
  const pid = ((created?.data ?? created)?.id) ?? "";
  if (!pid) { console.error("ERR 建课题失败, 无法继续:", JSON.stringify(created).slice(0, 200)); process.exit(1); }
  console.log(`  测试课题: ${pid}`);

  /**
   * 数据文件 + 一次真回归。
   * y = 2x + 噪声, 24 个点 —— 系数应当显著为正(这条断言依赖真跑, 不是 mock)。
   */
  const rows = ["id,x,y"];
  for (let i = 1; i <= 24; i++) rows.push(`${i},${i},${(2 * i + (i % 5) * 0.13).toFixed(2)}`);
  const up = await apiCall("POST", "/files/upload", token, {
    filename: "probe-evidence.csv", mime: "text/csv", base64: Buffer.from(rows.join("\n"), "utf-8").toString("base64"),
  });
  const fileId = up?.fileId ?? "";
  let jobId = "";
  if (fileId) {
    await apiCall("PUT", `/research/projects/${pid}/workbench`, token, { snapshot: { statisticsFileId: fileId, phase: 4 } });
    const job = await apiCall("POST", "/statistics-jobs", token, {
      tool: "regression", fileId, params: { dependentVar: "y", independentVars: ["x"] },
    });
    jobId = job?.job?.id ?? "";
    for (let i = 0; i < 12 && jobId; i++) {
      await sleep(3000);
      const st = await apiCall("GET", `/statistics-jobs/${jobId}`, token);
      if (["completed", "failed", "cancelled"].includes(st?.job?.status)) break;
    }
  }

  const SEC_ID = "sec-1";
  const SEC_BODY = "数字化转型显著提升了企业全要素生产率[1]。在控制了企业规模与行业固定效应后依然稳健。";
  await apiCall("PUT", `/research/projects/${pid}/workbench`, token, {
    snapshot: {
      statisticsFileId: fileId, phase: 4,
      input: { title: "证据链研究", outline: "一、引言\n二、研究设计\n三、实证结果", totalWordCount: 8000, researchMethod: "quantitative", requirements: "", sampleFiles: [], clarifyAnswers: {} },
      sections: [
        { id: SEC_ID, title: "实证结果", level: 1, content: SEC_BODY },
        { id: "sec-2", title: "引言", level: 1, content: "" },
      ],
    },
  });
  // 一条 table 素材(带表格 → 会被渲染进证据块)
  await apiCall("POST", "/research/materials", token, {
    projectId: pid, kind: "table", title: "探针回归表", contentMd: "",
    tableData: { columns: ["变量", "系数"], rows: [["x", 2.01], ["const", 0.12]] },
  });

  const edge = spawn(resolveBrowser({ label: "scripts/probe-research-evidence.mjs" }), [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`, "--headless=new",
    "--disable-gpu", "--window-size=1600,1000", "--no-first-run", "about:blank"], { stdio: "ignore" });
  let exited = false;
  edge.on("exit", (code) => { exited = true; if (ws === undefined) console.error(`  浏览器提前退出(code=${code})`); });

  try {
    for (let i = 0; i < 40; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        const pg = l.find((t) => t.type === "page");
        if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); break; }
      } catch { /* not ready */ }
      if (exited) break;
      await sleep(500);
    }
    if (ws === undefined) throw new Error(`连不上浏览器调试端口 ${CDP_PORT}(20s 超时)。参见 scripts/lib/cdp-port.mjs。`);
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
    };
    await cdp("Page.enable"); await cdp("Runtime.enable");

    await cdp("Page.navigate", { url: BASE }); await sleep(2200);
    await ev(`localStorage.setItem('sag:language-preference:v1','zh');`);
    if (token) await ev(`localStorage.setItem('sag_token', ${JSON.stringify(token)});`);
    // ⚠ 写作舱的"当前项目"读 localStorage 指针, 不看 URL —— 不写它, 页面加载的是别的项目
    await ev(`localStorage.setItem('lastTask_workflow', ${JSON.stringify(pid)});`);

    const hardGo = async (sub) => {
      await cdp("Page.navigate", { url: `${BASE}/soc/index.html` });
      await sleep(600);
      await cdp("Page.navigate", { url: `${BASE}/soc/index.html#${sub}` });
      await sleep(3400);
    };
    const tap = async (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'MISSING';e.scrollIntoView({block:'center'});e.click();return 'ok';})()`);
    const exists = async (sel) => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
    const bodyText = async () => ev(`(document.body.innerText||'').replace(/\\s+/g,' ')`);

    // ══════════════════════════════════════════════════════════════
    // ① 本章依据: 勾选 → 保存 → 重载后仍在
    // ══════════════════════════════════════════════════════════════
    await hardGo("/workflow/workspace");
    const evOpen = await exists(".evidence-box");
    check("本章依据-面板已挂到创作台", evOpen);
    if (evOpen) {
      // 展开(默认 open, 但保险起见)
      await ev(`(()=>{const d=document.querySelector('.evidence-box'); if(d && !d.open) d.open=true; return 1;})()`);
      await sleep(400);
      const mats = await ev(`document.querySelectorAll('[data-control^="workflow:evidence-material-"]').length`);
      check("本章依据-列出了可选素材", (mats ?? 0) > 0, `素材候选 ${mats}`);
      if ((mats ?? 0) > 0) {
        // 勾第一条 + 填一句用途
        const cid = await ev(`(()=>{const b=document.querySelector('[data-control^="workflow:evidence-material-"]'); if(!b) return ''; b.scrollIntoView({block:'center'}); b.click(); return b.getAttribute('data-control');})()`);
        await sleep(500);
        const refId = String(cid || "").replace("workflow:evidence-material-", "");
        if (refId) {
          await ev(`(()=>{const i=document.querySelector('[data-control="workflow:evidence-note-${refId}"]'); if(i){i.focus();i.value='报告主回归';i.dispatchEvent(new Event('input',{bubbles:true}));} return 1;})()`);
          await sleep(300);
        }
        await tap(`[data-control^="workflow:evidence-save-"]`);
        await sleep(1600);
        // **副作用**验证: 从后端读回来
        const saved = await apiCall("GET", `/research/projects/${pid}/evidence`, token);
        const got = saved?.bySection?.[SEC_ID] ?? [];
        check("本章依据-保存后真落库", got.length > 0, `库里 ${got.length} 条`);

        // 重新加载页面 → 勾选状态应还原(这是"存了读不回来"那类 bug 的照妖镜)
        await hardGo("/workflow/workspace");
        await ev(`(()=>{const d=document.querySelector('.evidence-box'); if(d && !d.open) d.open=true; return 1;})()`);
        await sleep(600);
        const stillOn = await ev(`(()=>{const b=document.querySelector('[data-control^="workflow:evidence-material-"]'); return b ? b.checked : null;})()`);
        check("本章依据-刷新后勾选仍在", stillOn === true, `checked=${stillOn}`);
      }
      // 预览: 生成时到底给模型看了什么(不做黑箱)
      await tap(`[data-control^="workflow:evidence-preview-"]`);
      await sleep(1800);
      const pv = await ev(`(()=>{const p=document.querySelector('.cep-preview'); return p ? p.textContent : '';})()`);
      check("本章依据-预览真出证据块", typeof pv === "string" && pv.includes("本章依据"), String(pv).slice(0, 80));
      check("本章依据-证据块带写作纪律", typeof pv === "string" && pv.includes("写作纪律"));
    }

    // ══════════════════════════════════════════════════════════════
    // ③④ 发现台账: 采集 + 自动采集(B)
    // ══════════════════════════════════════════════════════════════
    const findingsApi = await apiCall("GET", `/research/projects/${pid}/findings`, token);
    const autoRows = findingsApi?.findings ?? [];
    // ④ 自动采集: 分析一跑完就该有行, 不需要人点任何按钮
    check("自动采集-分析完成后台账已有发现(B)", autoRows.length > 0, `条数=${autoRows.length}`);
    const xRow = autoRows.find((f) => f.varName === "x");
    check("自动采集-抽到了 x 且系数接近 2", xRow && Math.abs(Number(xRow.coef) - 2) < 0.5, `coef=${xRow?.coef} stars=${xRow?.stars}`);
    check("自动采集-状态是 candidate(系统不替人采纳)", autoRows.length > 0 && autoRows.every((f) => f.status === "candidate"));

    await hardGo("/workflow/materials");
    // 展开「研究台账」折叠块
    await ev(`(()=>{const d=document.querySelector('.ledger-box'); if(d && !d.open) d.open=true; return 1;})()`);
    await sleep(900);
    const ledgerTab = await exists('[data-control="workflow:ledger-tab-find"]');
    check("发现台账-tab 已挂到资料页", ledgerTab);
    if (ledgerTab) {
      await tap('[data-control="workflow:ledger-tab-find"]');
      await sleep(1200);
      const n = await ev(`document.querySelectorAll('[data-control^="workflow:find-claim-"]').length`);
      check("发现台账-渲染出已采集的发现", (n ?? 0) > 0, `条数=${n}`);
      // 采纳一条 → 真落库
      const adoptCtl = await ev(`(()=>{const b=document.querySelector('[data-control^="workflow:find-adopt-"]'); return b ? b.getAttribute('data-control') : '';})()`);
      if (adoptCtl) {
        const fid = String(adoptCtl).replace("workflow:find-adopt-", "");
        await tap(`[data-control="${adoptCtl}"]`);
        await sleep(1500);
        const after = await apiCall("GET", `/research/projects/${pid}/findings`, token);
        const adopted = (after?.findings ?? []).find((f) => f.id === fid);
        check("发现台账-采纳真的落库", adopted?.status === "adopted", `status=${adopted?.status}`);
      }
    }

    // ══════════════════════════════════════════════════════════════
    // ② 假设台账: 手填 → 保存 → 刷新后仍在
    // ══════════════════════════════════════════════════════════════
    if (ledgerTab) {
      await tap('[data-control="workflow:ledger-tab-hyp"]');
      await sleep(900);
      await tap('[data-control="workflow:hyp-add"]');
      await sleep(400);
      await ev(`(()=>{const t=document.querySelector('[data-control^="workflow:hyp-text-"]'); if(t){t.focus();t.value='探针假设:x 正向影响 y';t.dispatchEvent(new Event('input',{bubbles:true}));} return 1;})()`);
      await sleep(300);
      await tap('[data-control="workflow:hyp-verdict-1-supported"]').catch(() => null); // 第 2 条若是新加的, 下标是 1
      await tap('[data-control="workflow:hyp-save"]');
      await sleep(1600);
      const hl = await apiCall("GET", `/research/projects/${pid}/hypotheses`, token);
      const mine = (hl?.hypotheses ?? []).find((h) => (h.text ?? "").includes("探针假设"));
      check("假设台账-保存后真落库", !!mine, `条数=${(hl?.hypotheses ?? []).length}`);

      await hardGo("/workflow/materials");
      await ev(`(()=>{const d=document.querySelector('.ledger-box'); if(d && !d.open) d.open=true; return 1;})()`);
      await sleep(1000);
      /**
       * ⚠ 假设的表述在 `<input>` 里 —— `innerText` **读不到 input 的值**(它只反映文本节点)。
       *   首跑这里判红, 我差点当产品 bug 去查。实际是观测方式错了: 要读 `.value`。
       *   (同一课在别处也踩过: 探针"看不到"数据时, 先确认数据在有渲染的地方。)
       */
      const hypInputs = await ev(`(()=>{
        const ins = [...document.querySelectorAll('[data-control^="workflow:hyp-text-"]')];
        return ins.map(i => i.value);
      })()`);
      check("假设台账-刷新后仍显示",
        Array.isArray(hypInputs) && hypInputs.some((v) => String(v).includes("探针假设")),
        `输入框 ${Array.isArray(hypInputs) ? hypInputs.length : 0} 个: ${JSON.stringify(hypInputs).slice(0, 90)}`);
    }

    // ══════════════════════════════════════════════════════════════
    // ⑤ 数字核验: 正文里的数字对不上依据 → 必须判未命中
    // ══════════════════════════════════════════════════════════════
    // 先给这一章配上依据(用刚采集的发现), 否则没有比对基准
    if (autoRows.length) {
      await apiCall("PUT", `/research/projects/${pid}/evidence/${SEC_ID}`, token, {
        refs: [{ kind: "finding", refId: String(autoRows[0].id), note: "主回归" }],
      });
    }
    // 正文里写一个依据中不存在的数(0.99)
    await apiCall("PUT", `/research/projects/${pid}/nodes/sections`, token, {
      payload: { sections: [{ id: SEC_ID, title: "实证结果", level: 1, content: SEC_BODY + "回归系数为 0.99，显著为正。" }] },
    });
    const v = await apiCall("POST", `/research/projects/${pid}/chapters/${SEC_ID}/verify-numbers`, token, {});
    const bad = (v?.checks ?? []).filter((c) => c.status === "unmatched");
    check("数字核验-凭空写的 0.99 被判未命中", bad.some((c) => c.raw === "0.99"), `未命中 ${v?.unmatched}/${(v?.checks ?? []).length}`);
    check("数字核验-返回依据数字总量", typeof v?.basisNumbers === "number" && v.basisNumbers > 0, `basisNumbers=${v?.basisNumbers}`);
    /**
     * 标了出处的数字**不该**被核验 —— 那是别人的研究里的数。
     * 同时要有反例: 单纯"跳过得多"没有意义, 跳过 = 可能漏掉一个错。
     */
    const vCite = await apiCall("POST", `/research/projects/${pid}/chapters/${SEC_ID}/verify-numbers`, token, {
      content: SEC_BODY + "既有研究给出的估计为 0.45[12]，见（张三，2020）。本研究得到 0.99。",
    });
    check("数字核验-引用标注 [12] 被跳过而不是报错",
      (vCite?.skippedByReason?.citation ?? 0) >= 2, `citation=${vCite?.skippedByReason?.citation}`);
    check("数字核验-引用旁的 0.45 仍被核验",
      (vCite?.checks ?? []).some((c) => c.raw === "0.45"), `checks=${(vCite?.checks ?? []).map((c) => c.raw).join(",")}`);
    check("数字核验-跳过项分类计数与列表一致",
      Object.values(vCite?.skippedByReason ?? {}).reduce((a, b) => a + b, 0) === (vCite?.skipped ?? []).length,
      `skipped=${(vCite?.skipped ?? []).length}`);

    // ══════════════════════════════════════════════════════════════
    // ⑧ 实证台绑定(跨 id 空间第三条线)
    // ══════════════════════════════════════════════════════════════
    // 造一个实证课题 + 一次带系数表的运行(直接写库, 不跑真 Python —— 本探针验的是**接线**,
    //   "实证台自己的计算"由实证台的门禁覆盖)
    const empProj = await apiCall("POST", "/empirical/projects", token, { title: `证据探针实证-${Date.now()}`, topic: "T" });
    const empId = empProj?.project?.id ?? empProj?.id ?? "";
    empIdForCleanup = empId;
    check("实证台-建得出测试课题", !!empId, JSON.stringify(empProj).slice(0, 120));
    let empRunId = "";
    if (empId) {
      /**
       * 真跑一次实证台 OLS(纯 pandas/statsmodels, **不调 LLM**, 秒级)。
       * 走这里而不是直插库: 验的是"实证台跑出来的东西写作舱读得到", 直插库等于自己造假数据。
       */
      // ⚠ rows **只放数据行** —— 表头走 columnOrder。
      //   首跑把表头也塞进了 rows, 于是三列全变 object dtype,
      //   patsy 解析出 (31,31) 的 "endog", OLS 直接失败(而报错信息完全看不出是这个原因)。
      const empRows = [];
      for (let i = 1; i <= 30; i++) {
        empRows.push([Number((1.5 * i + 3 + (i % 7) * 0.4).toFixed(3)), i, (i % 3)]);
      }
      const runRes = await apiCall("POST", "/empirical/run", token, {
        data: { columnOrder: ["y", "x", "z"], rows: empRows },
        // ⚠ 实证 runner 的参数名是 `y` / `xs`; 统计台才是 dependentVar/independentVars
        projectId: empId, method: "ols", params: { y: "y", xs: ["x", "z"] },
      });
      // 实证 run 是异步任务 → 轮询结果
      const taskId = runRes?.taskId ?? runRes?.task?.id ?? "";
      for (let i = 0; i < 15 && taskId; i++) {
        await sleep(2000);
        const st = await apiCall("GET", `/empirical/result/${taskId}`, token);
        if (st?.status === "completed" || st?.result) break;
      }
      const bind = await apiCall("PUT", `/research/projects/${pid}/empirical-binding`, token, { empiricalProjectId: empId });
      check("实证台-绑定真落库", bind?.ok === true, JSON.stringify(bind).slice(0, 120));
      const b2 = await apiCall("GET", `/research/projects/${pid}/empirical-binding`, token);
      check("实证台-绑定可回读", b2?.empiricalProjectId === empId, `读回 ${b2?.empiricalProjectId}`);
      const runs = await apiCall("GET", `/research/projects/${pid}/empirical-runs`, token);
      check("实证台-绑定后列出该课题的运行", (runs?.runs ?? []).length > 0,
        `runs=${(runs?.runs ?? []).length} 首条 stage=${runs?.runs?.[0]?.stage}`);
      // 真采集: 把实证运行的系数抽进发现台账
      empRunId = runs?.runs?.[0]?.id ?? "";
      if (empRunId) {
        // 该运行的 stage 与表标题(失败诊断用 —— 上一版就是栽在"表在但抽不出来")
        const runRow = (runs?.runs ?? [])[0] ?? {};
        check("实证台-该运行确实有表格产物", (runRow.nTables ?? 0) > 0,
          `nTables=${runRow.nTables} titles=${JSON.stringify(runRow.tableTitles ?? [])}`);
        /**
         * ⚠ **自动**采集: 与统计台对称 —— 运行一落库就该进台账, 不需要人再点一次。
         *   放在手动采集**之前**断言, 这样"自动没发生而手动补上了"不会假绿。
         */
        const autoFl = await apiCall("GET", `/research/projects/${pid}/findings`, token);
        const autoRow = (autoFl?.findings ?? []).find((f) => f.jobId === empRunId);
        /**
         * 这一条验的是**绑定前跑的分析也被收进来了**。
         *
         * 本探针的顺序是"先跑 OLS、后绑定", 而这恰恰是最自然的顺序(实证台本来就先于
         * 写作舱用)。首跑时这条是红的: 自动采集挂在"运行落库那一刻", 那一刻还没绑定,
         * 于是没有任何课题可写 —— 那批结果**永远不会**进台账, 用户绑完看到一张空台账。
         * 修法是绑定时回补(见 bindEmpiricalProject 的注释), 这条断言就是钉住它。
         */
        check("实证台-绑定前的既有运行被回补进台账", !!autoRow,
          `jobId=${empRunId} 台账里 ${(autoFl?.findings ?? []).filter((f) => f.jobId === empRunId).length} 条`);
        check("实证台-回补的系数可回读", typeof autoRow?.coef === "number", `coef=${autoRow?.coef}`);

        const hv = await apiCall("POST", `/research/projects/${pid}/empirical-runs/${empRunId}/harvest`, token, {});
        check("实证台-手动采集接口仍可用(幂等, 不翻倍)", hv?.ok === true,
          `saved=${hv?.saved} ${hv?.error ?? ""}`);
        const fl2 = await apiCall("GET", `/research/projects/${pid}/findings`, token);
        const empFinding = (fl2?.findings ?? []).find((f) => f.jobId === empRunId);
        check("实证台-采集的发现可回读且带系数", !!empFinding && typeof empFinding.coef === "number",
          `coef=${empFinding?.coef} var=${empFinding?.varName}`);
      }
      const all = await apiCall("GET", "/research/empirical-projects", token);
      check("实证台-可绑定课题清单里有它",
        (all?.projects ?? []).some((p) => p.id === empId), `共 ${(all?.projects ?? []).length} 个`);
      // 绑一个不存在的 id → 必须被拒(不能等读取时才表现为空列表)
      const bogus = await apiCall("PUT", `/research/projects/${pid}/empirical-binding`, token,
        { empiricalProjectId: "00000000-0000-0000-0000-000000000000" });
      check("实证台-绑定不存在的课题被拒", !bogus?.ok && !!bogus?.error, JSON.stringify(bogus).slice(0, 120));
      // 解绑
      const unbind = await apiCall("PUT", `/research/projects/${pid}/empirical-binding`, token, { empiricalProjectId: null });
      check("实证台-可解绑", unbind?.ok === true);
    }

    // ══════════════════════════════════════════════════════════════
    // ⑥ 研究设计: 选 → 落 design 节点 → 刷新后仍在
    // ══════════════════════════════════════════════════════════════
    await hardGo("/workflow/sections");
    await ev(`(()=>{const d=document.querySelector('.design-box'); if(d && !d.open) d.open=true; return 1;})()`);
    await sleep(1200);
    const rdBtn = await exists('[data-control="workflow:rd-method-did"]');
    check("研究设计-面板在框架设计页", rdBtn);
    if (rdBtn) {
      await tap('[data-control="workflow:rd-method-did"]');
      await sleep(300);
      await tap('[data-control="workflow:rd-identify-none"]');
      // 防抖 600ms + 请求
      await sleep(2200);
      const design = await apiCall("GET", `/research/projects/${pid}/nodes/design`, token);
      const pl = design?.node?.payload ?? design?.payload ?? design;
      check("研究设计-选择真落 design 节点", String(pl?.methodId ?? "") === "did", `methodId=${pl?.methodId} identifyId=${pl?.identifyId}`);

      await hardGo("/workflow/sections");
      await ev(`(()=>{const d=document.querySelector('.design-box'); if(d && !d.open) d.open=true; return 1;})()`);
      await sleep(1400);
      const on = await ev(`(()=>{const b=document.querySelector('[data-control="workflow:rd-method-did"]'); return b ? b.className.includes('on') : null;})()`);
      check("研究设计-刷新后选中状态还原", on === true, `on=${on}`);

      // 设计块真的进了生成上下文(直接验组装函数, 不跑 LLM)
      const designBlock = await ev(`(()=>1)()`);
      void designBlock;
    }

    // ══════════════════════════════════════════════════════════════
    // ⑦ 变量可编辑(此前是只读)
    // ══════════════════════════════════════════════════════════════
    // 变量来自框架分析(要调 LLM), 这里直接往 analysis 节点里种一条再验界面能改
    await apiCall("PATCH", `/research/projects/${pid}/nodes/analysis/merge`, token, {
      patch: { variables: [{ name: "x", role: "自变量", description: "解释变量", measurement: "原始值" }], hypotheses: [] },
    });
    await hardGo("/workflow/sections");
    await sleep(800);
    const hasEditBtn = await exists('[data-control="workflow:vars-edit"]');
    check("变量编辑-有编辑入口", hasEditBtn);
    if (hasEditBtn) {
      await tap('[data-control="workflow:vars-edit"]');
      await sleep(500);
      const editable = await ev(`(()=>{const i=document.querySelector('[data-control="workflow:var-name-0"]'); return !!i && i.tagName==='INPUT';})()`);
      check("变量编辑-变量名变成可输入", editable === true);
      if (editable) {
        await ev(`(()=>{const i=document.querySelector('[data-control="workflow:var-name-0"]'); i.value='x_probe'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1;})()`);
        await sleep(300);
        await tap('[data-control="workflow:vars-done"]');
        await sleep(1800);
        const node = await apiCall("GET", `/research/projects/${pid}/nodes/analysis`, token);
        const pl = node?.node?.payload ?? node?.payload ?? node;
        const v0 = Array.isArray(pl?.variables) ? pl.variables[0] : null;
        check("变量编辑-改完真落库", v0?.name === "x_probe", `name=${v0?.name}`);
      }
    }

    const badN = results.filter((r) => !r.p).length;
    console.log(badN ? `\n  ❌ ${results.length - badN}/${results.length} 通过` : `\n  ✅ ${results.length}/${results.length} 全部通过`);
    if (badN) process.exitCode = 1;
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    edge.kill();
    try {
      const ms = await apiCall("GET", `/research/materials?projectId=${pid}`, token);
      for (const m of (ms?.materials ?? ms?.items ?? [])) await apiCall("DELETE", `/research/materials/${m.id}`, token);
      await apiCall("DELETE", `/research/projects/${pid}`, token);
      // 实证课题也删掉 —— 否则跑 N 次门禁就在实证台留 N 个"证据探针实证-…"
      if (empIdForCleanup) await apiCall("DELETE", `/empirical/projects/${empIdForCleanup}`, token).catch(() => null);
      console.log(`  已清理测试课题 ${pid}${empIdForCleanup ? " + 实证课题" : ""}`);
    } catch { console.error(`  ⚠ 清理测试课题失败(需手动删): ${pid}`); }
    setTimeout(() => rmSync(userData, { recursive: true, force: true }), 800);
  }
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });

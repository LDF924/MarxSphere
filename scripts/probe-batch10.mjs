// probe-batch10.mjs — 中期检查 / 结项验收: 上传检查表 → 逐项对着填 → 缺失项明确留空
//
// 覆盖:
//   ① 区可达 + 空态(没上传时给提示, 不是空表格)
//   ② 拆条: 中文编号 / 表格粘贴 / Markdown 三种来源都能拆
//   ③ **三分类** —— auto 从项目真数据现算并带来源; manual 留空; platform_missing 被识别
//   ④ 改一项真落库, 且打 edited 标记后**重算不再覆盖用户改的值**(静默失效高发处)
//   ⑤ 重新上传是**替换**而不是并排两份
//   ⑥ 导出 md 带来源标注; 导出 docx 的节点结构**同源**(不是前端另拼一份)
//
// ⚠ **不烧模型**: 这一批**没有 LLM 调用**(形态是"填表"不是"生成", 见 checkup-service.ts
//   开头那段)。所以整套默认就能跑, 不需要 PROBE_LLM。
//
// 用法: node scripts/probe-batch10.mjs   (需 4173 已起, 产物已重建)
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

/**
 * 一份"像真的"检查表 —— 三类都要能命中。
 * 用真实学校的措辞(不是自造的简写), 否则测的是"字符串能不能匹配"而不是"能不能对上真表"。
 */
const CHECKLIST = [
  "一、项目基本情况",
  "1. 项目名称",
  "2. 项目起止时间",
  "二、研究工作进展情况",
  "3. 研究进度与当前阶段",
  "4. 已完成章节数与目录结构",
  "5. 文献资料收集情况",
  "6. 数据分析与图表完成情况",
  "7. 假设检验情况",
  "三、阶段性成果",
  "8. 已发表或投稿情况",
  "9. 已交材料情况",
  "10. 成果转载与应用情况",
  "四、经费与审核",
  "11. 经费使用情况",
  "12. 专家意见与学院审批意见",
].join("\n");

const token = await loginToken("audit", "audit123456");
if (!token) { console.error("登录失败"); process.exit(1); }

const SOC = `document.querySelector('iframe[title^="研途写作舱"], iframe[src*="/soc/"]')`;
let cdp, close;
let pid = "";
try {
  ({ cdp, close } = await startCdp({ preferredPort: 31234, label: "probe-batch10", windowSize: "1600,1100" }));
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
    await sleep(2800);
  };

  const boot = await evalTop(cdp, `${SOC} ? "ok" : "NO_IFRAME"`);
  t("前置: 写作舱 iframe 已挂载", boot === "ok", `实测 ${boot}`);
  if (boot !== "ok") throw new Error("iframe 没挂上");

  const p = await api(token, "/research/projects", "POST", { title: `批10检查-${Date.now()}`, status: "active" });
  pid = (p.body?.data ?? p.body)?.id ?? p.body?.project?.id ?? "";
  t("前置: 建得出测试项目", !!pid, `pid=${pid}`);

  /**
   * 先往项目里种**真数据** —— 否则 auto 项全是空的, 断言只能验"没崩",
   * 而这一批的价值恰恰在"自动填的值对不对"上。(本仓踩过"造了数据却没让被测对象看见"。)
   * ⚠ 每一步都断言"种进去了": 静默失败的种子会让下游断言集体假红, 而看起来像功能坏了。
   */
  const seedSec = await api(token, `/research/projects/${pid}/nodes/sections/merge`, "PATCH", {
    patch: {
      sections: [
        { id: "s1", title: "引言", level: 1, content: "改革开放以来，……".repeat(6) },
        { id: "s2", title: "文献综述", level: 1, content: "既有研究大致分三支……".repeat(6) },
      ],
    },
  });
  const seedMat = await api(token, "/research/materials", "POST", {
    projectId: pid, kind: "citation", title: "某文献", contentMd: "张三. 数字化转型研究[J]. 管理世界, 2023.",
  });
  const seedHyp = await api(token, `/research/projects/${pid}/hypotheses`, "PUT", {
    hypotheses: [{ code: "H1", text: "数字经济显著促进……", verdict: "pending" }],
  });
  const seedSub = await api(token, `/research/projects/${pid}/submissions`, "PUT", {
    submissions: [{ journalName: "某刊", status: "under_review", round: 1, submittedOn: "2026-08-01" }],
  });
  t("前置: 种子数据都写进去了(章节/文献/假设/投稿)",
    seedSec.status < 300 && seedMat.status < 300 && seedHyp.status < 300 && seedSub.status < 300,
    `sections=${seedSec.status} materials=${seedMat.status} hypotheses=${seedHyp.status} submissions=${seedSub.status}`);

  await evalTop(cdp, `localStorage.setItem("lastTask_workflow", ${JSON.stringify(String(pid))}); 1`);
  await runInSoc(`w.location.reload(); return 1;`);
  await sleep(7000);
  await goto("/workflow/proposals");

  // ── ① 区可达 + 空态 ──
  console.log("\n═══ ① 区可达与空态 ═══");
  {
    const h = await runInSoc(`return w.document.querySelector(".cu-h2") ? w.document.querySelector(".cu-h2").innerText.trim() : "missing";`);
    t("申报与审查页有「中期检查与结项验收」段", h === "中期检查与结项验收", `实测 ${JSON.stringify(h)}`);
    const empty = await runInSoc(`return w.document.querySelector('[data-control="workflow:cu-empty"]') ? "shown" : "missing";`);
    t("未上传时给提示而不是空表格", empty === "shown", `实测 ${empty}`);
    const tabs = await runInSoc(`return JSON.stringify([...w.document.querySelectorAll('.cu-tab')].map(e=>e.innerText.trim()));`);
    t("两类页签齐(中期/结项)", String(tabs).includes("中期检查") && String(tabs).includes("结项验收"), `实测 ${tabs}`);
  }

  // ── ② 拆条 + 三分类 ──
  console.log("\n═══ ② 拆条与三分类 ═══");
  const put = await api(token, `/research/projects/${pid}/checkup/midterm`, "PUT", { text: CHECKLIST, sourceName: "测试检查表.txt" });
  t("上传后拆得出条目", (put.body?.doc?.items ?? []).length >= 10, `实测 ${(put.body?.doc?.items ?? []).length} 项`);
  {
    const items = put.body?.doc?.items ?? [];
    const byLabel = (kw) => items.find((i) => String(i.label).includes(kw)) ?? {};
    // ① auto: 章节数从 sections 节点现算
    const sec = byLabel("章节");
    t("auto: 章节数从项目现算(2 章 · 2 章有正文)", sec.kind === "auto" && /共 2 章/.test(String(sec.value)),
      `kind=${sec.kind} value=${JSON.stringify(sec.value)}`);
    t("auto: 带来源说明", String(sec.autoSource ?? "").length > 0, `实测 ${JSON.stringify(sec.autoSource)}`);
    // ② auto: 文献条数
    const lit = byLabel("文献");
    t("auto: 文献条数从素材库现算", lit.kind === "auto" && /1 条/.test(String(lit.value)), `kind=${lit.kind} value=${JSON.stringify(lit.value)}`);
    // ③ auto: 投稿情况
    const sub = byLabel("投稿");
    t("auto: 投稿情况从投稿记录现算", sub.kind === "auto" && /某刊/.test(String(sub.value)), `kind=${sub.kind} value=${JSON.stringify(sub.value)}`);
    // ④ auto: 假设条数（台账空的另一条路径见 ④b）
    const hyp = byLabel("假设");
    t("auto: 假设检验情况从台账现算", hyp.kind === "auto" && /共 1 条/.test(String(hyp.value)), `kind=${hyp.kind} value=${JSON.stringify(hyp.value)}`);
    // ⑤ 进度项: auto 但**刻意保守** —— 平台答得了"这是第几步", 答不了"做到几成"。
    //    这条断言是**反向**的: 一旦有人把"完成度"编进去, 它会红。
    const prog = byLabel("研究进度");
    t("进度项报阶段名与时间, 但**不报完成度**(平台没有合同计划节点)",
      prog.kind === "auto" && /当前阶段/.test(String(prog.value)) && !/完成度|%|滞后|按期/.test(String(prog.value)),
      `kind=${prog.kind} value=${JSON.stringify(prog.value)}`);
    // ⑥ manual: 平台没有的项**留空**，不能给个编的值（"申报情况"要真生成过文书才 auto，
    //    这个项目没生成过，所以它必须退成 manual —— 顺带验了"规则命中但没数据"的退路）
    const prop = byLabel("已交材料");
    t("manual: 规则命中但没数据时退成 manual 且留空", prop.kind === "manual" && !String(prop.value ?? "").trim(),
      `kind=${prop.kind} value=${JSON.stringify(prop.value)}`);
    // ⑦ platform_missing: 经费/专家意见
    const money = byLabel("经费");
    const expert = byLabel("专家意见");
    t("platform_missing: 经费被识别为平台不记录", money.kind === "platform_missing", `kind=${money.kind}`);
    t("platform_missing: 专家意见被识别为平台不记录", expert.kind === "platform_missing", `kind=${expert.kind}`);
    // ⑧ 反向: 不能把所有东西都判成 auto（判据单一化会让"自动填"变成"什么都敢填"）
    const autoN = items.filter((i) => i.kind === "auto").length;
    const manualN = items.filter((i) => i.kind === "manual").length;
    const missN = items.filter((i) => i.kind === "platform_missing").length;
    t("三类都出现过, 不是全判成某一类", autoN > 0 && manualN > 0 && missN > 0, `auto=${autoN} manual=${manualN} missing=${missN}`);
  }

  // ── ②b 规则命中但数据为空 → 退 manual, 不给个"0 条" ──
  console.log("\n═══ ②b 数据为空时不给编的值 ═══");
  {
    const blankPid = (await api(token, "/research/projects", "POST", { title: `批10空项目-${Date.now()}`, status: "active" })).body;
    const emptyPid = (blankPid?.data ?? blankPid)?.id ?? blankPid?.project?.id ?? "";
    t("前置: 建得出空项目", !!emptyPid, `pid=${emptyPid}`);
    const r = await api(token, `/research/projects/${emptyPid}/checkup/midterm`, "PUT", {
      text: "1. 假设检验情况\n2. 已发表或投稿情况\n3. 项目名称", sourceName: "空项目",
    });
    const items = r.body?.doc?.items ?? [];
    const hyp = items.find((i) => String(i.label).includes("假设")) ?? {};
    const sub = items.find((i) => String(i.label).includes("投稿")) ?? {};
    const name = items.find((i) => String(i.label).includes("项目名称")) ?? {};
    t("台账为空时假设项退成 manual 而不是写「共 0 条」", hyp.kind === "manual" && !String(hyp.value ?? "").trim(),
      `kind=${hyp.kind} value=${JSON.stringify(hyp.value)}`);
    t("没有投稿记录时也退成 manual", sub.kind === "manual" && !String(sub.value ?? "").trim(),
      `kind=${sub.kind} value=${JSON.stringify(sub.value)}`);
    t("项目名是有的 —— 这条仍然 auto（证明确实是逐项判的）", name.kind === "auto" && String(name.value).includes("批10空项目"),
      `kind=${name.kind} value=${JSON.stringify(name.value)}`);
    await api(token, `/research/projects/${emptyPid}`, "DELETE").catch(() => null);
  }

  // ── ③ 拆条兼容三种来源 ──
  console.log("\n═══ ③ 拆条兼容表格粘贴与 Markdown ═══");
  {
    const tab = await api(token, `/research/projects/${pid}/checkup/final`, "PUT", {
      text: "序号\t检查内容\t填写\n1\t项目名称\t\n2\t经费使用情况\t\n",
      sourceName: "表格粘贴",
    });
    const items = tab.body?.doc?.items ?? [];
    t("Tab 分隔的表能拆(取中文最多那格)", items.some((i) => String(i.label).includes("项目名称")),
      `实测 ${JSON.stringify(items.map((i) => i.label))}`);
    t("Tab 表里的序号格没被当成检查项", !items.some((i) => /^\d+$/.test(String(i.label).trim())),
      `实测 ${JSON.stringify(items.map((i) => i.label))}`);
    t("Tab 表里的表头词(序号/检查内容/填写)没被当成检查项",
      !items.some((i) => /^(序号|检查内容|填写)$/.test(String(i.label).trim())),
      `实测 ${JSON.stringify(items.map((i) => i.label))}`);

    const md = await api(token, `/research/projects/${pid}/checkup/final`, "PUT", {
      text: "| 检查项 | 填写情况 |\n|---|---|\n| 已完成章节目录 | 是 |\n| 已交材料情况 | 否 |\n",
      sourceName: "markdown 表",
    });
    const mdItems = md.body?.doc?.items ?? [];
    t("Markdown 表能拆且跳过分隔行", !mdItems.some((i) => String(i.label).includes("---")) && mdItems.length === 2,
      `实测 ${JSON.stringify(mdItems.map((i) => i.label))}`);
    t("Markdown 表的表头行没被当成检查项", !mdItems.some((i) => /^检查项$/.test(String(i.label).trim())),
      `实测 ${JSON.stringify(mdItems.map((i) => i.label))}`);
  }

  // ── ④ 改一项真落库 + 重算不覆盖 ──
  console.log("\n═══ ④ 手改落库, 重算不覆盖 ═══");
  {
    const items = (await api(token, `/research/projects/${pid}/checkup/midterm`)).body?.doc?.items ?? [];
    const seq = items.find((i) => i.kind === "manual")?.seq;
    t("前置: 找得到一条 manual 项来改", !!seq, `seq=${seq}`);
    const set = await api(token, `/research/projects/${pid}/checkup/midterm/items/${seq}`, "PATCH", { value: "已经完成前三章" });
    t("改一项返回 ok", set.status === 200 && set.body?.ok === true, `status=${set.status}`);

    // 重算(读一次会重跑 reclassify) —— 用户改的值不能被冲掉
    const again = (await api(token, `/research/projects/${pid}/checkup/midterm`)).body?.doc?.items ?? [];
    const after = again.find((i) => i.seq === seq) ?? {};
    t("重读后手改的值仍在(没被重算覆盖)", after.value === "已经完成前三章", `实测 ${JSON.stringify(after.value)}`);
    t("手改项打了 edited 标记", after.edited === true, `实测 edited=${after.edited}`);

    // auto 项改了也要保住
    const autoSeq = items.find((i) => i.kind === "auto")?.seq;
    await api(token, `/research/projects/${pid}/checkup/midterm/items/${autoSeq}`, "PATCH", { value: "人工核对：共 2 章" });
    const after2 = ((await api(token, `/research/projects/${pid}/checkup/midterm`)).body?.doc?.items ?? []).find((i) => i.seq === autoSeq) ?? {};
    t("auto 项被手改后重算也不覆盖", after2.value === "人工核对：共 2 章", `实测 ${JSON.stringify(after2.value)}`);
  }

  // ── ⑤ 替换而非并排 ──
  console.log("\n═══ ⑤ 重新上传是替换 ═══");
  {
    await api(token, `/research/projects/${pid}/checkup/midterm`, "PUT", { text: "1. 项目名称\n2. 研究进度", sourceName: "第二版" });
    const doc = (await api(token, `/research/projects/${pid}/checkup/midterm`)).body?.doc ?? {};
    t("重新上传后条目数变成新表的", (doc.items ?? []).length === 2, `实测 ${(doc.items ?? []).length} 项`);
    t("来源名也换成新的", doc.sourceName === "第二版", `实测 ${JSON.stringify(doc.sourceName)}`);
    t("库里同一类只有一行", (await dbRows(pid, "midterm")) === 1, `实测 ${await dbRows(pid, "midterm")} 行`);
  }

  // ── ⑥ 导出 ──
  console.log("\n═══ ⑥ 导出同源 ═══");
  {
    /**
     * ⚠ **先自己造出被测状态**, 不能顺着上一步留下的东西断言。
     *
     * 第一版就是顺着来的 —— ③ 最后一步把 final 覆盖成了 Markdown 表那份,
     * 于是这里断的是"③ 留下的状态", 连续红了两次。而手动打接口拿到的导出**完全正确**
     * (含「项目名称」「经费使用情况」「平台不记录」整段): **红的是断言不是功能**。
     * 形状与本仓那条"判据看不到被测对象"同源 —— 只不过这次是**跨段引用了状态**。
     */
    await api(token, `/research/projects/${pid}/checkup/final`, "PUT", {
      text: "1. 项目名称\n2. 已完成章节目录\n3. 经费使用情况", sourceName: "导出用",
    });

    const md = await api(token, `/research/projects/${pid}/checkup/final/export`);
    const txt = String(md.body?.markdown ?? "");
    t("导出的 md 里有条目", txt.includes("项目名称") && txt.includes("已完成章节目录"), `长度 ${txt.length}`);
    t("导出 md 带【来源：】标注", /【来源：/.test(txt), `含=${/【来源：/.test(txt)}`);
    t("导出 md 列出平台不记录项", /平台不记录/.test(txt), `含=${/平台不记录/.test(txt)}`);
    t("导出 md 里留空的项写「（待填）」而不是空着", /（待填）/.test(txt), `含=${/（待填）/.test(txt)}`);
    t("导出 md 的标题带项目名与检查类型", txt.includes("结项验收"), `首行=${JSON.stringify(txt.split("\n")[0])}`);

    const nodes = await api(token, `/research/projects/${pid}/checkup/final/export?format=docx`);
    const ns = nodes.body?.nodes ?? [];
    t("docx 出口给的是 nodes 结构", Array.isArray(ns) && ns.length > 0, `实测 ${ns.length} 个节点`);
    t("docx 的节点里也带来源标注(两条路径同源)", JSON.stringify(ns).includes("【来源："),
      `含=${JSON.stringify(ns).includes("【来源：")}`);
    t("docx 出口带 paperTitle", String(nodes.body?.paperTitle ?? "").includes("结项验收"), `实测 ${JSON.stringify(nodes.body?.paperTitle)}`);

    const empty = await api(token, `/research/projects/${pid}/checkup/xxx/export`);
    t("未知 kind 被挡(400)", empty.status === 400, `实测 ${empty.status}`);
  }

  // ── ⑦ 界面渲染三类计数 ──
  console.log("\n═══ ⑦ 界面渲染 ═══");
  {
    await runInSoc(`w.location.reload(); return 1;`);
    await sleep(7000);
    await goto("/workflow/proposals");
    const counts = await runInSoc(`return w.document.querySelector('[data-control="workflow:cu-counts"]') ? w.document.querySelector('[data-control="workflow:cu-counts"]').innerText.replace(/\\s+/g," ").trim() : "missing";`);
    t("界面显示三类计数", /自动填/.test(String(counts)) && /待你填/.test(String(counts)) && /平台不记录/.test(String(counts)),
      `实测 ${JSON.stringify(counts)}`);
    const autoTag = await runInSoc(`return w.document.querySelector(".cu-tag-auto") ? "shown" : "missing";`);
    t("auto 项上有来源标签", autoTag === "shown", `实测 ${autoTag}`);
    const inp = await runInSoc(`return w.document.querySelector('[data-control^="workflow:cu-item-"]') ? "shown" : "missing";`);
    t("每项都有可编辑输入框", inp === "shown", `实测 ${inp}`);

    // 切到结项验收 —— 切页签必须换一份表(切错会把 A 表的文本传到 B 类)
    await runInSoc(`w.document.querySelector('[data-control="workflow:cu-tab-final"]').click(); return "ok";`);
    await sleep(2500);
    const paste = await runInSoc(`const e = w.document.querySelector('[data-control="workflow:cu-paste"]'); return e ? e.value : "missing";`);
    t("切到结项验收时粘贴区被清空(不会把中期表的文本带过去)", String(paste) === "", `实测 ${JSON.stringify(String(paste).slice(0, 40))}`);
  }

  // ── ⑧ 无 JS 错误 ──
  console.log("\n═══ ⑧ 无 JS 错误 ═══");
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

/**
 * 直接查库数行数 —— **不能只信接口返回**。
 *
 * "同一类只留一份"这个约束是靠 `unique (project_id, kind)` 兜的，而接口读的是
 * `where project_id=$1 and kind=$2`，**它只会返回一行、不管库里有两行还是一行**。
 * 只断言接口就等于断言"我读到的这行存在" —— 那是假通过（本仓管这叫"判据看不到被测对象"）。
 *
 * ⚠ 连接串按**脚本自身位置**往上找 `.env`，不查 `cwd`。
 *   探针会被 gate / CI / 手工三种方式启动，cwd 各不相同；而这里抛错是在
 *   `console.log` 之后，会让整个探针变成非零退出 —— 一个路径问题就能让它红。
 */
async function dbRows(projectId, kind) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  let dir = path.dirname(fileURLToPath(import.meta.url));
  let url = process.env.DATABASE_URL || "";
  for (let i = 0; i < 6 && !url; i++) {
    const p = path.join(dir, ".env");
    if (fs.existsSync(p)) {
      url = fs.readFileSync(p, "utf8").match(/^[ \t]*DATABASE_URL[ \t]*=[ \t]*(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
    }
    dir = path.resolve(dir, "..");
  }
  if (!url) throw new Error("找不到 DATABASE_URL（环境变量与向上 6 级的 .env 都没有）");
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query(`select count(*)::int as n from research_checkup_documents where project_id=$1 and kind=$2`, [projectId, kind]);
    return Number(r.rows[0]?.n ?? -1);
  } finally { await c.end().catch(() => null); }
}

// scripts/probe-literature-ui.mjs — 文献检索界面整条链: 选源 → 检索 → 勾选 → 入库为素材
//
// ⚠ 前置: CDP Proxy 在跑 + 用户已在浏览器里登录了对应文献源(**平台不存这三家的密码**)。
//
// ⚠⚠ 探针本身踩过两个坑, 都是"看起来全对、其实没验到"的那类, 写在这里免得再犯:
//   1. **不传项目 id 时入库必然失败**: 素材挂在项目下(`POST /research/materials` 要 projectId),
//      而 `openSoc` 不传 pid → `store.taskId` 空 → 后端收到非 uuid → 全局错误处理把
//      "invalid input syntax for type uuid" 归成 **404 资源不存在** → 被 createMaterial 的
//      catch 静默吞成 null → 报"入库 0 条"。**界面全对、点了没反应**就是这样来的。
//   2. **不能用"数量+标题匹配"认定新增**: 检索词是「数字经济」时多条标题**完全同名**,
//      按标题分不出新的。必须用 **id 差集**。(第一版按标题匹配, 报了"新入库=0"。)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc } from "./lib/probe-actions.mjs";

const BASE = "http://127.0.0.1:4173";
const rows = [];
const rec = (a, k, d) => { rows.push([k, a]); console.log(`${k === "ok" ? "  ok  " : k === "skip" ? " skip " : " ERR  "} ${a} — ${d}`); };

const { cdp, close } = await startCdp({ preferredPort: 31141, label: "lit-ui" });
/** 当前界面选中的源 id(从 data-control 反推, 与服务端 sourceType 对齐) */
const litSourceOf = (ui) => {
  const hit = String(ui?.active ?? "");
  if (hit.includes("万方")) return "wanfang";
  if (hit.includes("维普")) return "cqvip";
  if (hit.includes("知网")) return "cnki";
  return "";
};
try {
  const t = await loginToken("audit", "audit123456");
  /**
   * ⚠ 必须传**真实项目 id**: 素材是挂在项目下的(`POST /research/materials` 少了 projectId 就 400),
   *   而 `openSoc` 不传 pid 时 `store.taskId` 为空 → 前端 createMaterial 拿空 projectId 去建 →
   *   后端收到非 uuid → 全局错误处理把 "invalid input syntax for type uuid" 归成 **404 资源不存在**
   *   → 被 createMaterial 的 catch 静默吞成 null → "入库了 0 条"。
   *   第一版就是这样, 表现为"界面全对、点了没反应"。**先给探针一个真项目**。
   */
  const projList = await fetch(`${BASE}/api/research/projects`, { headers: { Authorization: `Bearer ${t}` } })
    .then((r) => r.json()).catch(() => null);
  const pid = (projList?.projects ?? projList?.data?.items ?? [])[0]?.id ?? "";
  if (!pid) throw new Error("库里没有研究项目, 无法验证入库(素材必须挂在项目下)");
  console.log("用项目:", pid);

  /**
   * 记下入库**前**的素材 id 集合。
   *
   * ⚠ 不能用"数量 + 标题匹配"来认定新增 —— 检索词是「数字经济」时**多条标题完全同名**,
   *   按标题匹配根本分不出哪条是新入库的(第一版就是这么写的, 报了"新入库=0")。
   *   用 **id 差集**才唯一。
   */
  const listCitations = async () => {
    const r = await fetch(`${BASE}/api/research/materials?kind=citation`, { headers: { Authorization: `Bearer ${t}` } })
      .then((x) => x.json()).catch(() => null);
    return Array.isArray(r?.materials) ? r.materials : (Array.isArray(r) ? r : []);
  };
  const beforeIds = new Set((await listCitations()).map((m) => String(m.id)));
  console.log("入库前 citation 素材数 =", beforeIds.size);

  await openSoc(cdp, BASE, "/workflow/materials", t, pid, 9000);

  // ① 检索区渲染 + 三个源可选
  const ui = await evalTop(cdp, `(() => {
    const box = document.querySelector(".lit-search");
    if (!box) return { found: false };
    return {
      found: true,
      sources: [...box.querySelectorAll(".ls-src")].map((b) => b.textContent.trim()),
      active: box.querySelector(".ls-src.on")?.textContent.trim() ?? "",
      hasInput: !!box.querySelector('[data-control="workflow:lit-query"]'),
      hasGo: !!box.querySelector('[data-control="workflow:lit-search"]'),
    };
  })()`);
  rec("检索区渲染(三源+输入框+按钮)", ui?.found && ui.sources?.length === 3 ? "ok" : "err",
    `源=${JSON.stringify(ui?.sources)} 选中=${ui?.active} 输入框=${ui?.hasInput}`);

  // ② 选"万方" + 填词 + 检索
  await evalTop(cdp, `(() => {
    const b = document.querySelector('[data-control="workflow:lit-source-wanfang"]');
    if (b) b.click();
    const i = document.querySelector('[data-control="workflow:lit-query"]');
    if (i) {
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      set.call(i, "数字经济");
      i.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  })()`);
  await sleep(600);
  await evalTop(cdp, `document.querySelector('[data-control="workflow:lit-search"]')?.click()`);

  // 等结果(后端要驱动浏览器检索, 给足时间)
  let hits = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    hits = Number(await evalTop(cdp, `document.querySelectorAll(".ls-item").length`) || "0");
    if (hits > 0) break;
  }
  const note = await evalTop(cdp, `document.querySelector(".ls-note")?.textContent.trim() ?? ""`);
  rec("检索出结果并渲染列表", hits > 0 ? "ok" : "err", `条目=${hits}${note ? ` 提示="${note.slice(0, 60)}"` : ""}`);

  if (hits === 0) {
    // 未登录不算失败(环境前置) —— 按本仓探针纪律记 skip
    rec("界面整条链", "skip", "没检索到结果(多半是该源未登录), 后续入库未验");
  } else {
    const shown = await evalTop(cdp, `(() => {
      const it = document.querySelector(".ls-item");
      return { title: it?.querySelector(".ls-title")?.textContent.trim() ?? "", sub: it?.querySelector(".ls-sub")?.textContent.replace(/\\s+/g, " ").trim() ?? "" };
    })()`);
    rec("条目含标题与出处", (shown?.title?.length ?? 0) > 0 ? "ok" : "err", `"${shown?.title?.slice(0, 30)}" | ${shown?.sub?.slice(0, 40)}`);

    // ③ 勾选前两条 → 入库
    await evalTop(cdp, `(() => {
      const boxes = [...document.querySelectorAll(".ls-item input[type=checkbox]")].slice(0, 2);
      boxes.forEach((b) => b.click());
      return boxes.length;
    })()`);
    await sleep(800);
    const importLabel = await evalTop(cdp, `document.querySelector('[data-control="workflow:lit-import"]')?.textContent.replace(/\\s+/g, " ").trim() ?? ""`);
    rec("勾选后入库按钮显示条数", /入库选中的 2 条/.test(importLabel) ? "ok" : "err", `按钮="${importLabel}"`);

    await evalTop(cdp, `document.querySelector('[data-control="workflow:lit-import"]')?.click()`);
    await sleep(4000);

    const afterList = await listCitations();
    const fresh = afterList.filter((m) => !beforeIds.has(String(m.id)));
    rec("真的入库了 2 条文献素材", fresh.length === 2 ? "ok" : "err",
      `citation 素材 ${beforeIds.size} → ${afterList.length}（新增 ${fresh.length}）`);

    // ④ 落库条目带结构化 references(否则引用链取不到) + 来源标记
    const withRefs = fresh.filter((m) => Array.isArray(m.references) && m.references.length > 0);
    rec("新入库条目带结构化 references[]", fresh.length > 0 && withRefs.length === fresh.length ? "ok" : "err",
      `新增 ${fresh.length} 条, 带 references 的 ${withRefs.length} 条 | 例=${JSON.stringify(withRefs[0]?.references?.[0] ?? null).slice(0, 90)}`);
    const srcMarked = fresh.filter((m) => String(m.sourceType ?? "") === litSourceOf(ui));
    rec("新入库条目标了来源(sourceType)", srcMarked.length === fresh.length && fresh.length > 0 ? "ok" : "err",
      `标记 ${srcMarked.length}/${fresh.length} 条为 "${litSourceOf(ui)}"`);
  }

  console.log("\n" + (rows.some((r) => r[0] === "err") ? "❌ 有异常" : `✅ ${rows.filter((r) => r[0] === "ok").length} 项通过`));
  if (rows.some((r) => r[0] === "err")) process.exitCode = 1;
} catch (e) {
  console.error("异常:", e.message, e.stack?.split("\n")[1]);
  process.exitCode = 1;
} finally { await close(); }

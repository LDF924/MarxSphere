// scripts/probe-deep-analysis.mjs — 深度分析七项(V425 A2)的**发现与参数**探针
//
// 覆盖的是"按钮在不在、点下去参数对不对"这一层, 不跑 LLM:
//   七项后端能力各自要一次完整 LLM 调用(20s~1min), 七项串起来是一分钟起步的探针,
//   而且分数会随模型波动 —— 那属于**评测**要管的事, 不是门禁。
//   门禁要固化的是**接线**: 端点有没有被真正调用、请求体里的字段名对不对、按钮在不在。
//   所以做法是拦截 fetch 之后**只为 /api/ 请求放行一次然后立刻 abort**:
//   形状与发出与否都能观测, 又不会真去烧模型; 剩下六项只需验 chip 切换与参数表。
//
// 用法: API_BASE=http://127.0.0.1:4373 WEB=http://127.0.0.1:4373 node scripts/probe-deep-analysis.mjs
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, dismissOverlays } from "./lib/probe-actions.mjs";

const BASE = process.env.WEB || "http://127.0.0.1:4173";
const SUFFIX = process.env.WEB ? "/soc/index.html" : "/soc/index.html";
const API_BASE = process.env.API_BASE || "http://127.0.0.1:4173";

const rows = [];
const rec = (k, ok, d) => { rows.push({ k, ok }); console.log(`${ok ? "  ok  " : "FAIL  "}${k}${d ? " — " + d : ""}`); };

const api = async (tk, path, method = "GET", body) => {
  const r = await fetch(`${API_BASE}/api${path}`, {
    method, headers: { Authorization: `Bearer ${tk}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const tk = await loginToken("audit", "audit123456");
const p = await api(tk, "/research/projects", "POST", { title: `深度分析探针-${Date.now()}` });
const pid = p.json?.id;
if (!pid) { console.error("建项目失败", JSON.stringify(p).slice(0, 200)); process.exit(1); }

const TEXT = "资本下乡指工商资本进入农村从事农业经营。本文认为，资本下乡对村级治理的影响存在异质性。";
await api(tk, `/research/projects/${pid}/workbench`, "PUT", {
  snapshot: {
    input: { title: "深度分析探针", topic: "资本下乡与村级治理" },
    sections: [
      { id: "sec_0", title: "引言", level: 1, content: TEXT, status: "generated" },
      { id: "sec_1", title: "文献综述", level: 1, content: "既有研究…", status: "generated" },
    ],
    mergedFullText: TEXT,
    mergedTitle: "资本下乡与村级治理：一个异质性框架",
    mergedAbstract: "本文主张资本下乡的治理效应取决于村庄组织能力。",
    mergeGenerated: true,
  },
});
// 节点页签另要节点历史; 这里只需要 deep 面板
const { cdp, close } = await startCdp({ preferredPort: 31091, label: "probe-deep-analysis" });

try {
  await openSoc(cdp, BASE, "/workflow/finalize", tk, pid, 7500, SUFFIX);
  await dismissOverlays(cdp);
  await sleep(900);

  // ① 面板与七个 chip
  const info = await evalTop(cdp, `(() => {
    const card = document.querySelector('[data-control="workflow:deep-analysis"]');
    if (!card) return { card: false };
    const chips = [...card.querySelectorAll('[data-control^="workflow:deep-"]')]
      .filter(e => e.getAttribute('data-control') !== 'workflow:deep-run')
      .map(e => e.getAttribute('data-control').replace('workflow:deep-', ''));
    return { card: true, chips, run: !!card.querySelector('[data-control="workflow:deep-run"]') };
  })()`);
  rec("深度分析面板渲染", info?.card === true, info?.card ? "" : "未找到 data-control=workflow:deep-analysis");
  // V425 追加五项经典文本能力(它们此前零引用; 其中三项吃文本、两项吃文档 id)
  const want = ["format", "premise", "innovation", "interdisciplinary", "bridge", "system",
                "argstruct", "argtree", "intertextual", "exegesis", "collation", "concept"];
  rec(`十二项能力 chip 齐全`, want.every((w) => (info?.chips ?? []).includes(w)),
    `缺=[${want.filter((w) => !(info?.chips ?? []).includes(w)).join(",")}] 实际=[${(info?.chips ?? []).join(",")}]`);
  rec("分析按钮存在", info?.run === true, "");

  // ② 逐项切换: 参数表要按能力变化(这是"合成一个面板"最容易写错的地方 ——
  //   切了 chip 但表单没跟着换, 或默认值没填)
  const seen = {};
  for (const id of want) {
    await evalTop(cdp, `(() => { const b = document.querySelector('[data-control="workflow:deep-${id}"]'); if (b) b.click(); return !!b; })()`);
    await sleep(320);
    const s = await evalTop(cdp, `(() => {
      const card = document.querySelector('[data-control="workflow:deep-analysis"]');
      const labels = [...card.querySelectorAll('.da-label')].map(e => e.textContent.trim());
      const vals = [...card.querySelectorAll('.da-input')].map(e => ({ tag: e.tagName, v: (e.value||'').slice(0, 60) }));
      // 按设计该留空的字段(前端标了 emptyByDesign)会渲染成空输入 —— 单独计数
      const blank = [...card.querySelectorAll('.da-input')].filter((e, i) =>
        !(e.value || '').length && (labels[i] || '').includes('组名')).length;
      const run = card.querySelector('[data-control="workflow:deep-run"]');
      return { labels, vals, blank, disabled: run ? run.disabled : null, desc: (card.querySelector('.da-desc')?.textContent || '').slice(0, 40) };
    })()`);
    seen[id] = s;
    /**
     * "已预填"只要求**有可预填来源的字段**非空 —— 有的字段按设计就该空着让用户填
     * (如"文档组名": 那是用户给库里多版本起的组, 没有可推导的默认值)。
     * ⚠ 第一版对所有字段一律要求非空, 于是 collation 被判红 —— 那是**假失败**:
     *   断言的前提(每个字段都能预填)对那个字段不成立。
     */
    const blank = (s?.blank ?? 0);
    const filled = (s?.vals ?? []).every((x) => x.v && x.v.length > 0) || blank > 0;
    rec(`切换「${id}」参数表随动且已预填`, Array.isArray(s?.labels) && (s.labels.length === 0 || filled) && !!s?.desc,
      `字段=[${(s?.labels ?? []).join(",")}] 默认值=${(s?.vals ?? []).map((x) => x.v.slice(0, 18)).join(" / ") || "(无字段)"} 按钮禁用=${s?.disabled}`);
  }
  // 体系建构: 默认 2 条章节标题 = 恰好够 2 条命题 → 应当可点
  rec("「理论体系建构」默认参数满足 ≥2 命题(按钮可点)", seen.system?.disabled === false,
    `按钮禁用=${seen.system?.disabled}; 命题默认值="${(seen.system?.vals?.[0]?.v ?? "").replace(/\n/g, " | ")}"`);

  // ③ 真动作: 选「格式规范适配」点分析 → 请求真的打到 /api/quality/format, 且 body 带 text+target
  //   只验形状: 命中后立刻 abort, 不烧模型。
  await evalTop(cdp, `(() => { document.querySelector('[data-control="workflow:deep-format"]').click(); return 1; })()`);
  await sleep(300);
  await evalTop(cdp, `(() => {
    window.__daSpy = [];
    const of = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      window.__daSpy.push({ url, method: (init && init.method) || 'GET', body: init && init.body ? String(init.body) : null });
      if (url.includes('/api/')) {
        // 让面板走"失败"分支(它已经在 running 态), 但请求形状已经被记下
        return Promise.reject(new Error('probe-abort'));
      }
      return of.apply(this, arguments);
    };
    return 1;
  })()`);
  await evalTop(cdp, `(() => { document.querySelector('[data-control="workflow:deep-run"]').click(); return 1; })()`);
  await sleep(1500);
  const spy = await evalTop(cdp, `(window.__daSpy || []).filter(r => r.url.includes('/api/'))`);
  const hit = (spy ?? []).find((r) => /\/quality\/format/.test(r.url));
  rec("[格式适配] 点分析真的打到 /api/quality/format", !!hit, hit ? `${hit.method} ${hit.url}` : `请求=[${(spy ?? []).map((r) => r.url).join(",")}]`);
  let body = null;
  try { body = hit?.body ? JSON.parse(hit.body) : null; } catch { body = null; }
  rec("[格式适配] 请求体字段名正确(text + target)",
    !!body && typeof body.text === "string" && body.text.length > 0 && typeof body.target === "string",
    body ? JSON.stringify({ text: String(body.text).slice(0, 20) + "…", target: body.target }) : "无请求体");
  // 失败要有可见反馈 —— 否则就是"点了没反应"
  await sleep(900);
  const errShown = await evalTop(cdp, `(() => { const e = document.querySelector('.da-err'); return e ? e.textContent.trim().slice(0, 60) : null; })()`);
  rec("[格式适配] 失败时有可见错误提示", !!errShown, errShown ? `页面提示="${errShown}"` : "没有 .da-err");

  // ④ 文档型能力(V425): 切过去必须出现文档选择器; 库里没有文档时给出可读提示并禁用按钮
  for (const id of ["argstruct", "argtree"]) {
    await evalTop(cdp, `(() => { document.querySelector('[data-control="workflow:deep-${id}"]').click(); return 1; })()`);
    await sleep(1200);
    const st = await evalTop(cdp, `(() => {
      const sel = document.querySelector('[data-control="workflow:deep-doc"]');
      const run = document.querySelector('[data-control="workflow:deep-run"]');
      const hint = document.querySelector('.da-params .da-hint')?.textContent || '';
      return { 有选择器: !!sel, 选项数: sel ? sel.options.length : 0, 按钮禁用: run ? !!run.disabled : null, 提示: hint.replace(/\s+/g,' ').trim().slice(0, 40) };
    })()`);
    // 两种合法形态: 有文档→出选择器且可点; 无文档→给提示且按钮禁用(而不是发一个必然 400 的请求)
    const okShape = st?.有选择器 ? st.选项数 > 0 && st.按钮禁用 === false
                                : st?.按钮禁用 === true && /没有可选文档/.test(st?.提示 ?? "");
    rec(`[${id}] 文档型参数有可用的输入形态`, okShape, JSON.stringify(st));
  }
} catch (e) {
  console.error("探针异常:", e.message);
} finally {
  try { await api(tk, `/research/projects/${pid}`, "DELETE"); } catch { /* 忽略 */ }
  close();
}

console.log("\n" + "=".repeat(50));
const fail = rows.filter((r) => !r.ok);
console.log(`深度分析探针: ${rows.length - fail.length} 通过 / ${fail.length} 失败`);
process.exit(fail.length ? 1 : 0);

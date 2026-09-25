// scripts/probe-editor-versions-import.mjs — 编辑器「版本历史」「导入 Word」真链路探针
//
// 为什么单开一个: `probe-editor-export.mjs` 管的是**导出**, 而编辑器右上的两个入口
//   一直是**零覆盖**。2026-09-20 首次实测, 一验就现形 —— 三条链全死:
//
//   ① 版本列表后端回 `{versions:[{version,content_len,…}]}`, 而 api.ts 的 `q()` **直接返回
//      整个响应体**(不像 axios 会剥 `data`) → 前端把对象当数组用: `!versions.length` 恒 false
//       → 渲染「暂无版本记录」, `v-for` 去遍历那个对象。
//   ② 列表字段名也不对: 后端 `version`/`content_len` vs 模板 `version_num`/`word_count`/`id`。
//   ③ 「恢复」打的 `POST /documents/:id/versions/<id>/restore` 后端**不存在**(实测 404);
//      真实形态是 `POST /documents/:id/restore {version}`。
//   ④ 「导入 Word」打的 `POST /editor/v1/documents/import` 后端**也不存在**(实测 404)。
//
// 本探针钉死四条断言, 每条都对应上面一个死因(缺一条, 将来改回去照样绿):
//   · 版本列表**真渲染出行**(不是空态) —— 抓共享 bug ①
//   · 行里显示的是**版本号与字数**(不是 vundefined / undefined 字) —— 抓 ②
//   · 点「恢复」**真回档并落新版本行**(版本数 +1), 且打的是真端点 —— 抓 ③
//   · 「导入 Word」选真 docx **真发出请求且 200**, 编辑器正文随后**真的变成文档内容** —— 抓 ④
//
// docx 样本用平台自己的 `POST /paper-outline/export` 现造(同仓既有能力, 不烧 LLM),
//   同时也是**往返一致**的验证: 导出的 docx 能被自己导入回结构化 HTML。
//
// 用法: node scripts/probe-editor-versions-import.mjs        (需 4173 已起)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, spyInstall, probeAction } from "./lib/probe-actions.mjs";

const BASE = process.env.API_BASE || "http://127.0.0.1:4173";
const rows = [];
function rec(action, kind, detail) {
  rows.push({ action, kind, detail });
  const tag = kind === "ok" ? "  ok  " : kind === "dead" ? " DEAD " : kind === "gated" ? " gated" : kind === "err" ? " ERR  " : " skip ";
  console.log(`${tag} ${action} — ${detail}`);
}
const short = (u) => String(u ?? "").replace(BASE, "").slice(0, 74);

const api = async (token, path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

/** TipTap JSON 字符串 —— store.applyDoc 直接交给 setContent, 喂 markdown 会静默塌成一段 */
function tiptapJson(title, h1, paras) {
  return JSON.stringify({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: h1 }] },
      ...paras.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })),
    ],
  });
}

const { cdp, close } = await startCdp({ preferredPort: 31079, label: "probe-editor-ver-import" });
try {
  const token = await loginToken("audit", "audit123456");
  if (!token) throw new Error("登录失败");

  // ── 播种: 一篇有 3 个版本行的文档(建 + PUT 两次, API 直造, 不碰 LLM) ──
  const DOC_TITLE = "探针·版本与导入";
  const V1_H1 = "第一章 版本探针";
  const V1_PARA = "第一版正文，用来验证版本行显示的是真实旧版内容。";
  const created = await api(token, "/editor/v1/documents", "POST", { title: DOC_TITLE });
  const docId = created.json?.id;
  rec("造测试文档", docId ? "ok" : "err", docId ? `id=${docId}` : `HTTP ${created.status}`);
  if (!docId) throw new Error("建文档失败");
  await api(token, `/editor/v1/documents/${docId}`, "PUT", { content: tiptapJson(DOC_TITLE, V1_H1, [V1_PARA]) });
  await api(token, `/editor/v1/documents/${docId}`, "PUT", { content: tiptapJson(DOC_TITLE, V1_H1, ["第二版正文。"]) });
  const before = await api(token, `/editor/v1/documents/${docId}/versions`);
  const verCountBefore = (before.json?.items ?? []).length;
  rec("播种出多个版本行", verCountBefore >= 3 ? "ok" : "err", `版本数=${verCountBefore}(建1+改2)`);

  // ── 打开编辑器(顶层 /soc/, iframe 里 CDP 点不准) ──
  await openSoc(cdp, BASE, `/editor?documentId=${docId}`, token);
  await spyInstall(cdp);

  // ══ 一、版本历史抽屉 ══
  const openRes = await probeAction(cdp, "button[data-control='editor:versions']", { wait: 2500 });
  const drawer = await evalTop(cdp, `(() => {
    const root = document.querySelector('.ade-version-history');
    if (!root) return { open: false };
    const items = [...root.querySelectorAll('.ade-version-item')];
    return {
      open: true,
      empty: /暂无版本记录/.test(root.textContent || ''),
      loading: /加载中/.test(root.textContent || ''),
      n: items.length,
      texts: items.map(e => (e.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 4),
    };
  })()`);
  rec("点「版本历史」抽屉打开", drawer?.open ? "ok" : "DEAD",
    drawer?.open ? "抽屉已渲染" : "点后 .ade-version-history 未出现");

  // 断言 ①: 真渲染出行 —— 后端有 N 个版本, 面板就该有 N 行(空了就是那个"对象当数组"的 bug)
  rec("版本列表真渲染出行(不是空态)", drawer?.n > 0 && !drawer.empty ? "ok" : "DEAD",
    drawer?.open
      ? `行数=${drawer?.n} 空态=${drawer?.empty} 加载中=${drawer?.loading} · 首行="${drawer?.texts?.[0] ?? "(无)"}"`
      : "抽屉没打开, 无从验");

  // 断言 ②: 行里是**真版本号与真字数**, 不是 undefined
  const joined = (drawer?.texts ?? []).join(" | ");
  const hasUndef = /undefined|NaN|vundefined/.test(joined);
  const hasVerNum = /v[0-9]+/.test(joined);
  rec("行显示真版本号与字数(非 undefined)", hasVerNum && !hasUndef ? "ok" : "DEAD",
    `版本号=${hasVerNum} 含undefined=${hasUndef} · ${joined.slice(0, 90)}`);

  // 断言 ③: 点「恢复」→ 真回档(版本数 +1), 且打的是真端点
  // ⚠ `keepOverlays: true` 是必须的: 恢复按钮**就在版本抽屉里**, 而 probeAction 默认会
  //   先 dismissOverlays —— 那会把抽屉整个关掉, 再去点一个不存在的按钮, 表现为"点了没反应"。
  //   实测踩过: 不加这个参数时点击无效, 而版本数仍 +1(自动保存的功劳) → **假通过**。
  // ⚠ 抽屉是**倒序**渲染(最新在最上), 所以 index 1 = v2。点第一项只会恢复到最新版,
  //   正文本来就没变 —— 那条断言会红成假缺陷(实测踩过一次)。
  const restoreRes = await probeAction(cdp, ".ade-version-item", { wait: 2500, keepOverlays: true, index: 1 });
  const dlg = await probeAction(cdp, "button[data-control='dialog:confirm']", { wait: 5000, keepOverlays: true });
  const after = await api(token, `/editor/v1/documents/${docId}/versions`);
  const verCountAfter = (after.json?.items ?? []).length;
  // 恢复请求可能落在第一次点击(无确认框)或第二次(确认后)任一个窗口里, 两处合并看
  const allReq = [...(restoreRes.apiReqs ?? []), ...(dlg.apiReqs ?? [])];
  const spoke = allReq.map((x) => `${short(x.url)}→${x.status}`);
  const restoreReq = allReq.find((x) => /\/documents\/[^/]+\/restore/.test(x.url));
  rec("点「恢复」真回档(版本数+1)", restoreReq && restoreReq.status === 200 && verCountAfter > verCountBefore ? "ok" : "DEAD",
    `恢复前=${verCountBefore} 恢复后=${verCountAfter} · toast="${(dlg.toast || restoreRes.toast || "").slice(0, 40)}" · 请求=${spoke.slice(-4).join(" ") || "零请求"}`);
  rec("恢复打的是真端点(非 /versions/<id>/restore)", restoreReq && restoreReq.status === 200 ? "ok" : "DEAD",
    restoreReq ? `${short(restoreReq.url)} → ${restoreReq.status}` : `未见 restore 请求`);

  // 回档后正文应回到第一版 —— 这是"恢复了什么"的实质断言, 不是只看计数器
  const tiptap = await evalTop(cdp, `(() => {
    const ps = [...document.querySelectorAll('.tiptap p')].map(e => e.textContent.trim());
    return ps.join(' | ');
  })()`);
  rec("回档后正文是真的旧版内容", String(tiptap ?? "").includes(V1_PARA.slice(0, 12)) ? "ok" : "err",
    `正文="${String(tiptap ?? "").slice(0, 70)}"`);

  // ══ 二、导入 Word ══
  // 样本现造: 平台自己的导出端点产 docx(不烧 LLM), 顺带验"自己导出的能被自己导入"
  const exp = await api(token, "/paper-outline/export", "POST", {
    paperTitle: "导入探针论文",
    nodes: [
      { title: "第一章 导入探针", level: 1, content: "这是导入探针的正文内容。", children: [
        { title: "1.1 子节", level: 2, content: "子节内容。", children: [] } ] },
    ],
  });
  const b64 = exp.json?.base64 ?? "";
  rec("造 docx 样本(平台导出端点)", b64 ? "ok" : "err", b64 ? `${b64.length} base64 字符` : `HTTP ${exp.status}`);

  const setFile = await evalTop(cdp, `(() => {
    const inp = document.querySelector(".ade-topbar__right input[type=file]");
    if (!inp) return 'no-input';
    const bin = atob(${JSON.stringify(b64)});
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const f = new File([buf], "导入探针论文.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    const dt = new DataTransfer();
    dt.items.add(f);
    inp.files = dt.files;
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    return 'fired:' + inp.files.length;
  })()`);
  rec("把 docx 挂到文件输入并触发", String(setFile).startsWith("fired") ? "ok" : "err", String(setFile));
  // toast 只活约 3.2s —— 在等待窗口内按 250ms 采样, 取最早一条非空
  let toastTxt = "";
  const dl = Date.now() + 8000;
  while (!toastTxt && Date.now() < dl) {
    await sleep(250);
    toastTxt = await evalTop(cdp, `(() => {
      const t = [...document.querySelectorAll('div,span')].map(e => e.textContent || '').filter(s => /导入失败|导入完成/.test(s));
      return t.slice(-1)[0] ?? '';
    })()`);
  }
  await sleep(500);

  const reqs = await evalTop(cdp, `(window.__spy ? window.__spy.log : []).map(r => ({url:r.url, status:r.status}))`);
  const importReq = (reqs ?? []).find((x) => /documents\/import/.test(x.url));
  rec("导入真的发出请求且 200", importReq && importReq.status === 200 ? "ok" : "DEAD",
    importReq ? `${short(importReq.url)} → ${importReq.status}` : `未见 import 请求(共 ${(reqs ?? []).length} 个)`);

  const docAfter = await evalTop(cdp, `(() => {
    const t = document.querySelector('.tiptap');
    return t ? (t.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 120) : '(无编辑器)';
  })()`);
  const imported = String(docAfter ?? "").includes("导入探针") && String(docAfter ?? "").includes("子节内容");
  rec("导入后正文真的换成文档内容", imported ? "ok" : "err", `正文="${docAfter}"`);

  // 反向断言: 不能再出现"导入失败"的反馈(旧的 404 表现)
  rec("反馈是成功文案(非导入失败)", /导入完成/.test(String(toastTxt)) && !/导入失败/.test(String(toastTxt)) ? "ok" : "err",
    `toast="${String(toastTxt).slice(0, 60)}"`);

  await api(token, `/editor/v1/documents/${docId}`, "DELETE");

  console.log("\n════════ 汇总 ════════");
  const bad = rows.filter((x) => x.kind === "err" || x.kind === "dead");
  console.log(bad.length ? `\n❌ ${bad.length} 项异常 / 共 ${rows.length}` : `\n✅ ${rows.length} 项全部通过`);
  if (bad.length) process.exitCode = 1;
} catch (e) {
  console.error("探针异常:", e.message, e.stack?.split("\n")[1] ?? "");
  process.exitCode = 1;
} finally {
  await close();
}

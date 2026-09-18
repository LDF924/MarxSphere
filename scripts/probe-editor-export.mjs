// scripts/probe-editor-export.mjs — 学术编辑器「导出 Word」真链路探针
//
// 这条链此前**零覆盖**: 门禁只验编辑器长什么样, 从没点过工具栏那个「导出 Word」。
// 一验就现形 —— 它 POST 的 `/api/editor/v1/documents/<id>/export` **后端根本不存在**
// (实测恒 404「接口不存在」), 点下去必然弹「导出失败」。详见台账 §18.1。
//
// 本探针钉死三件事:
//   ① 点「导出 Word」真发请求, 且打的是**平台真有的** POST /paper-outline/export(200);
//   ② 请求体里**真带着文档内容**(章节标题在、正文在) —— 只断言"发了请求"会漏掉"发了个空壳";
//   ③ 反向断言**不再打**那个死 URL —— 缺了这条, 将来有人把旧代码复制回来照样"绿"。
//
// 文档用 API 直接造(不调 LLM, 秒级): 建 doc → PUT 带内容的 TipTap JSON。
//
// 用法: node scripts/probe-editor-export.mjs        (需 4173 已起)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, spyInstall, probeAction } from "./lib/probe-actions.mjs";

const BASE = "http://127.0.0.1:4173";
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

/**
 * 造一篇有章节结构的文档。
 *
 * ⚠ 内容必须是 **TipTap JSON 字符串**(不是 markdown): store 的 `applyDoc` 直接把它交给
 *   `setContent`。喂 markdown 进去内容会静默变成"一个段落", 于是"正文没导出"的断言
 *   红成"产品缺陷", 而实际是播种喂错了格式 —— 这条踩过一次, 记这儿。
 */
function tiptapJson(title, h1, paras, h2) {
  const doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: h1 }] },
      ...paras.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })),
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: h2 }] },
    ],
  };
  return { title, content: JSON.stringify(doc), mark: { h1, para: paras[0], h2 } };
}

const { cdp, close } = await startCdp({ preferredPort: 31077, label: "probe-editor-export" });
try {
  const token = await loginToken("audit", "audit123456");
  if (!token) throw new Error("登录失败");

  // ── 播种: 建文档 + 写内容(全走 API, 不碰 LLM) ──
  const seed = tiptapJson(
    "探针·导出链路",
    "第一章 导论",
    ["这是一段用来验证导出的正文内容，长度足够作为断言依据。"],
    "1.1 研究背景"
  );
  const created = await api(token, "/editor/v1/documents", "POST", { title: seed.title, content: "{}" });
  const docId = created.json?.id;
  rec("造测试文档", docId ? "ok" : "err", docId ? `id=${docId}` : `HTTP ${created.status} ${JSON.stringify(created.json).slice(0, 80)}`);
  if (!docId) throw new Error("建文档失败, 后续无法验");
  const put = await api(token, `/editor/v1/documents/${docId}`, "PUT", { content: seed.content });
  rec("写入章节结构", put.status === 200 ? "ok" : "err", `HTTP ${put.status}`);

  // ── 打开编辑器(顶层 /soc/, 不用 iframe —— iframe 里 CDP 点不准) ──
  await openSoc(cdp, BASE, `/editor?documentId=${docId}`, token);
  await spyInstall(cdp);
  /**
   * 捕下载产物。
   *
   * ⚠ 不能去 DOM 里找 `<a download>` —— 全仓的下载写法都是
   *   `createElement('a') → a.click() → revokeObjectURL()`, **从不 appendChild**,
   *   那类断言**结构上**永远不可能通过(我第一版就是这么写的, 红了一次)。
   *   改挂在 `URL.createObjectURL` 上: 它能拿到真 Blob 对象(revoke 只作废 URL, 不动 Blob),
   *   于是可以验"产物非空 + 真是 docx 容器(PK 魔数)", 比查锚点强得多。
   */
  await evalTop(cdp, `(() => {
    window.__blobs = [];
    const orig = URL.createObjectURL;
    URL.createObjectURL = function (b) {
      try { window.__blobs.push(b); } catch (e) { /* 忽略 */ }
      return orig.call(this, b);
    };
    return true;
  })()`);

  const ready = await evalTop(cdp, `(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('导出 Word'));
    const h1 = [...document.querySelectorAll('.tiptap h1')].map(e => e.textContent.trim());
    return { btn: !!btn, h1 };
  })()`);
  rec("编辑器已加载该文档", ready?.btn && (ready.h1 || []).includes(seed.mark.h1) ? "ok" : "err",
    `导出按钮=${ready?.btn} 正文 h1=${JSON.stringify(ready?.h1 ?? [])}`);

  // ── 真点 ──
  // ⚠ 必须按**文案**定位。`.ade-toolbar-btn` 类在工具栏上有 20 多个(缩放/撤销/加粗/H1/列表…),
  //   按 class 取第一个点下去是「缩小视图」—— 一个请求都不会发, 于是恒报 DEAD(假失败)。
  const EXPORT_SEL = "button.ade-toolbar-btn[title='导出 Word']";
  const r = await probeAction(cdp, EXPORT_SEL, { wait: 6000 });
  const reqs = r.apiReqs ?? [];
  const exportReq = reqs.find((x) => /paper-outline\/export/.test(x.url));
  const deadReq = reqs.find((x) => /editor\/v1\/documents\/.*\/export/.test(x.url));

  // ① 打的是真端点 + 200
  rec("点导出 → POST /paper-outline/export 200", exportReq && exportReq.status === 200 ? "ok" : "DEAD",
    exportReq ? `${short(exportReq.url)} → ${exportReq.status}` : `本动作共 ${reqs.length} 个请求: ${reqs.map((x) => short(x.url)).join(" · ") || "零请求"}`);

  // ② 请求体真带内容(只验"发了请求"会漏掉空壳)
  let body = null;
  try { body = exportReq?.body ? JSON.parse(exportReq.body) : null; } catch { body = null; }
  const bodyText = JSON.stringify(body ?? {});
  const hasTitle = bodyText.includes(seed.mark.h1);
  const hasPara = bodyText.includes(seed.mark.para);
  const hasH2 = bodyText.includes(seed.mark.h2);
  rec("请求体带论文标题/一级/二级/正文", hasTitle && hasPara && hasH2 ? "ok" : "err",
    `h1=${hasTitle} 正文=${hasPara} h2=${hasH2} · fontName=${body?.fontName ?? "(缺)"} · nodes=${Array.isArray(body?.nodes) ? body.nodes.length : "无"}`);

  // ③ 反向断言: 不再打那个死端点
  rec("不再打不存在的 /documents/:id/export", deadReq ? "err" : "ok",
    deadReq ? `仍在打 ${short(deadReq.url)} → ${deadReq.status}` : "旧死 URL 零命中");

  // ④ 用户看到的是成功, 不是失败
  const okToast = /已导出 Word/.test(r.toast ?? "");
  const failToast = /导出失败/.test(r.toast ?? "");
  rec("反馈是成功文案且无失败文案", okToast && !failToast ? "ok" : "err",
    `toast="${(r.toast ?? "(无)").slice(0, 40)}"`);

  // ⑤ 产物是**真 docx 字节**(不是空壳、也不是把别的什么当 docx 发下去)
  const blobInfo = await evalTop(cdp, `(async () => {
    const bs = window.__blobs || [];
    if (!bs.length) return { n: 0 };
    const b = bs[bs.length - 1];
    const buf = new Uint8Array(await b.arrayBuffer());
    return { n: bs.length, size: buf.length, type: b.type,
             magic: String.fromCharCode(buf[0], buf[1]) };
  })()`);
  const isZip = blobInfo?.magic === "PK";
  rec("产物是真 docx(ZIP 魔数 + 非空)", isZip && (blobInfo?.size ?? 0) > 5000 ? "ok" : "err",
    `blob 数=${blobInfo?.n} 大小=${blobInfo?.size ?? 0}B 魔数=${blobInfo?.magic ?? "(无)"} type=${blobInfo?.type ?? "(无)"}`);

  console.log("\n════════ 汇总 ════════");
  for (const x of rows) console.log(`${x.kind.padEnd(6)} ${x.action}`);
  const bad = rows.filter((x) => x.kind === "err" || x.kind === "dead");
  console.log(bad.length ? `\n❌ ${bad.length} 项异常` : `\n✅ ${rows.length} 项全部通过`);
  if (bad.length) process.exitCode = 1;
} catch (e) {
  console.error("探针异常:", e.message, e.stack?.split("\n")[1] ?? "");
  process.exitCode = 1;
} finally {
  await close();
}

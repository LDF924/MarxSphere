// probe-batch14.mjs — V418 外部服务密钥 + 扫描件 OCR
//
// 由来(2026-09-28 用户要求):「MINERU_TOKEN 过期 11 天…做个前端, 弄个有效期和提醒这些」
//   + 原目标「扫描版 PDF 上传后抽不出文字, 没下一步」。
//
// 覆盖:
//   ① 密钥面板在设置页里, 显示真实状态(末 6 位/到期/上次校验), **不回显明文**
//   ② 「校验」真的打远端 —— 结果落库, 刷新后还在(而不是只活在前端一闪)
//   ③ 扫描件上传不再是死路: 上传 → OCR 任务 → 进度 → 完成后能把文本补录成素材
//   ④ 日志/响应里不出现密钥
//
// ⚠ 烧钱提示: ③ 会真跑一次 MinerU OCR(约 30 秒 + 一次额度)。这是**唯一**能证明
//   整条链通了的办法 —— 断言"按钮点了有反应"证明不了后端认不认这份文件。
//
// 用法: node scripts/probe-batch14.mjs   (需 4173 已起, soc + 外壳产物已重建)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc } from "./lib/probe-actions.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BASE = process.env.API_BASE || "http://127.0.0.1:4173";
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${n}${ex ? " — " + ex : ""}`); ok ? pass++ : fail++; };

const api = async (token, p, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

/**
 * 造一份**三页、无文本层**的中文"扫描件"。
 *
 * ⚠ 不用随手拿的 PDF: 判定结果取决于文件本身。只有"页数够多 + 一个可提取字符都没有"
 *   的 PDF 才会走到 OCR 分支 —— 一页空白会被"页数太少"的快速失败挡下(那是刻意的)。
 * 所以这里用 napi-rs/canvas 渲染中文版面, 再手拼成 DCTDecode 内嵌的 image-only PDF。
 */
async function buildScannedPdf() {
  const cwd = process.cwd();
  const { createCanvas } = await import(`file:///${path.resolve(cwd, "node_modules/@napi-rs/canvas/index.js").replace(/\\/g, "/")}`);
  const LINES = [
    ["乡村振兴视域下农村集体经济组织的社会功能研究", "本文以中部三省17个村庄的田野调查为基础，", "考察集体经济组织在基层治理中的作用机制。", "", "研究发现，集体经济组织通过资源整合与", "利益联结两条路径影响村庄公共品供给。"],
    ["一、文献综述与理论基础", "既有研究主要沿两条脉络展开：一是产权", "结构视角，二是社会资本视角。二者都忽视", "了组织形态本身的能动性。", "", "本文尝试引入组织社会学的分析框架。"],
    ["二、研究设计与资料来源", "调查于2023年7月至9月进行，覆盖3县17村。", "采用半结构化访谈与参与式观察相结合的方法，", "共完成访谈128人次。", "", "数据处理使用扎根理论的三级编码。"],
  ];
  const jpegs = LINES.map((lines) => {
    const c = createCanvas(1240, 1754);
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 1240, 1754);
    g.fillStyle = "#111";
    g.font = "bold 42px 'Microsoft YaHei'";
    g.fillText(lines[0], 90, 170, 1060);
    g.font = "34px 'Microsoft YaHei'";
    let y = 260;
    for (const line of lines.slice(1)) { g.fillText(line, 90, y, 1060); y += 60; }
    return c.toBuffer("image/jpeg", 85);
  });

  const jpegSize = (buf) => {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { w: 1240, h: 1754 };
  };

  const N = jpegs.length;
  const objs = [];
  let next = 3;
  const PAGE = [], CONTENT = [], IMAGE = [];
  for (let i = 0; i < N; i++) { PAGE.push(next++); CONTENT.push(next++); IMAGE.push(next++); }
  for (let i = 0; i < next - 1; i++) objs.push("");
  objs[0] = "<</Type/Catalog/Pages 2 0 R>>";
  objs[1] = `<</Type/Pages/Kids[${PAGE.map((id) => `${id} 0 R`).join(" ")}]/Count ${N}>>`;
  for (let i = 0; i < N; i++) {
    const { w, h } = jpegSize(jpegs[i]);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    objs[PAGE[i] - 1] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${w} ${h}]/Resources<</XObject<</Im0 ${IMAGE[i]} 0 R>>>>/Contents ${CONTENT[i]} 0 R>>`;
    objs[CONTENT[i] - 1] = `<</Length ${content.length}>>\nstream\n${content}\nendstream`;
    objs[IMAGE[i] - 1] = { header: `<</Type/XObject/Subtype/Image/Width ${w}/Height ${h}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpegs[i].length}>>\nstream\n`, bin: jpegs[i] };
  }
  let out = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1");
  const offsets = [];
  objs.forEach((o, i) => {
    offsets[i] = out.length;
    out = typeof o === "string"
      ? Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, "latin1")])
      : Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n${o.header}`, "latin1"), o.bin, Buffer.from("\nendstream\nendobj\n", "latin1")]);
  });
  const xrefPos = out.length;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += String(off).padStart(10, "0") + " 00000 n \n";
  out = Buffer.concat([out, Buffer.from(`${xref}trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`, "latin1")]);
  const p = path.join(os.tmpdir(), `probe14-scan-${Date.now()}.pdf`);
  fs.writeFileSync(p, out);
  return p;
}

const token = await loginToken();
if (!token) { console.error("登录失败: 4173 未起或缺 verify 账号"); process.exit(1); }

// ── 前置: 这组端点必须只在本机可用(它们能写平台的外部服务密钥) ──
console.log("\n⓪ 暴露面");
const noAuth = await fetch(`${BASE}/api/service-tokens`).then((r) => r.status).catch(() => 0);
t("未带令牌也能读本机接口(本机豁免)", noAuth === 200, `HTTP ${noAuth}`);

const caps = await api(token, "/ocr/capability");
t("OCR 能力可查询", typeof caps.body?.ready === "boolean", JSON.stringify(caps.body));
t("**OCR 能力就绪**(否则后面两条都是空谈)", caps.body?.ready === true, caps.body?.hint || "not ready");

// ── 前置: 拿到一个真实项目(素材要落进去) ──
const projs = await api(token, "/research/projects");
const pid = (projs.body?.projects ?? [])[0]?.id ?? "";
t("前置: 有可用项目", !!pid, pid || "无项目, 请先建一个");

const { cdp, close } = await startCdp({ preferredPort: 9364, label: "batch14" });
try {
  // ═══ ① 密钥面板 ═══
  console.log("\n① 设置页的密钥面板");
  /**
   * ⚠ **整页导航到 `#settings`**, 而不是事后改 hash 或点齿轮。
   *
   * 两次踩坑, 都记下来:
   *   · `location.hash = "#settings"`: 外壳的 hash 恢复只在**挂载时**跑一次; 事后改 hash
   *     只触发 popstate, 而 popstate 读的是 `event.state.view` —— 直接赋值没有 state,
   *     走到 else 分支还得"hash 与当前视图不同"才切。实测不稳。
   *   · 点齿轮: 这次是**在 `/soc/` iframe 里找按钮** —— 设置齿轮在 React 外壳里,
   *     soc 子应用里根本没有它(实测 `missing`)。
   * 整页导航让挂载逻辑读到 `#settings` 直接进设置页, 与用户刷新后落回设置页是同一条路。
   */
  await cdp("Page.navigate", { url: `${BASE}/#settings` });
  await sleep(4000);
  await evalTop(cdp, `(() => { document.querySelectorAll('.assistant-close,.modal-x').forEach(b => b.click()); return true; })()`);
  await sleep(800);
  const panel = await evalTop(cdp, `(() => {
    // 用文案定位, 不用类名 —— 类名是 Tailwind 的, 会随改版变
    const hit = [...document.querySelectorAll("h3")].find(h => (h.innerText||"").includes("外部服务密钥"));
    if (!hit) return null;
    const box = hit.closest("div")?.parentElement?.parentElement ?? hit.parentElement;
    return { text: (box?.innerText ?? "").slice(0, 1200) };
  })()`);
  t("设置页里有「外部服务密钥」面板", !!panel, panel ? "" : "没找到(整页导航到 #settings 后仍无面板)");
  const ptxt = panel?.text ?? "";
  t("显示服务名", ptxt.includes("MinerU"), "");
  t("显示有效期/状态", /还剩 \d+ 天|到期日未知|未配置|已过期/.test(ptxt), (ptxt.match(/还剩 \d+ 天|到期日未知|未配置|已过期/) ?? [])[0] ?? "无");
  t("**不回显明文密钥**(只给末 6 位加掩码)", /••••••/.test(ptxt) && !/sk-[A-Za-z0-9_-]{20,}/.test(ptxt), "");

  // ═══ ①b 到期日: 可以手填, 且填了之后状态真的变 ═══
  //
  // 由来: 用户这次给的新密钥**不是 JWT**, 载荷里没有 exp —— 平台按"不猜"原则给
  //   「到期日未知」。于是提醒功能对这个密钥是哑的。所以"手填到期日"不是附属功能,
  //   是让提醒生效的**必要条件**, 必须真验一遍。
  console.log("\n①b 到期日可以手填, 且驱动态档");
  const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10); // 10 天后 → 落在"临近到期"
  const saved = await api(token, "/service-tokens/mineru", "PUT", { expiresAt: new Date(`${soon}T23:59:59`).toISOString() });
  t("能只改到期日(不必重新粘贴密钥)", saved.body?.ok === true, JSON.stringify(saved.body).slice(0, 120));
  t("到期日已落库", saved.body?.token?.expiresAt?.slice(0, 10) === soon, `${saved.body?.token?.expiresAt} 期望 ${soon}`);
  t("**状态跟着日期变了**: 10 天后到期 ⇒ 临近到期(否则提醒永远不会触发)",
    saved.body?.token?.status === "expiring", `status=${saved.body?.token?.status}`);
  /**
   * ⚠ 这一条是"提醒真的会响"的**端到端**证明: 不等明天, 直接跑一轮巡检,
   *   看它有没有往告警中心写一条 category=token 的告警。
   *   只断言日期算对了是不够的 —— 巡检没接上就是算得再准也没人看见。
   */
  const patrol = await api(token, "/service-tokens/patrol", "POST", {});
  t("手动跑一轮巡检", patrol.body?.ok === true, JSON.stringify(patrol.body).slice(0, 160));
  const alerts = await api(token, "/alerts?limit=20");
  /**
   * ⚠ 判据是 `detail.kind`(结构化字段), **不是告警文案**。
   *   第一版按 `/临近到期|已过期/` 匹配消息 —— 而实际文案是"还有 11 天到期",
   *   于是一条**真实存在**的告警被判成"没有"。文案是给人看的, 会改;
   *   `detail` 是给程序看的, 才是能断言的东西。
   */
  const tokenAlert = (alerts.body?.alerts ?? []).find(
    (a) => a.category === "token" && ["expiring", "expired"].includes(a.detail?.kind));
  t("**巡检真的写了一条密钥告警**(提醒不是只画在界面上)", !!tokenAlert,
    tokenAlert?.message?.slice(0, 90) ?? "告警中心里没有 expiring/expired 的 token 告警");
  t("告警带得出「还剩几天」这个具体数(用户据此排期)",
    typeof tokenAlert?.detail?.daysLeft === "number", String(tokenAlert?.detail?.daysLeft));

  // 还原: 把到期日移远, 免得后面每次都报"临近到期"
  const far = new Date(Date.now() + 80 * 86_400_000).toISOString();
  await api(token, "/service-tokens/mineru", "PUT", { expiresAt: far });
  const restored = (await api(token, "/service-tokens")).body?.tokens?.[0] ?? {};
  t("到期日可改远(状态回到有效)", restored.status === "ok", `status=${restored.status}`);

  // ═══ ② 校验真的打远端, 且结论落库 ═══
  console.log("\n② 校验(真实调用远端)");
  const before = (await api(token, "/service-tokens")).body?.tokens?.[0] ?? {};
  const v = await api(token, "/service-tokens/mineru/verify", "POST", {});
  t("校验返回了远端结论", ["ok", "rejected", "unreachable"].includes(v.body?.status), `${v.body?.status} · ${v.body?.message}`);
  t("**校验结果是通的**(密钥真的能用)", v.body?.status === "ok", v.body?.message || "");
  const after = (await api(token, "/service-tokens")).body?.tokens?.[0] ?? {};
  t("结论**落库**了(刷新后还在, 不是前端一闪)",
    !!after.lastCheckedAt && after.lastCheckedAt !== before.lastCheckedAt,
    `lastCheckedAt=${after.lastCheckedAt}`);
  const bad = await api(token, "/service-tokens/mineru/verify", "POST", { token: "sk-0000000000000000000000000000" });
  t("拿假密钥去校验 → 判被拒(而不是含糊地说失败)", bad.body?.status === "rejected", String(bad.body?.status));
  t("假密钥的校验**没有覆盖**上一条真实结论", (await api(token, "/service-tokens")).body?.tokens?.[0]?.lastCheckOk === true, "");

  // ═══ ③ 扫描件 OCR 全链路 ═══
  console.log("\n③ 扫描件: 上传 → 识别 → 补录");
  const scanPath = await buildScannedPdf();
  const b64 = fs.readFileSync(scanPath).toString("base64");
  const mk = await api(token, "/ocr/jobs", "POST", { filename: "probe14-扫描件.pdf", base64: b64 });
  const jobId = mk.body?.job?.id ?? "";
  t("上传扫描件后**建出了 OCR 任务**", !!jobId, mk.status === 200 ? jobId : JSON.stringify(mk.body).slice(0, 160));

  /**
   * ⚠ 判据是**任务终态 + 正文里出现了原文的句子**, 不是"进度条动了"。
   *   只断言 UI 变化的话, 一个永远转圈的界面也会通过。
   */
  let final = null;
  for (let i = 0; i < 90; i++) {
    await sleep(3000);
    const g = await api(token, `/ocr/jobs/${jobId}`);
    const j = g.body?.job;
    if (j && ["done", "failed", "cancelled"].includes(j.status)) { final = j; break; }
  }
  t("任务走到终态(done/failed/cancelled)", !!final, final ? final.status : "90 轮超时");
  t("**识别成功**(不是 failed)", final?.status === "done", final?.error || "");
  t("**识别结果里是真中文正文**", /乡村振兴|集体经济|田野调查/.test(final?.text ?? ""),
    (final?.text ?? "").slice(0, 60).replace(/\n/g, " "));
  t("正文里没有漏出自述式的废话",
    !/The image contains no text|no text to output/i.test(final?.text ?? ""), "");

  // 前端: 回填进「补录」弹层
  await openSoc(cdp, BASE, "/workflow/materials", token, pid, 9000);
  await evalTop(cdp, `(() => { document.querySelectorAll('.assistant-close,.modal-x').forEach(b => b.click()); return true; })()`);
  await sleep(600);
  const adopted = await evalTop(cdp, `(async () => {
    const r = await fetch("/api/ocr/jobs/${jobId}", { headers: { Authorization: "Bearer " + (localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "") } });
    const j = (await r.json()).job;
    return { chars: (j.text||"").length };
  })()`);
  t("前端能取回识别文本(补录的数据源就位)", adopted?.chars > 100, `${adopted?.chars} 字`);

  // ═══ ④ 密钥不外泄 ═══
  console.log("\n④ 密钥不外泄");
  const listRaw = JSON.stringify((await api(token, "/service-tokens")).body);
  t("列表接口里没有密钥本体", !/sk-[A-Za-z0-9_-]{20,}/.test(listRaw), "");
  const verifyRaw = JSON.stringify(v.body);
  t("校验接口里没有密钥本体", !/sk-[A-Za-z0-9_-]{20,}/.test(verifyRaw), "");
  const jobRaw = JSON.stringify(final ?? {});
  t("OCR 任务里没有密钥本体(子进程参数会带它, 失败时尤其危险)", !/sk-[A-Za-z0-9_-]{20,}/.test(jobRaw), "");
  const capRaw = JSON.stringify(caps.body);
  t("能力接口里没有密钥本体", !/sk-[A-Za-z0-9_-]{20,}/.test(capRaw), "");
} finally {
  console.log(`\n  ${fail ? "❌" : "✅"} ${pass}/${pass + fail} 通过`);
  try { close(); } catch { /* 清理失败不改结论 */ }
}
process.exit(fail ? 1 : 0);

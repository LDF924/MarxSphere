// 文献库身份卡: 真读浏览器里的知网登录态并显示
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc } from "./lib/probe-actions.mjs";

const BASE = process.env.API_BASE || "http://127.0.0.1:4173";
const rows = [];
const rec = (a, k, d) => { rows.push([k, a]); console.log(`${k === "ok" ? "  ok  " : " ERR  "} ${a} — ${d}`); };

const { cdp, close } = await startCdp({ preferredPort: 31133, label: "cnki-identity" });
try {
  const t = await loginToken("audit", "audit123456");

  await openSoc(cdp, BASE, "/workflow/materials", t, undefined, 8000);

  // ① 先看后端端点直出什么
  const api = await fetch(`${BASE}/api/cnki/identity`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  console.log("  后端 /api/cnki/identity →", JSON.stringify(api));
  rec("后端能读出知网身份", api?.ok && api?.loggedIn ? "ok" : "err",
    `loggedIn=${api?.loggedIn} 身份=${api?.showName ?? "?"} userType=${api?.userType ?? "?"} 机构=${api?.isInstitution}`);
  rec("识别出机构订阅账号", api?.isInstitution === true ? "ok" : "err", `isInstitution=${api?.isInstitution}`);

  // 诊断: 前端这个请求到底拿到了什么
  const dbg = await evalTop(cdp, `(async () => {
    try { const r = await fetch('/api/cnki/identity', { headers: { Authorization: 'Bearer ' + (localStorage.getItem('skf_auth_token')||localStorage.getItem('sag_token')||'') } });
      return { status: r.status, body: (await r.text()).slice(0, 200) }; } catch (e) { return { err: String(e) }; }
  })()`);
  console.log("  前端直取 →", JSON.stringify(dbg));

  // ② 界面上真显示
  const shown = await evalTop(cdp, `(() => {
    const card = document.querySelector('.cnki-identity');
    if (!card) return { found: false };
    const modes = [...card.querySelectorAll('.ci-mode')].map(b => b.textContent.trim());
    const val = card.querySelector('.ci-val')?.textContent.trim() ?? '';
    const badge = card.querySelector('.ci-badge')?.textContent.trim() ?? '';
    const active = card.querySelector('.ci-mode.on')?.textContent.trim() ?? '';
    const note = card.querySelector('.ci-note')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60) ?? '';
    return { found: true, modes, val, badge, active, note };
  })()`);
  rec("素材页渲染出身份卡", shown?.found ? "ok" : "err", `模式项=${JSON.stringify(shown?.modes)}`);
  rec("显示出当前知网身份", /南宁师范|GZ0041/.test(shown?.val ?? "") ? "ok" : "err", `显示="${shown?.val}" 徽标="${shown?.badge}"`);
  // ⚠ 这条第一版是**假通过**: 默认模式本来就是 institution, 身份没读到时也会"通过"。
  //   必须同时要求"身份确实读到了"才算数。
  rec("模式自动对齐到实际身份", shown?.active?.includes("机构") && /南宁师范|GZ0041/.test(shown?.val ?? "") ? "ok" : "err",
    `选中模式="${shown?.active}" 身份="${shown?.val}"(两个都要非空才算)`);
  rec("明确写出不保存密码", /不保存/.test(shown?.note ?? "") ? "ok" : "err", `说明="${shown?.note}"`);

  // ③ 「刷新」按钮真发请求
  const clicked = await evalTop(cdp, `(() => { const b = document.querySelector('[data-control="workflow:cnki-refresh"]'); if (!b) return 'missing'; b.click(); return 'clicked'; })()`);
  await sleep(3000);
  rec("刷新按钮可点", clicked === "clicked" ? "ok" : "err", `点击=${clicked}`);

  console.log("\n" + (rows.some((r) => r[0] === "err") ? "❌ 有异常" : `✅ ${rows.length} 项全通过`));
  if (rows.some((r) => r[0] === "err")) process.exitCode = 1;
} catch (e) {
  console.error("异常:", e.message, e.stack?.split("\n")[1]);
  process.exitCode = 1;
} finally { await close(); }

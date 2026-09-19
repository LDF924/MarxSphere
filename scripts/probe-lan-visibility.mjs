// scripts/probe-lan-visibility.mjs — 从**局域网 IP** 验受保护资源的可见性
//
// 为什么必须走 LAN IP: 本机 socket 有鉴权豁免, 一切"正常"; 远程才是真实部署形态。
//   项目既有约定: 外部行为验证必须用局域网 IP。
//
// ⚠ 本探针会暴露一个**先在的严重缺陷**, 且不随本文件的断言变化而消失:
//   后端的强制鉴权中间件(`src/api/server.ts` 的 onRequest hook)**只认外部 API 令牌 sag_xxx**,
//   **不认 Web 登录的 JWT** —— 实测带 JWT 从 LAN 访问 `/api/projects` 得到 401、
//   `/api/llm/models` 得到 403。也就是说 **Web 登录 + 非本机地址 = 整个应用不可用**。
//   第 ④ 条断言(带 token ≠ 401)因此在**修好中间件之前会一直红** —— 那是**如实反映**,
//   不是探针坏了。修中间件属改鉴权边界, 需产品决策, 见台账 §25。
import { startCdp, loginToken, sleep, evalTop } from "./scripts/lib/cdp-editor.mjs";
import { execFileSync } from "node:child_process";

const rows = [];
const rec = (a, k, d) => { rows.push([k, a]); console.log(`${k === "ok" ? "  ok  " : " ERR  "} ${a} — ${d}`); };

// 取本机局域网 IP
const psOut = execFileSync("powershell", ["-NoProfile", "-Command",
  "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' } | Select-Object -First 1).IPAddress"],
  { encoding: "utf-8" });
const LAN = String(psOut).trim().split(String.fromCharCode(10)).pop().trim();
const BASE = `http://${LAN}:4173`;
console.log("局域网地址:", BASE);

const { cdp, close } = await startCdp({ preferredPort: 31131, label: "lan-visibility" });
try {
  const t = await loginToken("audit", "audit123456");

  // 造一张真图落到 blob-store 的 viz 目录
  const seeded = execFileSync(process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "scripts/lib/seed-viz-file.ts", "probe-lan.png", "audit"],
    { encoding: "utf-8" });
  const IMG = String(seeded).split(String.fromCharCode(10)).map((l) => l.trim()).filter((l) => l.startsWith("/api/")).pop();
  console.log("图片:", IMG);

  await cdp("Page.navigate", { url: `${BASE}/` });
  await sleep(5000);
  // 局域网下要登录才能拿 token
  await evalTop(cdp, `localStorage.setItem('sag_token', ${JSON.stringify(t)}); localStorage.setItem('skf_auth_token', ${JSON.stringify(t)});`);
  await cdp("Page.reload");
  await sleep(6000);

  // ① 原生 <img>: 应当失败 —— 这条是"为什么需要 AuthedImg"的反向证据
  const native = await evalTop(cdp, `(async () => {
    const i = new Image();
    const done = new Promise(r => { i.onload = () => r('load'); i.onerror = () => r('error'); });
    i.src = ${JSON.stringify(IMG)};
    return await Promise.race([done, new Promise(r => setTimeout(() => r('timeout'), 5000))]);
  })()`);
  rec("LAN 下原生 <img> 取不到(证明问题真实存在)", native === "error" ? "ok" : "err", `结果=${native}`);

  // ② 带鉴权取 blob: 应当成功 —— 这是修好后各组件走的路径
  const authed = await evalTop(cdp, `(async () => {
    const tk = localStorage.getItem('skf_auth_token') || localStorage.getItem('sag_token') || '';
    const r = await fetch(${JSON.stringify(IMG)}, { headers: { Authorization: 'Bearer ' + tk }, cache: 'no-store' });
    if (!r.ok) return { status: r.status, ok: false };
    const b = await r.blob();
    const u = URL.createObjectURL(b);
    const i = new Image();
    const done = new Promise(res => { i.onload = () => res({ w: i.naturalWidth }); i.onerror = () => res({ w: 0 }); });
    i.src = u;
    const out = await Promise.race([done, new Promise(res => setTimeout(() => res({ w: -1 }), 4000))]);
    URL.revokeObjectURL(u);
    return { status: r.status, ok: true, size: b.size, w: out.w };
  })()`);
  rec("LAN 下带鉴权取 blob 并解码", authed?.ok && authed?.w > 0 ? "ok" : "err",
    `HTTP ${authed?.status} ${authed?.size ?? 0}B naturalWidth=${authed?.w}`);

  // ③ 实证图表端点(有 V414 的"本机放行"补丁)在 LAN 下 —— 这决定 PipelineOverview 是否必须改
  const fig = await evalTop(cdp, `(async () => {
    const tk = localStorage.getItem('skf_auth_token') || localStorage.getItem('sag_token') || '';
    const bare = await fetch('/api/empirical/figures/nonexist.png').then(r => r.status).catch(e => 'ERR');
    const withTok = await fetch('/api/empirical/figures/nonexist.png', { headers: { Authorization: 'Bearer ' + tk } }).then(r => r.status).catch(e => 'ERR');
    return { bare, withTok };
  })()`);
  rec("实证图表: 不带 token=401 / 带 token≠401", fig?.bare === 401 && fig?.withTok !== 401 ? "ok" : "err",
    `裸=${fig?.bare} 带token=${fig?.withTok}(404=路由通但文件不存在, 正是我们要的)`);

  // ④ vault binary 同理
  const vault = await evalTop(cdp, `(async () => {
    const tk = localStorage.getItem('skf_auth_token') || localStorage.getItem('sag_token') || '';
    const bare = await fetch('/api/vault/binary?path=x').then(r => r.status).catch(e => 'ERR');
    const withTok = await fetch('/api/vault/binary?path=x', { headers: { Authorization: 'Bearer ' + tk } }).then(r => r.status).catch(e => 'ERR');
    return { bare, withTok };
  })()`);
  rec("保管箱二进制: 不带 token=401 / 带 token≠401", vault?.bare === 401 && vault?.withTok !== 401 ? "ok" : "err",
    `裸=${vault?.bare} 带token=${vault?.withTok}`);

  console.log("\n" + (rows.some((r) => r[0] === "err") ? "❌ 有异常" : `✅ ${rows.length} 项全通过`));
  if (rows.some((r) => r[0] === "err")) process.exitCode = 1;
} catch (e) {
  console.error("异常:", e.message, e.stack?.split("\n")[1]);
  process.exitCode = 1;
} finally {
  await close();
}

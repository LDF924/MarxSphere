// scripts/probe-authed-image.mjs — 受保护图片的取用链(照抄闭源 `ye()` 的那套)
//
// 为什么单开一条: 后端的图片端点(`/api/viz/files/*`、`/api/chat/images/*`)是 **requireUser** 保护的,
//   而 `<img src="/api/...">` **发不带 Authorization 头** —— 两边对不上, 图必然加载不出来。
//   改造前各组件全是这么写的。
//
// 实测(同一浏览器、同一张已落盘的图):
//   原生 `<img src>` → **error**(naturalWidth=0)
//   带鉴权 fetch    → **200 + 70B image/png**
//
// ⚠ 值得记一笔: 我原先以为"本机有鉴权豁免所以本地看不出来, 只有上云才 401"。
//   实测**本机也是 401** —— 也就是说这个缺陷在本地就一直存在, 只是没人拿它当过门禁。
//
// 用法: node scripts/probe-authed-image.mjs   (需 4173 已起)
import { execFileSync } from "node:child_process";
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc } from "./lib/probe-actions.mjs";

const BASE = "http://127.0.0.1:4173";
const rows = [];
function rec(action, kind, detail) {
  rows.push({ action, kind, detail });
  const tag = kind === "ok" ? "  ok  " : kind === "err" ? " ERR  " : " skip ";
  console.log(`${tag} ${action} — ${detail}`);
}


const { cdp, close } = await startCdp({ preferredPort: 31095, label: "probe-authed-image" });
try {
  const token = await loginToken("audit", "audit123456");
  if (!token) throw new Error("登录失败");

  /**
   * 造一张真图落到 blob-store(探针自备数据, 不依赖"恰好有产物")。
   *
   * ⚠ 必须走 `tsx` 子进程: 探针本身是 `node xxx.mjs`, **读不了应用的 TS ESM**
   *   (`src/db/pool.ts` 里是 `./env.js` 这种写法, 裸 node 解析不到)。播种脚本单独放
   *   `scripts/lib/seed-viz-file.ts`, 由这里调 —— 探针保持"不 import 应用代码"的约定。
   */
  // ⚠ Windows 上 `execFileSync("npx.cmd", ...)` 会 EINVAL(不能直接 spawn .cmd, 除非开 shell)。
  //   改走 **node 本体 + tsx 的 cli.mjs** —— 不经 shell, 路径与参数都不必转义, 也避开了
  //   "npx 在 Windows 上要先解析一层"的不确定性。
  const seededOut = execFileSync(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "scripts/lib/seed-viz-file.ts", `probe-authed-${Date.now()}.png`, "audit"],
    { encoding: "utf-8" }
  );
  // tsx/npm 会往 stdout 混警告 —— 挑出形如 /api/... 的那一行, 别假设"最后一行就是"
  const PATH = String(seededOut)
    .split(String.fromCharCode(10))
    .map((l) => l.trim())
    .filter((l) => l.startsWith("/api/"))
    .pop();
  if (!PATH) throw new Error(`播种失败, 输出: ${String(seededOut).slice(-200)}`);

  await cdp("Page.navigate", { url: `${BASE}/` });
  await sleep(3500);
  await evalTop(cdp, `localStorage.setItem('sag_token', ${JSON.stringify(token)});`);
  await cdp("Page.reload");
  await sleep(4000);

  // ① 反向断言: 原生 <img> 这条**必须**失败 —— 它就是我们要淘汰的用法。
  //    哪天服务端给图片端点开了豁免, 这条会红, 提示我们"这个 helper 也许不再必要",
  //    比"默默两边都能用"更值得知道。
  const native = await evalTop(cdp, `(async () => {
    const img = new Image();
    const done = new Promise(res => { img.onload = () => res('load'); img.onerror = () => res('error'); });
    img.src = ${JSON.stringify(PATH)};
    return await Promise.race([done, new Promise(res => setTimeout(() => res('timeout'), 5000))]);
  })()`);
  rec("原生 <img src> 取不到(端点需鉴权)", native === "error" ? "ok" : "err",
    `结果=${native}${native === "load" ? " —— 图片端点可能已开豁免, 这条断言该复核了" : ""}`);

  // ② 带鉴权 fetch → 200 + 真字节
  const authed = await evalTop(cdp, `(async () => {
    const t = localStorage.getItem('sag_token') || '';
    const res = await fetch(${JSON.stringify(PATH)}, { headers: { Authorization: 'Bearer ' + t }, cache: 'no-store' });
    if (!res.ok) return { status: res.status, ok: false };
    const b = await res.blob();
    return { status: res.status, ok: true, size: b.size, type: b.type };
  })()`);
  rec("带鉴权 fetch 取到真图", authed?.ok && authed?.size > 0 && String(authed?.type).startsWith("image/") ? "ok" : "err",
    `HTTP ${authed?.status} ${authed?.size ?? 0}B ${authed?.type ?? ""}`);

  // ③ objectURL 能真解码成一张图(不是"拿到了字节但画不出来")
  const decoded = await evalTop(cdp, `(async () => {
    const t = localStorage.getItem('sag_token') || '';
    const res = await fetch(${JSON.stringify(PATH)}, { headers: { Authorization: 'Bearer ' + t }, cache: 'no-store' });
    const url = URL.createObjectURL(await res.blob());
    const img = new Image();
    const done = new Promise(r => { img.onload = () => r({ ok: true, w: img.naturalWidth, h: img.naturalHeight }); img.onerror = () => r({ ok: false }); });
    img.src = url;
    const out = await Promise.race([done, new Promise(r => setTimeout(() => r({ ok: false, timeout: true }), 4000))]);
    URL.revokeObjectURL(url);
    return out;
  })()`);
  rec("objectURL 能解码成图", decoded?.ok && decoded?.w > 0 ? "ok" : "err",
    `naturalWidth=${decoded?.w ?? 0} naturalHeight=${decoded?.h ?? 0}`);

  // ④ 不存在的路径必须是 404(且这是**不可恢复**, 不该被重试拖到 900ms)
  const missing = await evalTop(cdp, `(async () => {
    const t = localStorage.getItem('sag_token') || '';
    const t0 = performance.now();
    const res = await fetch(${JSON.stringify(PATH.replace(/[^/]+$/, "definitely-not-here.png"))},
      { headers: { Authorization: 'Bearer ' + t }, cache: 'no-store' });
    return { status: res.status, ms: Math.round(performance.now() - t0) };
  })()`);
  rec("不存在的图 → 404", missing?.status === 404 ? "ok" : "err", `HTTP ${missing?.status} 耗时 ${missing?.ms}ms`);

  /**
   * ⑤ 端到端"编辑器正文里插入的图表看得见" —— **没做, 且不该按原计划做**。
   *
   * 原计划: 建文档 → 写 `![图表](/api/viz/files/…)` → 进编辑器切「双栏」→ 断言图渲染出来。
   * 实测发现**前提不成立**, 两层:
   *
   *   1. `/soc/#/editor` 是 **Vue 版**(tiptap 所见即所得), 没有 markdown 预览模式 ——
   *      工具栏只有「保存/版本历史/撤销/加粗…」, 没有「双栏」。我照着"怎么不渲染"查了半天,
   *      结论是**我找错了组件**。
   *   2. 我改的 `MarkdownRich` 在 **React 版** `EditorView.tsx` 里 —— 而那个文件
   *      **零 import**、构建产物 0 命中, 是**死文件**(详见台账 §21)。对着它做端到端探针没有意义。
   *
   * 活着的 `MarkdownRich` 消费者只有 `ChatPanel`; 驱动它要造会话 + 精确复刻租户过滤
   *   (造了一条, 会话接口按租户过滤就是不返回), 成本远高于收益。
   * 于是这条改成**渲染器单测** `web/src/lib/markdown-image.test.tsx`(4 条), 并验证过
   *   "拆掉图片分支就红 2 条" —— 有牙, 不是摆设。
   */
  console.log("\n════════ 汇总 ════════");
  for (const x of rows) console.log(`${x.kind.padEnd(6)} ${x.action}`);
  const bad = rows.filter((x) => x.kind === "err");
  console.log(bad.length ? `\n❌ ${bad.length} 项异常` : `\n✅ ${rows.length} 项全部通过`);
  if (bad.length) process.exitCode = 1;
} catch (e) {
  console.error("探针异常:", e.message, e.stack?.split("\n")[1] ?? "");
  process.exitCode = 1;
} finally {
  await close();
}

// scripts/lib/cdp-port.mjs — CDP 调试端口解析(2026-09-14)
//
// 由来: 7 个走 DevTools 协议的验证脚本各自硬写了端口(9333/9334/9345/9347/9348/9350/9363),
//   在本机**全部**落在 Windows 保留区间里 —— `netsh int ipv4 show excludedportrange protocol=tcp`
//   显示 9250-9349 / 9350-9449 / 9450-9549 … 成片被保留(Docker/Hyper-V/WSL 会这么干)。
//   浏览器 bind() 时报 WSAEACCES(0x271D) → "Cannot start http server for devtools" →
//   端口没人监听 → 脚本要么空转超时, 要么在 `ws.onmessage` 上抛
//   "Cannot set properties of undefined" —— 完全看不出真实原因。
//
// 所以端口不能写死: 从首选值起逐个试, 返回第一个**真能绑上**的。
// 用真实 bind 探测而不是查保留表: 端口还可能被别的进程占着, 两种情况都要躲开。

import net from "node:net";

/** 能不能绑定该端口(绑得上=可用)。只测环回 —— CDP 调试端口就只在环回上。 */
function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    const done = (ok) => { try { srv.close(); } catch { /* 未监听时 close 会抛 */ } resolve(ok); };
    srv.once("error", () => done(false));
    srv.once("listening", () => done(true));
    try { srv.listen(port, "127.0.0.1"); } catch { done(false); }
  });
}

/**
 * 找一个可用的 CDP 端口。
 * @param {number} preferred 首选端口(各脚本保持原值作起点, 便于日志对照)
 * @param {number} span      向后试多少个(默认 40, 足以跨过成片保留区间)
 * @returns {Promise<number>}
 */
export async function resolveCdpPort(preferred, span = 40) {
  const tried = [];
  for (let p = preferred; p < preferred + span; p++) {
    if (await canBind(p)) {
      if (p !== preferred) {
        console.log(`[env] CDP 端口: ${preferred} 被占用/保留(WSAEACCES) → 改用 ${p}`);
      }
      return p;
    }
    tried.push(p);
  }
  throw new Error(
    `从 ${preferred} 起连续 ${span} 个端口都不可用(Windows 保留区间或已被占用)。\n` +
    `  已试: ${tried[0]}..${tried[tried.length - 1]}\n` +
    `  排查: netsh int ipv4 show excludedportrange protocol=tcp\n` +
    `  绕过: 用 UI_VERIFY_BROWSER 指定别的浏览器并不能解决, 端口才是瓶颈 —— 请换一台机器或释放端口范围。`
  );
}

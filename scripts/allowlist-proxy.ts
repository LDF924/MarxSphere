// allowlist-proxy.ts — 沙盒网络出口白名单代理（BOOK-GAP-ROADMAP P0-14）
// 书中 Ch5: 网络出口默认断网 + 白名单代理放行——"即使注入成功读到敏感数据，没出口也传不出去"
// 本机轻量 HTTP 代理（127.0.0.1:8899）: 只转发白名单 URL，其余 403
// 用法: npx tsx scripts/allowlist-proxy.ts [--port 8899]
import http from "node:http";
import { URL } from "node:url";

const PORT = (() => {
  const i = process.argv.indexOf("--port");
  const v = i >= 0 && i + 1 < process.argv.length ? parseInt(process.argv[i + 1], 10) : NaN;
  return !isNaN(v) && v > 0 ? v : 8899;
})();

// 白名单：包管理源 / 文档站 / 明确需要的 API
const ALLOWED_HOSTS = [
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
];

/** 校验请求 URL 是否在白名单 */
function isAllowed(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    return ALLOWED_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  // HTTP 代理模式下 req.url 是绝对 URL（如 http://pypi.org/simple/）；无 host 头时兜底拼接
  const target = req.url?.startsWith("http") ? req.url : (req.headers["host"] ? "http://" + req.headers["host"] + (req.url || "/") : "");
  // CONNECT 方法（HTTPS 隧道）→ 拒绝（沙箱内不需要 HTTPS 直连）
  if (req.method === "CONNECT") {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("CONNECT forbidden by allowlist proxy");
    return;
  }
  if (!isAllowed(target)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("403 Forbidden by allowlist proxy: " + target);
    return;
  }
  // 转发请求
  const proxyReq = http.request(target, { method: req.method, headers: req.headers }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", () => {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("502 Bad Gateway");
  });
  req.pipe(proxyReq);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[allowlist-proxy] listening on 127.0.0.1:${PORT}`);
  console.log(`[allowlist-proxy] 白名单: ${ALLOWED_HOSTS.join(", ")}`);
  console.log(`[allowlist-proxy] 其余请求 → 403`);
});

// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
/**
 * authed-image.ts — 带鉴权 + 重试的图片取用(参考产品 `ye()` 的等价物)
 *
 * 为什么需要它: 后端的图片端点(`/api/viz/files/*` 等)是 **requireUser** 保护的,
 *   而 `<img src="/api/viz/files/...">` **发不带 Authorization 头** —— 本机因为鉴权豁免看不出来,
 *   一旦走局域网/上云就是必然 401。参考产品那套是 `fetch(url, {headers: 注入 token, cache:"no-store"})`
 *   再 `URL.createObjectURL(blob)`, 顺带做了重试。
 *
 * 规格照抄参考产品 `ye()`(`VizView-DKRGiXDk.js`), 逐条对齐:
 *   · `cache: "no-store"`                     —— 产物图会被同名覆盖, 不能吃浏览器缓存
 *   · **只对可恢复状态码重试**: 401/404/408/425/429/500/502/503/504
 *     其他状态码(如 403/400)**立即放弃** —— 重试不会让它变好, 白等
 *   · 网络异常(`fetch` reject)**也重试**(这是参考产品的写法: catch 到就记下继续下一轮)
 *   · 最多 4 次, 退避 `150ms * (attempt + 1)` → 150/300/450
 *
 * ⚠ 与 Vue 侧 `vizApi.ts` 的 `blobifyPng` 是同一个契约的**两份实现**(那一份在 soc 子应用里,
 *   构建产物独立)。两边各自的注释里都指向对方, 改规格时**两处一起改**。
 */
import * as React from "react";

/** 值得重试的状态码 —— 与参考产品那张表逐字一致 */
export const RETRYABLE_STATUS = [401, 404, 408, 425, 429, 500, 502, 503, 504] as const;

export interface AuthedImageOptions {
  /** 最多几次(含首次), 参考产品默认 4 */
  attempts?: number;
  /** 退避基数(ms), 参考产品 150 → 150/300/450 */
  backoffMs?: number;
  /** 取 token 的方式(默认读 localStorage 的两个键, 与 lib/api.ts 同口径) */
  token?: string;
  signal?: AbortSignal;
}

/** 与 `lib/api.ts` 的 request() 同口径: 任一个在就用 */
export function authToken(): string {
  try {
    return localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
  } catch {
    return "";
  }
}

/**
 * 取图 → object URL。**调用方负责 `URL.revokeObjectURL`**(组件卸载时)。
 *
 * 失败时抛最后一个错误, 且错误里带 state(status), 便于调用方区分"没权限"和"服务端挂了"。
 */
export async function fetchImageObjectUrl(url: string, opts: AuthedImageOptions = {}): Promise<string> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const backoff = opts.backoffMs ?? 150;
  const token = opts.token ?? authToken();
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    /**
     * ⚠ 不可恢复时用 **break**, 不能用 **throw**。
     *
     * 第一版在 try 里 `throw err` 想提前退出 —— 结果被**自己的 catch 接住**了,
     * 于是"403 立即放弃"完全没生效, 照样重试满 4 次(白等 900ms 还多打三次服务端)。
     * 单测把这条抓出来了。参考产品用的也是 `break`。
     */
    let retryable = true;
    try {
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
        signal: opts.signal,
      });
      if (res.ok) return URL.createObjectURL(await res.blob());
      const err = new Error(`图片加载失败 (${res.status})`) as Error & { status?: number };
      err.status = res.status;
      lastErr = err;
      retryable = (RETRYABLE_STATUS as readonly number[]).includes(res.status);
      if (!retryable) break;
    } catch (e) {
      // 网络层异常也重试 —— 但**中止**(用户切走了)不该重试
      if ((e as { name?: string })?.name === "AbortError") throw e;
      lastErr = e;
    }
    if (attempt < attempts - 1) {
      await new Promise((r) => setTimeout(r, backoff * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error("图片加载失败");
}

/**
 * 取**任意受保护二进制**的 object URL(图片之外的 PDF / 附件也走它)。
 *
 * 由来(2026-09-19): 壳里有三处把 `/api/vault/binary?path=…` 直接当 `<img src>` / `<iframe src>`
 *   (`PolicyPanel` / `VaultPanel` / `EducationPanel`)。该端点**没有 requireUser**, 却被
 *   **全局鉴权中间件**挡住 —— 实测本机 500(放行进入处理)、**局域网 IP 401**。
 *   也就是说远程部署时, 保管箱/政策资料/教育资料里的图片与 PDF 预览**全是白的**。
 *
 * 与 `fetchImageObjectUrl` 同一套重试规格, 只是不假设内容是图片。
 */
export async function fetchBinaryObjectUrl(url: string, opts: AuthedImageOptions = {}): Promise<string> {
  return fetchImageObjectUrl(url, opts);
}

/**
 * React 侧的一步到位版: 传 URL → 拿状态与可用地址, **卸载/换 URL 时自动 revoke**。
 *
 * 组件里原本要自己写 `useEffect` + `createObjectURL` + 清理, 很容易漏掉 revoke(内存泄漏),
 * 或者漏掉"token 变了要重取"。
 */
export function useAuthedImage(
  url: string | null | undefined
): { src: string | null; loading: boolean; error: string | null } {
  const [state, setState] = React.useState<{ src: string | null; loading: boolean; error: string | null }>(
    { src: null, loading: !!url, error: null }
  );
  React.useEffect(() => {
    if (!url) {
      setState({ src: null, loading: false, error: null });
      return;
    }
    let alive = true;
    let created: string | null = null;
    setState({ src: null, loading: true, error: null });
    fetchImageObjectUrl(url)
      .then((objUrl) => {
        if (!alive) {
          // 已经切走了 —— 这一张必须当场回收, 否则永远没人回收它
          URL.revokeObjectURL(objUrl);
          return;
        }
        created = objUrl;
        setState({ src: objUrl, loading: false, error: null });
      })
      .catch((e: Error) => {
        if (alive) setState({ src: null, loading: false, error: e?.message ?? "加载失败" });
      });
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [url]);
  return state;
}

/**
 * 直接替换 `<img src="/api/...">` 的组件 —— 后端的图基本都要鉴权, 用原生 `<img>` 取
 * **只在有本机豁免时看得见, 上云必 401**。凡是取 `/api/` 下的图, 一律用这个。
 *
 * 加载中/失败都给一个等尺寸的占位, 避免列表里图片位置跳动。
 */
export function AuthedImg({
  path,
  alt,
  className,
  style,
}: {
  path: string;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { src, loading, error } = useAuthedImage(path);
  if (loading || error || !src) {
    return (
      <span
        className={className}
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: 48, ...style }}
        role="img"
        aria-label={error ? `${alt ?? "图片"}加载失败` : `正在加载${alt ?? "图片"}`}
        title={error ?? undefined}
      >
        <span style={{ fontSize: 11, opacity: 0.6 }}>{error ? "图片加载失败" : "加载中…"}</span>
      </span>
    );
  }
  return <img src={src} alt={alt} className={className} style={style} />;
}

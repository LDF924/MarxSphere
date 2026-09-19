// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
/**
 * cdp-browser.ts — 通用 CDP 浏览器代理原语
 *
 * 由来(2026-09-19): 这套原语原本长在 `cnki-citation-proxy.ts` 里, 而它只服务知网一家。
 *   现在要接**万方 / 维普**(同样是"用你自己浏览器里的机构登录态去查", 没有对外 API),
 *   三家共用的是同一套"开 tab / 求值 / 点击 / 关闭", 所以抽到这里。
 *
 * ⚠ **接线必须自证**(这条是 2026-09-19 用真金白银的排查换来的):
 *   `newTab()` 曾把 URL 用 `JSON.stringify()` 发出去, 而代理要**裸文本** ——
 *   代理返回空响应 → `JSON.parse("")` 抛错被 catch 吞掉 → 返回空 targetId
 *   → 上层报"打开论文详情页失败"。**这个错从 2026-08 就在, 知网的 searchAndOpen 从来没成功过。**
 *   表现极易被误判成"目标站点不稳定"。接线时请先 `assertLive()`。
 *
 * 本次只抽原语 + 修那个传参 bug 的**唯一一份实现**; 三家的搜索/抓取适配器见各自的 service。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CDP_PROXY = process.env.CDP_PROXY_URL || "http://localhost:3456";

/** 调代理的 HTTP 接口。用 curl 而非 node fetch: 与既有实现一致, 且避开本机 IPv6 解析差异。 */
export function cdpCurl(
  args: string[],
  opts: { encoding?: BufferEncoding; maxBuffer?: number; timeout?: number } = {}
): string {
  return execFileSync("curl", args, {
    encoding: opts.encoding ?? "utf-8",
    maxBuffer: opts.maxBuffer ?? 1024 * 1024 * 8,
    timeout: opts.timeout ?? 25000
  }) as unknown as string;
}

export interface CdpTarget {
  targetId: string;
  title: string;
  url: string;
}

/** 列出所有 page 类型的 tab */
export function listTargets(): CdpTarget[] {
  try {
    const out = cdpCurl(["-s", "-m", "5", `${CDP_PROXY}/targets`]);
    const all = JSON.parse(out) as Array<CdpTarget & { type?: string }>;
    return all.filter((t) => t.type === "page" || !t.type);
  } catch {
    return [];
  }
}

/**
 * 新建 tab 并返回 targetId。
 *
 * ⚠ URL 走 **POST body 的裸文本**, 不是 JSON 字符串 —— 见文件头那段血泪。
 */
export function newTab(url: string): string {
  try {
    const out = cdpCurl(["-s", "-m", "20", "-X", "POST", `${CDP_PROXY}/new`, "--data-raw", url]);
    return (JSON.parse(out) as { targetId?: string })?.targetId ?? "";
  } catch {
    return "";
  }
}

/** 在既有 tab 里导航 */
export function navigate(targetId: string, url: string): boolean {
  try {
    cdpCurl(["-s", "-m", "20", "-X", "POST", `${CDP_PROXY}/navigate?target=${targetId}`, "--data-raw", url]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 tab 里求值并取回结果。
 *
 * 表达式写进临时文件再用 `--data-binary @file` 发 —— 避免长表达式在命令行里被转义/截断。
 */
export function evalJs(targetId: string, expression: string): string {
  let tmpFile = "";
  try {
    tmpFile = path.join(os.tmpdir(), `cdp-eval-${Date.now()}-${Math.floor(Math.random() * 10000)}.js`);
    fs.writeFileSync(tmpFile, expression, "utf-8");
    const out = cdpCurl(
      ["-s", "-m", "20", "-X", "POST", `${CDP_PROXY}/eval?target=${targetId}`, "--data-binary", `@${tmpFile}`],
      { maxBuffer: 1024 * 1024 * 8, timeout: 25000 }
    );
    const parsed = JSON.parse(out) as { value?: unknown; error?: string };
    if (parsed?.error) throw new Error(parsed.error);
    return typeof parsed?.value === "string" ? parsed.value : JSON.stringify(parsed?.value ?? "");
  } finally {
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* 忽略 */
      }
    }
  }
}

/** 取 tab 的 url/title/ready */
export function tabInfo(targetId: string): { title: string; url: string; ready?: string } | null {
  try {
    const out = cdpCurl(["-s", "-m", "8", `${CDP_PROXY}/info?target=${targetId}`]);
    return JSON.parse(out) as { title: string; url: string; ready?: string };
  } catch {
    return null;
  }
}

/** 关闭 tab */
export function closeTab(targetId: string): void {
  try {
    cdpCurl(["-s", "-m", "5", `${CDP_PROXY}/close?target=${targetId}`]);
  } catch {
    /* 忽略 */
  }
}

/** 找第一个满足条件的 tab */
export function findTab(match: (t: CdpTarget) => boolean): string {
  return listTargets().find(match)?.targetId ?? "";
}

/** 在 tab 上派发一次真实点击(按选择器) */
export function clickAt(targetId: string, selector: string): boolean {
  try {
    const r = evalJs(
      targetId,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return "notfound"; el.click(); return "ok"; })()`
    );
    return r === "ok";
  } catch {
    return false;
  }
}

/** 轮询等待某个选择器出现(默认最多 30s) */
export async function waitForSelector(targetId: string, selector: string, attempts = 10, intervalMs = 3000): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    const n = Number(
      evalJs(targetId, `document.querySelectorAll(${JSON.stringify(selector)}).length`) || "0"
    );
    if (n > 0) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * 接线自证: 真的能开 tab 吗?
 *
 * 任何依赖本模块的功能在报"目标站点不可用"之前, 先用它排除**是我们这层断了**。
 *   2026-09-19 的教训就是没做这个自证, 让人以为知网坏了(实际是我们传参错)。
 */
export function assertLive(): { ok: boolean; targetId?: string; error?: string } {
  const id = newTab("about:blank");
  if (!id) return { ok: false, error: "CDP 代理不可用, 或 /new 参数格式不对(URL 必须走裸文本 body)" };
  closeTab(id);
  return { ok: true, targetId: id };
}

/**
 * 把标签切到前台 —— `GET /activate?target=`。
 *
 * ## 为什么需要它
 *
 * 有些站点**只在窗口可见时渲染内容**, 后台标签拿到的是空壳。实测(知网文献详情页):
 * 后台标签的 `#refpartdiv` 只有 6 个标签文字(innerText 长度恒为 **39**), 等 25 秒、重载都不变;
 * 同一个 URL 被激活后立刻变成 **712** 长度 / 10 条完整条目。
 *
 * ⚠ `Target.activateTarget` 只能改**标签是否活动**, 改不了**窗口是否被遮挡**
 * —— 窗口被盖住(或最小化)时, 激活后 `focused:true` 但 `visibilityState` 仍是 `hidden`。
 *   所以本函数**不保证**调用后页面就可见, 判据要看返回的 `state`。
 *
 * ⚠⚠ **这是对本地代理扩展能力的依赖**: `/activate` 是 2026-09-20 加进
 *   `~/.claude/skills/web-access/scripts/cdp-proxy.mjs` 的, 而那个 skill **不在本仓库里**。
 *   代理若是旧版(没有该端点), 这里会返回 `supported: false` —— 调用方应当**如实降级**
 *   (例如把"引文区没渲染出数据"说成"需要你把浏览器窗口切到前台"), 而不是当成普通失败。
 */
export function activateTab(targetId: string): { supported: boolean; visible: boolean; raw?: string; error?: string } {
  let out = "";
  try {
    out = cdpCurl(["-s", "-m", "25", `${CDP_PROXY}/activate?target=${targetId}`]);
  } catch (e) {
    return { supported: false, visible: false, error: String((e as Error)?.message ?? e).slice(0, 160) };
  }
  // 未知端点时代理回 404 + {error:"未知端点", endpoints:{…}} —— 据此判定"能力不存在"
  if (out.includes("未知端点") || out.includes("Unknown endpoint")) {
    return { supported: false, visible: false, raw: out.slice(0, 200) };
  }
  const visible = out.includes('"visibility":"visible"') || out.includes('\\"visibility\\":\\"visible\\"');
  return { supported: true, visible, raw: out.slice(0, 200) };
}

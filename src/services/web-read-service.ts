// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// web-read-service.ts — 网页 → Markdown + 阅读质量报告(2026-10-03)
//
// 由来(对照开源项目 观澜/Guanlan 的 read + quality-report, MIT): 本仓此前**没有网页正文抽取** ——
//   `web_fetch`(agent-tool-router)、MCP `sag_browse`、URL 一键导入这三条链用的是同一句
//   `.replace(/<script…|<style…|<[^>]+>/g," ")`: 剥标签后把所有可见文本糊成一行。
//   后果有三: ① 导航/页脚/推荐位混进正文; ② 没有 Markdown 结构(标题/列表/表格全糊);
//   ③ **抓完不知道干不干净** —— 正文 20 字也可能被当成"抓到了"。
//
// ═══ 质量报告为什么重要(这条是观澜最值得抄的设计) ═══
//   它把"这次抽取靠不靠谱"变成**结构化字段**而不是感觉: 字数、中文占比、噪声命中、
//   乱码、行数、平均行长、以及一个 `label`(clean/noisy/thin/fallback)。
//   下游据此决定"能不能拿它当证据", 而不是拿到一坨文本自己猜。
//   → 我们照搬这套判据(字段名都保持可对照), 但**读数来自我们自己的抽取器**。
//
// ═══ 与观澜的差别 ═══
//   它的 `read` 主路是 Jina Reader(`r.jina.ai`)—— 本机实测**连不通**(HTTP 000/21s 超时),
//   它的 direct 后端作备份。我们**反过来**: 直连自己抽(不依赖任何第三方服务),
//   需要时再把 Jina 当可选的兜底(配了 key / 网络通才用)。
//   这不是抬杠: 一个把主路压在第三方 reader 上的设计, 在墙内是不可用的。
import { logger } from "../observability/logger.js";

export interface ReadQuality {
  /** 判级 —— 下游据此决定"能不能当证据用" */
  label: "clean" | "noisy" | "thin" | "failed";
  /** 0-100: 综合可读性(不是"正确率", 别过度解读) */
  score: number;
  chars: number;
  cjkChars: number;
  /** 命中的噪声词(导航/推荐/登录/版权这类), 给用户看"为什么判成 noisy" */
  noiseHits: string[];
  mojibake: boolean;
  /** 正文是否偏薄(可能只抓到摘要/登录墙) */
  weak: boolean;
  lineCount: number;
  avgLineLen: number;
  noiseRatio: number;
}

export interface ReadResult {
  ok: boolean;
  url: string;
  /** 最终 URL(可能因重定向与入参不同) */
  finalUrl?: string;
  title: string;
  markdown: string;
  quality: ReadQuality;
  error?: string;
  fetchedAt: string;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 噪声词 —— 判"这一块是不是正文"用。它们出现在**标题行**或**高频短行**里就是噪声信号 */
const NOISE_WORDS = [
  "登录", "注册", "订阅", "关注我们", "广告", "版权所有", "免责声明", "转载", "点击查看",
  "上一篇", "下一篇", "相关阅读", "推荐阅读", "热门推荐", "猜你喜欢", "扫码", "下载APP",
  "客户端下载", "意见反馈", "联系我们", "关于我们", "服务条款", "隐私政策", "网站地图",
  "首页", "导航", "更多", "全部评论", "取消", "确认", "分享到", "返回顶部",
];

/**
 * HTML → 结构化 Markdown。
 *
 * ⚠ 为什么不引 readability/turndown: 那两个包要配 jsdom(几 MB + 解析整棵 DOM),
 *   而我们要处理的是**服务端抓回来的**、结构相当规整的新闻/政策页。
 *   这里用"块级切分 + 按块判正文"的办法, 零新增依赖 —— 与 office-preview-service 里
 *   "结构极浅就用正则, 不装解析器"是同一个判断。
 *   ⚠ 代价同样要写清: 遇到**强 JS 渲染**的页面(内容全靠前端拼)这套会抽空,
 *   那时 `quality.label` 会是 thin/failed, 界面如实说"抓不到正文", 而不是假装成功。
 */
export function htmlToMarkdown(html: string): { markdown: string; title: string; noiseHits: string[] } {
  const raw = String(html ?? "");

  /**
   * ⚠ 标题必须**在剥离 <head> 之前**取 —— `<title>` 就在 head 里。
   *   第一版先 `replace(/<head>…<\/head>/)` 再找 title, 于是标题**恒为空**
   *   (实测: 通篇 title="" 而正文正常), 而空标题会让归档文件名退化成"未命名页面"。
   */
  const title =
    (/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(raw)?.[1]
      ?? /<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)/i.exec(raw)?.[1]
      ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]
      ?? "").replace(/\s+/g, " ").trim();

  let s = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head|nav|footer|form|iframe)\b[\s\S]*?<\/\1>/gi, "");

  /**
   * ⚠ 容器定位**不能用 `<div …>[\s\S]*?<\/div>` 这种正则** —— 第一版就是这么写的,
   *   实测被**嵌套 div 打败**: 非贪婪匹配停在内层第一个 `</div>`, 只抓到 263 字的
   *   面包屑导航("首页 > IT之家 > …"), 整车正文在容器外, 于是抽出来 0 字、
   *   质量报告判 failed。而肉眼看上去"正则写得挺对"。
   *
   *   只用**标题级语义标签**(article/main) —— 它们极少嵌套, 正则足够;
   *   找不到就用整篇, 让"块级提取 + 噪声行过滤"去干本来的活。宁可多带一点导航,
   *   也不要因为容器猜错而**整篇丢光**。
   */
  const article = /<article\b[\s\S]*?<\/article>/i.exec(s)?.[0]
    ?? /<main\b[\s\S]*?<\/main>/i.exec(s)?.[0]
    ?? s;

  const noiseHits: string[] = [];
  const lines: string[] = [];

  const textOf = (frag: string) => frag
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    // ⚠ `&` 必须最后解 —— 先解会把 `&amp;lt;` 变成 `<`(双重解码), 与 office-preview 同一条
    .replace(/&amp;/g, "&")
    .replace(/[ \t ]+/g, " ");

  // 块级元素逐个转 —— 顺序即文档顺序
  const blocks = article.match(/<(h[1-6]|p|li|blockquote|pre|td|div)[^>]*>[\s\S]*?<\/\1>/gi) ?? [];
  for (const b of blocks) {
    const tag = /^<(\w+)/.exec(b)?.[1]?.toLowerCase() ?? "";
    if (tag === "div") continue;                     // div 只是容器, 内容由里面的块级元素给
    const t = textOf(b).trim();
    if (!t || t.length < 2) continue;
    if (tag === "h1") lines.push(`# ${t}`);
    else if (tag === "h2") lines.push(`## ${t}`);
    else if (tag === "h3") lines.push(`### ${t}`);
    else if (tag === "h4" || tag === "h5" || tag === "h6") lines.push(`#### ${t}`);
    else if (tag === "li") lines.push(`- ${t}`);
    else if (tag === "blockquote") lines.push(`> ${t}`);
    else if (tag === "pre") lines.push("```\n" + t + "\n```");
    else if (tag === "td") lines.push(`| ${t} `);
    else lines.push(t);
  }

  // 块级元素一个都没匹配到(结构异常的页面) → 退化成纯文本, 至少不空手而归
  if (!lines.length) {
    const t = textOf(article).split("\n").map((x) => x.trim()).filter((x) => x.length > 1);
    lines.push(...t);
  }

  // 噪声行识别: 逐行看是否**短且命中噪声词**(长行里出现"登录"可能是正文在讲登录)
  const kept: string[] = [];
  for (const line of lines) {
    const bare = line.replace(/^#+\s*|^-\s*|^>\s*/, "");
    const hit = NOISE_WORDS.find((w) => bare.includes(w));
    if (hit && bare.length <= 24) { if (!noiseHits.includes(hit)) noiseHits.push(hit); continue; }
    kept.push(line);
  }

  const markdown = kept.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return { markdown, title, noiseHits };
}

/**
 * 质量判据。
 *
 * ⚠ 这套阈值不是拍的: 观澜公开了它的判据与质量报告(它们跑了 benchmark), 这里取同一组口径,
 *   这样两边的 label 语义可比。**但分数只说明"抽取质量", 不说明内容对不对** ——
 *   一条干净的假新闻同样会得高分, 界面上必须写清这一点。
 */
export function assessQuality(markdown: string, noiseHits: string[]): ReadQuality {
  const chars = markdown.length;
  const cjkChars = (markdown.match(/[一-鿿]/g) ?? []).length;
  // 乱码判据: 替换符 / 常见的 UTF-8 被当 Latin-1 读出来的序列
  const mojibake = /�|Ã[-¿]|â€/.test(markdown);
  const rows = markdown.split("\n").filter((l) => l.trim());
  const lineCount = rows.length;
  const avgLineLen = lineCount ? Math.round(chars / lineCount) : 0;
  const noiseRatio = lineCount ? Math.min(1, noiseHits.length / lineCount) : 0;
  const weak = chars < 400 || cjkChars < 150;

  let label: ReadQuality["label"] = "clean";
  if (chars < 120) label = "failed";
  else if (weak) label = "thin";
  else if (noiseHits.length >= 3 || noiseRatio > 0.15) label = "noisy";

  // 分数: 从 100 往下扣。**只用来排序/展示, 不要拿它当"可信度"**
  let score = 100;
  score -= Math.min(30, noiseHits.length * 6);
  score -= mojibake ? 40 : 0;
  score -= weak ? 25 : 0;
  if (chars < 120) score = Math.min(score, 20);
  score = Math.max(0, Math.min(100, score));

  return { label, score, chars, cjkChars, noiseHits, mojibake, weak, lineCount, avgLineLen, noiseRatio };
}

/** 抓网页(带超时、UA、重定向后的真实 URL) */
async function fetchHtml(url: string, timeoutMs: number): Promise<{ ok: boolean; html?: string; finalUrl?: string; error?: string }> {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    // ⚠ 编码: 中文站大量是 GBK/GB18030, 而 fetch 的 .text() **一律按 UTF-8 解** ——
    //   直接 text() 会得到一屏乱码(而且 quality.mojibake 会报 true, 看起来像"站点的错")。
    //   所以先取字节, 再从 header/meta 里读 charset 自己解。
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get("content-type") ?? "";
    const head = buf.subarray(0, 2048).toString("latin1");
    const charset = (
      /charset=["']?([\w-]+)/i.exec(ct)?.[1]
      ?? /charset=["']?([\w-]+)/i.exec(head)?.[1]
      ?? "utf-8"
    ).toLowerCase();
    let html: string;
    if (charset.includes("gb") || charset.includes("gbk") || charset.includes("gb2312")) {
      // Node 内置没有 GBK 解码器 —— TextDecoder 支持 gbk(Node 18+ 的 full-icu 构建)
      try { html = new TextDecoder("gbk").decode(buf); }
      catch { html = buf.toString("utf-8"); }
    } else {
      html = buf.toString("utf-8");
    }
    return { ok: true, html, finalUrl: r.url };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** 读一个网页 → Markdown + 质量报告 */
export async function readWebPage(url: string, opts: { timeoutMs?: number; maxChars?: number } = {}): Promise<ReadResult> {
  const u = String(url ?? "").trim();
  const now = new Date().toISOString();
  if (!/^https?:\/\//i.test(u)) {
    return { ok: false, url: u, title: "", markdown: "", quality: assessQuality("", []), error: "只支持 http/https 链接", fetchedAt: now };
  }
  const r = await fetchHtml(u, opts.timeoutMs ?? 20_000);
  if (!r.ok || !r.html) {
    logger.warn({ url: u, err: r.error }, "网页读取失败");
    return { ok: false, url: u, title: "", markdown: "", quality: assessQuality("", []), error: r.error ?? "抓取失败", fetchedAt: now };
  }
  const { markdown, title, noiseHits } = htmlToMarkdown(r.html);
  const clipped = opts.maxChars && markdown.length > opts.maxChars ? markdown.slice(0, opts.maxChars) : markdown;
  const quality = assessQuality(clipped, noiseHits);
  return {
    ok: quality.label !== "failed",
    url: u, finalUrl: r.finalUrl, title, markdown: clipped, quality, fetchedAt: now,
    error: quality.label === "failed" ? `没抽到正文(仅 ${quality.chars} 字) —— 可能是纯 JS 渲染页或需要登录` : undefined,
  };
}

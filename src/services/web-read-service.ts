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
 * ═══ 为什么是"正则"而不是 readability(2026-10-04 核实后改写的定论) ═══
 * 我原先写的版本只做了**第一层**(删标签 + 块级转 Markdown), 实测在 IT 之家上
 * 因为容器正则被嵌套 div 打败而抽出 0 字。回头核实开源项目 观澜/Guanlan(MIT) 的做法
 * 才发现: **它也是正则的**, 没有 readability, 但比我多三层 ——
 *   ① `_drop_noise_blocks`  按 id/class **属性**整块删导航/评论/推荐/广告(循环多轮, 因为
 *      删外层会露出内层);
 *   ② `_prefer_main_content` 取**多个候选**容器, 各自打分选最高的, 而不是"第一个命中的";
 *   ③ `_extract_density_text` 第二套按段落密度抽取, 与主结果**比分数**, 取高的。
 * 这三层才是"能行"的关键, 不是抽取器本身。所以这里把它们重写进来(判据照抄、代码自己写)。
 *
 * ⚠ 已知上限, 不假装全能: **强 JS 渲染**的页面(内容全靠前端拼)这套会抽空,
 *   那时 quality.label 是 thin/failed, 界面如实说"抓不到正文", 而不是假装成功。
 */
/**
 * 以下正文抽取逻辑是 **从观澜/Guanlan 移植的代码**(MIT, https://github.com/shenyangs/Guanlan),
 * 对应其 `guanlan/web/_legacy_web_impl.py` 的下列函数, 逐行转成 TypeScript:
 *   `_extract_article_text` / `_extract_density_text` / `_text_body_score` / `_content_score` /
 *   `_content_candidates` / `_prefer_main_content` / `_drop_noise_blocks` / `_is_noise_content_line`
 * 见 THIRD_PARTY_NOTICES.md 第 9 节。
 *
 * ⚠ 我原先自己写的那版**漏了它的三层**(_drop_noise_blocks 整块删噪声 / _prefer_main_content
 *   多候选打分选容器 / _extract_density_text 密度窗口双跑), 实测在一个常见的
 *   "面包屑 + 正文 + 相关阅读" 嵌套结构上抽出 **0 字**。这三层才是它能用的原因, 不是抽取器本身。
 */
const NOISE_ATTR = "nav|navbar|menu|footer|header|sidebar|aside|breadcrumb|share|social|comment|"
  + "recommend|related|relate|hot|popular|advert|ad-|ads|login|signin|signup|"
  + "download|app|qrcode|qr-code|copyright|toolbar|pagination|下一篇|上一篇";

/** 正文容器的属性名 —— 中文站各有各的约定(微信 js_content / 政府站 TRS_Editor / 门户 zoom…) */
const MAIN_ATTR = "article|content|main|正文|内容|稿件|文章|详情|post|entry|detail|news|"
  + "rich_media_content|js_content|main-content|article-content|article_content|"
  + "article_body|articleBody|content_area|contentArea|detailContent|text_content|"
  + "TRS_Editor|zoom|con_txt|news_txt|pages_content";

/** 整块删噪声用到的标记词(与行级的 NOISE_WORDS 是两回事, 别合并) */
const NOISE_LINE_MARKERS = [
  "登录", "注册", "分享", "收藏", "点赞", "评论", "发表评论", "下载app", "下载 app",
  "客户端", "扫码", "二维码", "广告", "推荐阅读", "相关阅读", "热门推荐", "返回首页",
  "首页", "导航", "菜单", "上一页", "下一页", "上一篇", "下一篇", "版权所有", "copyright",
  "icp", "京公网安备", "联系我们", "关于我们", "打开app", "打开 app", "展开全文",
  "继续阅读", "点击查看", "点击下载", "微信扫一扫", "用微信扫码", "扫码关注",
  "更多精彩", "特别声明", "免责声明",
];

/** 剥完标签后的文本(用于给候选打分) */
function stripTags(frag: string): string {
  return String(frag ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** 正文页面的行级噪声判据(移植 `_is_noise_content_line`) */
function isNoiseContentLine(line: string): boolean {
  if (!line) return true;
  if (line.length <= 1) return true;
  const lowered = line.toLowerCase();
  if (line.length <= 28 && NOISE_LINE_MARKERS.some((m) => lowered.includes(m))) return true;
  /**
   * ⚠ **Python→JS 移植的经典陷阱, 必须写下来**(2026-10-04):
   *
   *   原文是 `re.fullmatch(r"[\W_]+", line)` —— 排除"纯符号行"。
   *   我直译成 `/^[\W_]+$/`, 结果**所有中文行都被判成噪声**, 整篇抽出 **0 字**。
   *
   *   根因: Python 3 的 `str` 正则默认 **Unicode 感知**, `\w` 含 CJK;
   *   而 JavaScript 的 `\w` 永远是 `[A-Za-z0-9_]` —— **中文全落在 `\W` 里**。
   *   同一条规则在两种语言里含义相反。
   *
   *   还原 Python 语义要显式用 Unicode 属性转义: `\p{L}`(字母, 含中文) + `\p{N}`(数字)。
   *   凡是从 Python 移植 `\w` / `\W` / `\b`(词边界同样基于 `\w`) 的地方, 都要这样核一遍。
   */
  if (/^[^\p{L}\p{N}]+$/u.test(line)) return true;
  if (line.length <= 18 && /(首页|新闻|财经|科技|娱乐|体育|视频|图片|专题|登录|注册)/.test(line)) return true;
  const punct = (line.match(/[，。；：、,.!?！？]/g) ?? []).length;
  if (line.length <= 36 && punct === 0 && /(客户端|专题|频道|订阅|投稿|爆料|更多|排行|热搜)/.test(line)) return true;
  return false;
}

/** 正文得分(移植 `_text_body_score`): 中文 ×2 + 标点 ×8 + 平均行长 − 噪声 ×80 */
function bodyScore(text: string): number {
  const t = String(text ?? "");
  const cjk = (t.match(/[一-鿿]/g) ?? []).length;
  const punct = (t.match(/[，。；：、！？,.!?]/g) ?? []).length;
  const noise = ["登录", "注册", "打开APP", "推荐阅读", "相关阅读", "版权声明"].filter((x) => t.includes(x)).length;
  const rows = t.split("\n").filter((x) => x.trim()).length || 1;
  const collapsed = t.replace(/\s+/g, " ").trim();
  return cjk * 2 + punct * 8 + collapsed.length / rows - noise * 80;
}

/**
 * 按段落密度抽正文(移植 `_extract_density_text`)。
 *
 * ⚠ 关键在最后那一步**"保留最密的连续窗口"**: 不取全部段落, 而是滑一个 14 段的窗口,
 *   取其中得分最高的那一段连续区间。理由是**侧栏**: 侧栏的文字零散分布在全页各处,
 *   把全文所有段落合起来算分, 侧栏会跟着正文一起被算进去; 而正文是**连续**的,
 *   侧栏不是 —— 取连续窗口正好把侧栏切掉。这一步我第一版没抄, 是白写的。
 */
function extractByDensity(raw: string): string {
  let body = String(raw ?? "").replace(/<!--[\s\S]*?-->/g, " ");
  body = body.replace(/<(script|style|noscript|svg|canvas|iframe|form)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const blocks: string[] = [];
  for (const m of body.matchAll(/<(h[1-3]|p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = stripTags(m[2]).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
    if (isNoiseContentLine(text)) continue;
    // 过短的碎片不要, 除非它确实是中文长句(原文判据: len<12 且不是 中文+.{4,})
    if (text.length < 12 && !/[一-鿿].{4,}/.test(text)) continue;
    blocks.push(text);
  }
  if (!blocks.length) return "";

  let best: string[] = [];
  let bestScore = -1;
  for (let start = 0; start < blocks.length; start++) {
    const window: string[] = [];
    for (const line of blocks.slice(start, start + 14)) {
      window.push(line);
      const score = bodyScore(window.join("\n"));
      if (score > bestScore) { bestScore = score; best = [...window]; }
    }
  }
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const line of best) {
    const k = line.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    cleaned.push(line);
  }
  return cleaned.join("\n\n");
}

/**
 * 给一段 HTML 片段打"像不像正文"的分(移植 `_content_score`)。
 *
 * 判据: 总长 + 中文 ×2 + 段落数 × 40 − **链接文字 ×2**。
 * 为什么链接文字要减: 导航条/相关阅读全是链接, 纯文本长度可能很大却毫无内容;
 * 这个减项正是把"看着很长的导航"和"真正的正文"区分开的关键。
 */
function contentScore(frag: string): number {
  const text = stripTags(frag);
  if (!text) return 0;
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  const paragraphs = (frag.match(/<\/p>|<br\b|<\/h[1-6]>/gi) ?? []).length;
  const linkText = (frag.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []).join("");
  return text.length + cjk * 2 + paragraphs * 40 - stripTags(linkText).length * 2;
}

/**
 * 按 id/class 属性整块删噪声(移植 `_drop_noise_blocks`)。
 * ⚠ 要**循环多轮**: 浅层正则删掉外层容器后, 原来嵌在里面的噪声块才暴露出来。
 */
function dropNoiseBlocks(html: string): string {
  const re = new RegExp(
    `<(div|section|ul|ol)\\b[^>]*(?:id|class|role)=["'][^"']*(?:${NOISE_ATTR})[^"']*["'][^>]*>[\\s\\S]*?<\\/\\1>`,
    "gi"
  );
  let cur = html;
  for (let i = 0; i < 4; i++) {
    const next = cur.replace(re, " ");
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/**
 * 找主内容容器 —— **多候选 + 打分取最高**, 不是"命中第一个就用"。
 *
 * ⚠ 这条是我上一版抽搐的根因: 只取第一个 `<div class="…content…">`, 而它是面包屑导航
 *   (263 字), 真正的正文在另一个容器里。多候选 + 打分能自动挑中正文那个 ——
 *   因为导航虽然也带 "content" 字样, 但它的**链接文字占比极高**, 分数被减下去。
 * 兜底: 最高分低于 120 就**不裁剪**(返回整篇), 宁可多带导航也不要赌错容器。
 */
function preferMainContent(body: string): string {
  const cands: string[] = [];
  const pats = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<main\b[^>]*>([\s\S]*?)<\/main>/gi,
    new RegExp(`<div\\b[^>]*(?:id|class)=["'][^"']*(?:js_content|rich_media_content)[^"']*["'][^>]*>([\\s\\S]*?)<\\/div>`, "gi"),
    new RegExp(`<div\\b[^>]*(?:id|class)=["'][^"']*(?:${MAIN_ATTR})[^"']*["'][^>]*>([\\s\\S]*?)<\\/div>`, "gi"),
    new RegExp(`<section\\b[^>]*(?:id|class)=["'][^"']*(?:${MAIN_ATTR})[^"']*["'][^>]*>([\\s\\S]*?)<\\/section>`, "gi"),
  ];
  for (const p of pats) for (const m of body.matchAll(p)) if (m[1]) cands.push(m[1]);
  if (!cands.length) return body;
  let best = cands[0];
  let bestScore = contentScore(best);
  for (const c of cands.slice(1)) {
    const s = contentScore(c);
    if (s > bestScore) { best = c; bestScore = s; }
  }
  return bestScore >= 120 ? best : body;
}

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
    .replace(/<(script|style|noscript|svg|canvas|head|iframe)\b[\s\S]*?<\/\1>/gi, "");

  // 三层加工: 删噪声块 → 选主容器。之后才轮到块级转 Markdown。
  s = dropNoiseBlocks(s);
  const article = preferMainContent(s);

  /**
   * ⚠ 顺序照抄原文, 但**我第一版把顺序弄反了**, 这一点必须写下来:
   *
   *   我原来写的是"先逐块正则匹配 `<p>`/`<div>`/… , 再逐个转" —— 而 `<div …>[\s\S]*?</div>`
   *   会先匹配到**最外层**那个 div 并一路吃到它自己的闭合标签, 随后 `if (tag === "div") continue`
   *   把它整块丢掉 → 里面所有段落一起消失。
   *   实测在一个"面包屑 + 正文 + 相关阅读"的常见结构上: **抽出 0 字**。
   *
   *   原文的做法是**先做一次全局替换**: 把所有块级标签(含 div)换成换行符 ——
   *   位置信息保住了, 也不存在"谁吃了谁"的问题; 之后才剥掉剩下的行内标签。
   */
  let body = article
    .replace(/<\/?(?:p|div|section|article|main|h[1-6]|li|blockquote|tr|br)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  body = body
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    // ⚠ `&` 必须最后解 —— 先解会把 `&amp;lt;` 变成 `<`(双重解码)
    .replace(/&amp;/g, "&");

  const noiseHits: string[] = [];
  const lines: string[] = [];
  const seenLine = new Set<string>();
  for (const rawLine of body.split("\n")) {
    const t = rawLine.replace(/^[\s\-•·|]+|[\s\-•·|]+$/g, "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (isNoiseContentLine(t)) {
      // 记下命中的噪声词 —— 质量报告要能说清"为什么判成 noisy"
      const hit = NOISE_WORDS.find((w) => t.toLowerCase().includes(w));
      if (hit && !noiseHits.includes(hit)) noiseHits.push(hit);
      continue;
    }
    // 同一行出现两次(响应式布局常留一份隐藏副本) —— 去重, 否则正文会读着像复读
    const k = t.toLowerCase();
    if (seenLine.has(k)) continue;
    seenLine.add(k);
    lines.push(t);
  }

  /**
   * 第三层: **另一套抽取器独立跑一遍, 谁分高用谁**。
   *
   * 主路的块级解析对规整页面很好, 但中文站有一大类是"不规整"的 ——
   * 段落不闭合、正文塞在 `<font>`/`<span>` 里、整页只有 `<br>` 换行。
   * 这时块级解析会抽空或抽碎, 而"按段落密度"的路径照样能拿到正文。
   * 两条路各自算分, 取高的那个 —— 而不是"主路失败才用备路"(那样备路永远慢一拍)。
   * (判据 `_text_body_score` 与观澜同源: 中文 ×2 + 标点 ×8 + 行长 − 噪声 ×80。)
   */
  const primary = lines.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  const density = extractByDensity(article);
  const markdown = density && bodyScore(density) > bodyScore(primary) * 1.15 ? density : primary;
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

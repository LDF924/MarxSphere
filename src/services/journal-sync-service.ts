// journal-sync-service.ts — V395-38/39/40: 期刊实时更新管道
// 目标: 自主自动获取各期刊最新选题方向/研究热点/目录
// 方式: ①抓期刊官网/公开页面 ②微信公众号搜索(搜狗, 选题方向/目录/内容提要) ③解析热点词 ④写入 updates
// 容错: 官网/微信失败 → 用期刊选题标签降级, 不阻断管道
// V395-39: JS重定向跟随 + last_sync_status + 短内容过滤
// V395-40: 微信源(搜狗搜索标题=高价值数据) + kind分类(trend/issue/cfp/hotspot)
// V395-41: 微信抓取改用 curl execFile(引号安全) — node fetch/execSync 转义问题触发反爬
// 定时: 启动后跑一次 + 每 6 小时自动同步(带单例锁防重入)
import { pool } from "../db/pool.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 小时
const MIN_CONTENT_LEN = 1000;  // 小于此长度视为跳转页/空页, 不算抓取成功
const WEIXIN_DELAY_MS = 1500;  // 微信搜索间隔(防搜狗限流)
let syncing = false;
let lastSyncAt = 0;
let weixinBlocked = false;  // 搜狗限流标记: 触发验证码后本轮跳过微信
let lastWeixinAt = 0;       // 上次微信请求时间(节流)

/** 用 curl 抓取（execFile 数组参数, 无引号转义问题; node fetch 会被搜狗反爬） */
async function fetchWithCurl(url: string, timeoutSec = 8): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("curl", [
      "-sL", "--max-time", String(timeoutSec),
      "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0",
      url,
    ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: timeoutSec * 1000 + 3000 });
    return stdout.length > 200 ? stdout : null;
  } catch { return null; }
}

/** 抓取单页 HTML（8s 超时, 失败返回 null） */
async function fetchPage(url: string, timeoutMs = 8000): Promise<string | null> {
  return fetchWithCurl(url, Math.ceil(timeoutMs / 1000));
}

/** 搜狗微信搜索: 搜索期刊公众号文章（列表页标题即高价值数据: 选题方向/目录/内容提要/征稿）
 * 限流保护: 触发验证码后置 weixinBlocked 标记, 本轮后续期刊跳过微信; 请求间 1.5s 节流 */
async function fetchWeixinTitles(journalName: string): Promise<Array<{ title: string; sourceUrl: string }>> {
  if (weixinBlocked) return [];
  // 节流: 距上次请求至少 1.5s
  const wait = WEIXIN_DELAY_MS - (Date.now() - lastWeixinAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastWeixinAt = Date.now();
  try {
    const q = encodeURIComponent(journalName);
    const html = await fetchWithCurl(`https://weixin.sogou.com/weixin?type=2&query=${q}`, 10);
    if (!html) return [];
    // 反爬/限流检测: 触发后本轮标记跳过
    if (html.includes("antispider") || html.includes("验证码") || html.includes("请输入验证码")) {
      weixinBlocked = true;
      return [];
    }
    // 提取文章标题(搜狗列表页结构: <h3><a ...>标题</a></h3>)
    const results: Array<{ title: string; sourceUrl: string }> = [];
    const h3s = html.split(/<h3>/g).slice(1);
    for (const h3 of h3s) {
      const a = h3.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      const title = a[2].replace(/<[^>]+>/g, "").replace(/&ldquo;|&rdquo;|&middot;|&amp;|&quot;/g, (m: string) => ({ "&ldquo;": "“", "&rdquo;": "”", "&middot;": "·", "&amp;": "&", "&quot;": '"' })[m] || m).trim();
      if (!title || title.length < 6) continue;
      const href = a[1].startsWith("http") ? a[1] : `https://weixin.sogou.com${a[1]}`;
      results.push({ title, sourceUrl: href });
    }
    // 只保留选题方向/目录/内容提要/征稿/笔谈/专题类标题(高价值)
    const HIGH_VALUE = /(选题|方向|导引|指南|目录|目次|内容提要|征文|征稿|约稿|笔谈|专题|热点|重点)/;
    return results.filter((r) => HIGH_VALUE.test(r.title)).slice(0, 6);
  } catch { return []; }
}

/** 跟随 JS 重定向: 识别 window.location.href 跳转脚本 → 二次抓取真实页 */
async function fetchPageFollowingRedirect(url: string): Promise<string | null> {
  let html = await fetchPage(url);
  if (!html) return null;
  // 玛格泰克系统: 首页是 <script>window.location.href='...'</script> 跳转
  const redirectMatch = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
  if (redirectMatch) {
    const target = redirectMatch[1];
    const targetUrl = target.startsWith("http") ? target : new URL(target, url).href;
    html = await fetchPage(targetUrl);
    // 若深层页再跳一次(部分系统两级跳转)
    if (html) {
      const m2 = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
      if (m2) {
        const t2 = m2[1];
        const u2 = t2.startsWith("http") ? t2 : new URL(t2, targetUrl).href;
        html = await fetchPage(u2);
      }
    }
  }
  return html;
}

/** 从 HTML 文本提取候选热点词（去除标签后按高频词/关键词提取） */
function extractHotspots(html: string, fallbackTags: string[]): string[] {
  const text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 8000);
  // 常见主题词模式: 中国式现代化/新质生产力/人工智能/共同富裕/数字经济/高质量发展 等
  const TOPIC_PATTERNS = [
    /(中国式现代化|新质生产力|高质量发展|共同富裕|人工智能|数字经济|数字劳动|平台经济|算法|数据要素|生产力|生产关系|劳动过程|剩余价值|资本逻辑|马克思主义中国化|两个结合|文化思想|现代化|乡村振兴|绿色发展|全国统一大市场|未来产业|耐心资本|投资于人|科技自立自强|经济体制改革|金融|人口高质量发展|区域协调|高水平开放|智能经济)/g,
  ];
  const found = new Set<string>();
  for (const re of TOPIC_PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (m[1] && m[1].length >= 2) found.add(m[1]);
    }
  }
  // 加回该刊选题标签作为基础
  for (const t of fallbackTags) if (t && t.length >= 2) found.add(t);
  return Array.from(found).slice(0, 12);
}

/** 同步单本期刊: ①官网抓取(跟随JS跳转) ②微信公众号搜索(选题方向/目录/内容提要) → 写入 updates + 记录状态 */
async function syncJournal(j: any): Promise<number> {
  let html: string | null = null;
  let status = "fail";
  // ① 官网优先
  if (j.official_site) {
    html = await fetchPageFollowingRedirect(j.official_site);
    if (html && html.length < MIN_CONTENT_LEN) html = null;
    status = html ? "ok" : "fail";
  }
  // ② 微信公众号搜索(补全 73 本官网不可达的期刊)
  const weixinItems = await fetchWeixinTitles(j.name);
  const wxOk = weixinItems.length > 0;
  if (wxOk && status !== "ok") status = "ok";  // 微信命中也算成功(有真实内容)
  // 搜狗限流时标记信息(供报告)
  const wxBlockedNote = weixinBlocked ? "（搜狗限流, 本轮跳过微信）" : "";

  // 组装热点: 官网热点 + 微信高价值标题 + 内置标签兜底
  // 排序权重: 微信高价值标题(trend/issue/cfp) > 官网热点 > 降级标签
  const hotspots: Array<{ title: string; source: string; url: string | null; rank: number }> = [];
  if (html) {
    for (const h of extractHotspots(html, j.topic_tags || [])) hotspots.push({ title: h, source: j.official_site, url: j.official_site, rank: 2 });
  }
  for (const w of weixinItems) {
    const isHighValue = /(选题|方向|导引|指南|目录|目次|内容提要|征文|征稿|约稿|笔谈|专题)/.test(w.title);
    hotspots.push({ title: w.title, source: "微信公众号(搜狗搜索)", url: w.sourceUrl, rank: isHighValue ? 0 : 1 });
  }
  if (hotspots.length === 0) {
    for (const t of (j.topic_tags || [])) hotspots.push({ title: t, source: "内置选题标签(官网/微信均不可达, 降级)", url: null, rank: 3 });
  }
  // 按权重排序 + 去重
  hotspots.sort((a, b) => a.rank - b.rank);
  const seen = new Set<string>();
  const uniq = hotspots.filter((h) => { if (seen.has(h.title)) return false; seen.add(h.title); return true; }).slice(0, 10);

  if (uniq.length === 0) {
    await pool.query("update cjournal_journals set updated_at = now(), last_sync_status = $2 where id = $1", [j.id, status]);
    return 0;
  }
  let n = 0;
  for (const h of uniq) {
    // 去重: 同刊同标题 7 天内不重复写
    const dup = await pool.query(
      "select 1 from cjournal_journal_updates where journal_id=$1 and title=$2 and found_at > now() - interval '7 days' limit 1",
      [j.id, h.title]
    );
    if (dup.rows.length > 0) continue;
    const kind = /(选题|方向|导引|指南)/.test(h.title) ? "trend" : /(目录|目次|内容提要)/.test(h.title) ? "issue" : /(征文|征稿|约稿)/.test(h.title) ? "cfp" : "hotspot";
    await pool.query(
      "insert into cjournal_journal_updates (journal_id, kind, title, content, source_url) values ($1,$2,$3,$4,$5)",
      [j.id, kind, h.title, `来源: ${h.source}`, h.url]
    );
    n++;
  }
  // 记录同步时间与状态
  await pool.query("update cjournal_journals set updated_at = now(), last_sync_status = $2 where id = $1", [j.id, status]);
  return n;
}

/** 同步全部期刊（带单例锁） */
export async function syncAllJournals(): Promise<{ ok: boolean; synced: number; total: number; errors: string[]; tookMs: number; statusCounts: Record<string, number> }> {
  if (syncing) return { ok: false, synced: 0, total: 0, errors: ["已在同步中(单例锁)"], tookMs: 0, statusCounts: {} };
  syncing = true;
  weixinBlocked = false;  // 每轮重置限流标记(限流解除后下轮自动恢复微信)
  const t0 = Date.now();
  const errors: string[] = [];
  let synced = 0;
  const statusCounts: Record<string, number> = { ok: 0, degraded: 0, fail: 0 };
  try {
    const r = await pool.query("select id, name, official_site, topic_tags from cjournal_journals order by id");
    const journals = r.rows;
    // 并发 5 个, 逐个容错
    for (let i = 0; i < journals.length; i += 5) {
      const batch = journals.slice(i, i + 5);
      const results = await Promise.all(batch.map((j) => syncJournal(j).catch((e) => { errors.push(`${j.name}: ${String(e?.message || e).slice(0, 60)}`); return 0; })));
      synced += results.reduce((a, b) => a + b, 0);
    }
    // 统计状态
    const st = await pool.query("select last_sync_status, count(*) from cjournal_journals group by last_sync_status");
    for (const row of st.rows) {
      if (row.last_sync_status) statusCounts[row.last_sync_status] = Number(row.count);
    }
    lastSyncAt = Date.now();
  } catch (e: any) {
    errors.push(`整体失败: ${String(e?.message || e).slice(0, 80)}`);
  } finally {
    syncing = false;
  }
  return { ok: errors.length === 0, synced, total: (await pool.query("select count(*) from cjournal_journals")).rows[0].count, errors, tookMs: Date.now() - t0, statusCounts };
}

/** 查询期刊最新热点（前端用） */
export async function listJournalUpdates(journalId?: string, limit = 50): Promise<any[]> {
  if (journalId) {
    const r = await pool.query(
      "select u.id, u.journal_id, j.name as journal_name, u.kind, u.title, u.content, u.source_url, u.found_at from cjournal_journal_updates u join cjournal_journals j on j.id = u.journal_id where u.journal_id = $1 order by u.found_at desc limit $2",
      [journalId, limit]
    );
    return r.rows;
  }
  const r = await pool.query(
    "select u.id, u.journal_id, j.name as journal_name, u.kind, u.title, u.content, u.source_url, u.found_at from cjournal_journal_updates u join cjournal_journals j on j.id = u.journal_id order by u.found_at desc limit $1",
    [limit]
  );
  return r.rows;
}

/** 自动同步定时器（模块级自启动: 立即跑一次 + 每 6 小时） */
export function startJournalSyncScheduler(): void {
  void syncAllJournals();  // 启动即同步一次
  setInterval(() => { void syncAllJournals(); }, SYNC_INTERVAL_MS);
  console.log("[journal-sync] 期刊同步管道已启动 (每6小时自动同步)");
}

/** 手动触发同步（API 用, 跳过单例锁判断的强制版） */
export async function forceSyncAllJournals(): Promise<any> {
  syncing = false;  // 重置锁允许手动触发
  return syncAllJournals();
}

export const journalSyncService = {
  syncAllJournals,
  forceSyncAllJournals,
  listJournalUpdates,
  startJournalSyncScheduler,
};

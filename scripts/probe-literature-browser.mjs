// scripts/probe-literature-browser.mjs — 中文三大库(知网/万方/维普)浏览器代抓
//
// 这仨**都没有对外检索 API**: 万方检索页是 SPA 空壳(168KB 里搜不到「摘要/作者/参考文献」),
// 维普同理, 知网要登录态。所以唯一可行的是**借用户自己浏览器里的机构登录态**去查。
//
// ⚠ 前置(缺一不可):
//   1. CDP Proxy 在跑(`node ~/.claude/skills/web-access/scripts/check-deps.mjs`);
//   2. 用户已在 Edge 里通过机构统一认证登录了对应站点。**平台不存这三家的密码** ——
//      本探针只是在"用户已经登录"的前提下借身份取数据, 不是代登录。
//
// ⚠ 探针自身的第一条断言是**接线自证**(能开 tab 吗)。2026-09-19 的教训:
//   `newTab` 曾把 URL 用 JSON.stringify 发(代理要裸文本), 导致知网的 searchAndOpen
//   **从 2026-08 起就没成功过**, 而报错看着像"目标站点不稳定"。先自证能省一整轮排查。
//
// 用法: npx tsx scripts/probe-literature-browser.mjs   (需 CDP Proxy + 已登录浏览器)
import { searchInBrowserSource } from "../src/services/literature-browser-service.js";
import { assertLive, evalJs, listTargets, tabInfo } from "../src/services/cdp-browser.js";
import { cnkiCitationProxy } from "../src/services/cnki-citation-proxy.js";

const rows = [];
const rec = (a, k, d, extra) => {
  rows.push([k, a]);
  console.log(`${k === "ok" ? "  ok  " : k === "skip" ? " skip " : " ERR  "} ${a} — ${d}`);
  if (extra) console.log(`        ${extra}`);
};

console.log("═══ ⓪ 接线自证 ═══");
const live = assertLive();
rec("CDP 代理可用(/new 传参格式正确)", live.ok ? "ok" : "err", live.ok ? `targetId=${live.targetId?.slice(0, 8)}…` : String(live.error));
if (!live.ok) {
  console.log("\n❌ 接线就不通, 后面不用跑(先修这层, 别去怀疑目标站点)");
  process.exit(1);
}

const QUERY = "数字经济";
const SOURCES = [
  { id: "wanfang", name: "万方数据", expectFields: ["journal", "issue"] },
  { id: "cqvip", name: "维普期刊", expectFields: ["journal", "issue"] },
  { id: "cnki", name: "中国知网", expectFields: ["url"] }
];

for (const src of SOURCES) {
  console.log(`\n═══ ${src.name} (${src.id}) ═══`);
  const r = await searchInBrowserSource(src.id, QUERY, { maxWaitMs: 30000 });

  if (r.needsLogin) {
    // 未登录**不算失败** —— 这是环境前置, 如实记 skip 而不是 DEAD(本仓的探针纪律)
    rec(`${src.name} 检索`, "skip", `需要先在浏览器里登录${src.name}: ${r.error}`);
    continue;
  }

  rec(`${src.name} 能检索并解析出条目`, r.ok && r.hits.length > 0 ? "ok" : "err",
    `hits=${r.hits.length}${r.total ? ` total=${r.total}` : ""}${r.error ? ` err=${r.error}` : ""}`);

  /**
   * 检索页**必须真的停在这次的查询词上**。
   *
   * ⚠ 这条断言是被 2026-09-19 的排查换来的: `cnki-citation-proxy` 自己的 `navigate()` 把 URL
   *   用 `JSON.stringify` 发出去(代理要裸文本), 于是**导航静默失效** —— 页面停在旧查询的结果上,
   *   而所有调用方都以为"已经搜过了"。表现是"搜什么都返回同一批结果", 极难怀疑到导航。
   *   同一晚我还看到"命中 100 万条"这种**明显不合理**的总数(查询词很偏), 那其实就是这条的旁证。
   *   断言方式: 打开页面的 URL 里应当出现本次查询词的编码形式。
   */
  if (r.tabId) {
    const info = tabInfo(r.tabId);
    const decoded = decodeURIComponent(info?.url ?? "");
    rec(`${src.name} 检索页停在本次查询词上`, decoded.includes(QUERY) ? "ok" : "err",
      decoded.includes(QUERY) ? QUERY : `页面 URL 与查询词不符: ${decoded.slice(0, 70)}`);
  }

  if (!r.hits.length) continue;

  const h = r.hits[0];
  /**
   * 错位检查: **有没有哪条的标题恰好等于另一条的摘要**。
   *
   * ⚠ 我第一版用的是"标题重复率 < 50%", 那条**是错的** —— 搜「数字经济」本来就会命中
   *   多篇**同名**文章(万方前 5 条都叫「数字经济」, 分属不同期号), 重复是真实的检索结果,
   *   不是解析错位。按重复率判会把正常结果判成失败。
   *   真正要抓的是维普踩过的那类错位: **第 N 条的标题显示成了第 N-1 条的摘要**。
   */
  const abstracts = new Set(r.hits.map((x) => (x.abstract ?? "").trim()).filter(Boolean));
  const misaligned = r.hits.filter((x) => x.title.trim() && abstracts.has(x.title.trim()) && x.title.trim() !== (x.abstract ?? "").trim());
  rec("没有「这条的标题是别人的摘要」的错位", misaligned.length === 0 ? "ok" : "err",
    misaligned.length
      ? `错位 ${misaligned.length} 条, 例: "${misaligned[0].title.slice(0, 30)}"`
      : `前三条=${JSON.stringify(r.hits.slice(0, 3).map((x) => x.title.slice(0, 18)))}`);

  // 首条不该是"摘要" —— 摘要通常 100+ 字且以句号/逗号结尾, 标题一般短
  rec("首条标题长度合理(<80字)", h.title.length > 0 && h.title.length < 80 ? "ok" : "err",
    `长度=${h.title.length} 内容="${h.title.slice(0, 40)}"`);

  for (const f of src.expectFields) {
    const v = h[f];
    rec(`首条取到 ${f}`, v ? "ok" : "err", `${f}="${String(v ?? "").slice(0, 46)}"`);
  }
  console.log(`        示例: ${JSON.stringify({ title: h.title.slice(0, 30), journal: h.journal, issue: h.issue, type: h.type })}`);
}

console.log("\n═══ 知网引文网络(独立一段: 需要一篇**已打开的详情页**) ═══");
/**
 * ⚠ 这段的存在理由是 2026-09-19 的一轮真金白银的失败:
 *
 *   我连续四轮报"知网引文抓不到数据 / 结构已变 / 功能不可用", **四次全是错的**。
 *   真因是**我测在了别的页面上**(报纸文章没有引文网络、被验证码挡的页、量错了容器 `rc1~rc6`
 *   而不是 `#refpartdiv`)。而真正的链路一直是通的。
 *
 *   所以这里不测"函数返回什么", 而是测**完整证据链**:
 *     找到 kcms2 详情页 tab → 6 个引文 tab 在不在 → 「参考文献」能不能取到条目 → 分页计数在不在。
 *   任一环断了都要能一眼看出断在哪, 而不是笼统地说"知网坏了"。
 *
 *   没有详情页 tab 时记 **skip**(环境前置), 不算失败 —— 与上面三家一致。
 *
 *   ⚠ **顺序敏感**: 本脚本上面的"知网检索"会把**知网那个 tab** 导航成检索结果页 ——
 *     若是直接从详情页切过去, 详情页就没了(实测: 连跑两次, 第二次必 skip)。
 *     所以要么**先另开一个知网 tab**, 要么接受"每轮最多验一次引文"。
 */
const detailTabs = listTargets().filter((t) => /kcms2\/article/.test(t.url));
if (!detailTabs.length) {
  rec("知网引文网络", "skip", "浏览器里没有知网详情页(kcms2/article)tab —— 先用「外部检索」搜一篇并打开详情页再跑");
} else {
  /**
   * 遍历**所有**已开的详情页, 取第一个"真的有引文网络"的。
   *
   * ⚠ 为什么要遍历: 实测知网检索「数字经济」排第一的是**《工人日报》的报纸文章** ——
   *   报纸**没有** `#refpartdiv`, 只测第一篇就会一直 skip 或误报。而有引文网络的期刊论文
   *   常常就在同一次检索里开了好几篇。逐个试比"猜哪篇是期刊"可靠。
   */
  let picked = null;
  const tried = [];
  for (const t of detailTabs) {
    const n = Number(evalJs(t.targetId, `document.querySelectorAll("#refpartdiv li").length`) || "0");
    tried.push(`${(t.title || "").slice(0, 18)}=${n}`);
    if (n >= 6) { picked = { tab: t, lis: n }; break; }
  }

  if (!picked) {
    // 报纸/资讯类本来就没有引文网络 → 环境前置, 如实 skip 而不是 DEAD(本仓的探针纪律)
    rec("知网引文网络", "skip",
      `已开的 ${detailTabs.length} 篇详情页都没有引文区(报纸/资讯类常见) —— 换一篇期刊论文再跑 | ${tried.join(" ")}`);
  } else {
    rec("找到带引文网络的详情页", "ok", `${(picked.tab.title || "").slice(0, 34)} (li=${picked.lis})`);

    /**
     * 断言的是**机制**, 不是"某篇一定有引文"。
     *
     * ⚠ 我第一版写的是"「参考文献」必须取到条目" —— 那条**会误报**: 实测
     *   《国际科技反垄断制度新动向及其对我国的借鉴》在知网上**本身就是 0 条参考文献**
     *   (`li=6` 结构在、数据就是空), 于是机制完全正常却被判 err。
     *   一篇论文有没有引文是**数据**, 不是**功能**; 门禁不该拿数据当断言。
     *
     * 真正要锁的是两件事:
     *   a) 调用返回 ok(没有把正常结果报成错);
     *   b) 为空时给的是**说明**(「…为 0 条…属正常结果」), 而不是把我们自己诊断不清的
     *      "结构已变更 / 功能不可用"甩给用户 —— 后者正是 2026-09-19 我把注释写反的原因。
     */
    const r = await cnkiCitationProxy.fetch("references", picked.tab.targetId);
    const hasItems = r.ok && r.items.length > 0;
    rec("「参考文献」调用可用(取到条目, 或为 0 但如实说明)",
      r.ok ? "ok" : "err",
      hasItems
        ? `items=${r.items.length} total=${r.total ?? "-"}`
        : `items=0 说明="${(r.error ?? "").slice(0, 46)}"`);
    if (hasItems) console.log(`        示例: ${r.items[0].raw.slice(0, 70)}`);

    // 为 0 时**不许**把责任推给"结构变了/功能不可用" —— 那是未经验证的甩锅(实测结构一直在)
    const empty = await cnkiCitationProxy.fetch("secondcitations", picked.tab.targetId);
    const blamesStructure = /结构.*(变|改)|不可用|抓取失败/.test(empty.error ?? "");
    rec("空引文如实说明, 不甩锅给「结构已变更」",
      empty.ok && empty.items.length === 0 && !blamesStructure ? "ok" : "err",
      `items=${empty.items.length} 文案="${(empty.error ?? "").slice(0, 50)}"`);
  }
}

console.log("\n════════ 汇总 ════════");
for (const [k, a] of rows) console.log(`${k.padEnd(6)} ${a}`);
const bad = rows.filter(([k]) => k === "err");
const skipped = rows.filter(([k]) => k === "skip");
console.log(
  bad.length
    ? `\n❌ ${bad.length} 项异常`
    : `\n✅ ${rows.length - skipped.length} 项通过${skipped.length ? ` · ${skipped.length} 项 skip(未登录, 不算失败)` : ""}`
);
if (bad.length) process.exitCode = 1;

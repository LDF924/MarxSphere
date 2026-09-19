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
import { assertLive } from "../src/services/cdp-browser.js";

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

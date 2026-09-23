// pb-report-verify.mjs — P-B 审稿报告 UI 验证: 往期审稿 → 打开一条 → 断言报告结构
//
// 验什么: ①「往期审稿」列表能渲染出记录卡; ②点一条能打开报告;
//   ③报告页渲染出综合评分块 / 评级徽标 / 维度评分 / 速览指标 / 原文对照入口。
//
// 2026-09-14 重写。三处过时(全是"断言与实际实现不符", 脚本一直红着没人管):
//   ① 卡片选择器 `div[class*=cursor]` —— 实际类名是 `.history-item`(ReviewView.vue:1421),
//      页面里 cursor 类名的 div 数为 0, 所以恒返回 NO-CARD。
//   ② 在**顶层 document** 里找 —— 真界面是 Vue 版、渲染在 /soc/ iframe 里。
//   ③ 断言的文案串(总分/核心问题/7 个维度审查/权重 4)在代码里**根本不存在**;
//      实际是「综合评分」+ 评级徽标 + 「评审维度」等速览指标。断言已按真实结构重写。
//
// 用法: node scripts/pb-report-verify.mjs  (前置: 4173 已起; admin 账号存在; 至少有 1 条历史审稿)
import { startCdp, loginToken, findSocFrame, evalInFrame, verdict, sleep } from "./lib/cdp-editor.mjs";

const BASE = "http://127.0.0.1:4173";

async function main() {
  const { ev, cdp, close } = await startCdp({ preferredPort: 31005, label: "scripts/pb-report-verify.mjs", tmpPrefix: "edge-cdp-pb" });
  try {
    const token = await loginToken();
    if (!token) { console.error("ERR 登录失败(默认账号 verify/verify123456)"); process.exit(1); }

    // 先落在同源页面上把 token 写进 localStorage, 再直达审稿页(它会带出往期记录)
    await cdp("Page.navigate", { url: `${BASE}/` });
    await sleep(3000);
    await ev(`localStorage.setItem('sag_token', ${JSON.stringify(token)}); true;`);
    await cdp("Page.navigate", { url: `${BASE}/#review-lab` });
    await sleep(10000);

    const frameId = await findSocFrame(cdp);
    if (!frameId) { console.error("ERR 审稿 iframe 未挂载(/soc/)"); process.exit(1); }

    // ① 往期列表有卡片 → 点第一条
    const opened = await evalInFrame(cdp, frameId, `(async () => {
      const items = Array.from(document.querySelectorAll('.history-item'));
      if (!items.length) return { err: 'no-history-item', hint: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 150) };
      const first = items[0];
      const title = (first.querySelector('.h-title')?.textContent || '').trim();
      first.click();
      await new Promise(r => setTimeout(r, 5000));
      return { itemCount: items.length, title };
    })()`);
    if (opened?.err) {
      console.error(`ERR ${opened.err} — ${opened.hint ?? ""}`);
      console.error("  (前置: 该账号至少要有一条历史审稿记录; 没有就先跑一次审稿)");
      process.exit(1);
    }

    // ② 报告结构断言(按真实类名, 不赌文案)
    const st = await evalInFrame(cdp, frameId, `(() => {
      const txt = (document.body.innerText || '');
      const dims = Array.from(document.querySelectorAll('.dim-score'));
      const metrics = Array.from(document.querySelectorAll('.ov-metric'));
      return {
        historyCount: document.querySelectorAll('.history-item').length,
        hasScoreBlock: !!document.querySelector('.score-block'),
        bigScore: (document.querySelector('.big-score')?.textContent || '').trim(),
        grade: (document.querySelector('.grade-badge')?.textContent || '').trim(),
        hasScoreLabel: txt.includes('综合评分'),
        dimCount: dims.length,
        dimScores: dims.slice(0, 8).map(d => (d.textContent||'').trim()),
        metricCount: metrics.length,
        metricLabels: metrics.map(m => (m.textContent||'').replace(/\\s+/g,' ').trim().slice(0, 18)),
        hasDetailBtn: Array.from(document.querySelectorAll('button')).some(b => (b.textContent||'').includes('原文对照')),
      };
    })()`);

    const score = st?.bigScore ?? "";
    const grade = st?.grade ?? "";
    const results = [
      { name: "往期审稿列表有记录卡", pass: (opened?.itemCount ?? 0) > 0, detail: `共 ${opened?.itemCount} 条, 打开「${opened?.title}」` },
      { name: "报告页出现综合评分块", pass: st?.hasScoreBlock === true && st?.hasScoreLabel === true, detail: `评分=${score} 标签含"综合评分"=${st?.hasScoreLabel}` },
      { name: "评级徽标非空", pass: !!grade && grade !== "—", detail: `评级=${grade}` },
      { name: "维度评分已渲染", pass: (st?.dimCount ?? 0) > 0, detail: `${st?.dimCount} 个维度: ${(st?.dimScores ?? []).join(" ")}` },
      { name: "速览指标已渲染", pass: (st?.metricCount ?? 0) >= 3, detail: (st?.metricLabels ?? []).join(" | ") },
      { name: "有「原文对照与批注」入口", pass: st?.hasDetailBtn === true, detail: "" },
    ];
    process.exit(verdict(results) ? 0 : 1);
  } finally { close(); }
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });

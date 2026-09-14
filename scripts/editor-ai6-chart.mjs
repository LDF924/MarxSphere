// editor-ai6-chart.mjs — 编辑器「图表」页签的结构验证
//
// 验什么: 「图表」页签渲染出图表生成表单 —— 数据来源选择器(5 种来源)、图表类型下拉
//   (5 种图)、需求描述框、生成按钮; 且类型下拉真能选中。
//
// 2026-09-14 重写。两处过时:
//   ① 原版在顶层 document 用 __reactProps 找 React 编辑器 —— 真编辑器是 Vue 版、在 /soc/
//      iframe 里, 原版**永远不可能通过**。
//   ② 原版按"5 个按钮"去点图表类型, 但现在的实现是 `<select>` 下拉(AIPanel.vue:695);
//      它断言的「散点图」也从来不在 CHART_TYPES 里。
//   断言从"按钮文案"改成"表单结构 + 可选中", 结构比具体控件类型稳。
//
// 用法: node scripts/editor-ai6-chart.mjs  (前置: 4173 已起, admin 账号存在)
import { startCdp, loginToken, openEditorWithAiPanel, evalInFrame, verdict } from "./lib/cdp-editor.mjs";

async function main() {
  const { ev, cdp, close } = await startCdp({ preferredPort: 31002, label: "scripts/editor-ai6-chart.mjs", tmpPrefix: "edge-cdp-chart" });
  try {
    const token = await loginToken();
    if (!token) { console.error("ERR 登录失败(admin/admin123)"); process.exit(1); }
    const frameId = await openEditorWithAiPanel(ev, cdp, token);
    if (!frameId) { console.error("ERR 编辑器 iframe 未挂载(/soc/)"); process.exit(1); }

    const state = await evalInFrame(cdp, frameId, `(async () => {
      const tab = Array.from(document.querySelectorAll('.ade-ai-panel__tab')).find(b => (b.textContent||'').trim() === '图表');
      if (!tab) return { err: 'no-chart-tab' };
      tab.click();
      await new Promise(r => setTimeout(r, 900));
      const body = document.querySelector('.ade-ai-panel__body');
      if (!body) return { err: 'no-body' };
      const selects = Array.from(body.querySelectorAll('select'));
      // 图表类型下拉: 选项里含"柱状图"
      const typeSel = selects.find(s => Array.from(s.options).some(o => /柱状图/.test(o.textContent||'')));
      const srcSel = selects.find(s => Array.from(s.options).some(o => /数据来源|统一分析台数据|无数据/.test(o.textContent||''))) || selects.find(s => s !== typeSel);
      const typeOpts = typeSel ? Array.from(typeSel.options).map(o => (o.textContent||'').trim()) : [];
      // 真选一次: 切到第二项再切回, 确认值能变
      let switched = false, before = "", after = "";
      if (typeSel && typeSel.options.length > 1) {
        before = typeSel.value;
        typeSel.value = typeSel.options[1].value;
        typeSel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 400));
        after = typeSel.value;
        switched = after === typeSel.options[1].value && after !== before;
      }
      const ta = Array.from(body.querySelectorAll('textarea'));
      const genBtn = Array.from(body.querySelectorAll('button')).find(b => /生成图表/.test(b.textContent||''));
      return {
        activeTab: tab.classList.contains('ade-ai-panel__tab--active'),
        srcOpts: srcSel ? Array.from(srcSel.options).map(o => (o.textContent||'').trim()) : [],
        typeOpts, switched, before, after,
        hasDesc: ta.length > 0,
        hasGenBtn: !!genBtn,
      };
    })()`);

    if (state?.err) { console.error("ERR", state.err); process.exit(1); }
    const typeOpts = state?.typeOpts ?? [];
    const wantTypes = ["流程图", "思维导图", "柱状图", "折线图", "饼图"];
    const hit = wantTypes.filter((t) => typeOpts.some((o) => o.includes(t)));
    const results = [
      { name: "「图表」页签可切", pass: state?.activeTab === true, detail: "" },
      { name: "数据来源选择器(≥4 种来源)", pass: (state?.srcOpts ?? []).length >= 4, detail: (state?.srcOpts ?? []).join(" | ") },
      { name: "5 种图表类型齐全", pass: hit.length === 5, detail: `命中 ${hit.length}/5 — ${typeOpts.join("/")}` },
      { name: "类型下拉可切换", pass: state?.switched === true, detail: `${state?.before} → ${state?.after}` },
      { name: "有需求描述框", pass: state?.hasDesc === true, detail: "" },
      { name: "有生成按钮", pass: state?.hasGenBtn === true, detail: "" },
    ];
    process.exit(verdict(results) ? 0 : 1);
  } finally { close(); }
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });

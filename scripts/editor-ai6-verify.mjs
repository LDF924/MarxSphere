// editor-ai6-verify.mjs — AI 编辑助手页签对齐验证
//
// 验什么: 编辑器「辅助工具」面板的 6 个页签存在、顺序与闭源一致, 且能真实切换。
//
// 2026-09-14 重写。原版在**顶层 document** 找 React 组件、用 `__reactProps` 触发点击 ——
//   但真编辑器是 Vue 版(web/socialsci-vue/src/views/editor/), 渲染在 /soc/ 的 iframe 里。
//   顶层既没有那些节点也没有 __reactProps, 该脚本**永远不可能通过**, 一直红着也没人发现。
//   现在统一走 scripts/lib/cdp-editor.mjs 的 iframe 路径 + 真实 DOM 点击。
//
// 用法: node scripts/editor-ai6-verify.mjs  (前置: 4173 已起, admin 账号存在)
import { startCdp, loginToken, openEditorWithAiPanel, evalInFrame, verdict } from "./lib/cdp-editor.mjs";

const EXPECTED = ["全文检查", "选区修改", "题名摘要", "引用格式", "格式模板", "图表"];

async function main() {
  const { ev, cdp, close } = await startCdp({ preferredPort: 31003, label: "scripts/editor-ai6-verify.mjs", tmpPrefix: "edge-cdp-ai6" });
  try {
    const token = await loginToken();
    if (!token) { console.error("ERR 登录失败(admin/admin123) —— 无法验证"); process.exit(1); }
    const frameId = await openEditorWithAiPanel(ev, cdp, token);
    if (!frameId) { console.error("ERR 编辑器 iframe 未挂载(/soc/)"); process.exit(1); }

    const state = await evalInFrame(cdp, frameId, `(() => {
      const tabs = Array.from(document.querySelectorAll('.ade-ai-panel__tab'));
      return {
        labels: tabs.map(b => (b.textContent||'').trim()),
        panelOpen: !!document.querySelector('.ade-ai-panel'),
      };
    })()`);

    const labels = state?.labels ?? [];
    const results = [];
    results.push({ name: "AI 面板已展开", pass: state?.panelOpen === true, detail: state?.panelOpen ? "" : "未找到 .ade-ai-panel" });
    results.push({ name: `6 个页签齐全`, pass: labels.length === 6, detail: `实际 ${labels.length} 个: ${labels.join("/")}` });
    results.push({
      name: "页签顺序与闭源一致",
      pass: JSON.stringify(labels) === JSON.stringify(EXPECTED),
      detail: labels.join(" → "),
    });

    // 真点一遍每个页签, 确认能切且面板有内容(不是空壳)
    const switched = await evalInFrame(cdp, frameId, `(async () => {
      const tabs = Array.from(document.querySelectorAll('.ade-ai-panel__tab'));
      const seen = [];
      for (const t of tabs) {
        t.click();
        await new Promise(r => setTimeout(r, 700));
        const body = document.querySelector('.ade-ai-panel__body');
        seen.push({ label: (t.textContent||'').trim(), active: t.classList.contains('ade-ai-panel__tab--active'), bodyLen: (body?.innerText||'').length });
      }
      return seen;
    })()`);
    const arr = Array.isArray(switched) ? switched : [];
    results.push({
      name: "每个页签可切换且有内容",
      pass: arr.length === 6 && arr.every((s) => s.active && s.bodyLen > 10),
      detail: arr.map((s) => `${s.label}:${s.active ? "✓" : "✗"}/${s.bodyLen}字`).join(" "),
    });

    process.exit(verdict(results) ? 0 : 1);
  } finally { close(); }
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });

// editor-check-verify.mjs — 编辑器「全文检查」页签的动作卡验证
//
// 验什么: 「全文检查」页签渲染出 4 个检查动作(全文逻辑/章节衔接/变量-方法-结论/投稿前),
//   且这些动作卡的可点性一致(要么因为已开文档全可点, 要么全禁用)。
//
// 2026-09-14 重写 —— 原版在顶层 document 找 React 组件(__reactProps 触发点击),
//   而真编辑器是 Vue 版、渲染在 /soc/ iframe 里, 原版**永远不可能通过**。
//   断言也从"某句提示语"改成"动作卡的结构与可点性": 文案随版本变, 结构不会。
//
// 用法: node scripts/editor-check-verify.mjs  (前置: 4173 已起, admin 账号存在)
import { startCdp, loginToken, openEditorWithAiPanel, evalInFrame, verdict } from "./lib/cdp-editor.mjs";

const CHECK_TITLES = ["全文逻辑检查", "章节衔接检查", "变量-方法-结论", "投稿前检查"];

async function main() {
  const { ev, cdp, close } = await startCdp({ preferredPort: 31004, label: "scripts/editor-check-verify.mjs", tmpPrefix: "edge-cdp-ec" });
  try {
    const token = await loginToken();
    if (!token) { console.error("ERR 登录失败(admin/admin123)"); process.exit(1); }
    const frameId = await openEditorWithAiPanel(ev, cdp, token);
    if (!frameId) { console.error("ERR 编辑器 iframe 未挂载(/soc/)"); process.exit(1); }

    const state = await evalInFrame(cdp, frameId, `(async () => {
      const tab = Array.from(document.querySelectorAll('.ade-ai-panel__tab')).find(b => (b.textContent||'').includes('全文检查'));
      if (!tab) return { err: 'no-check-tab' };
      tab.click();
      await new Promise(r => setTimeout(r, 900));
      const cards = Array.from(document.querySelectorAll('.ade-task-card'));
      return {
        activeTab: tab.classList.contains('ade-ai-panel__tab--active'),
        titles: cards.map(c => (c.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30)),
        enabled: cards.map(c => !c.disabled),
      };
    })()`);

    if (state?.err) { console.error("ERR", state.err); process.exit(1); }
    const titles = state?.titles ?? [];
    const hit = CHECK_TITLES.filter((t) => titles.some((x) => x.includes(t)));
    const en = state?.enabled ?? [];
    const results = [
      { name: "「全文检查」页签可切", pass: state?.activeTab === true, detail: "" },
      { name: "4 个检查动作卡齐全", pass: hit.length === 4, detail: `命中 ${hit.length}/4 — ${hit.join(" | ")}` },
      {
        name: "动作可点性一致(结构正确)",
        pass: en.length > 0 && (en.every(Boolean) || en.every((x) => !x)),
        detail: `共 ${en.length} 张卡: ${en.filter(Boolean).length} 可点 / ${en.filter((x) => !x).length} 禁用`,
      },
    ];
    process.exit(verdict(results) ? 0 : 1);
  } finally { close(); }
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });

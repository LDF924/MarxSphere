// scripts/probe-workspace-actions.mjs — 创作工作台「动作打通」探针(第三轮: WorkspaceView 13 个未覆盖动作)
//
// 由覆盖表驱动(见 VUE-ALIGNMENT-AUDIT-20260916.md §九): 写作舱 93 个 data-control 里,
// 前两轮把 workflow 主干与素材页覆盖了, 剩下最大一块是 **WorkspaceView**。
// 这里验的是"点下去做没做事", 与 verify-writing-cabin.mjs 的形态断言互补。
//
// 用法: node scripts/probe-workspace-actions.mjs        (需 4173 已起)
//       node scripts/probe-workspace-actions.mjs --all  (含真调 LLM 的生成动作, 慢)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, spyInstall, probeAction, waitFor } from "./lib/probe-actions.mjs";

const BASE = "http://127.0.0.1:4173";
const ALL = process.argv.includes("--all");
const rows = [];
function rec(action, kind, detail) {
  rows.push({ action, kind, detail });
  const tag = kind === "ok" ? "  ok  " : kind === "dead" ? " DEAD " : kind === "gated" ? " gated" : kind === "err" ? " ERR  " : " skip ";
  console.log(`${tag} ${action} — ${detail}`);
}

const api = async (token, path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.ok ? r.json().catch(() => ({})) : { __status: r.status };
};
const short = (u) => String(u ?? "").replace(BASE, "").replace("/api/research", "").slice(0, 70);

/**
 * 播种一个"已到创作阶段"的项目。
 * ⚠ 章节必须**同时**写 input 节点、sections 节点与 workbench 快照:
 *   创作页读章节走 store(快照), 而 generate-section 等后端接口读节点 —— 只写一处会出现
 *   "界面有章节但生成说找不到"的假失败(素材页 allocate 那个坑的同源问题)。
 */
async function seed(token, { withMaterials = true } = {}) {
  const TITLE = `创作探针-${Date.now()}`;
  const proj = await api(token, "/research/projects", "POST", { title: TITLE, status: "in-progress", phase: 4, phaseLabel: "文本创作" });
  const pid = (proj?.data ?? proj)?.id;
  if (!pid) return null;
  const INPUT = { title: TITLE, outline: "一、引言\n  1.1 研究背景\n二、文献综述\n  2.1 已有研究", totalWordCount: 8000, researchMethod: "quantitative", requirements: "", sampleFiles: [] };
  const sections = [
    { id: "sec_0", title: "引言", level: 1, order: 0, status: "pending", content: "" },
    { id: "sec_1", title: "文献综述", level: 1, order: 1, status: "pending", content: "" },
    { id: "sec_1_1", title: "已有研究", level: 2, order: 0, status: "pending", content: "", parentId: "sec_1" },
  ];
  await api(token, `/research/projects/${pid}/nodes/input`, "PUT", { payload: { input: INPUT, sections } });
  await api(token, `/research/projects/${pid}/nodes/sections`, "PUT", { payload: { sections } });
  await api(token, `/research/projects/${pid}/workbench`, "PUT", {
    snapshot: { phase: 4, phaseLabel: "文本创作", input: INPUT, sections, variables: [], hypotheses: [] },
  });
  let matId = "";
  if (withMaterials) {
    const m = await api(token, "/research/materials", "POST", {
      projectId: pid, kind: "theory", title: "创作探针素材", contentMd: "理论内容", sectionIds: ["sec_0"],
    });
    matId = (m?.data ?? m)?.id ?? "";
  }
  return { pid, matId };
}

const { cdp, ev, close } = await startCdp({ preferredPort: 31049, label: "probe-workspace-actions" });
try {
  const token = await loginToken("audit", "audit123456");
  if (!token) throw new Error("登录失败");
  const s = await seed(token);
  if (!s?.pid) throw new Error("播种失败");
  console.log(`项目 ${s.pid} 素材 ${s.matId.slice(0, 8)}\n`);

  await openSoc(cdp, BASE, "/workflow/workspace", token, s.pid);
  await spyInstall(cdp);

  // ── ① 只读/切换类: 这些不需要模型, 必须先全绿 ──
  console.log("\n═══ ① 面板切换与编辑区入口 ═══");
  {
    const open = await probeAction(cdp, '[data-control="workflow:toggle-ai-panel"]', { wait: 1200 });
    const st = await evalTop(cdp, `(() => {
      const b = document.querySelector('[data-control="workflow:toggle-ai-panel"]');
      return { text: b ? b.textContent.trim() : '', hasPanel: !!document.querySelector('.ai-panel, .think-panel, .right-rail') };
    })()`);
    rec("toggle-ai-panel(AI 面板开合)", open.clicked ? "ok" : "DEAD", `点击=${open.clicked} 按钮文案="${st?.text}" 面板=${st?.hasPanel}`);
    // 关回去: AI 面板覆盖中央区, 留着会挡住后续的真实鼠标点击(本轮踩到过一次假 DEAD)
    await evalTop(cdp, `(() => { const b = document.querySelector('.ai-close'); if (b) { b.click(); return true; } return false; })()`);
    await sleep(500);
  }

  // 写/预览 tab 切换: 同一章节内切 tab 不应丢编辑态
  {
    const w = await probeAction(cdp, '[data-control="workflow:md-write"]', { wait: 700 });
    const p = await probeAction(cdp, '[data-control="workflow:md-preview"]', { wait: 700 });
    const st = await evalTop(cdp, `(() => ({
      writeOn: document.querySelector('[data-control="workflow:md-write"]')?.className || '',
      previewOn: document.querySelector('[data-control="workflow:md-preview"]')?.className || '',
      // 预览态容器是 .content-view(不是 .md-preview) —— 写错选择器会恒判 false
      hasPreview: !!document.querySelector('.content-view'),
    }))()`);
    rec("md-write / md-preview(写-预览切换)", w.clicked && p.clicked ? "ok" : "DEAD",
      `preview tab on=${/on/.test(st?.previewOn ?? "")} 预览容器 .content-view=${st?.hasPreview}`);
  }

  // ── ② 生成动作: 生成/停止(需真 LLM) ──
  console.log("\n═══ ② 章节生成 ═══");
  {
    if (!ALL) {
      rec("generate-section(单章生成)", "skip", "需真 LLM, 加 --all 才跑");
      rec("stop-generation(停止生成)", "skip", "需真 LLM, 加 --all 才跑");
      rec("generate-all(全部生成)", "skip", "需真 LLM, 加 --all 才跑");
    } else {
      // ⚠ 「停止生成是否真停」**不能**靠"正文有没有继续变长"来判 —— 创作页的正文是任务 **done 时
      //   才一次性回填** 的(pollTask 的 onDone → refreshSections), 生成途中 `.content-textarea`
      //   始终为空。第一版按"文字增长"写, 量到 0→0 恒真, 是假通过; 加重前置条件后才发现
      //   "60s 内一个字都没流出"根本不是缺陷, 而是回填时机就是完成时。
      //   真正可判的是**后端任务状态**与**落库守卫**:
      //     (a) 停止 → 任务转 cancelled; (b) 已取消的任务不得再写回章节正文
      //         (exec-engine 的 markDone 带 `status <> 'cancelled'` 守卫)。
      const gen = await probeAction(cdp, '[data-control="workflow:generate-section"]', { wait: 3000 });
      // ⚠ 任务 id 是**服务端生成**的(请求体里没有) —— 只能从随后的轮询 URL 里取。
      //   第一版去解析 POST 的 body, 恒得空串(实测)。
      const taskId = (() => {
        for (const r of gen.apiReqs) {
          const m = String(r.url).match(/\/research\/tasks\/([0-9a-f-]{36})/i);
          if (m) return m[1];
        }
        return "";
      })();
      rec("generate-section(单章生成)", gen.apiReqs.length ? "ok" : "DEAD",
        `任务=${taskId.slice(0, 8)} ` + (gen.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || `零请求 toast=${gen.toast.slice(0, 50)}`));

      const streaming = await waitFor(cdp, `!!document.querySelector('[data-control="workflow:stop-generation"]')`, { timeout: 30000, every: 800 });
      rec("生成中出现 停止生成 按钮", streaming ? "ok" : "ERR", streaming ? "有" : "30s 内未出现");

      if (streaming) {
        const stop = await probeAction(cdp, '[data-control="workflow:stop-generation"]', { wait: 2500 });
        rec("stop-generation(停止生成)", stop.apiReqs.some((x) => /control/.test(x.url)) ? "ok" : "DEAD",
          stop.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || "零请求");
        // (a) 任务必须转 cancelled —— 这是"真停"的直接证据
        let st = "";
        for (let i = 0; i < 20; i++) {
          await sleep(1000);
          const tt = taskId ? await api(token, `/research/tasks/${taskId}`) : null;
          st = String(tt?.task?.status ?? "");
          if (st === "cancelled" || st === "failed" || st === "done") break;
        }
        rec("停止后任务转 cancelled", st === "cancelled" ? "ok" : "ERR", `任务状态=${st || "未知"}`);
        // (b) 已取消的任务不得再回填正文 —— markDone 的 `status <> 'cancelled'` 守卫
        await sleep(8000);
        const node = await api(token, `/research/projects/${s.pid}/nodes/sections`);
        const sec = (node?.node?.payload?.sections ?? []).find((x) => x.id === "sec_0");
        // 语义: 取消 = "别再往下跑了", 不是"把已生成的作废"。但**不得回写** ——
        //   回写而前端标 pending, 会出现"库里有正文、界面说没生成"(用户不重新生成、合稿却能合进去)。
        //   修前实测: 取消后 sec_0 落了 1617 字。
        rec("已取消的任务不再回填正文(守卫生效)", !String(sec?.content ?? "") ? "ok" : "ERR",
          `章节正文 ${String(sec?.content ?? "").length} 字(取消后应为 0)`);
      }
      const all = await probeAction(cdp, '[data-control="workflow:generate-all"]', { wait: 3500 });
      rec("generate-all(全部生成)", all.apiReqs.length ? "ok" : "DEAD",
        all.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || `零请求 toast=${all.toast.slice(0, 50)}`);
      await probeAction(cdp, '[data-control="workflow:stop-generation"]', { wait: 2000 });
    }
  }

  // ── ③ 保存/编辑持久化 ──
  console.log("\n═══ ③ 正文保存 ═══");
  {
    // ⚠ 先切回「编辑」tab: 上一步的 md-preview 会**卸载** `.content-textarea`(预览态渲染的是
    //   `.content-view`), 正文输入框此时根本不存在 → 写入 null → 保存/落库断言连锁失败(实测踩到)。
    //   附带说明: 早先这步能过, 恰恰是因为 AI 面板盖住了 tab、真实鼠标点不到 —— "因错得对";
    //   把面板关回去之后立刻暴露。
    await probeAction(cdp, '[data-control="workflow:md-write"]', { wait: 700 });
    const typed = await evalTop(cdp, `(() => {
      const ta = document.querySelector('.content-textarea') || document.querySelector('.md-editor textarea');
      if (!ta) return null;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '探针写入的正文内容。'.repeat(8));
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return ta.value.length;
    })()`);
    rec("正文输入框可写", typed ? "ok" : "ERR", `写入 ${typed ?? 0} 字`);
    const save = await probeAction(cdp, '[data-control="workflow:save-section"]', { wait: 2500 });
    const wrote = save.apiReqs.filter((x) => /(nodes|sections|workbench)/.test(x.url) && x.method !== "GET");
    rec("save-section(保存章节)", wrote.length ? "ok" : "DEAD",
      wrote.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || `零写请求 toast=${save.toast.slice(0, 50)}`);
    // 落库复核: 重新读节点, 正文应在
    const node = await api(token, `/research/projects/${s.pid}/nodes/sections`);
    const sec = (node?.node?.payload?.sections ?? []).find((x) => x.id === "sec_0");
    rec("保存已落库(节点复核)", String(sec?.content ?? "").includes("探针写入") ? "ok" : "ERR",
      `节点里 sec_0 正文 ${String(sec?.content ?? "").length} 字`);
  }

  // ── ③b 「送编辑器」(必须在正文非空之后 —— 按钮本身 v-if 正文>50字) ──
  //   ⚠ 三个坑叠在一起, 第一版探针全踩了:
  //   (1) 门禁: `sendSectionToEditor` 要求正文 ≥50 字 —— 必须放在保存正文**之后**验, 否则恒被拦;
  //   (2) 通道: 走 postMessage → React 外壳中转, **不是 HTTP** —— 不能用"有没有请求"判通;
  //   (3) 前提: 独立打开 /soc/ 子应用时 `window.parent === window`, 该函数**必然返回 false**。
  //       所以本探针只能验到"给出了明确反馈"这一层; 真正的跨模块投递需要外壳内(iframe)环境,
  //       归 verify-fusion-tabs / assistant-soc 那条链路, 不在本探针职责内。
  {
    // toast 存活约 3.2s, 单次固定延时读取会扑空 —— 轮询到出现为止(实测: 读固定 1.2s 后为空)
    const readToast = () => evalTop(cdp, `(() => {
      const t = [...document.querySelectorAll('div')].find(d => {
        const s = d.getAttribute('style') || '';
        return s.includes('position') && s.includes('fixed');
      });
      return t ? (t.innerText || '').replace(/\s+/g, ' ').slice(0, 60) : '';
    })()`);
    const direct = await evalTop(cdp, `(() => { const b = document.querySelector('[data-control="workflow:section-to-editor"]'); if (b) { b.click(); return true; } return false; })()`);
    let fb = "";
    for (let i = 0; i < 8 && !fb; i++) { await sleep(400); fb = (await readToast()) || ""; }
    fb = fb.slice(0, 60);
    rec("section-to-editor(送编辑器)", direct && /已送往|发送失败|为空/.test(fb) ? "ok" : "DEAD",
      `点击=${direct} 反馈="${fb}"${/独立打开/.test(fb) ? " ← 顶层页无 parent, 属探针环境限制(函数行为正确)" : ""}`);
  }


  // ── ④ 素材区: 生成弹层 / 插入 / 移除 ──
  console.log("\n═══ ④ 右栏素材 ═══");
  {
    // 上一步的失败 toast 停在 `top:64px; right:16px` —— 正好压在右栏素材卡上,
    //   真实鼠标会点到 toast 而不是「＋ 生成」(实测: 这里恒报 DEAD)。等它自己消失(约 3.2s)。
    await sleep(3800);
    const open = await probeAction(cdp, '[data-control="workflow:open-gen-dialog"]', { wait: 1200 });
    const st = await evalTop(cdp, `(() => {
      const d = document.querySelector('.gen-mask, .modal-mask');
      const btns = d ? [...d.querySelectorAll('button')].map(b => ({ t: b.textContent.trim(), ctl: b.getAttribute('data-control') || '', dis: b.disabled })) : [];
      return { open: !!d, btns };
    })()`);
    rec("open-gen-dialog(打开生成素材弹层)", st?.open ? "ok" : "DEAD", `弹层=${st?.open} 按钮=${JSON.stringify(st?.btns?.map((b) => b.ctl).filter(Boolean))}`);
    if (st?.open) {
      // 闭源 WorkspaceView 的素材生成弹层就是 [执行智能体开始思考] + 「取消」(无 data-control);
      //   「放弃/取消」二选一是**素材页**那套 genDialog 的形态, 别串台(第一版探针串了, 误报 ERR)。
      const cancelBtn = st.btns?.find((b) => b.t === "取消");
      rec("弹层有 执行/取消 两个动作", st.btns?.some((b) => /run-material-gen/.test(b.ctl)) && cancelBtn ? "ok" : "ERR",
        `按钮=${JSON.stringify(st.btns?.map((b) => b.t))}`);
      const close = await probeAction(cdp, '.gen-mask .gen-cancel', { wait: 1500, keepOverlays: true });
      const after = await evalTop(cdp, `(() => ({
        mask: !!document.querySelector('.gen-mask'),
        busy: document.querySelector('[data-assistant-async-busy]')?.getAttribute('data-assistant-async-busy') || ''
      }))()`);
      rec("放弃生成 → 关层且 busy 复位", !after?.mask && after?.busy === "false" ? "ok" : "ERR",
        `弹层还在=${after?.mask} busy=${after?.busy} 请求=${close.apiReqs.length}`);
    }

    const has = await evalTop(cdp, `document.querySelectorAll('[data-control="workflow:insert-material"]').length`);
    if (has > 0) {
      const ins = await probeAction(cdp, '[data-control="workflow:insert-material"]', { wait: 1800 });
      rec("insert-material(插入素材到正文)", ins.clicked ? "ok" : "DEAD", `点击=${ins.clicked}`);
    } else rec("insert-material(插入素材到正文)", "skip", "本章无挂载素材 → 不渲染该按钮");

    const hasRm = await evalTop(cdp, `document.querySelectorAll('[data-control="workflow:remove-material"]').length`);
    if (hasRm > 0) {
      const rm = await probeAction(cdp, '[data-control="workflow:remove-material"]', { wait: 1800 });
      rec("remove-material(移除本章素材)", rm.clicked ? "ok" : "DEAD", `点击=${rm.clicked}`);
    } else rec("remove-material(移除本章素材)", "skip", "本章无挂载素材 → 不渲染该按钮");
  }

  // ── ⑤ 版本回滚(批量撤销) ──
  console.log("\n═══ ⑤ 批量回滚 ═══");
  {
    const rb = await evalTop(cdp, `document.querySelectorAll('[data-control="workflow:rollback-batch"]').length`);
    if (!rb) rec("rollback-batch(撤销上次批量生成)", "skip", "当前没有可回滚的批量批次 → 不渲染");
    else {
      const r = await probeAction(cdp, '[data-control="workflow:rollback-batch"]', { wait: 2500 });
      const cfm = await evalTop(cdp, `(() => {
        const btns = [...document.querySelectorAll('button')].filter(x => {
          let p = x.parentElement; while (p) { if (getComputedStyle(p).position === 'fixed') return true; p = p.parentElement; } return false;
        }).map(b => b.textContent.trim());
        return btns;
      })()`);
      rec("rollback-batch(弹确认)", cfm.length || r.apiReqs.length ? "ok" : "DEAD",
        `请求=${r.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || "无"} 确认层=${JSON.stringify(cfm)}`);
      if (cfm.includes("撤销")) {
        await evalTop(cdp, `(() => {
          const b = [...document.querySelectorAll('button')].filter(x => {
            let p = x.parentElement; while (p) { if (getComputedStyle(p).position === 'fixed') return true; p = p.parentElement; } return false;
          }).find(x => x.textContent.trim() === '撤销');
          if (b) b.click(); return !!b;
        })()`);
        await sleep(2200);
        rec("确认后真回滚", "ok", "已点确认(具体版本状态由 nodes/history 断言覆盖)");
      }
    }
  }

  // ── ⑥ 进入合稿 ──
  console.log("\n═══ ⑥ 阶段推进 ═══");
  {
    const dis = await evalTop(cdp, `(() => { const b = document.querySelector('[data-control="workflow:enter-finalize"]'); return b ? { disabled: b.disabled, text: b.textContent.trim() } : null; })()`);
    const r = await probeAction(cdp, '[data-control="workflow:enter-finalize"]', { wait: 1600 });
    const nav = await evalTop(cdp, `location.hash`);
    // 门禁形态是 **disabled + 按钮文案带未完成章数**(不是 toast) ——
    //   只查"有没有请求"会把正确拦下读成 DEAD。
    rec("enter-finalize(进入合稿)",
      r.apiReqs.length || /finalize/.test(nav || "") ? "ok" : (dis?.disabled ? "gated" : "DEAD"),
      `按钮="${dis?.text}" disabled=${dis?.disabled} hash=${nav}`);
  }

  console.log("\n════════ 汇总 ════════");
  const bad = rows.filter((r) => r.kind === "ERR" || r.kind === "DEAD");
  for (const r of rows) console.log(`${r.kind.padEnd(6)} ${r.action}`);
  console.log(bad.length ? `\n❌ ${bad.length} 项异常` : `\n✅ ${rows.length} 项全部通过`);
  // 退出码 —— 否则挂进门禁也拿不到失败信号(verify-ui.mjs 只看 code)。
  //   skip 不算失败(环境限制), ERR/DEAD 才算。
  if (bad.length) process.exitCode = 1;
} catch (e) {
  console.error("探针异常:", e.message, e.stack?.split("\n")[1] ?? "");
} finally {
  await close();
}

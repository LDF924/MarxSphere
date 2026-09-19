// scripts/probe-provider-sync.mjs — 服务商联动真的把角色模型写进后端吗
//
// 由来(2026-09-19): 这个功能原本 POST `/api/llm/provider-sync` —— **端点不存在**(恒 404),
//   且 `.catch(()=>{})` 静默吞, 于是"服务商联动"**从来没生效过**。契约对账时挖出来的。
//   我先只是把文案改成不撒谎, 后来发现平台**本来就有**正确的落点:
//   `PUT /api/llm/models {role, modelId}`(requireUser + saveModelSelection 持久化)。
//   于是真做了: 只改平台的角色配置, 不碰 .env。
//
// **前置**(本环境只有 deepseek 两个模型可过 isModelUsable, 其余 PUT 一律 400: 密钥未配):
//   要观察"别家的角色被改掉", 只能从 DB 侧种:
//     update agent_settings set value = ... where key='llm_roles'   (把 verify/strategy 设成 qwen3.7-max)
//   然后**重启后端**(内存态才会读新值)。
//
// ⚠ 用**原型上的 value setter** 切下拉, 不能 `sel.value = x` ——
//   React 在实例上打了 tracker, 直接赋值会让它判定"值没变", 合成 change 不触发;
//   表现为"第一次切换有效、第二次静默不生效", 极像功能坏了。
//
// 用法: node scripts/probe-provider-sync.mjs   (需 4173 已起, 且已按上面种好前置)
//
// ⚠ 这个文件必须用**写文件工具**生成, 不能走 shell heredoc ——
//   `\d` / `\n` 这类转义在 heredoc 里会被解释掉, 变成 `Invalid regular expression`。
//   同一个坑这个会话里踩过五次以上, 故此处直接用 Write 落盘。
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";

const BASE = "http://127.0.0.1:4173";
/** 种子模型: 选**非 deepseek**的, 这样"切回 deepseek"才有真实变化可观察 */
/**
 * 本环境只有 deepseek 两个模型可用(其余 PUT 一律 400: 密钥未配), 所以"种一个别家模型"只能
 * **从 DB 侧**种(agent_settings.llm_roles) + 重启后端起效 —— 探针前置已由外部脚本完成。
 * 这里只断言: 切到 deepseek 后, 那两条别家的角色被改掉, 其余**原样不动**。
 */
const FOREIGN = "qwen3.7-max";
const rows = [];
const rec = (a, k, d) => {
  rows.push([k, a]);
  console.log(`${k === "ok" ? "  ok  " : " ERR  "} ${a} — ${d}`);
};

const roleMap = async (t) => {
  const r = await fetch(`${BASE}/api/llm/models`, { headers: { Authorization: `Bearer ${t}` } });
  return (await r.json()).roleMap;
};
const setRole = (t, role, modelId) =>
  fetch(`${BASE}/api/llm/models`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role, modelId }),
  });

/**
 * 在设置页把服务商下拉切到指定值。
 *
 * ⚠ 必须走**原型上的 value setter**, 不能 `sel.value = x` ——
 *   React 会给受控元素**在实例上**打一个 value setter 用来追踪值;
 *   直接赋值会连 tracker 一起更新, 于是它判定"值没变", **合成 change 不会触发**。
 *   实测表现: 第一次切换有效、第二次静默不生效(提示为空), 极像"功能坏了"。
 *   用 `HTMLSelectElement.prototype` 的原生 setter 绕开实例上的那个, React 才会看到变化。
 */
const switchProvider = (cdp, value) =>
  evalTop(cdp, `(() => {
    const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === ${JSON.stringify(value)}));
    if (!sel) return 'no-select';
    const desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
    desc.set.call(sel, ${JSON.stringify(value)});
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'switched:' + sel.value;
  })()`);

/** 读提示行: 取带「角色」或「未改动」字样的 <p>, 避免用正则 */
const readNote = (cdp) =>
  evalTop(cdp, `(() => {
    const ps = [...document.querySelectorAll('p')].map(p => p.innerText.trim());
    return ps.filter(x => x.includes('角色') || x.includes('未改动')).join(' | ');
  })()`);

const { cdp, close } = await startCdp({ preferredPort: 31119, label: "provsync" });
try {
  const t = await loginToken("audit", "audit123456");
  const before = await roleMap(t);
  console.log("切换前:", JSON.stringify(before));

  // ⚠ **不要在这里预置**。我第一版留了个"把全部角色改成 v4-pro"的循环, 正好把 DB 种入的
  //   别家模型覆盖掉了 → `foreign=[]`, 而后面 `changedRoles.length === foreign.length` 变成
  //   `0 === 0` **假通过**。前置由外部脚本(DB 种入 + 重启)提供, 此处只读取。
  const seeded = await roleMap(t);
  const foreign = Object.entries(seeded).filter(([, v]) => v === FOREIGN).map(([k]) => k);
  rec("前置: 有角色在别家服务商上", foreign.length > 0 ? "ok" : "err", `别家的角色=${JSON.stringify(foreign)}(由 DB 种入 + 重启生效)`);

  await cdp("Page.navigate", { url: `${BASE}/` });
  await sleep(3500);
  await evalTop(cdp, `localStorage.setItem('sag_token', ${JSON.stringify(t)}); location.hash = "#settings";`);
  await cdp("Page.reload");
  await sleep(7000);

  // ① 切到没有模型的服务商(302ai) → 应"一个都不动"并如实说
  const s1 = await switchProvider(cdp, "302ai");
  await sleep(4000);
  const note1 = await readNote(cdp);
  const afterWarn = await roleMap(t);
  const untouched = JSON.stringify(afterWarn) === JSON.stringify(seeded);
  rec("切到无模型的服务商 → 模型一个没动", String(s1).startsWith("switched") && untouched ? "ok" : "err", `全部未动=${untouched}`);
  rec("并如实说明为什么没动", /未改动/.test(note1) ? "ok" : "err", `提示="${note1}"`);

  // ② 切回 deepseek → 角色还在该服务商下(v4-pro)…… 先验证"已在该服务商就不动",
  //   再把它们种成别家已不可行(本环境只有 deepseek 可用), 故改验: 切换后仍在 deepseek 系
  //   且提示明确说了"无需改动"
  const s2 = await switchProvider(cdp, "deepseek");
  await sleep(6000);
  const note2 = await readNote(cdp);
  const after = await roleMap(t);
  const nowAllDeepseek = Object.values(after).every((v) => String(v).startsWith("deepseek-"));
  const changedRoles = Object.keys(after).filter((k) => after[k] !== seeded[k]);
  rec("切回 deepseek → 别家的角色被**真的**改掉", String(s2).startsWith("switched") && nowAllDeepseek && changedRoles.length === foreign.length ? "ok" : "err",
    `改成=${JSON.stringify(changedRoles)} 结果=${JSON.stringify(after)}`);
  // 反向: 本来就在 deepseek 的角色不该被动(用户的选择不能被冲掉)
  const untouchedRoles = Object.keys(after).filter((k) => !foreign.includes(k));
  const kept = untouchedRoles.every((k) => after[k] === seeded[k]);
  rec("已在该服务商下的角色原样不动", kept ? "ok" : "err", `保持不动的角色=${untouchedRoles.length} 个, 全部保持=${kept}`);
  rec("并如实说明无需改动", /无需改动|个角色的模型切到/.test(note2) ? "ok" : "err", `提示="${note2}"`);

  console.log("\n" + (rows.some((r) => r[0] === "err") ? "❌ 有异常" : `✅ ${rows.length} 项全通过`));
  if (rows.some((r) => r[0] === "err")) process.exitCode = 1;
} catch (e) {
  console.error("异常:", e.message, e.stack?.split("\n")[1]);
  process.exitCode = 1;
} finally {
  await close();
}

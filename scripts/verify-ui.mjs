// verify-ui.mjs — UI 门禁: 把各个 CDP 验证脚本串起来跑, 一个失败就整体失败。
//
// 由来(2026-09-14): 仓库里有 7 个走 DevTools 协议的 UI 验证脚本, 但它们**不在任何门禁里** ——
//   `npm test`(vitest) 与 `npm run typecheck` 都不跑它们。后果是它们悄悄腐烂了很久:
//   6 个坏掉(端口落进 Windows 保留区间 / 验证的是已废弃的 React 编辑器 / 断言串在代码里
//   根本不存在), 却没有任何信号提醒。
//
// 用法:
//   node scripts/verify-ui.mjs                 # 跑默认那一组(快、纯配置面)
//   node scripts/verify-ui.mjs --all           # 加上重数据依赖的(需要真实历史审稿等)
//   node scripts/verify-ui.mjs --only fusion-tabs,editor-ai6-verify
//
// 前置: 4173 已起。脚本自己会做登录与导航。
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = "http://127.0.0.1:4173";

/**
 * 每个条目单独一个子进程 —— 它们各自 spawn 浏览器 / 连 CDP / 清临时目录,
 * 同进程内串行反而容易互相污染(共享 globalThis、端口复用)。
 *
 * data: 需要"真实的历史数据"才跑得起来(如往期审稿记录), 默认组不含, 用 --all 带上。
 * 这类断言在空环境里会红得莫名其妙, 不适合当 CI 默认门。
 */
const SUITES = [
  { key: "fusion-tabs", file: "verify-fusion-tabs.mjs", desc: "5 个 FusionPanel tab 真的挂的是 Vue 子应用" },
  { key: "assistant-coverage", file: "verify-assistant-coverage.mjs", desc: "45 视图上下文 + 动作埋点 + 点击驱动" },
  // soc 是 iframe, 动作走 postMessage 上报 —— 与上面那条是**两条链路**, 外壳侧全绿不代表这条通
  { key: "assistant-soc", file: "verify-assistant-soc.mjs", desc: "iframe 子应用动作上报 + 可命中可点 + 换页刷新" },
  // 站点内容页是**纯静态数据**, 不接后端也不进单测 —— 内容腐烂没有信号, 只能靠这个回归顶住
  { key: "site-content", file: "verify-site-content.mjs", desc: "四个 tab 真渲染 + 帮助条目跳转真生效" },
  // 写作舱这一批(2026-09-15)修的全是"类型检查抓不到、失败还静默"的项 —— 只能靠真浏览器顶住
  { key: "writing-cabin", file: "verify-writing-cabin.mjs", desc: "章节树二级/正文渲染/素材按章过滤/降AIGC档位" },
  // 上面那条是**状态**断言(长什么样)。下面两条是**动作**断言(点下去做没做事) ——
  //   两者互补, 缺一就会出现"界面全对、按钮全死"。这两条此前是手动脚本, 不进门禁的东西会腐烂:
  //   补它们的过程中挖出的两个缺陷(采用修订稿是空操作、素材来源弹层只有状态没有视图)
  //   都活了很久没有任何信号。
  { key: "materials-actions", file: "probe-materials-actions.mjs", desc: "素材页 20 动作: 增删改/来源/审视/编排/文献结构化" },
  { key: "workspace-actions", file: "probe-workspace-actions.mjs", desc: "创作台 16 动作: 面板/编辑/保存/素材/阶段门禁(不含 LLM)" },
  { key: "input-actions", file: "probe-input-clarify-and-phase.mjs", desc: "信息录入 10 项: 草稿存与恢复/方法卡/来源/新项目(含真建项目)" },
  // 失败态分支: SectionsView 六个动作**全部**长在失败/分析中/缺指导三种横幅里, 成功态断言照不到。
  //   做法是真跑一次 analyze 并在几秒内取消 → 驱动出失败横幅(LLM 实际只跑几秒, 成本很低)。
  { key: "sections-banners", file: "probe-sections-banners.mjs", desc: "科研架构 失败/分析中横幅: 取消→失败态→补指导/重跑" },
  // 要件生成是**同步** LLM 接口, 真跑一次要烧额度 → 默认组不带, 需要时 `--only=finalize-gen`
  // 或手动 `node scripts/probe-finalize-component-gen.mjs`。
  { key: "finalize-gen", file: "probe-finalize-component-gen.mjs", desc: "论文要件生成: 参数/并回章节/刷新后仍在/缺标题门禁", data: true },
  // 支撑视图(不在写作舱主流程): DAG 编排 / 数据台 / 绘图台 / 审稿台。
  //   审稿那四个动作(retry/export-html/export-word/send-to-workflow)只在**已有审稿结果**后渲染 ——
  //   不真跑一次审稿它们根本不出现, 所以带 LLM 的那段归 --all。
  { key: "support-views", file: "probe-support-views-actions.mjs", desc: "QuickMode/Statistics/Viz/Review 的 12 个动作" },
  // 数据分析台的 .xlsx 上传: 台账长期记的是「后端仅 csv/tsv」, 实际早有 xlsx→CSV 通道 ——
  //   但套件里**从来没有 xlsx 用例**(只验过 csv), 所以这条是真跑一遍端到端。
  //   xlsx 在 node 侧用 fflate 现造(最小 OOXML, openpyxl 能读), 不往仓库塞二进制样本。
  { key: "stats-xlsx", file: "probe-stats-xlsx-upload.mjs", desc: "xlsx 上传: 后端转换/profile/变量渲染/可点选/运行前置" },
  // 审稿台「＋ 新建审稿」: 按闭源 review_new_review 补的入口, 补完只验了渲染 ——
  //   跑整条流才现形: 点确认后正文一个字没少(正文框另存了一份本地副本, resetPaper 只清了 store)。
  //   同时钉住"不重挂载组件时重置也要清界面"(另一个入口走同一路径)。
  { key: "review-reset", file: "probe-review-reset.mjs", desc: "新建审稿: 确认层文案/取消保留/确认清空/重置机制" },
  // R9: 后端的图片端点是 requireUser 保护的, 而 `<img src="/api/...">` 发不带 Authorization 头 ——
  //   实测**本机也是 401**(不是"上云才坏"), naturalWidth=0。这条钉住"带鉴权取 blob"这条路必须通。
  { key: "authed-image", file: "probe-authed-image.mjs", desc: "受保护图片: 原生 img 取不到 / 带鉴权 fetch 200 / objectURL 可解码 / 404" },
  // 「快照 ↔ 节点」口径: 验"改完之后刷新还在不在"(用户视角), 与单测(验合并函数本身)互补。
  //   不调 LLM, 秒级。
  { key: "workbench-sync", file: "probe-workbench-sync.mjs", desc: "已定稿/数据文件刷新后仍在 + 防倒退 + diff 守卫" },
  // 布局是**另一层**问题: 旧门禁全是文案/结构断言, 从没量过"元素实际占多大、窄屏会不会塌、底部能不能滚到"
  { key: "layout", file: "verify-layout.mjs", desc: "三档视口 × 5 视图: 溢出/塌陷/重叠/可滚动容器" },
  { key: "editor-ai6", file: "editor-ai6-verify.mjs", desc: "编辑器 AI 面板 6 页签与顺序" },
  // 编辑器「导出 Word」此前**零覆盖** —— 一验就现形: 它打的是一个后端不存在的 URL(恒 404)。
  //   这条同时反向断言"不再打那个死 URL", 否则将来有人把旧代码抄回来照样绿。
  { key: "editor-export", file: "probe-editor-export.mjs", desc: "编辑器导出 Word: 真端点/请求体带内容/产物是真 docx" },
  { key: "editor-check", file: "editor-check-verify.mjs", desc: "全文检查 4 个动作卡" },
  { key: "editor-chart", file: "editor-ai6-chart.mjs", desc: "图表页签: 数据源/类型/描述/生成" },
  { key: "empirical-switch", file: "verify-empirical-project-switch.mjs", desc: "实证台课题切换与空态" },
  { key: "pb-report", file: "pb-report-verify.mjs", desc: "往期审稿 → 报告结构", data: true },
];

const argv = process.argv.slice(2);
const wantAll = argv.includes("--all");
const onlyArg = argv.find((a) => a.startsWith("--only=")) ?? (argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null);
const only = onlyArg ? new Set(String(onlyArg).replace(/^--only=/, "").split(",").map((s) => s.trim()).filter(Boolean)) : null;

const chosen = SUITES.filter((s) => (only ? only.has(s.key) : wantAll || !s.data));
if (!chosen.length) { console.error(`没有匹配的套件。可选: ${SUITES.map((s) => s.key).join(", ")}`); process.exit(1); }

console.log(`UI 门禁: 跑 ${chosen.length}/${SUITES.length} 套` + (wantAll ? "(含数据依赖)" : "(默认组; 数据依赖的用 --all)"));
console.log(`前置: ${BASE} 已起\n`);

function runOne(suite) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(here, suite.file)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      // 只回显最后一行结论 —— 各脚本自己已经打印了逐项 ✅/❌
      const tail = out.trim().split("\n").filter((l) => l.trim()).slice(-1)[0] ?? "(无输出)";
      console.log(`${code === 0 ? "✅" : "❌"} ${suite.key.padEnd(20)} ${secs.padStart(5)}s  ${tail.replace(/^\s+/, "").slice(0, 90)}`);
      if (code !== 0 && out.trim()) {
        // 失败时把有意义的行挖出来(❌ / ERR), 免得只看到一行总结无从下手
        const detail = out.split("\n").filter((l) => /❌|ERR|JSERR|超时/.test(l)).slice(0, 6);
        if (detail.length) console.log(detail.map((l) => "     " + l.trim()).join("\n"));
      }
      resolve({ key: suite.key, code, secs });
    });
  });
}

// 串行: 每个套件都要起浏览器并连 4173, 并发会互相抢端口/抢资源
const results = [];
for (const s of chosen) results.push(await runOne(s));

const failed = results.filter((r) => r.code !== 0);
console.log(`\n${failed.length ? `❌ ${results.length - failed.length}/${results.length} 套通过` : `✅ ${results.length}/${results.length} 套全部通过`}`);
if (failed.length) {
  console.log(`失败: ${failed.map((f) => f.key).join(", ")}`);
  console.log(`单跑排查: node scripts/<文件>.mjs  (对应关系见本文件 SUITES)`);
  process.exit(1);
}

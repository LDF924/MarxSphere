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
import { spawn, execFileSync } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 从 .env 读库连接串 —— 只给**收尾清理**用。
 * 候选顺序与探针一致: 环境变量 → cwd → 仓库根(worktree 是三级上去)。
 * 读不到就返回空串, 清理脚本据此自己跳过(它不该让门禁失败)。
 */
function readDbUrl() {
  const cands = [process.env.SAG_ENV_FILE, path.join(process.cwd(), ".env"), path.join(process.cwd(), "..", "..", "..", ".env")].filter(Boolean);
  const hit = cands.find((p) => existsSync(p));
  if (!hit) return "";
  const m = readFileSync(hit, "utf8").match(/^DATABASE_URL=(.*)$/m);
  return m ? m[1].trim() : "";
}
/**
 * 门禁默认打 4173(生产产物)。要验**本 worktree** 的后端/前端时给 env:
 *   API_BASE=http://127.0.0.1:4373 WEB=http://127.0.0.1:4373 node scripts/verify-ui.mjs
 * 子进程**继承 process.env**(spawn 不传 env 时即为继承), 所以只有认这两个变量的套件会改向,
 * 其余套件照旧打 4173 —— 于是"老套件回归 + 新套件打新代码"可以在同一次跑里完成。
 */
const BASE = process.env.API_BASE || "http://127.0.0.1:4173";

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
  { key: "input-actions", file: "probe-input-clarify-and-phase.mjs", desc: "选题界定 10 项: 草稿存与恢复/方法卡/来源/新项目(含真建项目)" },
  // 2026-09-26 加。这一批修的四条全是"静态看都对、跑起来才错"的类型:
  //   ①素材交接在**没有项目**时会被读后即删(**静默丢数据**, 无任何报错)
  //   ②删项目后掉进"模块建设中"占位页, 没有返回入口
  //   ③版本历史入口此前只在第 5 步(另两页发布了版本却退不回去)
  //   ④数据分析台(Vue, 1218 行)外壳里没有入口, 只能手改 URL
  //   这四条的共同点是:**类型检查与单测都照不到** —— 它们长在路由/导航/localStorage 上。
  { key: "batch01", file: "probe-batch01.mjs", desc: "批1 回归: 交接不丢/占位页消亡/版本入口五页/数据台入口" },
  // 2026-09-26 加。阶段模型真源化 + 重编号(迁移 157): 编号从 1..5 变成 1,2,4,5,6。
  //   这一批的风险全在"号对了但名错了"上 —— 类型检查抓不到(号只是个 number),
  //   只有真浏览器能验"这个号的节点上写着哪个中文名、Alt+N 跳到哪一页"。
  { key: "batch02", file: "probe-batch02.mjs", desc: "批2 回归: 阶段号重排/旧项目落点/Alt+N 跳页" },
  // 2026-09-26 加。论文要件加「讨论」档 —— 这一档最易静默失效的是**落点**:
  //   显示走 order 排序, 只管数组 splice 不生效(我第一版就是那么写的)。
  //   ⚠ **不进 data 组**: 它默认只验结构与落点(不烧模型), 真生成那步要 PROBE_LLM=1。
  //     我第一版标了 data:true, 那等于把最有价值的排序断言也关在默认门禁外 ——
  //     而那条根本不花钱。**成本高的部分不该拖累不花钱的部分。**
  { key: "batch04", file: "probe-batch04.mjs", desc: "批4 回归: 讨论档落点(结论之前) + 未知档被挡" },
  // 2026-09-26 加。投稿声明独立一区 —— 这一批最易静默失效的是**存储位置**:
  //   第一版只写节点不写 store, 而导出读 store → "填了声明, 导出时那段是空的"。
  //   探针 ③ 同时验节点与快照, ⑤ 解压 ZIP 真读 论文.md。
  //   整套**不烧模型**（声明只能人填, 本页没有任何 LLM 调用）。
  { key: "batch05", file: "probe-batch05.mjs", desc: "批5 回归: 五项声明落库/完整性检查/导出带声明" },
  // 2026-09-27 加。外部审稿意见与逐条回应 —— 在此之前平台**没有这个概念**
  //   (`/api/review/*` 是"我方当审稿人", phase5_revise 吃的是系统自审报告)。
  //   这一批最易静默失效的两处:
  //     ① **落库位置** —— 参考产品那份"逐条复核"就只在 localStorage, 换个浏览器就没了,
  //        而这是要交给编辑部的材料;
  //     ② **拆条** —— 启发式必然有边界, 而切错的条目在界面上看着完全正常
  //        (把一条拦腰切成两条, 用户只觉得"这意见怪怪的")。
  //   整套**不烧模型**（拆条刻意走启发式不走 LLM —— LLM 会改写原文）。
  { key: "batch06", file: "probe-batch06.mjs", desc: "批6 回归: 意见粘贴拆条/逐条回应状态派生/刷新仍在/回应信" },
  // 2026-09-27 加。申报与审查(开题/基金/伦理/预注册)—— 平台此前**后端零实现**。
  //   默认组只验**接线与节次结构**(不烧模型): 四类页签、每类 7 节的固定结构、
  //   界面的节数与接口返回的一致(防前端自己写死一份)、空态、入口可达。
  //   真生成(七节逐节调 LLM, 一分钟以上)归 PROBE_LLM=1 —— 与 batch04 同一条切法:
  //   **成本高的部分不该拖累不花钱的部分。**
  { key: "batch07", file: "probe-batch07.mjs", desc: "批7 回归: 申报与审查四类/节次结构/空态/入口(真生成要 PROBE_LLM=1)" },
  // 2026-09-27 加。批9 录用与传播 —— 17 环节的第 16/17 项, 此前**零实现**。
  //   ⚠ 这一批**没有 LLM 调用**: 版权/OA 是标准条款的选择、校样要看到校样,
  //     两者都不该由模型生成(见 post-acceptance.ts 的注释), 所以默认组就能跑。
  //   最易静默失效的是**渲染条件**: 未录用时给提示、录用后才出卡。
  //   实测踩到过一次 —— 子组件 onMounted 早于父组件, store.taskId 还没就绪,
  //   面板渲染了却永远显示"还没有已录用的投稿"(数据对、界面看不到)。
  { key: "batch09", file: "probe-batch09.mjs", desc: "批9 回归: 出版事务(版权/OA/校样) + 成果转化 + 后续方向" },
  // 2026-09-27 加。批10 中期检查 / 结项验收 —— 17 环节里**此前被明确排除的两项**。
  //   排除理由("那是项目管理不是研究")站不住: 按它推, 批6/批9 也不该做。
  //   真正的分界线是"这件事的数据在不在平台手上" —— 检查表在用户手里, 所以形态是
  //   **填表不是生成**(上传→拆条→三分类→导出), 整套零 LLM。
  //   最易静默失效的两处:
  //     ① **手改的值被重算覆盖** —— auto 项每次读取都会重跑分类, 少了 edited 标记
  //        就变成"填了、刷新就没了";
  //     ② **三分类退化成单一分类** —— 全判 auto 会填出编的内容, 全判 manual 则功能等于没做,
  //        所以探针同时断言"三类都出现过"与"平台没有的项确实留空"。
  { key: "batch10", file: "probe-batch10.mjs", desc: "批10 回归: 检查表上传/拆条/三分类/手改不被覆盖/导出同源" },
  // 2026-09-28 加。DAG 编排补齐: 计划历史 / 节点详情四件事 / 启动确认层 / 泳道与可执行徽标。
  //   这一批的**核心是一条新后端链路** —— `orchestrator_run_events`(迁移 161) + 运行时的
  //   onEvent 钩子。它最危险的失效方式是**静默退化成快照**: 原来只有 step_log_json,
  //   而它 `on conflict do update` 整行覆盖, 同一节点的 pending→running→done 只剩最后一个。
  //   所以探针不只看"浮层有没有渲染", 而是**真起一次运行**再断言事件流里
  //   `node.running` 出现在 `node.failed` **之前** —— 顺序是快照表表达不了的那个东西。
  //   ⚠ 成本: 起的那条链是"质量门 + 备胎", 质量门会调一次 LLM(maxTokens 200)。很小但非零。
  { key: "batch11", file: "probe-batch11.mjs", desc: "批11 回归: 事件流落库/计划历史/节点详情四件事/启动确认层/泳道与可执行徽标" },
  // 2026-09-28 加。素材弹层对齐参考产品(图 1–9)。这一批里**实质性的一条是章节归属**:
  //   原先手动添加的素材保存时**默默挂到第一章**(`store.level1Sections[0]`), 用户改不了 ——
  //   所以探针不看"下拉在不在", 而是选第二章 → 保存 → **查库里的 section_ids**。
  //   ⚠ 它自建项目与章节(不靠已有数据), 因此空库 CI 上也能跑。
  { key: "batch12", file: "probe-batch12.mjs", desc: "批12 回归: 弹层提示与示例/章节归属真落库/拖拽三态/接近上限的附件真能传" },
  // 2026-09-28 加。阶段内部步骤(用户: "能执行每一个环节里的每一步")。
  //   最危险的失效方式是**编一个不存在的 capabilityId** —— 界面上有「▶ 跑」按钮、
  //   点下去必然失败, 而失败在几百毫秒之后, 看不出是"本来就不支持"还是"跑挂了"。
  //   所以探针不数按钮, 而是把每个可跑步骤的能力 id 拿去**后端能力表里反查**。
  //   单步执行那条也验后端**真的起了一次单节点运行**, 不是"界面上转了个圈"。
  //   ⚠ 成本: 只读 + 一次 user_input 节点的运行(不产生 LLM 调用)。
  { key: "batch13", file: "probe-batch13.mjs", desc: "批13 回归: 阶段步骤真源/可跑能力反查/单步真起运行/模板可展开" },
  // 2026-09-28 加。外部服务密钥(有效期/校验/提醒) + 扫描件 OCR 全链路。
  //   标的 `data: true` 是**必须的**, 理由与上面 sections-banners 那条一模一样:
  //   · ② 阶段要真打一次 MinerU 接口;
  //   · ③ 阶段要真跑一次 OCR(约 30 秒 + 一次外部额度);
  //   · ①b 会往告警中心写一条真实告警。
  //   在 CI(dummy key)上跑必然红, 而"一个自称不该进默认门的套件天天红着"正是这里
  //   记录过的教训。手动跑: `node scripts/probe-batch14.mjs`。
  { key: "batch14", file: "probe-batch14.mjs", desc: "批14 回归: 密钥面板/校验落库/到期日提醒/扫描件OCR全链路/密钥不外泄", data: true },
  // 2026-09-29 加。模板参数在画布上真的接对了(用户: "要修" 那两条死键)。
  //   最难的失效是**参数名写错**: 合并进 body 后被端点忽略, 界面上参数行照常显示、
  //   用户填了也不生效 —— 只能靠人肉比对能力注册表。探针把节点参数读回来跟能力表对。
  //   ⚠ 成本: 一次端点调用(描述统计, 不需要 LLM)。
  { key: "batch15", file: "probe-batch15.mjs", desc: "批15 回归: 模板参数真接对(死键/裸占位符/关键字名)" },
  // 2026-09-29 加。AI 对话页的工具/能力显示(用户: "好久没更新其调用工具和能力了")。
  //   根因是 ChatPanel 手抄了一份工具清单且当唯一来源 —— 后端 77 个工具它只登记 38 个,
  //   其余在工具链里**显示成英文原名**, 且不会报错。现改成以 /api/agent/tools 为准。
  //   守门的主力是单测(test/tool-meta-coverage.test.ts, 反向验证会翻); 这里兜渲染链路。
  //   ⚠ 成本: 只读。
  //   ⚠ `data: true` 是**必须的**(2026-09-29 第一次进 CI 就红了 —— 本机 6/6 全过)。两个原因:
  //     ① 它要打开一个**真跑过工具的历史会话**才能验渲染 —— CI 的库是干净的;
  //     ② 它的断言里有中文界面文案(本机 zh-CN; CI 无中文 locale → 界面全英文)。
  //     这正是本仓记过的"CI 与本机的 5 处差异"。
  { key: "batch16", file: "probe-batch16.mjs", desc: "批16 回归: 对话工具名以后端为准(全量/中文/不裸露英文)", data: true },
  // 失败态分支: SectionsView 六个动作**全部**长在失败/分析中/缺指导三种横幅里, 成功态断言照不到。  //   做法是真跑一次 analyze 并在几秒内取消 → 驱动出失败横幅(LLM 实际只跑几秒, 成本很低)。
  //   ⚠ 2026-09-23 加 `data: true` —— 它**一直该在这里**。探针自己的文件头就写着
  //     "analyze 是真调 LLM 的, 所以本探针按需手跑, **不进默认门禁**",
  //     可 SUITES 里没标 data, 于是它被默认组带上, 在 CI(LLM key 是 dummy)必然红。
  //     结果就是"一个自称不该进默认门的套件, 天天在 CI 上红着" —— 红久了就没人看了。
  { key: "sections-banners", file: "probe-sections-banners.mjs", desc: "框架设计 失败/分析中横幅: 取消→失败态→补指导/重跑", data: true },
  // 要件生成是**同步** LLM 接口, 真跑一次要烧额度 → 默认组不带, 需要时 `--only=finalize-gen`
  // 或手动 `node scripts/probe-finalize-component-gen.mjs`。
  { key: "finalize-gen", file: "probe-finalize-component-gen.mjs", desc: "论文要件生成: 参数/并回章节/刷新后仍在/缺标题门禁", data: true },
  // 支撑视图(不在写作舱主流程): DAG 编排 / 数据台 / 绘图台 / 审稿台。
  //   审稿那四个动作(retry/export-html/export-word/send-to-workflow)只在**已有审稿结果**后渲染 ——
  //   不真跑一次审稿它们根本不出现, 所以带 LLM 的那段归 --all。
  //   ⚠ 2026-09-23 加 `data: true`: 与 sections-banners 同因 —— 上面这句注释说"归 --all",
  //     但条目上没有 data 标记, 默认组照样带上它, 于是在 CI 上红。
  //     **注释说的和条目标的是两回事 —— 以后改这里请对着条目看, 别只看注释。**
  { key: "support-views", file: "probe-support-views-actions.mjs", desc: "QuickMode/Statistics/Viz/Review 的 12 个动作", data: true },
  // 数据分析台的 .xlsx 上传: 台账长期记的是「后端仅 csv/tsv」, 实际早有 xlsx→CSV 通道 ——
  //   但套件里**从来没有 xlsx 用例**(只验过 csv), 所以这条是真跑一遍端到端。
  //   xlsx 在 node 侧用 fflate 现造(最小 OOXML, openpyxl 能读), 不往仓库塞二进制样本。
  { key: "stats-xlsx", file: "probe-stats-xlsx-upload.mjs", desc: "xlsx 上传: 后端转换/profile/变量渲染/可点选/运行前置" },
  // 审稿台「＋ 新建审稿」: 按参考产品 review_new_review 补的入口, 补完只验了渲染 ——
  //   跑整条流才现形: 点确认后正文一个字没少(正文框另存了一份本地副本, resetPaper 只清了 store)。
  //   同时钉住"不重挂载组件时重置也要清界面"(另一个入口走同一路径)。
  { key: "review-reset", file: "probe-review-reset.mjs", desc: "新建审稿: 确认层文案/取消保留/确认清空/重置机制" },
  // R9: 后端的图片端点是 requireUser 保护的, 而 `<img src="/api/...">` 发不带 Authorization 头 ——
  //   实测**本机也是 401**(不是"上云才坏"), naturalWidth=0。这条钉住"带鉴权取 blob"这条路必须通。
  { key: "authed-image", file: "probe-authed-image.mjs", desc: "受保护图片: 原生 img 取不到 / 带鉴权 fetch 200 / objectURL 可解码 / 404" },
  // 服务商联动: 原先 POST 到一个不存在的端点(恒 404 + 静默吞), 功能从没生效过。
  //   ⚠ 需要**前置**: 从 DB 把某个角色种到别家服务商 + 重启后端(见该文件头注释),
  //   否则"别家的角色"为空, 断言会退化成 0===0 的假通过。故不放进默认组。
  { key: "provider-sync", file: "probe-provider-sync.mjs", desc: "切换服务商: 真把角色模型写进后端 + 不冲掉已在该服务商的角色", data: true },
  // 「快照 ↔ 节点」口径: 验"改完之后刷新还在不在"(用户视角), 与单测(验合并函数本身)互补。
  //   不调 LLM, 秒级。
  { key: "workbench-sync", file: "probe-workbench-sync.mjs", desc: "已定稿/数据文件刷新后仍在 + 防倒退 + diff 守卫" },
  // 布局是**另一层**问题: 旧门禁全是文案/结构断言, 从没量过"元素实际占多大、窄屏会不会塌、底部能不能滚到"
  { key: "layout", file: "verify-layout.mjs", desc: "三档视口 × 5 视图: 溢出/塌陷/重叠/可滚动容器" },
  { key: "editor-ai6", file: "editor-ai6-verify.mjs", desc: "编辑器 AI 面板 6 页签与顺序" },
  // 编辑器「导出 Word」此前**零覆盖** —— 一验就现形: 它打的是一个后端不存在的 URL(恒 404)。
  //   这条同时反向断言"不再打那个死 URL", 否则将来有人把旧代码抄回来照样绿。
  { key: "editor-export", file: "probe-editor-export.mjs", desc: "编辑器导出 Word: 真端点/请求体带内容/产物是真 docx" },
  // 「版本历史」「导入 Word」与导出同属编辑器右上一排, 同样**零覆盖过**。
  //   2026-09-20 首验现形: 版本列表恒空(q() 返回整个响应体却被当数组用)、恢复打 404、
  //   导入 Word 打 404。此套同时锁住"回档后正文真的变回旧版"与"导入后正文真的换掉"。
  { key: "editor-ver-import", file: "probe-editor-versions-import.mjs", desc: "编辑器版本历史(列表/恢复真回档)+ 导入 Word(真解析成正文)" },
  // 写作舱 V419 三项加法(质量四检 / 语料库召回 / 素材筛选与批量)此前**零覆盖** ——
  //   接上后若只验"按钮在", "点了没反应 / 打错端点 / 返回解析不出来"全会漏。
  //   这套每条都验到副作用: 四检验 4 个请求全 200 且四张卡真渲染; 语料验真打端点;
  //   筛选验列表真被筛短; 批量验选中态真变化。
  { key: "writing-cabin-v419", file: "probe-writing-cabin-v419.mjs", desc: "写作舱加法: 质量四检/语料召回/素材筛选与批量" },
  // V425 第二批加法(A1/A2/A3)同样**零覆盖**:
  //   A1 版本历史抽屉 —— 抽屉里的表格布局量不到, 只能真渲染; 且两条写动作(设为终稿/回滚)
  //      必须验到**库里的状态变化**, 而不是"请求发出去了"(回滚那条就是这么查出后端
  //      INSERT 少绑一个参数的 —— 端点存在但**从来没成功过一次**)。
  { key: "version-history", file: "verify-version-history.mjs", desc: "版本历史: 抽屉/三页签/设为终稿真落库/回滚真落库+二次确认" },
  // A2 深度分析七项 —— 真调 LLM 的断言会随模型波动且一分钟起步, 那是评测的事;
  //   这条门禁固化的是**接线**: 七个 chip 的参数表随动+预填、请求打到对的端点、字段名对得上。
  { key: "deep-analysis", file: "probe-deep-analysis.mjs", desc: "深度分析七项: 面板/chip 切换/参数预填/真打端点且字段名正确(拦请求不烧模型)" },
  // A3 整包导出 —— 产出是**一个文件**, 所以让 Chromium 真下载再打开那个 zip 校验结构;
  //   只看"请求 200"会漏掉 Content-Disposition 写错 / blob 没落盘 / 包里少章节。
  { key: "project-bundle", file: "probe-project-bundle.mjs", desc: "整包导出: 真下载 zip + 解开校验条目/章节数/中文文件名" },
  // B2/D2: 左侧项目栏(切项目/搜索/归档)与快捷键。**真的会切项目指针**, 所以脚本自己
  //   记下原值并在收尾还原 —— 门禁不该改用户当前项目。
  // V425 第二批加法(八项)的接线门禁 —— 全部不调 LLM(引文核验是 Crossref/OpenAlex 查证),
  //   所以进默认组。验的都是"接了没有"这类静默失败: 期刊库真加载、方法目录真拉到、
  //   正文里的 [n] 真被抽出来并真打端点、查重在没源文本时真禁用。
  //   脚本自带测试课题与收尾清理(首跑踩过: 造了数据却没让被测对象看见 → 三条假失败)。
  { key: "writing-cabin-v425b", file: "probe-writing-cabin-v425b.mjs", desc: "写作舱八项加法: 选题论证/研究设计/数据收集/引文核查/文献矩阵/投稿检查" },
  // 「研究 → 写作」这条线的接线门禁(2026-09-25)。这一批补的断线全是**静默**失败:
  //   面板渲染了、按钮在, 但点下去打错端点 / 存了读不回来 —— 只断言"元素存在"抓不到。
  //   所以每条都验到副作用: 勾选→重载后仍在、采纳→库里 status 真变、设计→design 节点真写。
  //   不调 LLM(统计是 pandas/statsmodels, 秒级), 故进默认组。脚本自带测试课题并自清。
  { key: "research-evidence", file: "probe-research-evidence.mjs", desc: "研究证据链: 本章依据/假设台账/发现采集/数字核验/研究设计/变量编辑" },
  { key: "project-rail", file: "probe-project-rail.mjs", desc: "项目栏: 列表/搜索/切项目/折叠 + Alt+数字快捷键(含越级拦截)" },
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
if (!chosen.length) { console.error(`没有匹配的套件。可选: ${SUITES.map((s) => s.key).join(", ")}`); await exitAfterFlush(1); }

/**
 * 分片：`VERIFY_UI_SHARD=1/4` —— 把 34 套按**实测耗时贪心平衡**分成 N 片，只跑自己那一片。
 *
 * ## 为什么走分片而不是并发（2026-09-27 实测）
 *
 * 单机并发**不成立**，三个并行度都试过：K=5 时 20 套里 19 次重试，K=2 时刚跑 3 套就挂 2 套，
 * 而挂掉的那两套单独跑都过 —— 不是端口冲突也不是数据互踩，是**机器一忙这些探针就读早了**
 * （它们大多靠固定 sleep 等页面，只有走 `openSoc` 的那批有就绪判据）。
 * 要让它们抗负载得逐套改成轮询，30 多个文件、每改一套都要重验断言，风险远大于收益。
 *
 * **分片没有这个问题**：每个分片跑在自己的 runner / 自己的机器上，片内仍是原样的串行，
 *   所以每一套的运行条件与"整轮串行"完全一致 —— 稳定性一个字节都没变，墙钟却线性缩短。
 *
 * ## 顺序固定，不随分片数变
 *
 * 平衡用的是**写死的一张耗时表**（`suiteCost`），不是现场测量 —— 现场测量会让
 * "哪些套件落在哪一片"随机器状态漂移，而排障时需要"第 2 片总是这 8 套"这种确定性。
 * 表里没有的套件按 60s 估（新的探针不会被漏掉，只是分片可能略不均衡）。
 * 新增套件时**顺手补一行**，分片才会一直均衡。
 *
 * ⚠ 分片只影响"跑哪些"，**不影响任何断言** —— 它不做子集筛选、不跳过任何套件，
 *   合起来必须是全集（`shards` 的并集校验在下面）。
 */
const SHARD_ARG = argv.find((a) => a.startsWith("--shard=")) ?? (argv.includes("--shard") ? `--shard=${argv[argv.indexOf("--shard") + 1]}` : "");
const SHARD_ENV = process.env.VERIFY_UI_SHARD || "";
const shardSpec = String(SHARD_ARG ? SHARD_ARG.replace(/^--shard=/, "") : SHARD_ENV).trim();
let chosenShard = chosen;
if (shardSpec) {
  const [iRaw, nRaw] = shardSpec.split("/");
  const i = Number(iRaw), n = Number(nRaw);
  if (!Number.isInteger(i) || !Number.isInteger(n) || i < 1 || n < 1 || i > n) {
    console.error(`分片参数不合法: ${JSON.stringify(shardSpec)}（应为 i/N，如 1/4）`);
    await exitAfterFlush(1);
  }
  /** 实测耗时(s) —— 取自 2026-09-27 提速后的一整轮。缺省 60。 */
  const suiteCost = {
    "writing-cabin-v425b": 116, "materials-actions": 90, "writing-cabin-v419": 89, "research-evidence": 91,
    "assistant-coverage": 70, "input-actions": 66, "assistant-soc": 62, "batch02": 67, "deep-analysis": 51,
    "workbench-sync": 51, "workspace-actions": 55, "writing-cabin": 55, "layout": 49, "batch06": 53,
    "empirical-switch": 49, "batch09": 49, "batch01": 46, "fusion-tabs": 45, "site-content": 45,
    "editor-ver-import": 45, "review-reset": 41, "stats-xlsx": 41, "editor-export": 39, "batch10": 31,
    "batch11": 50, "batch12": 140, "batch13": 40, "batch15": 45, "batch16": 30,
    "batch05": 33, "project-bundle": 21, "batch04": 27, "version-history": 25, "batch07": 20,
    "editor-ai6": 19, "editor-chart": 16, "editor-check": 15, "project-rail": 33,
  };
  // 贪心：按原顺序，每套放进当前最轻的一片（顺序固定 ⇒ 结果可复现）
  const buckets = Array.from({ length: n }, () => []);
  const loads = new Array(n).fill(0);
  for (const s of chosen) {
    const k = loads.indexOf(Math.min(...loads));
    buckets[k].push(s);
    loads[k] += suiteCost[s.key] ?? 60;
  }
  chosenShard = buckets[i - 1];
  console.log(`分片 ${i}/${n}：跑 ${chosenShard.length} 套（预计约 ${(loads[i - 1] / 60).toFixed(1)} 分钟）`);
  if (argv.includes("--print-shards")) {
    for (let b = 0; b < n; b++) {
      console.log(`\n  第 ${b + 1} 片（约 ${(loads[b] / 60).toFixed(1)} 分）：${buckets[b].map((s) => s.key).join(", ")}`);
    }
    // 并集校验：分片不能丢套件。这是**必须**的 —— 分片最容易出的错就是
    // "改了筛选逻辑之后某些套件谁都不跑"，而且没有任何信号（总时长还变短了）。
    const all = new Set(buckets.flat().map((s) => s.key));
    const miss = chosen.filter((s) => !all.has(s.key)).map((s) => s.key);
    console.log(`\n  并集校验：${all.size} / ${chosen.length} ${miss.length ? `· ❌ 漏: ${miss.join(", ")}` : "· ✅ 无遗漏"}`);
    await exitAfterFlush(miss.length ? 1 : 0);
  }
}

/**
 * 环境哨兵先行 —— 几秒钟, 换掉"跑完十几分钟才发现验错了对象"。
 *
 * 由来(2026-09-22): 那一晚全量 25 套(约 33 分钟)里有 3 个失败落在与改动无关的套件上,
 *   全是"在什么条件下跑"变了(cwd → .env 解析 → 数据根), 而不是代码回归。
 *   这类问题**推不出影响面**, 只能直接测 —— 那就提前测。
 *
 * `--no-sentinel` 跳过(用于"我知道环境是脏的, 就是要这么跑"的场合, 例如故意跨树对比)。
 */
/**
 * 退出前**显式冲刷 stdout** —— 不能用裸 `process.exit(1)`。
 *
 * ⚠ 2026-09-24 修。CI 里跑的是 `npm run verify:ui 2>&1 | tee /tmp/verify-ui.log`:
 *   管道是异步的, 而 `process.exit()` 立刻终止进程、**不等 stdout 写出去** ——
 *   于是失败时上传的工件只有 **1.6KB**(哨兵那几行 + 一行汇总),
 *   逐套的 ✅/❌ 与失败诊断**整段没进文件**。实测两次 CI 失败都是这个大小。
 *   等于当初加 artifact 想解决的"知道红了, 不知道红在哪"**根本没解决**, 只是看着像解决了。
 *
 * `process.stdout.write("", cb)` 的回调在缓冲区排空后才触发 —— 等它再退, 内容就丢不了。
 * (stdout 不是管道/文件时 cb 也会被调用, 所以这条在任何环境都安全。)
 */
async function exitAfterFlush(code) {
  process.exitCode = code;
  await new Promise((res) => { try { process.stdout.write("", res); } catch { res(); } });
  await new Promise((res) => { try { process.stderr.write("", res); } catch { res(); } });
  process.exit(code);
}

if (!argv.includes("--no-sentinel")) {
  /**
   * ⚠ 2026-09-24 另修一处"说了但没做": 这里一直**没把 `SENTINEL_ALLOW_MISMATCH` 传给哨兵**,
   *   尽管下面的提示语写着"加 SENTINEL_ALLOW_MISMATCH=1 把跨树降级为提醒" ——
   *   照提示做也不生效, 用的人只会以为是自己写错了。现在真的传下去。
   *   (哨兵自己读的是 `process.env.SENTINEL_ALLOW_MISMATCH` 与 `--allow-mismatch`。)
   */
  if (argv.includes("--allow-mismatch")) process.env.SENTINEL_ALLOW_MISMATCH = "1";
  const { runSentinel } = await import("./env-sentinel.mjs");
  const r = await runSentinel({ print: true });
  if (!r.ok) {
    console.error(`\n❌ 环境哨兵有 ${r.fail.length} 项不一致 —— 已中止, 没开始跑套件。`);
    console.error(`   这些不一致会让门禁验的不是你在改的代码, 先按上面的提示修。`);
    console.error(`   确实要这么跑: 加 --no-sentinel, 或 SENTINEL_ALLOW_MISMATCH=1 把跨树降级为提醒。\n`);
    await exitAfterFlush(1);
  }
  console.log("");
}

console.log(`UI 门禁: 跑 ${chosenShard.length}/${SUITES.length} 套` + (wantAll ? "(含数据依赖)" : "(默认组; 数据依赖的用 --all)"));
console.log(`前置: ${BASE} 已起\n`);

/**
 * 本轮开始时刻 —— 收尾清理用它界定"哪些是这次跑出来的"。
 *
 * ⚠ 必须在**跑套件之前**取。曾经想过用"最后一个套件结束时刻"之类的写法, 但那样界不定边界:
 *   套件之间还有间隔, 期间新建的会被漏掉。用开始时刻是**宁可多清一点**的方向,
 *   而这个方向是安全的 —— 见 cleanup-run-projects.mjs 里"只按时间、不按标题"那段说明。
 */
const RUN_STARTED_AT = new Date().toISOString();

/**
 * 这个套件到底算不算失败。
 *
 * ⚠ 2026-09-23 修, 起因是 CI 上看到这一行:
 *     ✅ fusion-tabs           58.1s  ❌ 0/5 通过
 *   **红着标了绿勾** —— 因为原先只看退出码(`code === 0`), 而有几个套件
 *   (`verify-fusion-tabs` 是其中之一)**自己算出失败却仍然 exit 0**。
 *   于是汇总行会撒谎: 总表说"全部通过", 逐行里却躺着 0/5。
 *   这类假绿比真红危险 —— 它让人以为门禁全都验过了。
 *
 * 判据改成**退出码 或 它自己打印的结论**:
 *   · 退出码非 0 → 失败(脚本崩了 / 自己 exit 1);
 *   · 退出码 0 但结论行以 ❌ 开头 → **也算失败** —— 这一条专治"算了但不退出"那种;
 *   · 结论行里出现 ERR → 失败(有些脚本用 ERR 标"动作没做成"),
 *     但**排除 "0 个 ERR" 这种把 ERR 当名词统计的句子**, 否则会把干净输出判成失败。
 */
function suiteFailed(code, out) {
  if (code !== 0) return true;
  const tail = out.trim().split("\n").filter((l) => l.trim()).slice(-1)[0] ?? "";
  if (tail.trim().startsWith("❌")) return true;
  return /ERR/.test(tail) && !/0\s*(个|项)?\s*ERR|ERR\s*[:=]?\s*0/i.test(tail);
}

/**
 * 跑一套 —— **自带重试**。
 *
 * 为什么并行前必须补这条（2026-09-27）：串行时每套独占机器，跑一次就是结论；
 *   并行后 4–6 个 Chromium 抢 4 核，**超时类偶发失败**会变成一个真实的日常现象。
 *   没有重试，门禁会时不时红一条无关的；而"偶尔红一条"最终等于"没人看门禁" ——
 *   本仓已经吃过这个亏（`sections-banners` 在 CI 上红了两周没人管）。
 *
 * ⚠ 重试**只对"看起来像资源竞争"的失败**生效，判据是 suiteFailed 的结果 + 退出码，
 *   **不区分具体错误类型** —— 这一点是有意的：把"哪些失败可以重试"写细，
 *   迟早会写出一张白名单，而白名单上的失败会被重试掩盖成绿的。
 *   重试上限 2 次（总共跑 3 遍），且**重试结果如实打印**（`(第2次通过)`），不藏。
 */
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
      const bad = suiteFailed(code, out);
      if (bad && out.trim()) {
        // 失败时把有意义的行挖出来, 免得只看到一行总结无从下手。
        // ⚠ 2026-09-23 补 `FAIL` 与 `DEAD` 与 `诊断`: 各脚本的失败标记**本来就不统一** ——
        //   assistant-coverage 用 `FAIL  `, 几个 probe 用 ` DEAD `, 其余用 `❌` / `ERR`;
        //   而 `诊断:` 是我给 fusion-tabs 加的自诊断行(`src=null` 那种摘要说明不了原因)。
        //   原先只匹配 ❌/ERR 两个, 于是 `通过 11 / 失败 4` 那套**四条失败一条都看不到**
        //   (CI 日志里就只躺着一行汇总), 新加的诊断也一起被吞掉 —— **加了等于没加**。
        //   判据统一不了, 至少把已知的这几种都收进来。
        // ⚠ 行数上限别设太小。踩过一次: fusion-tabs 失败时每个 tab 打 3 行诊断
        //   (结论 + iframe 数/尺寸/src + 按钮列表), 5 个 tab 共 15 行, 而这里是 8 ——
        //   结果我在 CI 日志里只看到前 3 行, 误以为"诊断没触发", 白跑了一轮 40 分钟的 CI。
        //   **加诊断的时候要一起想: 它会不会被这里截掉。**
        const detail = out.split("\n").filter((l) => /❌|FAIL|ERR|DEAD|JSERR|超时|诊断/.test(l)).slice(0, 30);
        if (detail.length) console.log(detail.map((l) => "     " + l.trim()).join("\n"));
      }
      resolve({ key: suite.key, code, bad, secs, out });
    });
  });
}

// ── 跑法：**默认串行**，可显式开并发 ──
//
// ⚠ 2026-09-27 实测结论：**并发不成立**，默认必须是 1。原注释写的"并发会互相抢端口/抢资源"
//   前半句已经不成立（`startCdp` 走 `resolveCdpPort`，端口动态解析），但**后半句是真的**，
//   而且比预想的严重。三个并行度都试过：
//
//   | 并行度 | 结果 |
//   |---|---|
//   | K=5 | 20 套里 **19 次重试**，`site-content` 连挂 3 次 |
//   | K=4 | 同样 19 次，14 套中招，成片 FAIL |
//   | K=2 | 刚跑 3 套就已经 2 次重试（`fusion-tabs` 0/5、`workbench-sync` 1 项异常）|
//   | K=1 | 全绿 |
//
//   而 **K=2 挂的那两套单独跑都过**（fusion-tabs 5/5、workbench-sync 10/10）——
//   所以不是端口冲突、不是数据互踩，是**机器一忙这些探针就读早了**：
//   它们大多靠固定 sleep 等页面（只有走 `openSoc` 的那批有就绪判据），
//   负载一上来，同样的睡眠时长就不够。要让它们抗负载，得逐套改成就绪轮询 ——
//   那是 30 多个文件的工作量，而且每改一套都要重新验它自己的断言，风险远大于收益。
//
//   **所以提速不在这条路上。** 真正可行的是 CI 侧分片（见 .github/workflows/ci.yml）：
//   把 34 套分给几个 runner 各跑各的，每个 runner 上仍是串行 —— 既保稳定，又线性缩短墙钟。
//
// 保留并发能力的原因：单机核多、且只想跑少数几套（`--only`）时它是有用的。
// 用 `VERIFY_UI_JOBS=N` 显式开启，看到 `↻ 重试` 就该知道是负载问题而不是回归。
const _cores = os.cpus().length || 4;
const K = Math.max(1, Math.min(Number(process.env.VERIFY_UI_JOBS) || 1, Math.max(1, _cores - 1), 6));
console.log(K > 1 ? `并发 ${K} 套（核数 ${_cores}）—— 注意：并发下超时类偶发失败会增多\n` : "");

const results = new Array(chosenShard.length);
{
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= chosenShard.length) return;
      let r = await runOne(chosenShard[i]);
      // 重试：并行下超时类偶发失败是真实存在的。结果如实标出来。
      let attempt = 1;
      while (r.bad && attempt < 3) {
        attempt++;
        console.log(`↻ ${chosenShard[i].key} 第 ${attempt} 次重试（上一次失败，可能是并发抢资源）`);
        r = await runOne(chosenShard[i]);
      }
      if (!r.bad && attempt > 1) r.retried = attempt;
      results[i] = r;
    }
  };
  await Promise.all(Array.from({ length: Math.min(K, chosenShard.length) }, worker));
}
for (const r of results) {
  if (!r) continue;
  const tail = (r.out ?? "").trim().split("\n").filter((l) => l.trim()).slice(-1)[0] ?? "(无输出)";
  console.log(`${r.bad ? "❌" : "✅"} ${r.key.padEnd(20)} ${r.secs.padStart(5)}s  ${tail.replace(/^\s+/, "").slice(0, 90)}${r.retried ? `  (第${r.retried}次通过)` : ""}`);
}

/**
 * 收尾: 清掉**本轮**新建的测试项目。
 *
 * 由来: 30 套里只有 3 套声明了清理, 其余探针建的种子不收尾 → 逐轮累积,
 *   audit 名下涨到 176(哨兵 400 就断门禁)。放在这里而不是逐个探针补,
 *   是因为**新探针不用做任何事**, 而且它同时是"探针自己忘了清"的安全网。
 *
 * 三条纪律(都写进 lib/cleanup-run-projects.mjs 的注释了, 这里只记要点):
 *   · 只按 `created_at >= 本轮开始` 判, **不按标题** —— 标题匹配会误伤真实项目;
 *   · **软删**(status='deleted'), 可逆 —— 批量动作一旦判据有偏差, 可逆与否决定代价;
 *   · **失败不影响结论** —— 它是收尾动作不是验证动作, 出任何错都只打一行提示。
 */
try {
  const out = execFileSync(
    process.execPath,
    [path.join(here, "lib", "cleanup-run-projects.mjs"), RUN_STARTED_AT, "--apply"],
    { encoding: "utf-8", env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || readDbUrl() }, timeout: 30_000 },
  ).trim();
  const m = /clean:(\d+)/.exec(out);
  if (m && m[1] !== "0") console.log(`\n🧹 已清理本轮产生的测试项目 ${m[1]} 个(软删, 可逆)`);
} catch (e) {
  console.log(`\n(收尾清理跳过: ${String(e?.message ?? e).slice(0, 80)})`);
}

// ⚠ 用 `bad` 而不是 `code`: 有的套件 exit 0 却自己算出失败(见 suiteFailed 的注释)。
//    这里曾经只认退出码, 于是汇总行会说"全部通过"而逐行躺着 ❌ 0/5。
const failed = results.filter((r) => r.bad);

/**
 * 分片覆盖的**运行时校验** —— 只读本片那一份套件清单，无法在这里直接算并集
 * （另一个分片的数据不在这台机器上）。所以校验放在**编排层**：
 *   · `--print-shards` 会打印并集校验（本地/CI 都能随时跑）；
 *   · CI 里 4 个分片各自打印"跑的是哪几套"，四份日志拼起来就是全集。
 * 这里只做一件廉价的对照：**本片跑完后，实际有结果的套件数必须等于分发下来的套件数** ——
 * 少了就说明结果数组有空位（worker 异常退出等），那种"少跑了但没人说"正是要拦的。
 */
if (results.some((r) => !r)) {
  console.log(`\n❌ 有 ${results.filter((r) => !r).length} 套没有产出结果（worker 异常退出？）—— 这不等于通过`);
  await exitAfterFlush(1);
}
console.log(`\n${failed.length ? `❌ ${results.length - failed.length}/${results.length} 套通过` : `✅ ${results.length}/${results.length} 套全部通过`}`);
if (failed.length) {
  console.log(`失败: ${failed.map((f) => f.key).join(", ")}`);
  const silent = failed.filter((f) => f.code === 0);
  if (silent.length) console.log(`  (其中 ${silent.map((f) => f.key).join(", ")} 是**退出码 0 但自报失败** —— 脚本该补 exit 1)`);
  console.log(`单跑排查: node scripts/<文件>.mjs  (对应关系见本文件 SUITES)`);
  await exitAfterFlush(1);
}

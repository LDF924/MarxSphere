# DOM 深采总解码(2026-09-08 真机 CDP 点击, DF 登录态)

> 方法: headless Edge + 复制 Default profile(保 cookie/localStorage), remote-debugging-port=9222,
> Runtime.evaluate + 原生 click 遍历 6 模块每可点元素; DOM 树采集器输出 标签+class(前8)+文本。
> 原文: docs/socialsci-chunks/deep/*.txt(56+3 文件)。本文件为结构汇总, 供源码对照。

## 全局骨架(site-header, 全模块一致)
- `.site-header` sticky top z-50 border-bottom #dce2e0 background #f7f? → 内含:
  - `__brand`(logo+社科研修云平台) / `__nav`(首页) / `__services`(button.active + `__dropdown`
    a×5: 在线科研工作流/科研审查/数据分析/科研绘图/学术文本编辑器) / `__nav-item`(科研选题/
    知识库查询/可视化DAG编排模式/团队介绍/科研协助/联系我们) / `__actions`(__workbench 工作台 +
    history-memo-inline __trigger is-subtle 历史 + __user avatar/name)
- 历史入口=顶栏按钮(history-memo), 点开是 history-memo 面板(9 rules css)

## 阶段进度条(phase-progress, workflow 页顶, data-v-3c3be9b6)
`.phase-progress-wrapper > .phase-progress-bar > .ppb-inner`:
- `ppb-topic`(280px 卡片: __topic-heading: label 研究主题+status is-success dot 已完成 + title) 
- `ppb-node .done/.active/.pending`(ppb-circle ✓/序号 + ppb-label, active 节点含 ppb-metric 如"9 章节")
- `ppb-line-wrap > .ppb-line .done/.pending` 连接线
- 尾: `ppb-new-btn` 新项目
- 顺序: 研究主题 → 1信息录入 → 2科研架构(9 章节徽标) → 3素材准备 → 4文本创作 → 5合稿定稿

## 通用弹层(全站一致形态)
`.fixed.inset-0.z-[70](或 z-50).flex.items-center.justify-center > .absolute.bg-black/20(或 /30,/40
+backdrop-blur) + .relative.bg-white.rounded-2xl.shadow-xl.w-[520|640px].max-w-[95vw].max-h-[85|90vh]`:
- 头: px-6 py-4 border-b: h3.text-lg.font-bold + × 灰按钮
- 体: p-6 space-y-4 overflow-y-auto(表单字段区)
- 脚: px-6 py-4 border-t flex gap-3: 主按钮(bg-red-600 text-white rounded-lg)=保存/生成, 次=取消
- toast 容器: `.fixed.top-16.right-4.z-[100]`(自动消失, 带 ✕)
- 关闭按钮体系: 取消/×/关闭 三态(遍历清理时按此找)

## workflow/materials 素材五类面板(手风琴)
每类=.bg-white.border.rounded-xl.overflow-hidden > 头.cursor-pointer.select-none.bg-gray-50
px-5 py-3.5(icon 红底圆角 + `text-base.font-semibold` 类名 + `0 项` 灰徽标 + 行内操作按钮
text-xs px-2 py-1 bg-white rounded-md + ▼) + 展开体条目卡。
- 文献检索: 检索文献/手动添加文献; 表格素材: 生成表格/添加表格; 理论素材: 生成理论/添加理论;
  数据分析素材: 上传图片/前往数据分析/前往科研绘图; 附件素材: 上传附件(支持 PDF/DOCX/TXT/
  Markdown/CSV/TSV 最大 25MB; 图片支持 PNG/JPG/JPEG/WebP 8MB)
- 4 步流程徽标+手动添加入口+设计思路(研究逻辑全文)+已整理素材
- 素材条目卡(实测真数据): 章节徽标(引言)+标题+编辑/删除+内容表格预览(Tab 分隔渲染表)+
  字数+日期 2026/9/8+`+ 继续搜集表格素材`按钮
- 门禁: 0 素材点确认 → toast「请先添加素材」(URL 不跳)

## workflow/workspace 三栏创作页
- 左 aside.w-72: 章节导航(0/3+进度条 h-full.bg-red-500)+workflow-outline-primary 主章按钮+
  章树(红数字徽标+折叠) + 智能全局思考(bg-gray-800)/返回素材准备/还有 3 章未完成
- 中 main.flex-1: 章标题 input(序号圆角块)+节 chips + 主控智能体思考 textarea(标注"主控智能体
  思考而成,可手动补充修改") + 章生成卡(待生成徽标+执行智能体开始思考 bg-slate-800) + 编辑/预览
  切换(bg-slate-800 激活)
- 右 aside.w-72.border-l.bg-gray-50/50: 素材库 h3 + 分类 select(全部素材/理论/数据/案例/方法/文献)
  + 素材卡(图标📊+标题+类型+字数+已关联徽标)

## statistics 三栏(statistics-workspace.flex.gap-5 max-w-1600)
- 左 aside.w-[260px]: tool-category×4 组(数据基础 5/推断统计 6/回归建模 2/信效度高级 3) +
  method-grid 内 `button.method-item.active`(17 法)
- 中 div.w-[360px]: 上传拖拽区(upload-label-sm)+tool-desc-mb+section-title-sm 分析变量(搜索/选择)
  +方法专属配置+btn-run-mb/btn-reset-mb
- 右 div.flex-1: 分析结果(results-body-mb)+欢迎卡(17 种徽标)
- 17 方法面板差异全在 deep/m3-method-*.txt(描述统计统计量勾选/数据转换 5 法复选含勾选状态/
  中介调节 X-Y-M select/信度 α 等)

## viz 双视图
- 图表视图: 对话区(0 条消息)+9 图表卡(散点/柱状/箱线/热力/回归拟合/逻辑回归/相关矩阵/
  子图网格/双轴图)+上传数据+需求 textarea+快捷模板 5 chips+0 字~0 tokens+发送
- 任务视图(viz-task-window): article.py-4 > 标题 h3+失败徽标(border-red-200 bg-red-50)+
  时间+对话 N 轮+查看任务+虚线框重试引导(模型完成了分析,但没有生成所要求的图表…)

## editor(ade- 体系, 全组件 ade- 前缀)
- ade-layout: ade-topbar(subtitle 在线文本编辑器+title+新建/保存/版本历史+status 已保存绿点)
  + ade-layout__body: ade-document-rail(文档列表 is-active/删除) + ade-editor-area(工具栏两行:
  row--format: font select(oman/Arial)+size select(小五9pt~三号16pt)+行距 select(单倍~双倍)+
  段后 select+颜色+荧光+清格式 | row2: B/I/U/S+H1/H2/H3/P(active)+UL/OL/引用/</>+←↔→+
  链接/图片+↩↪+导入/导出+辅助工具 assist-btn) + ade-editor-tiptap-wrap > .tiptap.ProseMirror
  .ade-editor-prose) + ade-statusbar(0 字 + 已锁定)
- ade-ai-panel 右抽屉(可拖 resize-handle): 6 tab(全文检查 4 卡: 全文逻辑/章节衔接/变量方法结论
  一致性/投稿前检查; 选区修改 5 按钮: 学术润色/减少模板化表达/压缩冗余/扩展论证/校对标点;
  题名摘要 3 卡: 优化论文标题(5候选)/优化摘要/提取关键词; 引用格式 2 卡: 引用一致性检查/格式与
  语言检查; 格式模板 4 卡+当前模板 SimSun·10.5pt·行距1.85; 图表: 生成图表)
- 弹层: 新建文档(标题 input+取消/创建) 空态: ade-editor-empty-card__actions 新建文档/上传 Word
- tiptap(ProseMirror 渲染), Word 导入(文件 input), 导出按钮

## review
- 空态: 粘贴文本/上传文件 tab + textarea + 严格度三档 radio(lax/standard/strict)+选用刊物
  select(不选用)+管理期刊库 a+选用审核标准 select+管理标准库 a+本次额外要求 textarea+
  开始审稿
- /review/library: 返回审稿|审稿库+期刊库/标准库 tab+7 分类 chips(全部分类/CSSCI/北大核心/SCI/
  SSCI/学位论文/普通期刊/其他)+新增期刊/AI 智能解析
- 新增期刊弹层: 刊物名称*+分类* 下拉 7 类+核心审稿要点 textarea("一行一条,AI 会自动识别…")
- 解析投稿须知弹层: 粘贴原文+智能解析+保存
- 创建审核标准弹层: 标准名称*+适用范围 select(全部学科/社科/理工/医学/自定义)+审查维度
  (+添加维度)+保存
- 新建审稿确认层: "开始新的审稿?当前审稿状态将清除。" 取消/确认
- 顶部: 论文审稿/审稿库 a/+新建审稿/往期审稿计数(0)+暂无审稿记录

## quick DAG(vue-flow 改名 agent-flow)
- .agent-flow-canvas > .vue-flow.agent-flow: viewport/edges(agent-edge-… 9 条)/nodes:
  `.vue-flow__node-agent > .agent-flow-node.is-draft.is-system-start[role=button]`
- 节点内部: node-header(node-index 00/06+node-module SYSTEM/STANDARD WORKFLOW+node-menu ...) +
  node-title-row strong + node-meta 输入/输出(值) + node-footer(node-state dot+→) + node-hint +
  vue-flow__handle bottom/top(source/target)
- 右键菜单 .canvas-context-menu: context-menu-title(节点名)+context-menu-item(查看节点详情↗)+
  is-muted(系统节点不可删除); 普通节点: 查看节点详情↗+删除模块×
- 底部启动门禁卡: "工作流已准备/点击开始后 Agent 将自动连续执行 Phase 1–5,直到生成最终稿。"
  +canvas-start-gate-button 开始自动执行
- 左对话 rail(agent-panel): agent-avatar Q+科研 Agent 在线+消息气泡(自然语言任务描述)

## 设计体系结论(CSS 全局文件 index-9BRpUt6j.css 122KB)
- 体系 = Tailwind 实用类(class="flex items-center gap-2 …")为主 + 每组件少量 scoped 语义类
  (BEM-ish: site-header__*, ppb-*, ade-*, agent-flow-node 等, 每类 data-v-hash 隔离)
- 主题色: 主操作 bg-red-600(保存/生成/开始全站统一红)+ 次操作 bg-slate-800(编辑器/工作台) +
  蓝紫点缀(indigo 变量卡/blue 链接); 绿色=成功态 dot/徽标
- 组件级语义类清单(重难点): ppb-40 rules / site-header 53 / history-memo 9 / ade-* / agent-flow-*
- 交互反馈: toast fixed top-16 right-4; hover 灰底; 禁点 muted/opacity

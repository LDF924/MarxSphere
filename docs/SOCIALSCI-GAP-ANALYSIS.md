# Social-Sci(社科研修云平台)→ MarxSphere 能力差距对照

> 2026-09-06 · 分析对象: social-sci.com「社科研修云平台」(闭源商业产品, AI 社科论文写作 SaaS)
> 信息来源: ①前端资源逆向(HTML/JS/CSS 公开资源, 32 chunk+主包) ②本人账号真实会话抓包(HAR 44MB, 1106 请求/155 端点) — 详见两份桌面报告
> 注: social-sci 闭源无仓库, 本文为**功能规格层对照**(哪些值得 MarxSphere 移植/吸收), 非源码移植。全部实现为原创代码, 交互形态与语义对齐; 不搬运其代码/文案/素材/UI 像素。

## 〇、图例

**证据分级**: EV1=UI 实证(前端视图逐帧逆向) / EV2=HAR 实测(真实会话跑通) / EV3=API 契约(端点+载荷还原) / R=推断(低置信, 待实测)

**五态判定**:
- ●+ = 已有-更强(功能超集, 直接引用现有服务)
- ● = 已有-等价(能力已具备, 仅需前端/入口补齐)
- ◐ = 已有-部分需补(核心在, 缺若干形态件)
- ○ = 缺失-真缺口(需原创新建)
- ✖ = 不做及理由(照搬有害 / 与路线冲突 / 版权与合规风险)

## 一、方法学

1. **信息源**: 桌面 `social-sci-逆向分析报告.md`(130 端点 API 字典+状态机+五阶段流水线还原)+ `social-sci-HAR深度分析.md`(真实数据模型+SSE 协议+计费实测)。证据按上表分级, 仅 API 契约层推断的条目标注待实测, 不做过度断言。
2. **对拍基准**: MarxSphere 开发主线 `C:\Users\HUAWEI\SAG-main`(Fastify5+React19+TS; 730 路由/195 服务/40+ 视图/110+ 表; 迁移至 113)。公开版 MarxSphere-product 为其清洗快照(落后约 6 天, 无 paper-outline 等 SAG 独有件), 对拍以 SAG-main 为准。
3. **原创实现边界**: 功能规格与交互形态对齐, 代码全原创。每文件头声明「参考 XX 交互, 不涉源码」(同 `paper-outline-service.ts` 既有先例范式)。商业功能数据(期刊/标准)由用户自采自录, 不搬运对方站点内容。

## 二、总览: A-L 十二域 × 五态

| 域 | 条目数 | ●+ | ● | ◐ | ○ | ✖ |
|---|---|---|---|---|---|---|
| A 科研工作流平台 | 12 | 0 | 1 | 3 | 8 | 0 |
| B 在线学术文本编辑器 | 6 | 0 | 0 | 1 | 5 | 0 |
| C 在线科研审查(审稿/期刊库) | 9 | 0 | 1 | 4 | 4 | 0 |
| D 在线数据分析 | 8 | 6 | 0 | 0 | 2 | 0 |
| E 在线科研绘图 | 7 | 0 | 0 | 0 | 7 | 0 |
| F 知识库 RAG | 7 | 6 | 0 | 0 | 1 | 0 |
| G AI 助手/编排 | 8 | 4 | 1 | 1 | 2 | 0 |
| H 账号/积分/计费 | 12 | 0 | 3 | 1 | 8 | 0 |
| I 管理后台 | 11 | 4 | 2 | 3 | 2 | 0 |
| J 内容营销页 | 7 | 0 | 0 | 0 | 7 | 0 |
| K 工程/平台特性 | 10 | 3 | 3 | 2 | 2 | 0 |
| L HAR 实证细节 | 9 | 0 | 3 | 2 | 1 | 3 |
| **合计** | **106** | **23** | **14** | **17** | **49** | **3** |

**真缺口 49 项, 全部有批次归属(见 §六), 零悬空。不做 3 项见 §七。**

## 三、逐项对拍矩阵

### A. 科研工作流平台(在线科研工作流平台+可视化 DAG 编排模式)

| # | 能力 | 证据 | MarxSphere 现状 | 态 | 批次 | 方案 |
|---|---|---|---|---|---|---|
| A1 | **可视化 DAG 科研工作台**(画布节点=研究要素, 连线=产物依赖; 节点可开工作界面) | EV1(QuickMode 243KB) | 无画布科研编排(AgentConsole 是列表式) | ○ | P0-1 | S-01 xyflow 画布+research_projects.canvas |
| A2 | 双态: 标准工作流模板(五阶段)与画布任务(NL→自动拆研究框架) | EV1 | PaperOutlinePanel 线性大纲(轻量写作台) | ◐ | P0-1 | S-02 dagTemplates+nlToDag |
| A3 | 任务容器跨模块(task+module: workflow/review/statistics/viz/knowledge) | EV2 | agent_tasks(52步推理专用)+各域自管 | ◐ | P0-1 | S-03 research_tasks 并列层 |
| A4 | 节点快照 UI 断点持久化(每 UI 阶段 node_key 全量 JSON, 刷新原地恢复) | EV1+EV2 | 无(会话态) | ○ | P0-1 | S-04 research_nodes+history |
| A5 | 需求澄清(可选, AI 生成结构化问题, 模板化归档) | EV2 | 无专门澄清流 | ○ | P0-1 | S-05 |
| A6 | 主控 Agent P1 分析(全局思考→变量/章节规划→派发执行) | EV3 | 52 步推理主链(更强, 复杂分析委托) | ●+ | P0-1 | S-06 适配器接入 |
| A7 | 变量识别(定量: 自/因/中介/调节/控制; 定性: 逻辑框架) | EV1+EV2 | empirical-variables-service 已有 | ●+ | — | 引用, 不重建 |
| A8 | 章节规划+技能挂载(skill_prompt) | EV1 | paper-outline generateChapter+技能系统(201) | ● | P0-2 | S-07 适配器注入素材 |
| A9 | 素材库(4 类素材生成/AI 分配/拖入正文) | EV2 | writing-corpus(语料库, 不同语义) | ○ | P0-2 | S-08 research_materials+Drawer |
| A10 | 合并定稿(标题/摘要/关键词/正文/参考文献五段式+终稿激活) | EV2 | paper-outline 要件生成+docx 导出 | ◐ | P0-2 | S-09 finalize 节点+发布 |
| A11 | 快照可回滚+阶段版本发布+断线续传(after=N) | EV2 | document_versions(090, 文档级) | ○ | P0-1 | S-10 指针快照 |
| A12 | 降重/去 AI 痕迹 humanize(流水线末位正式步骤) | EV3 | writing-output 无 humanize 语义 | ○ | P0-5 | S-11 rewrite 族并入 |

### B. 在线学术文本编辑器

| # | 能力 | 证据 | MarxSphere 现状 | 态 | 批次 | 方案 |
|---|---|---|---|---|---|---|
| B1 | 文档 CRUD+版本保存/切换+文档锁心跳 | EV2(doc#10 全程锁/心跳/保存) | doc-session-service(锁)+document_versions | ◐ | P0-5 | S-12 documents_v2 业务表 |
| B2 | 选区改写 5 模式(压缩冗余/去模板化/学术润色/语病/中文期刊风格) | EV1 | writing-output 段落改写(无选区/模式化 UI) | ○ | P0-5 | S-13 rewrite 端点+悬浮条 |
| B3 | 全文检查(逻辑/变量-方法-结论一致性/文本一致性) | EV1 | paper-quality(5 检查, 不同形态) | ○ | P0-5 | S-14 check-fulltext |
| B4 | AI 图表代码→渲染→插入正文 | EV1 | 无编辑器内图表插入 | ○ | P0-5 | S-15 chart-code(viz runner) |
| B5 | 编辑器内 AI 对话/模型选择 | EV1 | ChatPanel 通用对话 | ● | P0-5 | 引用上下文 |
| B6 | 诚实性边界: 不验证文献真实性(产品声明) | EV1 | citation-verify 反着做(核验) | ✖ | — | 设计注记(不同定位) |

### C. 在线科研审查(审稿任务流+期刊标准库)

| # | 能力 | 证据 | MarxSphere 现状 | 态 | 批次 | 方案 |
|---|---|---|---|---|---|---|
| C1 | 审稿 job(传稿/PDF 分段→汇总) | EV2(完整审一篇) | paper-quality 单次检查 | ○ | P0-3 | S-16 review-service |
| C2 | SSE 流式审稿(review.delta 维度 JSON 边流边渲染) | EV2 | format-eval SSE(不同域) | ○ | P0-3 | S-17 stream-utils |
| C3 | 维度评分卡+批注(paperTitle/wordCount/dimensions[]) | EV2 | ReviewerCard(SAG 独有雏形) | ◐ | P0-3 | S-18 对齐 schema |
| C4 | 期刊库+投稿须知 AI 解析入库(parse) | EV1 | cjournal(选题方法论, 非投稿须知库) | ◐ | P0-3 | S-19 review_journals |
| C5 | 审核标准库(自定义维度/解析/设默认) | EV1 | 无 | ○ | P0-3 | S-19 |
| C6 | 审稿选用刊物规则(parsed_rules 并入维度) | EV1 | 无 | ○ | P0-3 | S-20 |
| C7 | Word 审稿批注导出+HTML 打印 PDF | EV1 | format-docx-service(python-docx 通道) | ◐ | P0-3 | S-21 review_annotations.py |
| C8 | 审稿历史/详情/取消/重试 | EV2 | review_queue(间隔复习, 不同语义) | ◐ | P0-3 | S-22 避开命名 |
| C9 | 稿件正文提取(文件→纯文本) | EV2 | server.ts ~5404 V412 问卷解析 Python 通道 | ● | P0-3 | 引用 |

### D. 在线数据分析

| # | 能力 | 证据 | MarxSphere 现状 | 态 | 批次 | 方案 |
|---|---|---|---|---|---|---|
| D1 | 描述统计/箱线直方 | EV2 | empirical-pipeline 已有 | ●+ | — | 引用 |
| D2 | t 检验(单/独立/配对)/ANOVA/多因素 | EV2(t-test 实跑) | empirical-regression+scripts 已有 | ●+ | — | 引用 |
| D3 | 相关/卡方交叉表/非参数/正态性 | EV1 | empirical 17 方法已有 | ●+ | — | 引用 |
| D4 | OLS/Logistic/信度 α/EFA/中介 Bootstrap/调节 | EV1+EV2 | empirical-reliability/regression 已有 | ●+ | — | 引用 |
| D5 | 上传即自动 profiling(行/列/类型/缺失/唯一) | EV2(21 行 4 列实证) | 无 | ○ | P0-5 | S-23 /api/empirical/profile |
| D6 | 数据前处理(标准化/中心化/对数/排名/开方+分类汇总) | EV1 | 部分(插补有, 转换入口无) | ○ | P1 | S-24 前处理卡 |
| D7 | 统计结果导入素材库 | EV1 | 无(empirical_ledger 账本有) | ○ | P0-6 | S-25 导入钩子 |
| D8 | 图表产物+任务可重跑 | EV2 | empirical 结果+图已有 | ●+ | — | 引用 |

### E. 在线科研绘图(对话式 Agent)

| # | 能力 | 证据 | MarxSphere 现状 | 态 | 批次 | 方案 |
|---|---|---|---|---|---|---|
| E1 | NL 对话出图 Agent 循环(plan→thinking→tool→chart→…) | EV2(全流) | 图表解析有(thu-digitizer), 生成无 | ○ | P0-4 | S-26 viz-agent-service |
| E2 | Python analyze_data 真实计算(非幻觉图表) | EV2 | spawnPythonTask 范式+venv | ◐ | P0-4 | S-27 viz_runner.py |
| E3 | critique 自审→critique_fix 自动修订闭环(≤2 轮) | EV2 | 无 | ○ | P0-4 | S-28 强制步骤 |
| E4 | 版本化产物 png+svg_editable(可再编辑矢量) | EV2 | 无 | ○ | P0-4 | S-29 viz_artifacts |
| E5 | 会话上下文多轮改图(session+conversation 随请求) | EV2 | ChatPanel 会话模式 | ◐ | P0-4 | S-30 viz_messages |
| E6 | 产物用户目录+hash 防枚举 | EV2 | 文件服务有(不同布局) | ◐ | P0-4 | S-31 |
| E7 | cancel/retry/delete+健康检查 | EV2 | jobs-service 控制语义 | ● | P0-4 | 引用 |

### F. 知识库 RAG

| # | 能力 | 证据 | MarxSphere 现状 | 态 | 批次 | 方案 |
|---|---|---|---|---|---|---|
| F1 | 四库检索(全库/文献摘要/指标/量表) | EV1 | Ask 四源(Cognee+Graphiti+PG+全文) | ●+ | — | 引用 |
| F2 | 意图分流(rag.intent: source/keywords/entities/focus) | EV1+EV2 | 场景化检索 66 条+意图识别 | ●+ | — | 引用 |
| F3 | **evidence 流式引用徽标**(编号引用→可点击→文献详情) | EV1+EV2 | citation 来源可追溯有, 徽标交互无 | ○ | P0-6 | S-32 AskPanel 徽标吸收 |
| F4 | 检索任务重试追链(retryOf) | EV2 | jobs retry 语义 | ● | — | 引用 |
| F5 | 分步状态(planning→retrieving→found→generating) | EV2 | Ask 18 步逐步点亮 | ●+ | — | 引用 |
| F6 | 知识库健康页 | EV1 | 数据源管理视图 | ● | — | 引用 |
| F7 | 社科语义四库(指标/量表为社科定制) | EV1 | 语料侧重马理论经典 | ◐ | P2 | 语料子库扩展 |

### G. AI 助手/编排

| # | 能力 | 证据 | MarxSphere 现状 | 态 | 批次 | 方案 |
|---|---|---|---|---|---|---|
| G1 | 意图识别入口分流 | EV3 | agent-navigation/intent 类已有 | ●+ | — | 引用 |
| G2 | research-session+乐观锁 stateVersion | EV3 | agent_task_lease(107)已有 | ● | — | 引用 |
| G3 | 任务租约锁(owner+release-lock) | EV3 | agent_task_lease 已有 | ●+ | — | 引用 |
| G4 | 导航 Agent(下一步决策+页面引导) | EV1 | 52 步自省+Guardian 决策已有 | ●+ | — | 引用 |
| G5 | **悬浮助手 FAB**(页面观察+导航引导+签到卡+任务推荐) | EV1 | EduFeedbackFAB(教育域, 单页) | ○ | P0-7 | S-33 FloatingAssistantFAB |
| G6 | 每日签到问候卡(悬浮助手内) | EV1+EV2 | 无 | ○ | P0-8 | S-34 points 集成 |
| G7 | 任务推荐(基于会话上下文) | EV1 | agent-proactive-research 已有 | ◐ | P0-7 | S-33 聚合入口 |
| G8 | DAG 画布任务(主体科研入口) | EV1 | 见 A1 | ○ | P0-1 | S-01 |

### H. 账号/积分/计费

| # | 能力 | 证据 | MarxSphere 现状 | 态 | 批次 | 方案 |
|---|---|---|---|---|---|---|
| H1 | 注册带 role+邀请码(前端字段) | EV3 | 无(043 users.role 由 admin 设) | ✖ | — | 不仿(越权面), 见 §七 |
| H2 | 微信扫码免注册登录(ticket 轮询) | EV1 | 无(仅 Agent OAuth/企业微信 IM) | ○ | P0-8 | S-35 wechat-auth-service |
| H3 | 微信绑定既有账号 | EV1 | 无 | ○ | P0-8 | S-35 |
| H4 | 微信注册 | EV1 | 无 | ○ | P0-8 | S-35 |
| H5 | 邀请码+首账号(first-user) | EV1 | 无(注册开放) | ○ | P0-8 | S-36 冷启动控制 |
| H6 | 每日签到+20 分 | EV2 | 无 | ○ | P0-8 | S-37 checkin |
| H7 | 兑换码+批次管理 | EV1+EV2 | 无(充值 recharges 有) | ○ | P0-8 | S-38 redeem |
| H8 | 按量消费(双 amount 冻结→实扣对账) | EV2(rag 扣 2.63) | billing 余额扣费(实时单笔) | ◐ | P0-8 | S-39 freeze/settle |
| H9 | 负余额挂账继续服务 | EV2(-35.7 实证) | **禁止透支(替代)** | ✖ | — | 不仿, 见 §七 |
| H10 | 每日调用计数+消耗分布 | EV2 | user_usage_log/usage_daily 已有 | ● | P0-8 | 引用 |
| H11 | 管理员充扣(grant/deduct) | EV3 | admin 手动余额调整有 | ● | P0-8 | 扩展 points |
| H12 | 联系管理员表单 | EV1 | feedback 已有 | ● | — | 引用 |

### I. 管理后台

| # | 能力 | 证据 | MarxSphere 现状 | 态 | 批次 | 方案 |
|---|---|---|---|---|---|---|
| I1 | 用户管理 | EV1 | AdminPanel 已有 | ● | — | 引用 |
| I2 | 计费管理+配置 | EV3 | billing 管理已有 | ● | — | 引用 |
| I3 | points 运营(充扣/批次/交易) | EV1 | 无 | ○ | P0-8 | S-40 |
| I4 | 模型管理 | EV3 | llm-model-registry+AdminPanel 已有 | ●+ | — | 引用 |
| I5 | API 用量/审计/日志 | EV3 | trace/audit_logs 已有 | ● | — | 引用 |
| I6 | crawler 控制(SSRF 候选) | EV3 | **不做**(url-guard 已内化 SSRF 教训) | ✖ | — | 见 §七 |
| I7 | 配置原子保存+batch | EV3 | ai_provider_settings 原子保存有 | ◐ | P1 | S-41 batch 扩 |
| I8 | OpenAI-key 库 | EV3 | agent-credentials 有(不同形态) | ◐ | P1 | S-42 |
| I9 | KB 文件管理 | EV3 | sources-registry 已有 | ● | — | 引用 |
| I10 | AI 连通测试 | EV3 | settings 诊断有 | ● | — | 引用 |
| I11 | 配置诊断 config-diagnosis | EV3 | startup-check 已有 | ● | — | 引用 |

### J. 内容营销页

| # | 能力 | 证据 | MarxSphere 现状 | 态 | 批次 | 方案 |
|---|---|---|---|---|---|---|
| J1 | 落地页 CRUD+验证码 | EV1 | 无营销页(产品工作台) | ○ | P2 | S-43 config_texts |
| J2 | 新闻/公告 | EV1 | alerts 系统内告警(不同) | ○ | P2 | S-43 |
| J3 | 合作案例/帮助/免责/隐私/条款 | EV1 | 无 | ○ | P2 | S-43 |
| J4 | 资源导航(websites/categories) | EV1 | 无 | ○ | P2 | S-44 |
| J5 | 科研选题页 | EV1 | cjournal 选题方法论(更强) | ●+ | P2 | 引用展示 |
| J6 | 1v1 服务/联系表单 | EV1 | contact-admin 类无 | ○ | P2 | S-45 |
| J7 | 期刊展示页 | EV1 | cjournal 期刊匹配 | ◐ | P2 | 展示化 |

### K. 工程/平台特性

| # | 特性 | 证据 | MarxSphere 现状 | 态 | 批次 | 方案 |
|---|---|---|---|---|---|---|
| K1 | SSE 事件模块前缀命名(rag.*/review.*/viz.*) | EV1+EV2 | /api/search/stream 先例(单点) | ◐ | P0-1 | S-46 stream-utils 抽取 |
| K2 | 结构化错误 {code,userMessage,canRetry,hint} | EV2(PHASE3_JOB_FAILED) | jobs 错误对象有(形状不同) | ◐ | P0-1 | S-47 统一形状 |
| K3 | job 四态控制+retryOf 追链 | EV2 | agent-task-service controlAgentTask | ● | P0-1 | 引用 |
| K4 | 版本化体系(文档/图表/阶段/终稿四层) | EV2 | document_versions(文档层) | ◐ | P0-1/2/4 | S-10/29 |
| K5 | 任务容器+节点原子覆盖 | EV2 | 无 | ○ | P0-1 | S-04 |
| K6 | 租约锁+乐观锁+release-lock | EV3 | agent_task_lease(107) | ● | — | 引用 |
| K7 | 断线恢复(SSE after=N+节点恢复) | EV2 | 无 | ○ | P0-1 | S-48 |
| K8 | 1s 轮询 active job(坏味道) | EV2 | **不仿**: 全真 SSE | ✖ | — | 见 §七 |
| K9 | 上传→自动 profile→按需取 content | EV2 | files 服务有(profile 无) | ◐ | P0-5 | S-23 |
| K10 | 模型独立配置(model_viz 等) | EV3 | llm-model-registry role 表 | ● | P0-1 | S-49 补 role |

### L. HAR 实证细节(吸收/对照)

| # | 项 | 证据 | MarxSphere 对策 | 批次 |
|---|---|---|---|---|
| L1 | 模型 deepseek-v4-flash | EV2 | role 表映射, 不写死厂商 | P0-1 |
| L2 | Node+Python 双引擎 | EV2 | 同架构已有(empirical) | P0-4 |
| L3 | 双 amount 计费 | EV2 | freeze/settle 对账(替代挂账) | P0-8 |
| L4 | ID 体系前缀(wfjob_/node_…) | EV2 | uuid 主键惯例, 不照抄 | — |
| L5 | 高频轮询(313+183 次) | EV2 | 真 SSE+心跳节流 | P0-1 |
| L6 | 文件 profiling | EV2 | /api/empirical/profile | P0-5 |
| L7 | P3 bug `first is not defined` | EV2 | 借鉴: 分步重试设计要稳 | — |
| L8 | 产物路径 {userId}/{hash} | EV2 | 同语义自研布局 | P0-4 |
| L9 | clarify 归档(无答也归档) | EV2 | 同语义(模板化归档) | P0-1 |

## 四、实现语义差异深析(设计注记, 不贴代码)

1. **任务容器与节点快照**: social-sci task+module 容器承载全模块任务, 每 UI 阶段一个 node_key 全量 JSON 原子覆盖+历史行。MarxSphere 用 research_tasks(research 项目级, 并列于 agent_tasks 不动)+research_nodes+research_node_history 实现, 回滚=取历史回写当前(version+1)。
2. **SSE 事件规范**: 模块前缀命名(review.*/viz.*/pipe.*), 统一 attachSse 工具, 错误形状统一 {code,userMessage,canRetry,hint}。工作流主状态不用轮询(坏味道), 全真 SSE。
3. **双 amount 计费**: 消费=insert freeze 行(冻结)→核销=insert settle 行(实扣转账); 对账 SQL 比较两列和与余额变动。与 billing(balance_cents 真钱/token)解耦, 积分管 feature 计点。
4. **断线续传**: stream?after=N 服务端按已发事件序号续发, 从 research_tasks.progress 恢复。
5. **悬浮助手机制**: 页面观察(workspaceView 历史 localStorage)+推荐规则表(前端)+任务推荐聚合(服务端)。
6. **版本指针快照**: 发布=记录 {node_key: history_id} 引用, 不复制 payload(防膨胀)。

## 五、缺口技术方案要点(编号 S-01…S-49 全量见矩阵; 核心方案摘录)

| 条目 | 方案 | 复用底座 | 风险 |
|---|---|---|---|
| S-01 | xyflow 画布组件+research_projects.canvas(JSON 画布态) | 前端 xyflow 依赖已有 | 画布并发保存冲突(乐观锁) |
| S-03 | research_tasks: dag_node_id/depends_on/progress/retry_of; 与 agent_tasks 并列不动 | agent-task-service controlTask 语义 | 双任务体系混淆(文档明示边界) |
| S-04 | research_nodes unique(project_id,node_key)+node_history append-only | 090 document_versions 思想 | 全量 JSON 体积(历史行限长) |
| S-07 | 适配器包 generateChapter 注入素材/前文 | paper-outline-service | LLM 调用成本(节点记账) |
| S-13 | rewrite 5 模式+humanize 单端点 | writing-output-service 改写风格 | 模式边界模糊(提示词分离) |
| S-16 | 分段审稿+SSE delta+末次聚合 | server.ts 文件解析通道 | 长稿 token(2000-4000 字分段) |
| S-19 | review_journals 投稿须知 parse 入库(LLM JSON+zod) | paper-outline llmJson 模式 | 解析质量(需人工确认) |
| S-21 | python-docx 批注导出 | format-docx-service venv | venv 兼容(E2E 冒烟+HTML 兜底) |
| S-26 | viz-agent 独立循环 plan→analyze→chart→critique≤2 轮 | spawnPythonTask+matplotlib Agg | 图表幻觉(强制真实计算) |
| S-35 | 微信扫码 ticket 轮询(3min TTL)+mock 模式 | auth-service JWT | 真机资质(mock 先行) |
| S-39 | points freeze/settle 双字段对账+禁止透支 | 无(新) | 对账不平(审计 SQL) |

## 六、分期路线图(迁移 114 起; 每批可验证里程碑)

| 批次 | 内容 | 迁移 | 交付验收 |
|---|---|---|---|
| P0-1 | 可视化 DAG 工作台(画布项目+NL转DAG+模板)+任务容器/节点快照/SSE 基座+主控分析 | 114/115 | 建画布→NL 转 DAG/选五阶段模板→连线→节点开工作界面; 刷新恢复; SSE after=N 续传; agent_tasks 回归通过 |
| P0-2 | DAG 执行引擎(依赖就绪排程)+素材库+章节生成贯通+合并定稿+版本发布 | 116 | 逐节生成→快照回滚→发布; 素材注入下游; import-outline 双向桥接 |
| P0-3 | 审稿任务流+期刊库/标准库+Word 批注 | 117 | 传稿→SSE 维度涌入→报告→期刊 parse→Word 导出→入素材 |
| P0-4 | 对话式科研绘图 Agent | 118 | "画个图"→真实计算→出图→critique 修订→SVG 再编辑→redo→入素材 |
| P0-5 | 在线学术编辑器(EditorView)+改写族+全文检查+图表插入+profiling | 119 | 建文档→锁心跳→选区改写→全文检查→图表插入→版本切换; profile 出列结构 |
| P0-6 | Ask evidence 徽标吸收+素材导入钩子收口 | — | 编号引用可点→文献详情; 实证/审稿/绘图一键入素材 |
| P0-7 | 悬浮助手 FAB(观察/签到卡/任务推荐) | 120(可选) | FAB 随页面变推荐; 签到卡一键 |
| P0-8 | 积分商业化(签到/兑换/对账/充扣)+微信登录+邀请码首账号 | 121/122 | 对账 SQL 跑平; mock 扫码登录; 首账号免邀请码 |
| P1 | 管理后台补齐(openai-key/原子配置/ai-usage)+数据转换入口 | 123/124 | 各卡可用 |
| P2 | 内容营销页全套 | 125 | 静态页可访问 |

## 七、不做清单及理由(照搬有害 → 替代设计)

| # | social-sci 设计 | 问题 | MarxSphere 替代 |
|---|---|---|---|
| 1 | 注册含 role 字段 | 越权面(服务端校验压力) | 邀请码只挂积分与归属, 提权走 admin 手动(043 users.role) |
| 2 | 负余额挂账继续服务 | 坏账无界 | 禁止透支: 冻结失败即提示, admin adjust 冲正 |
| 3 | crawler/爬虫域(admin crawler-test) | SSRF 攻击面 | 不做; url-guard/checkNetworkAccess 已内化 SSRF 教训 |
| 4 | 1s 轮询 active job | 无谓负载 | 全真 SSE; 扫码短窗 2s 轮询限 3min TTL |
| 5 | wfjob_/node_ 前缀 ID | 与全仓 uuid 惯例冲突 | uuid 主键, node_key 用业务名 |
| 6 | 版本发布整存大 JSON | 存储膨胀 | 指针快照(history 行引用) |
| 7 | 694KB 单体视图 | 不可维护 | 组件树拆分 ≤ EmpiricalResearchPanel 同级 |
| 8 | 编辑器"不验证文献真实性"定位 | 与 MarxSphere citation-verify 定位冲突 | 保留各自定位, 服务注释写明边界 |
| 9 | 审稿报告生成引擎重造 | 重复建设 | 已有 paper-quality/format-eval 超集, 不重造 |

## 八、结论

1. **最强可吸收**: 六前台模块(科研工作流/DAG 编排/科研审查/数据分析/科研绘图/学术编辑器)的产品形态完整、操作闭环顺——MarxSphere 缺的不是零件(检索/Agent/统计底座更强), 是**工作台形态与跨模块任务编排**。
2. **最大差距**: DAG 画布工作台(P0-1)+素材闭环(P0-2)+编辑器形态(P0-5)——三者合起来就是 social-sci 的"纵向一体化研究 OS"体验。
3. **吸收而非重建**: F 域 RAG 四库、D 域统计方法、G 域 Agent 编排,MarsSphere 均已有更强实现, 只吸收交互细节(evidence 徽标)与计费语义(双 amount)。
4. **边界**: 本文档为内部对拍, 全部实现原创, 不搬运对方代码/文案/素材; 交互对齐参照既有 PaperOutlinePanel「参考 Respal 交互」先例范式。

---
附: 桌面报告索引
- `social-sci-逆向分析报告.md`(2026-09-06, 130 端点字典/状态机/方法论)
- `social-sci-HAR深度分析.md`(2026-09-06, 真实数据模型/SSE 协议/计费实测)

---

## 附录 A: HAR 二次全量审计记录(2026-09-06 修正版)

> 首次对拍基于端点聚合+响应抽样, 遗漏了动作链与高频请求中的深层信息。用户质疑后重做:
> **229 条时间链切分(>3s 断链) + 150 个低频端点逐条 + 高频请求按响应演变而非计数**。两轮修正:

### A1. 第一轮修正(低频端点逐条对照) — 14 项真漏已补(提交 6fcc12e/6e559b9/e4c22ee)
| 漏项 | HAR 实证 | 补齐 |
|---|---|---|
| 审稿 Word 导出 | POST /api/review/export-report | review_annotations.py+exportReportWord |
| 统计图表产物 | PUT /statistics-jobs/artifacts/{id}/image | stats_artifacts 表+4 端点 |
| AI 素材生成 | POST /ai/material/generate(按章节 count) | research-materials aiGenerateMaterial |
| 素材来源文献 | GET /materials/{id}/sources | source_docs 字段+端点 |
| 素材采纳挂章 | phase3 version materialUsages | adoptMaterial(section_ids) |
| 跨任务工件导入 | POST /workflow/versions/artifacts/import(wfart+contentHash) | research_artifacts 表+哈希幂等 |
| 文件 content 读取 | GET /files/{id}/content | user_files 表+原始字节下载 |
| 上传即剖析 | profile 返回列结构 | user_files.profile(CSV 行列) |
| 知识库会话删除 | DELETE /knowledge/sessions/{id} | mcp_sessions 清理端点 |
| viz_data 节点 | GET /tasks/{id}/nodes/viz_data | 兼容端点 |
| tasks/default | PUT /api/tasks/default | 最近项目兜底 |
| P3 文献/理论/表格子任务 | phase3/{literature-search,theory-generate,table-generate} | 专用执行器+端点 |
| P4 批量(带 skill_prompt) | phase4/batch sectionSnapshots | runChapterBatch(snapshot.sections) |
| P5 merge/review/revise | phase5/{merge,review,revise} | runPhase5 执行器 |

### A2. 第二轮修正(高频非噪音) — 深层数据模型已补(提交 ffd12f7)
**方法论教训: 313 次轮询不是重复 — 响应演变=状态机录像(phase2→4→5 时间戳); 24 次 PUT 是写入。**
| 深层字段 | HAR 实证 | 补齐 |
|---|---|---|
| aiSkill 9 字段写作卡 | sections[].aiSkill{type,wordCount,writingGoal,keyPoints,notes,connection,sectionTitle,frameworkSource,chapterDraft,childSections} | chapter_skill_cards+generateChapterSkillCard |
| 任务级整包快照 | PUT task 的 snapshot 23键(phase/projectId/input/sections/materials/merged*/variables...) | workbench_snapshot 列+GET/PUT |
| _englishAbstract | 快照含英文摘要 | english_abstract 列 |
| variables 语义化 | [{name,role,description}] 含可操作化 | 由整包快照承载 |
| skillStepDone | {1,2,3} 逐步技能状态 | 快照承载+技能卡批量 |

### A3. 审计法沉淀(后续对标复用)
1. 时间链切分: >3s 断链还原"一次点击→一串 API"
2. 响应演变分析: 高频请求按 payload 差异计数, 不按请求次数
3. 最深载荷挖取: 排序取最大 PUT/POST payload 找"整包状态"载体
4. 每轮结论必须带"审计方法说明", 防抽样偏差(本次两轮教训)

### A4. 第三轮(逐条审计 1106 条) — R4~R6 补漏(提交 da2cfaa/788d237/ce2aaa7)
**审计法**: 81 端点模板逐条结构签名比对(脚本 har_line_audit) + 大响应逐字段。本轮验证:
| 发现 | 补法 |
|---|---|
| review result 全 schema(overallScore/grade/annotations[{id,type,dimension,highlightText,comment}]/highlights/topSuggestions/dims含maxScore+weight+status+summary/issues含location+originalText) | 迁移126 + runReviewJob 聚合升级 |
| review_jobs 扩展(settings_json/rules_json/content_hash/source_file_*/sidebar_task_id/cancel_requested) | 迁移126 + createReviewJob 全参数 |
| clarify 响应含 analysis+5问题{category/guidance/importance} | /api/clarify/generate 完整端点 |
| versions/current state 含 stale 检测 | /api/research/versions/current |
| statsjob 计费(charge_points/billing_status/billing_policy)+result_version_id+artifact_ids | 迁移127 + saveEmpiricalResult 计费落库 |
| rag.intent 16键+evidence citation_index | AskPanel 已有四源+徽标覆盖, 标注不重建 |

### A5. 审计终态(三轮后)
1106 条 = 31 assets + 622 health/active心跳(已核: 响应演变=状态机录像) + 453 低频动作(81 模板逐字段过)。
三轮共补 6 个提交(组1-4+R2+R3)+3 个提交(R4-R6)。迁移至 127。全量 798 测试零回归。

### A6. 第四轮(UI层组件级审计, 2026-09-06) — 布局/组件/交互逐视图
12 视图全逆向(InputView/Sections/Materials/Workspace/Finalize/Review/Editor/QuickMode/FloatingAssistant/Knowledge/Admin/Home)。关键组件与交互机制:
| 发现 | 对照 MarxSphere |
|---|---|
| **data-assistant-\* 全站控制属性**(busy原因/完成标记/跳转目标编码DOM, 供悬浮Agent驱动) | 缺 → 核心机制差距(FAB只做规则推荐无页面级驱动) |
| **PhaseProgressBar**(App顶: 主题chip+阶段圆节点+新项目) | 缺(线性导轨在DagWorkbench内, 非全局) |
| **SectionsView 结构化指导3步面板**(变量识别→框架→Skill生成, 带typewriter+SSE钩子) | 部分(技能卡有, 3步状态面板缺) |
| **WorkspaceView 三栏**(左章节树+进度条+中生成区含执行智能体按钮/取消/重新思考/字数/MarkdownEditor+右素材筛选) | 部分(节点工作界面形态简化) |
| **章节structuredSummary 本地正则抽取** | 已补(ce08dc1 buildStructuredSummary) |
| **FinalizeView**(合稿模式: 直接/降AIGC+强度3档+垂直timeline+审查侧卡+查看差异+导出docx预览) | 缺Finalize独立页形态 |
| **ReviewView 原文对照**(左原文高亮+右问题抽屉resolved/unresolved) | 缺(ReviewLab报告有, 原文对照无) |
| **EditorView**(TipTap+6模式AIPanel+版本历史+docx双向) | 部分(markdown简版, 无TipTap/题名摘要/引用格式tab) |
| **HistoryView 6模块历史分区卡** | 缺(TaskPanel列表式不同) |
| **OutlineEditor 树编辑器**(插入模板/子节限1层/中文序号解析) | 部分(PaperOutline形态接近, 无模板示例插入) |

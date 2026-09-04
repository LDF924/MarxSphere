# MarxSphere 系统架构（2026-08-21 更新）

> MarxSphere 全链路架构：52 步推理 + 四源检索 + AI Agent 编排 + AI+教育，当前真实状态。

## 1. 整体架构 — 四层管道

```
用户 Query (HTTP / MCP / SSE)
        │
        ▼
┌─ 推理链路层 ──────────────────────────────┐
│ 问题分类(四路分调) → Cognee 粗检索 → Graphiti 精炼 │
│ → PG 词法 → 超边增强 → 融合 → 假设 → 评估 → 反思   │
└──────────────┬──────────────────────────┘
               ▼
┌─ 检索层（四源混合 RRF）───────────────────┐
│ SAG 事件(内容向量+标题向量+BM25)          │
│ Graphiti 超边/社区 · Cognee 切片 · PG 向量/词法 │
└──────────────┬──────────────────────────┘
               ▼
┌─ AI Agent 编排层 ────────────────────────┐
│ 规划→选工具→执行→reflect→replan(≤3轮)      │
│ 65 通用工具 + 5层安全 + 5层记忆            │
│ 插件系统(A1工具/A2服务/A3前端注册表)        │
└──────────────┬──────────────────────────┘
               ▼
┌─ AI+教育层（84 路由）────────────────────┐
│ 六能力/自适应四层/作业闭环/BKT/先修图      │
│ 苏格拉底五步打磨/思政审核/自动闭环/多模态   │
└──────────────┬──────────────────────────┘
               ▼
┌─ 数据层 ────────────────────────────────┐
│ PG+pgvector(1024维) │ Neo4j(Graphiti/Cognee) │
└──────────────────────────────────────────┘
```

**规模**：200 服务文件（36 agent-* + 16 教育服务：12 核心 + 学习引擎 7 新 + V399 新增 3 适配）· 492+ 路由（112 教育 + 32 学习引擎顶层 + 引文核验）· 101 迁移 · 41 前端视图 · 621 测试(CI 持续)

## 2. 推理链路（52 步）

入口 `InferenceService.reason()`，关键阶段：

1. **问题分类**（四路分调 PROFILES）
2. **Cognee 粗检索**（stage2）
3. **Graphiti 精炼**（stage3）
4. **PG 全文**（stage4）
5. **超边增强**（stage3.5）
6. **多源融合**
7. **假设生成**
8. **评估**
9. **反思自愈**（template → expandQuery → HyDE → reasonFast 逐级升级）

每阶段写入 `retrieve_steps` 日志（真实 token 可审计）；`mode: "adaptive"` 走 24 算子注册表（outline/pg_arm/cognee_hybrid/extract_entities 等）。

## 3. 检索架构（四源混合）

`SearchService.search()`（RRF 融合 + 余弦重排 0.7/0.3）：

| 源 | 作用 | 技术 |
|---|---|---|
| SAG 事件 | 主知识轴（Compiled Truth ×2.0） | 内容向量 + 标题向量 + BM25 三臂 RRF |
| Graphiti 超边 | 跨文档语义关联/社区聚合 | `hybrid_search_entities` MCP，Neo4j 11001 |
| Cognee 切片 | 段落级 HYBRID | `cognee_search`，Neo4j 11003 + LanceDB |
| PG | 向量/词法 + 教育知识库切片 | pgvector 1024 维 + BM25 + `source_chunks` |

## 4. AI Agent 编排

- **88 通用工具**（66 Agent + 22 视图）+ 教育工具集（112 路由）
- **5 层安全**：Guardian 策略(拒绝熔断) / 3 级沙箱 / 网络审批(SSRF) / 审批门(三级链: Hook→Guardian→User + 缓存) / 凭证隔离
- **5 层记忆**：情景 / 战略 / 技能蒸馏 / 防错规则 / 语料库
- **插件系统**：A1 工具插件（`agent_plugins` 表）/ A2 服务接口（Llm/Sandbox/Guard Provider）/ A3 前端注册表（`viewRegistry.tsx`）
- **外部服务**：OAuth（GitHub 适配器）/ 多 Agent 协作（动态角色 + 协商循环）/ 会话图 + checkpoint 分叉
- **V400 Codex 对齐**(2026-09-01): 预算/时间提醒注入(窗口去重) · Mid-turn 压缩不终止(滚动窗口) · Elicitation 暂停协调 · Stop/PreToolUse/PostToolUse/PermissionRequest/SessionStart 钩子 · 世界状态 diff(reflectLog 增量) · Steer 转向输入 · Mailbox 双通道 · 挂起检查点 · 评审会话隔离(read-only 暴露矩阵) · 共享上下文 LRU · 全链路插桩审计

## 4.5 V399 开源能力融入（Rimagination 生态, 2026-08-31）

| 能力 | 来源 | 融入方式 | 落点 |
|---|---|---|---|
| PDF/文档双模式转换 | mineru-go | 源码直用 vendor + TS 适配 | `pdf_convert` 工具（Agent 轻量 ≤10MB≤20页 / Precision 精准, 扫描件 OCR） |
| 研究选题打磨 | good-question | 源码直用技能 | S01/S04 场景 + 教育五步打磨 stress 注入 |
| 公文起草 | gongwen-draft | 源码直用技能 | `gongwen_draft` 工具（23 文种, 先查先核再写） |
| 视频学习笔记 | bili-note/dy-note | 源码直用技能 | `video_note` 工具（B站/抖音 → Markdown 素材池） |
| 元分析 | easymeta | 方法论移植 | 实证第 17 方法 `meta_analysis`（固定/随机效应+Q/I²/τ²+HK+森林/漏斗图） |
| 英文文献 OA | instsci | 源提炼 vendor | `view_openalex_search` / `view_oa_lookup`（OpenAlex+Unpaywall, 国内可达） |
| Markdown 清洗 | scansci-pdf | 源提炼 vendor | `cleanMarkdown()`（变音符号折叠+NFC+替换字符审计） |
| 科学叙事 | good-story | 源码直用技能 | `view_truth_narrative`（六段张力结构+证据阶梯） |
| 图表数字化 | thu-digitizer | 源码直用技能 | `view_chart_digitize`（两阶段: 预检→坐标确认→CSV） |
| 引文三维核验 | citation-lab | 方法论移植 | `POST /api/citations/verify`（元数据真伪/语境相关性/断言支持度） |

工具增量：+8（pdf_convert / gongwen_draft / video_note / view_openalex_search / view_oa_lookup / view_truth_narrative / view_chart_digitize / 实证 meta_analysis 方法）；技能注册 195→201。

## 5. AI+教育层（84 路由）

| 模块 | 服务 | 能力 |
|---|---|---|
| 核心六能力 | `education-service.ts` | 学习规划/课程辅导/学情诊断/预习复习/备课/陪伴 |
| 自适应四层 | `adaptive-learning-service.ts` | 建模/画像/推送/节奏/分层 |
| 作业闭环 | `homework-help-service.ts` | 解析/错题/变式/答疑/批改 |
| 教师助手 | `teaching-assistant-service.ts` | 备课/出题/组卷/批改/讨论/测验/总结 |
| 教育编排 | `agent-education.ts` | 苏格拉底/五步打磨/想法卡/追问/策略校验 |
| 认知诊断 | `cognitive-diagnosis.ts` | BKT p(掌握) 推断 |
| 知识图谱 | `knowledge-graph-edu.ts` | 先修图 + 拓扑路径 |
| 自动闭环 | `auto-learning-loop.ts` | 采集→诊断→迭代→周报 |
| 思政审核 | `content-audit-service.ts` | 四维核验 + Compiled Truth 校准 |
| 多模态/合规/学生/语言/编程 | 5 服务 | 拍照/口语/板书 · 数据分级 · 认知维度/千人千策/复习提醒 · 精读润色 · 任务拆解/面试 |

## 6. 评测体系

- **RAGAS v3 评测**（`scripts/eval-32-metrics.ts`）：31+ 评分项，53 题金标集，基线综合分 **0.884**
- **教育评测**（`scripts/eval-education.ts`）：BKT AUC / 路径逆序率 / 思政核验 / 批改准确率，综合分 **0.884**
- Kappa 校准门 ≥0.7（当前 1.000）；621 项单元测试

## 7. 基础设施

| 组件 | 说明 |
|---|---|
| 后端 | Fastify 5，4173，492+ 路由 |
| 前端 | React 19 + Vite 8，4173，40 视图（含「AI+教育」Tab） |
| 数据库 | PostgreSQL 16 + pgvector（Docker 5540）· Neo4j 11001/11003 · LanceDB |
| 桌面端 | Electron + NSIS |
| 模型 | DeepSeek 原生 + Embedding MAAS + Rerank（OpenAI 兼容协议） |

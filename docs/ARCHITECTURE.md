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
│ 44 通用工具 + 5层安全 + 5层记忆            │
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

**规模**：198 服务文件（36 agent-* + 16 教育服务：12 核心 + 学习引擎 7 新）· 489+ 路由（112 教育 + 32 学习引擎顶层）· 101 迁移 · 37 前端视图 · 273 测试

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

- **44 通用工具**（26 基础 + 18 视图）+ 教育工具集（84 路由）
- **5 层安全**：Guardian 策略 / 3 级沙箱 / 网络审批(SSRF) / 审批门 / 凭证隔离
- **5 层记忆**：情景 / 战略 / 技能蒸馏 / 防错规则 / 语料库
- **插件系统**：A1 工具插件（`agent_plugins` 表）/ A2 服务接口（Llm/Sandbox/Guard Provider）/ A3 前端注册表（`viewRegistry.tsx`）
- **外部服务**：OAuth（GitHub 适配器）/ 多 Agent 协作（动态角色 + 协商循环）/ 会话图 + checkpoint 分叉

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
- Kappa 校准门 ≥0.7（当前 1.000）；263 项单元测试

## 7. 基础设施

| 组件 | 说明 |
|---|---|
| 后端 | Fastify 5，4173，489 路由 |
| 前端 | React 19 + Vite 8，5173，40 视图（含「AI+教育」Tab） |
| 数据库 | PostgreSQL 16 + pgvector（Docker 5540）· Neo4j 11001/11003 · LanceDB |
| 桌面端 | Electron + NSIS |
| 模型 | DeepSeek 原生 + Embedding MAAS + Rerank（OpenAI 兼容协议） |

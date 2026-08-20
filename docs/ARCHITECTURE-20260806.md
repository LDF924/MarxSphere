# MarxSphere 架构总览（2026-08-06 · 历史快照）

> ⚠️ **历史归档**：本文为 2026-08-06 快照，已落后于当前系统（教育能力/A3 插件系统/新服务未含）。
> 当前架构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

> 三库知识图谱 + 双引擎检索 + 全生命周期科研场景 + 技能生态

## 分层架构

```mermaid
graph TB
 subgraph 前端层["前端层 (React+Vite 4173)"]
 Home[首页<br/>能力全景/数据带/动画]
 Ask[Ask检索<br/>18步流水线]
 Reason[推理工作台<br/>52步链路+真实token]
 Scenarios[科研场景<br/>35场景8阶段+步骤向导]
 Lit[文献库<br/>1化6笔记]
 Truth[知识页<br/>Compiled Truth]
 Graph[知识图谱<br/>径向/力导向]
 Policy[政策库] Vault[资料库]
 Skills[技能库<br/>190+技能]
 Jobs[Jobs自动化<br/>17类任务]
 Trace[Trace瀑布] Sciverse[外部检索]
 end

 subgraph API层["API层 (Fastify 4173)"]
 Server[server.ts<br/>~30 REST端点]
 ReasonHandler[reason-handler<br/>推理调度+fallback]
 end

 subgraph 服务层["服务层"]
 Search[search-service<br/>18步检索流水线]
 Infer[inference-service<br/>52步推理链路]
 Dual[dual-engine<br/>Cognee+Graphiti双引擎]
 Ingest[ingestion-service<br/>入库+幂等]
 TruthS[truth-service<br/>知识页+时间线]
 JobsS[jobs-service<br/>17类队列任务]
 SciverseS[sciverse-service<br/>4工具]
 PolicyS[policy-service<br/>gov.cn检索]
 LitS[literature-service<br/>文献库1化6]
 TraceS[trace-service<br/>OTEL span]
 SkillsS[skills-service<br/>扫描注册表+GitHub]
 VaultS[vault-service<br/>Obsidian资料库]
 end

 subgraph 数据层["数据层"]
 PG[(PostgreSQL<br/>5540 sag_lite)]
 Neo4jG[(Neo4j 11001<br/>Graphiti)]
 Neo4jC[(Neo4j 11003<br/>Cognee)]
 Lance[(LanceDB<br/>向量1024d)]
 Obs[(Obsidian Vault<br/>E盘课题库)]
 end

 subgraph 外部["外部"]
 DS[DeepSeek API<br/>LLM]
 MAAS[阿里MAAS<br/>Embedding]
 SciverseExt[Sciverse/知网]
 Gov[gov.cn]
 GitHub[GitHub]
 end

 Home --> Server
 Ask --> Search
 Reason --> ReasonHandler --> Infer
 Scenarios --> Ask & Reason & Skills
 Search --> Dual
 Infer --> Dual
 Dual --> PG & Neo4jG & Neo4jC & Lance
 Ingest --> PG & Neo4jG & Neo4jC
 TruthS --> PG
 JobsS --> PG & Neo4jG
 SciverseS --> SciverseExt
 PolicyS --> Gov
 SkillsS --> GitHub
 VaultS --> Obs
 Search --> DS & MAAS
 Infer --> DS & MAAS
 Ingest --> DS & MAAS
```

## 三大知识引擎

| 引擎 | 存储 | 数据规模 | 定位 |
|---|---|---|---|
| **Graphiti** | Neo4j 11001 | 大规模实体/关系/超边/社区图谱 | 中层精炼：实体/蒸馏/超边/社区 |
| **Cognee** | Neo4j 11003 + LanceDB | 实体 31,253 · 关系 248,417 · 切片 11,550 | 底层粗检：17 路检索 |
| **PG (SAG)** | PostgreSQL 5540 | 文献 500 · 切片 2,232 · 事件 2,232 | 本地补漏：全文/向量/实体 |

## 检索架构（Ask 18 步 / 推理 52 步）

```
问题 → 分类/意图 → 多臂召回(向量+关键词+Graphiti+Cognee+PG)
 → 加权RRF融合 → Cosine重打分 → Boost链(Compiled Truth×2.0)
 → LLM重排 → 超边知识层 → 假设生成 → LLM Judge自评 → 失败自愈
```

## 推理 52 步（四阶段 + 超边 + 融合）

- **Stage 0-1** 分类+大纲：问题分类/意图识别/术语变体/拆分子问题
- **Stage 2** Cognee 17 路粗检：HYBRID/RAG/图遍历/三元组/摘要/子问题/时序等
- **Stage 3** Graphiti 精炼：实体/概念/蒸馏/领域/邻居/段落回溯/论文溯源/DeepWalk
- **Stage 3.5** 超边知识层：向量/实体/BM25 三路 RRF + 时间衰减
- **Stage 4** 融合生成：Compiled Truth/多查询/HyDE/RRF/Cosine/Boost/LLM重排/COT/假设/评估

## 科研场景（35 个 · 8 阶段）

选题构思(4) → 文献调研(8) → 证据检索(5) → 数据分析(4) → 论文写作(4) → 图表制作(2) → 评审发表(4) → 系统自动化(4)

每个场景 → 全屏工作台（步骤向导 + 工具指引 + 一键跳转）

## 技能生态（仓库随附 10 个 + 命令面板动态扫描）

- **仓库自研 10 个**（`skills/`）：marx-agent(总入口)/marx-sag(推理)/marx-cognee/marx-graphiti/marx-ingest-all/marx-cognee-ingest/marx-graphiti-ingest/pdf2obsidian/md-clean/cnki
- **Web 命令面板**：`/` 弹出技能命令面板，扫描本地技能注册表（约 190+ 个，随安装增长）

## 数据流（论文入库链路）

```
PDF(10,237篇) → pdf2obsidian(1化6) → Obsidian(Vault)
 → md-clean(4文件) → marx-ingest-all(三库联动)
 → Cognee(add+cognify) + Graphiti(chunk+实体+蒸馏+超边) + PG(幂等)
```

## 关键配置

- LLM：DeepSeek 原生 API（deepseek-chat/v4-flash），数据库 ai_provider_settings 优先于 .env
- Embedding：阿里 MAAS text-embedding-v4（1024d）
- 运行模式：preview(省内存无MCP池) / full(推理+MCP池10实例)
- 超时：LLM 300s

## 提交史（260 个提交 · V1-）

- V1-V88：基础检索/入库/评测（基线 0.870）
- V89-V165：DeepSeek 迁移/推理升级/Compiled Truth/消融
- V166-V209：超边知识层/GBrain/首页动画/Trace/Jobs
- V210-V248：推理 52 步完整链路/真实 token/条件触发
- V249-V261：TS 全修复/Tailwind 根治/场景全景/工作台/三库数据带

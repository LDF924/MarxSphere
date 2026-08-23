---
name: marx-cognee
description: "Cognee 知识图谱 V27 — 2026-08-06: 模型DeepSeek原生(非MAAS) + Embedding MAAS。500篇论文，Neo4j 11003 31253实体/248417关系/11550切片，LanceDB v4 向量(1024d)。17种检索策略。SAG Stage2 HYBRID主搜索(BM25+向量RRF)。11个MCP工具。LLM超时300s(V260)。Use when 需要跨论文实体关系推理或混合检索问答；Don't use when 仅需单文档事实查询或实时性要求<1分钟。e.g. 输入\"比较各论文中关于RAG评估方法的异同\"可返回实体关系路径与切片证据。耗时约8-15分钟/成本约$2-5（含图谱构建与检索）。"
triggers: [知识图谱, 语义搜索, 图谱检索, 多跳推理, Cognee, 资本下乡, 农地流转, 工商资本, RAG评测, 图谱质量诊断, 缺陷检测]
notTriggers: [纯编程, 文件操作, 系统管理, 通用聊天]
category_zh: 知识图谱
origin: self-made
title_zh: Cognee知识图谱
---

# marx-cognee Skill — Cognee 引擎驱动的 Marx 领域知识图谱 V27

> **部署日期**: 2026-07-05 | **更新**: 2026-08-06 | **版本**: V27
> **数据**: 500篇 / 31253 Entity / 248417 关系 / 11550 DocumentChunk / LanceDB 1024d
> **关键修复 (2026-08-06)**: LLM 超时 60s→300s (长文档抽取 abort 死循环根因, V260)
> **双引擎**: Cognee F=0.44/O=0.51 vs Graphiti F=0.51/O=0.48

---

## 零、Cognee 在 SAG V88D2 检索管道中的定位

### 0.1 全链路位置

Cognee 是 SAG 四层检索管道中 **Stage2 粗检索** 阶段的核心引擎之一。在 V88D2 版本中的具体位置：

```
用户 Query
  │
  ├─ detectQuestionType → 4路分类
  ├─ expandQuery (V88D2) → 查询扩展
  │
  ▼
┌──────────────────────────────────────────────────────────────┐
│ Stage2: 粗检索 (stage2_cogneeCoarse)                          │
│                                                              │
│  ┌─────────────────────┐  ┌──────────────────────────────┐  │
│  │ Cognee MCP (本引擎)  │  │ PG 双路检索                   │  │
│  │                     │  │  pgvector(20)+ILIKE(10)       │  │
│  │ CHUNKS (25, 120s)   │  │  +V63 HyDE                   │  │
│  │ RAG_COMPLETION (15) │  │  +V88A document boost         │  │
│  │ HYBRID_COMPLETION    │  └──────────────────────────────┘  │
│  │ CHUNKS_LEXICAL (15) │                                    │
│  │                     │  ┌──────────────────────────────┐  │
│  │ Cognee Neo4j 直连    │  │ Cognee Entity CONTAINS 查询   │  │
│  │ bolt://:11003       │──│ subprocess python (15s)      │  │
│  └─────────────────────┘  └──────────────────────────────┘  │
│                                                              │
│  产出: coarse = { chunks, ragCompletion, hybridCompletion,   │
│           cogneeEntities }                                    │
└──────────────────────────────────────────────────────────────┘
  │
  ▼
Stage3: Graphiti 精炼 → Stage4: SAG 融合生成
  │
  └─ fuseResults V42: Cognee chunks → QUOTA_COGNEE (≤2100 chars)
     + V49 splitQABlocks: Cognee Q&A 全文按 ## 标题拆分为段落
```

### 0.2 V88D2 中 Cognee 与 SAG 的接口

| 接口 | SAG 函数 | Cognee 工具 | 超时 | 用途 |
|------|---------|------------|------|------|
| 向量 chunk 检索 | `cogneeSearch(query, 'CHUNKS', 25)` | `recall` (cognee_search) | 120s | 主检索路径, 返回 25 个最相关 chunk |
| RAG 语义补全 | `cogneeSearch(query, 'RAG_COMPLETION', 15)` | `recall` (cognee_search) | 60s | LLM 语义匹配的补充检索 |
| 混合检索 | `cogneeSearch(query, 'HYBRID_COMPLETION', 15)` | `recall` (cognee_search) | 60s | 向量+图混合检索 |
| 词法分块 | `cogneeSearch(query, 'CHUNKS_LEXICAL', 15)` | `recall` (cognee_search) | — | 仅 factual_retrieval, 词法匹配补漏 |
| 图实体查询 | `execSync(python subprocess)` | Neo4j CONTAINS | 15s | MATCH Entity WHERE CONTAINS, 纯 Cypher |

### 0.3 Cognee chunk 在 fuseResults 中的旅程

```
Cognee MCP 返回:
  [{text: "整篇论文Q&A全文(3000-8000字)"}, ...]

    ↓ SAG getText() 解包
    ↓ fuseResults 遍历 coarse.chunks
    
    ↓ V49 splitQABlocks:
      检测 \n## 或 \n### 标题
      → 按标题拆分为独立段落
      → 11550 DocumentChunk → ~15000 段落

    ↓ V42 appendWithCap:
      QUOTA_COGNEE = 2100 chars
      body chunks 和 QA chunks 交替注入
      超限自动截断 → [TRUNCATED]

    ↓ sections.sort(priority) → join('\n\n')
    
最终 fusedContext:
  ## Cognee 原文 [Cognee原文·高]
  {body段落1}
  
  ## Cognee Q&A [Cognee原文·高]
  {QA段落1}
  
  ## Cognee 语义检索 [Cognee语义·中]
  {RAG结果}
```

---

## 一、系统架构全景

### 1.0 架构图（2026-08-06）

```mermaid
graph TB
    subgraph 调用方["调用方"]
        SAG[SAG 推理 52步链路<br/>stage2_cogneeCoarse]
        SAGMCP[SAG MCP 工具<br/>cognee_search/cognify/add]
        CLI[独立 CLI/脚本]
    end

    subgraph MCP层["MCP 层"]
        Runner[mcp_cognee_runner.py<br/>SAG-main/scripts, stdio]
        SSEServer[cognee-mcp server.py<br/>SSE :8001, 11工具]
    end

    subgraph Cognee核心["Cognee 官方 (C:\\Users\\HUAWEI\\cognee)"]
        MCP[官方 mcp_server/server.py]
        ENV[.env<br/>API Key/DB配置]
        DATA[.cognee_system/databases<br/>LanceDB 1024d + SQLite]
    end

    subgraph 存储["存储"]
        Neo4j[(Neo4j 11003<br/>31253实体/248417关系/11550切片)]
        Lance[(LanceDB<br/>向量 1024d v4)]
    end

    SAG --> Runner --> MCP
    SAGMCP --> SSEServer --> MCP
    CLI --> MCP
    MCP --> ENV
    MCP --> DATA --> Lance
    MCP --> Neo4j
```

### 1.1 框架选型与技术栈

| 层级 | 组件 | 说明 |
|------|------|------|
| 传输层 | FastMCP (mcp.server.fastmcp) | SSE 传输 (:8001), 11 工具注册 |
| 图数据库 | Neo4j 5.26.27 Community | bolt://127.0.0.1:11003, 原生 Windows 非 Docker, 31253 实体 / 248417 关系 / 11550 切片 |
| 向量引擎 | text-embedding-v4 (1024d) | 阿里百炼 DashScope, openai_compatible 直连, RXYRYME Key |
| 大模型 | openai/qwen-plus | DashScope compatible-mode 接口, RXYRYME Key |
| 校验大模型 | qwen3.7-max | 仅用于 verify_faithfulness 后置校验 (默认关闭) |
| 关系库 | SQLite | 元数据 + 数据溯源 (59MB) |
| 向量库 | LanceDB | 嵌入式向量持久化, 8 集合 (含 Triplet_text + DocumentChunk_text) |
| 本体 | OWL/RDF (ladybug) | 本体验证 + 消歧 + 类型分类 |
| 原文注入 | raw_text_augmenter.py | Neo4j CONTAINS 全文检索 + ov_import 目录匹配 |
| 查询缓存 | SQLite (cache_kv 表) | sha256(query+type+dataset+top_k), TTL=1h, 260x 加速 |

### 1.2 Cognee vs Graphiti 双引擎对比

| 维度 | marx-cognee (本引擎) | marx-graphiti |
|------|---------------------|---------------|
| 知识组织 | 三元组 + 向量 + 图 + 本体 | 五层蒸馏 + 图 + 段落 |
| 图数据库 | Neo4j :11003 (31253实体/248417关系/11550切片) | Neo4j :11001 (21337实体/166631关系/11702超边/1085社区) |
| 实体数量 | 31253 | 21337 |
| Chunk 数量 | 11550 (切片, ~23.1/论文) | 39499 (细粒度, ~79/论文) |
| 检索策略 | 向量+词法+图实体+CoT (17种) | 向量+BM25+RRF+rerank+蒸馏 (23工具) |
| 评估 F 值 | 0.44 | 0.51 |
| 特有功能 | CoT 多跳推理, CYPHER 实体查询 | 五层文献蒸馏, 领域知识, Cross-encoder Rerank |
| MCP 工具数 | 11 | 23 |
| SAG 中的角色 | Stage2 粗检索 (chunks+实体) | Stage3 精炼 (entity expansion+蒸馏) |

### 1.3 Neo4j Cognee 数据模型

```
Neo4j Cognee :11003/11004 (bolt/http)
  ├─ TextDocument (2031): name (URL-encoded title), file_path, title
  ├─ DocumentChunk (11550): 论文切片
  │   └─ 粒度: ~23.1 切片/论文 (vs PG 23.7, Graphiti 79.0)
  ├─ Entity (31253): name, type, description
  │   └─ RELATES_TO (边): Entity-Entity 关系
  ├─ TextSummary: chunk 的 LLM 摘要
  │   └─ ⚠️ 配对不完整: HybridRetriever 频繁警告 "no paired TextSummary_text row"
  ├─ EntityType: 实体类型定义
  ├─ IngestMarker: 入库进度标记
  └─ __Node__: 根节点
```

### 1.4 CoT 推理机制

```
COT 推理流程:
  Step 1: 向量搜索 → 图谱投影 → 初始回答 (~20s)
  Step 2: 验证 → 追问 → 再检索 → 再回答 (1轮, ~30s)
  Step 3: 收敛检测 → 继续追问 或 终止

  终止条件:
    a. 达到自适应上限 (small=2跳, medium=3跳, large=4跳)
    b. 连续两轮答案变化率 < 5% (收敛检测)
    c. 单次 LLM 调用超时 (60s) → 该轮降级跳过
    d. 连续 2 次 LLM 失败 → hard-break 返回已有结果
    e. total 超时 420s (外层 asyncio.timeout)

  关键参数:
    max_iter: 2 (默认)
    PER_LLM_TIMEOUT: 60s
    CONVERGENCE_RATIO: 0.05
    LLM_MIN_RETRY_SECONDS: 60
    MAX_CONSECUTIVE_LLM_FAILURES: 2

  实际表现 (qwen-plus, 50K 边图):
    COT 延迟: ~92s
    收敛模式: 2 轮收敛 (confirmed by log)
    故障恢复: CancelledError → fallback
```

---

## 二、关键修复记录 (2026-07-28)

### 2.1 API Key 修复详情

**问题**: Cognee MCP 内部的 LLM 调用 (chunk 检索、RAG completion 等) 持续返回 HTTP 400 Arrearage 错误，所有 chunk 检索超时。

**根因链**:
```
Cognee MCP Python 进程读取 %USERPROFILE%\cognee\.env
  → LLM_API_KEY="" (欠费)
  → litellm 调用 DashScope API
  → 返回: "Access denied, Arrearage"
  → tenacity 重试 3 次 (16s/32s/64s 递增延迟)
  → 最终超时 120s
  → SAG 日志: "cognee CHUNKS FAIL: cognee_CHUNKS_TIMEOUT"
```

**修复**:
```
%USERPROFILE%\cognee\.env:
  LLM_API_KEY="" → ""
  OPENAI_API_KEY="" → ""
  FALLBACK_API_KEY="" → ""
```

**验证方法**: 重启 Cognee MCP 后, SAG 日志中不再出现 Arrearage 错误, chunk 检索正常返回.

### 2.2 chunk 粒度问题 (SAG V88D2 已修复)

**问题**: Cognee 返回的 Q&A chunk 是整篇论文全文 (3000-8000字), 命中一篇就占满 fusedContext 的 Cognee 配额.

**修复 (SAG 侧, 非 Cognee 侧)**:
- V49 splitQABlocks: SAG 的 fuseResults 中将 Cognee Q&A 全文按 ##/### 标题拆分为段落
- V42 fuseResults 配额: Cognee 配额上限 2100 chars, 超限自动截断
- 效果: 11550 DocumentChunk → ~15000 段落, 单篇论文不再垄断 Cognee 窗口

---

## 三、检索策略 (17种)

### 3.1 主检索路径 (17种全表, V262)

> SAG Stage2 实际调度: **9路并行** (cogneeRoutes, inference-service.ts:1285) + Phase C 词法 + Phase B Neo4j 直连 + PG 双路并行; COT/AGENTIC 在 Stage4 按需调用。

| search_type | 实现 | 说明 |
|-------------|------|------|
| HYBRID_COMPLETION | HybridRetriever (向量+图+词法) | **主搜索 (V88K)**: BM25 词法 + LanceDB 向量 + 图谱 RRF 融合, topK=max(chunksTopK,20), 300s; 替换纯向量 CHUNKS 解决语义漂移 |
| RAG_COMPLETION | RAGRetriever (向量+LLM 补全) | 标准 RAG: 向量召回 chunk + LLM 生成语义匹配文本, topK=15, 120s |
| SUMMARIES | SummariesRetriever (摘要) | 摘要级检索: TextSummary 节点语义匹配, topK=5, 60s |
| GRAPH_COMPLETION | GraphCompletionRetriever (图) | 图谱补全: 实体-关系 1-hop 邻居展开 + LLM 生成, topK=10, 90s |
| GRAPH_COMPLETION_DECOMPOSITION | DecompositionRetriever (拆解) | 自动问题拆解: 子问题分步图推理再聚合, topK=10, 120s |
| TRIPLET_COMPLETION | TripletRetriever (三元组) | (s,p,o) 结构化三元组检索 (LanceDB Triplet_text), topK=10, 90s |
| GRAPH_SUMMARY_COMPLETION | GraphSummaryRetriever (图+摘要) | 图谱路径 + 摘要混合的高阶概述, topK=10, 120s |
| GRAPH_COMPLETION_CONTEXT_EXTENSION | ContextExtensionRetriever (长链) | 上下文扩展: 长链多跳推理补全, topK=10, 180s (9 路中最慢) |
| TEMPORAL | TemporalRetriever (时序) | 时间序列检索: 带时间属性的实体/关系过滤, topK=10, 90s |
| CHUNKS_LEXICAL | LexicalRetriever (词法) | 纯词法 BM25 匹配, 加载全部 11550 DocumentChunk 到内存; SAG 在 Phase C 对含精确术语/数字/列举的 query (chunksTopK>=20 或"哪些/列举"等) 强制触发, topK=15 |
| GRAPH_COMPLETION_COT | CoTRetriever (多跳推理) | Chain-of-Thought 逐跳图推理 (2-4 轮, 收敛检测), Stage4 按需调用, 300s |
| AGENTIC_COMPLETION | AgenticRetriever (ReAct) | ReAct 多轮工具调用链: 检索→分析→追问→再检索, Stage4 按需调用, 300s |
| CHUNKS | ChunksRetriever (向量) | 纯向量语义检索 (引擎仍支持); V88K 已从 Stage2 并行路移除 (HYBRID 已含向量路, 冗余) |
| CYPHER / cogneeEntities | neo4j-query.ts 直连 (Neo4j) | Phase B: 用 PG 实体名/扩展关键词做 `MATCH (e:Entity)-[r]-(other:Entity) WHERE e.name CONTAINS $q` 参数化查询 (V99, 15s), 产出 coarse.cogneeEntities |
| pg_entities (ILIKE) | PG external_entities ILIKE | 实体名词法检索: 查询分词 `name ILIKE %word%` 匹配 external_entities, LIMIT 30 |
| pg_vector (HyDE) | PG pgvector 向量检索 | V63 HyDE: LLM 生成假设答案→嵌入→`embedding <=> $1::vector` 排序; entity sim>=0.50, chunk sim>=0.40 (V90/V93), 各取 20 |
| pg_chunks_lexical (ILIKE) | PG source_chunks ILIKE | V47: 查询分词+实体名扩展 ILIKE 双路检索 source_chunks, 解决精确短语/专有名词/数值盲区 |

### 3.1b 调度结构 (stage2_cogneeCoarse, V262)

```
Stage2 并行:
  ├─ cogneeRoutes 9路并行 (Promise.allSettled, 每路独立 withTimeout):
  │    HYBRID(300s) RAG(120s) SUMMARIES(60s) GRAPH(90s) DECOMP(120s)
  │    TRIPLET(90s) SUMMARY(120s) CONTEXT_EXT(180s) TEMPORAL(90s)
  │    → 每路按 V91 top-N 精简 (HYBRID/RAG/DECOMP/CONTEXT_EXT=5, 其余=3)
  ├─ Multi-query 变体 (推理升级②): 主搜索 HYBRID 额外跑 queryVariants, 去重合并
  ├─ Phase B: Neo4j 11003 实体 CONTAINS 直查 (pgEntities/pgEntityVectors 种子→Cypher)
  ├─ Phase C: CHUNKS_LEXICAL 条件触发 (精确术语/列举类 query)
  ├─ Phase D: COT/AGENTIC 不在 Stage2 执行, Stage4 按需
  └─ PG 双路并行 (pgPromise):
       pg_entities ILIKE (30) + pg_vector HyDE (entity 20 / chunk 20)
       + pg_chunks_lexical ILIKE (15)
       + relationalFanout / graphTraversalTwoHops (关系型 query, GBrain 步8)
```

### 3.1c Cognee 在 SAG 两条检索栈中的位置

Cognee 同时出现在 SAG 的两条检索链路中，职责与调用参数各不相同：

**① Ask 检索 18 步栈 — `step3Cognee` 臂**

```
Ask 18 步 (search-service.ts / step-docs.ts):
  step0AliasNormalize → step1Bm25Entities / step1ExtractEntities
  → step2RetrieveEntities / step2AliasHop / step2Relational
  → step3EntityEvents / step3QueryEvents / step3MultiQuery
  → ★ step3Cognee  ← Cognee 臂
  → step3Graphiti  ← Graphiti 臂
  → step4FetchDetails → step5Expand / step5GraphTraversal
  → step6CoarseRank / step6CompiledTruth → step7LlmRerank
  → step8FetchChunks / step8Neo4jSections / step8TruthGuarantee

step3Cognee 实现 (search-service.ts, "Cognee 检索臂"):
  前置: hasSource(sourceConfig, "cognee") && cogneePool.isReady()
  调用: cogneePool.callTool("cognee_search", {
          query: effectiveQuery,
          search_type: "HYBRID_COMPLETION",   ← 仅 1 路 (推理侧才是 17 路)
          top_k: 8,
          datasets: "capital_v28"             ← dataset 固定为 capital_v28
        })
  产出: cogneeHits → RetrievalHit[] (id: cognee-*, score: 0.5, source: "cognee")
        → 与 graphitiHits / pg 事件集合并进 step6 粗排 → step7 LLM rerank
```

要点: Ask 栈中 Cognee 是**三库融合的一臂**（Graphiti + Cognee + PG），只跑 HYBRID_COMPLETION 一路、top_k=8、dataset 固定 `capital_v28`（SAG 侧 `discoverCogneeDataset` 默认值，见 reason-handler.ts）。18 步栈以 PG 事件检索为主干，Cognee/Graphiti 臂为补充召回。

**② 推理 52 步栈 — Stage2 Cognee 17 路粗检**

```
推理 52 步 (inference-service.ts stage2_cogneeCoarse):
  Stage1 分类/大纲 → Stage2 粗检索 (★ Cognee 17 路 + PG 双路)
  → Stage3 Graphiti 精炼 → Stage4 融合生成/假设/自评

Stage2 Cognee 17 路 (cogneeRoutes, 9 路并行 + 条件路 + Neo4j 直连 + PG):
  HYBRID(300s) / RAG(120s) / SUMMARIES(60s) / GRAPH(90s) / DECOMP(120s)
  / TRIPLET(90s) / SUMMARY(120s) / CONTEXT_EXT(180s) / TEMPORAL(90s)   ← 9 路并行
  + CHUNKS_LEXICAL (Phase C 条件触发) + Cognee Neo4j 实体 CONTAINS (Phase B, 15s)
  + PG 双路 (pg_entities ILIKE / pg_vector HyDE / pg_chunks_lexical)  → 合计 17 路
  每路 V91 top-N 精简后进 fuseResults (QUOTA_COGNEE ≤2100 chars)
```

要点: 推理栈中 Cognee 是 **Stage2 粗检索主引擎**（V88K 起 HYBRID 为主搜索），17 路覆盖全部检索类型（详见 §3.1 全表），与 §3.1b 调度结构一致。

> 检索栈速记: **Ask 18 步 → Cognee 是 1 臂 (HYBRID top8 capital_v28)；推理 52 步 → Cognee 是 Stage2 17 路粗检主引擎**。

### 3.2 Chunks 检索器内部流程

```
ChunksRetriever:
  1. 向量搜索: LanceDB vector search, 返回 top-K 候选
  2. 图扩展: 从命中的 chunk → 关联的 Entity → 邻居 Entity → 关联的 chunk
  3. 结果排序: 向量相似度 + 图关系权重
  4. 返回: [{text: "论文段落内容", chunks: [...], entities: [...]}]
```

### 3.3 LexicalRetriever 内部流程

```
LexicalRetriever:
  1. 初始化: 从 Neo4j 加载全部 11550 DocumentChunk 到内存
     (日志: "Initialized with 11550 document chunks")
  2. 词法匹配: BM25/词频匹配 query 中的关键词
  3. 返回: top-K 匹配的 chunk
     (日志: "Retrieved N/11550 chunks for query (len=X)")
```

---

## 四、启动命令

```bash
# Cognee MCP (SSE 模式, 端口 8001)
cd %USERPROFILE%\cognee\cognee-mcp
%USERPROFILE%\cognee\.venv312\Scripts\python.exe src\server.py --transport sse --port 8001

# 健康检查
# SAG 启动时会自动输出:
#   [sag] Cognee MCP 预连接完成 (dataset=capital_20260727_003144)
#   [sag] Cognee MCP toolCount=11
```

## 四.1、前置依赖与环境自检（启动前必检）

> 任何 Cognee 检索 / SAG 推理 / 评测任务开始前，先跑一遍 **一键自检**（见 §4.1.9）。
> 全链路 8 项依赖，任一项不通过都要先修复再继续，避免"检索全空/全部超时"白跑一轮。

### 4.1.1 依赖1: Cognee MCP server 文件存在

| 项 | 内容 |
|----|------|
| 路径 | `%USERPROFILE%\cognee\mcp_server\server.py`（官方项目自带） |
| 作用 | Cognee MCP 官方入口，SSE :8001 与 stdio 双模式，11 工具注册 |
| 通过标准 | 文件存在且非空 |

```bash
# 自检命令
ls -la %USERPROFILE%/cognee/mcp_server/server.py

# 通过标准（输出示例）:
#   -rw-r--r-- ... %USERPROFILE%/cognee/mcp_server/server.py
# 失败含义: 官方项目缺失 → 从官方 Git 仓库重新 clone Cognee
```

### 4.1.2 依赖2: Cognee .env 双 key 非空

| 项 | 内容 |
|----|------|
| 路径 | `%USERPROFILE%\cognee\.env` |
| 检查项 | `LLM_API_KEY` + `EMBEDDING_API_KEY` 均非空（当前分别用 RXYRYME / EIYLDIH） |
| 通过标准 | 两个 key 均非空，且以 `sk-` 开头（欠费/失效时先自查此处） |

```bash
# 自检命令
cd %USERPROFILE%/cognee && .venv312/Scripts/python.exe -c "
from dotenv import load_dotenv; import os
load_dotenv()
k1, k2 = os.getenv('LLM_API_KEY',''), os.getenv('EMBEDDING_API_KEY','')
print('LLM_API_KEY', 'OK' if k1 and k1.startswith('sk-') else 'EMPTY/INVALID')
print('EMBEDDING_API_KEY', 'OK' if k2 and k2.startswith('sk-') else 'EMPTY/INVALID')
"

# 通过标准:
#   LLM_API_KEY OK
#   EMBEDDING_API_KEY OK
# 失败含义: 任一项 EMPTY → 恢复 .env 备份; INVALID → 密钥过期/格式错误, 更换配额 Key
```

### 4.1.3 依赖3: Neo4j 11003 运行中

| 项 | 内容 |
|----|------|
| 实例 | `%USERPROFILE%\neo4j\neo4j-community-5.26.27-cognee`（bolt :11003, neo4j/neo4j123） |
| 数据 | 31253 实体 / 248417 关系 / 11550 DocumentChunk |
| 通过标准 | `verify_connectivity()` 无异常 |

```bash
# 自检命令
%USERPROFILE%/cognee/.venv312/Scripts/python.exe -c "
from neo4j import GraphDatabase
d = GraphDatabase.driver('bolt://127.0.0.1:11003', auth=('neo4j','neo4j123'))
d.verify_connectivity(); print('Neo4j 11003 OK')
d.close()
"

# 通过标准: 输出 "Neo4j 11003 OK"
# 失败含义: Neo4j 未启动 → 启动命令见 §四; 连接被拒 → 检查端口占用/密码
```

### 4.1.4 依赖4: LanceDB 目录存在

| 项 | 内容 |
|----|------|
| 路径 | `%USERPROFILE%\cognee\.cognee_system\databases\cognee.lancedb` |
| 数据 | 8 集合向量（DocumentChunk_text 11550 行 / Triplet_text 等），1024d |
| 通过标准 | 目录存在且非空 |

```bash
# 自检命令
ls %USERPROFILE%/cognee/.cognee_system/databases/cognee.lancedb | head -3

# 通过标准: 输出集合目录（如 DocumentChunk_text.lance 等），非空
# 失败含义: 向量库缺失/损坏 → 从备份恢复 (见 §五.5) 或全量重嵌 (~2300 次 API 调用)
```

### 4.1.5 依赖5: SAG API 4173 运行中

| 项 | 内容 |
|----|------|
| 端点 | `http://localhost:4173/health`（SAG 唯一入口，**永不使用 5173**） |
| 通过标准 | HTTP 200 |

```bash
# 自检命令
curl -s -o /dev/null -w "%{http_code}\n" --max-time 5 http://localhost:4173/health

# 通过标准: 输出 200
# 失败含义: SAG 未启动 → cd %USERPROFILE%/SAG-main && npm run dev
#           返回 502/无响应 → 检查端口占用与构建产物
```

### 4.1.6 依赖6: MCP 池 (full 模式 cognee pool 10/10)

| 项 | 内容 |
|----|------|
| 机制 | `McpPool("cognee")` 维护 10 个 stdio MCP 实例，失效自动拉起（V96） |
| 通过标准 | full 模式下池就绪：日志 `[sag] cognee pool: 10/10 instances ready` **或** `/api/mcp/status` 中 `marx-cognee: true`（后端探活 Neo4j 11003, 见 mcp-tools-service.ts）+ `/api/mode` 为 full |

```bash
# 自检命令 (双通道, 任一通过即 OK)
curl -s --max-time 5 http://localhost:4173/api/mode
#   → {"mode":"full","mcpPoolSize":10}    ← 期望 full
curl -s --max-time 5 http://localhost:4173/api/mcp/status
#   → {"status":{"sag":true,"marx-cognee":true,...}}   ← 期望 marx-cognee: true
grep -m1 "cognee pool" D:/Desktop/执行流程/.mcp_logs/*.log 2>/dev/null

# 通过标准: mode=full 且 marx-cognee=true（或日志 "[sag] cognee pool: 10/10 instances ready"）
# 失败含义: mode=preview → 内存模式未建池 (改 mode.json 后重启); marx-cognee=false → MCP 未就绪, 重启 SAG
```

### 4.1.7 依赖7: API 配额（欠费检测）

| 项 | 内容 |
|----|------|
| 端点 | `https://ws-4cbe4oorrmbrzdya.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings`（MAAS text-embedding-v4, 1024d） |
| 通过标准 | HTTP 200（欠费时返回 400 Arrearage） |

```bash
# 自检命令 (MAAS OpenAI-compatible 端点, text-embedding-v4 1024d)
KEY=$(grep -E '^EMBEDDING_API_KEY=' %USERPROFILE%/cognee/.env | head -1 | sed -E 's/^[^=]+="?([^"]*)"?.*/\1/')
curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{"model":"text-embedding-v4","input":"欠费检测"}' \
  https://ws-4cbe4oorrmbrzdya.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings

# 通过标准: 输出 200
# 失败含义: 400 + "Arrearage" → 账户欠费, 充值或轮换 Key (见 §2.1); 401 → Key 失效
```

### 4.1.8 依赖8: SAG 数据库配置 (ai_provider_settings embedding_api_key 非空)

| 项 | 内容 |
|----|------|
| 数据库 | `postgres://sag_lite:***@127.0.0.1:5540/sag_lite`（SAG 经 HTTP API 读取，**无需直接连库**） |
| 检查项 | SAG `ai_provider_settings` 表 `id='global'` 行 `embedding_api_key` 非空（SAG 侧 Embedding 统一走 EIYLDIH） |
| 通过标准 | `/api/settings/ai` 返回 `hasEmbeddingApiKey: true`（SAG 脱敏后的布尔值） |

```bash
# 自检命令 (经 SAG HTTP API, 避免直接连 PG)
curl -s --max-time 5 http://localhost:4173/api/settings/ai | grep -o '"hasEmbeddingApiKey":[a-z]*'

# 通过标准: "hasEmbeddingApiKey":true
# 失败含义: false → SAG 侧 Embedding 无 Key, 在 SAG 管理界面 (PUT /api/settings/ai) 补齐
#           连接失败 → SAG 未启动 (依赖5 前置检查)
```

### 4.1.9 一键自检脚本（8 项全检）

```bash
# 一键运行全部 8 项依赖检查 (不通过项以 FAIL 标注)
cd %USERPROFILE%/cognee && .venv312/Scripts/python.exe -c "
import subprocess, os, sys

P = '%USERPROFILE%/cognee/.venv312/Scripts/python.exe'
def sh(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return (r.returncode, (r.stdout or r.stderr).strip()[:200])
    except Exception as e:
        return (-1, str(e)[:120])

ok = 0
def chk(n, cond, note):
    global ok
    print(('[PASS]' if cond else '[FAIL]'), n, '|', note)
    ok += 1 if cond else 0

# 1. MCP server 文件
chk(1, os.path.exists('%USERPROFILE%/cognee/mcp_server/server.py'), 'cognee mcp_server/server.py')

# 2. .env 双 key
from dotenv import load_dotenv
load_dotenv()
k1, k2 = os.getenv('LLM_API_KEY',''), os.getenv('EMBEDDING_API_KEY','')
chk(2, bool(k1.startswith('sk-') and k2.startswith('sk-')), 'LLM+EMBEDDING key 非空')

# 3. Neo4j 11003
try:
    from neo4j import GraphDatabase
    d = GraphDatabase.driver('bolt://127.0.0.1:11003', auth=('neo4j','neo4j123'))
    d.verify_connectivity(); d.close(); chk(3, True, 'Neo4j 11003')
except Exception as e:
    chk(3, False, 'Neo4j 11003: ' + str(e)[:80])

# 4. LanceDB 目录
chk(4, os.path.isdir('%USERPROFILE%/cognee/.cognee_system/databases/cognee.lancedb'), 'LanceDB cognee.lancedb')

# 5. SAG 4173
chk(5, '200' in sh('curl -s -o /dev/null -w %{http_code} --max-time 5 http://localhost:4173/health')[1], 'SAG :4173/health')

# 6. MCP 池 (mode=full 且 marx-cognee 状态 true)
import json as _json
try:
    _mode = _json.loads(sh('curl -s --max-time 5 http://localhost:4173/api/mode')[1])
    _st = _json.loads(sh('curl -s --max-time 5 http://localhost:4173/api/mcp/status')[1])
    chk(6, _mode.get('mode') == 'full' and _st.get('status', {}).get('marx-cognee') is True,
        'MCP 池: mode=' + str(_mode.get('mode')) + ' marx-cognee=' + str(_st.get('status', {}).get('marx-cognee')))
except Exception as e:
    chk(6, False, 'MCP 池: ' + str(e)[:80])

# 7. MAAS 配额 (端点实测返回 HTTP 200 + embedding 向量; 欠费时返回 400 Arrearage)
import urllib.request
try:
    import json as _json
    req = urllib.request.Request(
        'https://ws-4cbe4oorrmbrzdya.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings',
        data=_json.dumps({'model': 'text-embedding-v4', 'input': '欠费检测'}).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k2})
    with urllib.request.urlopen(req, timeout=15) as resp:
        _ = resp.read(); chk(7, resp.status == 200, 'MAAS embedding 配额 (HTTP ' + str(resp.status) + ')')
except urllib.error.HTTPError as e:
    chk(7, False, 'MAAS embedding 配额 (HTTP ' + str(e.code) + ', ' + (e.read().decode(errors='ignore')[:80]) + ')')
except Exception as e:
    chk(7, False, 'MAAS embedding 配额: ' + str(e)[:100])

# 8. SAG ai_provider_settings (HTTP API: hasEmbeddingApiKey 布尔值, SAG 已脱敏)
#    注: 用 urllib 直取 JSON 解析, 避免 sh() 输出截断 (200字符) 截掉长响应里的字段
try:
    import json as _json2
    with urllib.request.urlopen('http://localhost:4173/api/settings/ai', timeout=5) as resp:
        _s8 = _json2.loads(resp.read().decode('utf-8'))
        chk(8, _s8.get('settings', {}).get('hasEmbeddingApiKey') is True, 'SAG ai_provider_settings.embedding_api_key 非空')
except Exception as e:
    chk(8, False, 'SAG ai_provider_settings: ' + str(e)[:80])

print('\\n结果:', ok, '/8 通过')
"
```

> **失败处理约定**: 依赖 1-4 为数据/代码基础（优先修复）；依赖 5-6 为运行时（重启 SAG）；依赖 7-8 为配额/配置（换 Key 或补配置）。全部 8/8 通过后，再执行检索/推理任务。

## 四.2、V262 状态 (2026-08-06)

### 4.2.1 LLM 超时 300s (V260 修复)

- **根因**: 长文档抽取 (cognify) 与长链检索 (COT/CONTEXT_EXTENSION) 中, 旧 60s 单次 LLM 超时在长输出时被 asyncio.timeout 提前掐断 → 表现为死循环/abort 重试, Stage2 多路雪崩超时
- **修复 (V260)**: 所有 Cognee 相关 LLM 调用超时统一 **60s→300s** (MCP 工具级 withTimeout 同步放宽)
- **当前值**: cogneeRoutes 每路独立超时 (见 §3.1b): HYBRID 300s / RAG 120s / SUMMARIES 60s / GRAPH 90s / DECOMP 120s / TRIPLET 90s / SUMMARY 120s / CONTEXT_EXT 180s / TEMPORAL 90s; COT/AGENTIC 300s; Neo4j 直连 15s
- **验证**: 重启 Cognee MCP 后 Stage2 不再出现 cognee_*_TIMEOUT 雪崩

### 4.2.2 DeepSeek 原生 LLM (V89, 2026-07-31)

- **现状**: LLM 全部走 **DeepSeek 原生 API** (deepseek-chat, 便宜且够用); Embedding 保持 **MAAS text-embedding-v4** (EIYLDIH Key)
- **例外**: Cognee 侧受 litellm 栈限制 **不能** 迁到 DeepSeek 原生 — 保持 MAAS qwen-plus (`LLM_PROVIDER=openai`, `LLM_MODEL=openai/qwen-plus`)。DeepSeek 原生用于 SAG 侧 LLM (推理/评测/HyDE), 不用于 Cognee 内部
- **Key 统一**: SAG 全链路 key 统一为 EIYLDIH (V88D2), Cognee .env 用 RXYRYME

### 4.2.3 MCP 池 10 实例自动重连 (V96)

- **机制**: `McpPool("cognee")` 维护 10 个 MCP 实例 (stdio), `isReady()` 轮询活性, 失效实例自动拉起替换 → 消除单进程排队瓶颈 (cogneeSearch 优先走池)
- **V96 增强**: cognee_search 传递 `node_name=paperTitle` 过滤, MCP server 侧 `_filter_by_node_name()` 破折号归一化过滤 + SAG 侧双重保险过滤
- **验证**: SAG 启动日志 `[sag] Cognee MCP pre-connect OK` + 池就绪日志 "cognee pool: 10/10"

## 四.5、文件结构说明（为什么本 skill 没有 mcp_server 目录）

**Cognee 的 MCP server 不在本 skill 内**——它属于 **Cognee 官方项目**（`%USERPROFILE%\cognee\`），由官方安装自带：

```
%USERPROFILE%\cognee\                       ← Cognee 官方项目（Git 克隆）
├── mcp_server\server.py                       ← Cognee MCP Server（官方自带，SSE :8001）
├── cognee-mcp\src\server.py                   ← Cognee MCP 变体（也是官方）
├── .env                                       ← LLM/DB/Embedding 配置
└── .cognee_system\databases\                  ← LanceDB + SQLite 数据

%USERPROFILE%\SAG-main\scripts\mcp_cognee_runner.py   ← SAG 侧启动器（stdio 模式，158行）
```

**对比 Graphiti**：Graphiti 的 MCP server（`marx-graphiti/mcp_server/server.py`）是我们**自研的**，所以放 skill 内管理。Cognee 是**官方自带**，放官方项目内——**不是缺失，是架构差异**。

**调用链**：
- SAG 推理 → `reason-handler.ts` 用 `McpPool("cognee")` 拉起 `mcp_cognee_runner.py`（stdio）→ runner 导入官方 `mcp_server.server` 的 `mcp` 对象
- 独立 MCP 使用 → cognee-mcp 目录 SSE :8001 模式

**备份**：Cognee 的 server.py 不需要备份（官方 Git 仓库，可重新 clone），**只需备份 `.env` 和 `.cognee_system\databases`**（数据文件）。

## 五、关键文件

| 文件 | 说明 |
|------|------|
| `%USERPROFILE%\cognee\.env` | LLM/DB/Embedding 配置 (RXYRYME Key) |
| `%USERPROFILE%\cognee\cognee-mcp\src\server.py` | Cognee MCP Server (11 tools, SSE transport) |
| `%USERPROFILE%\cognee\cognee\.cognee_system\databases` | LanceDB + SQLite 数据文件 |
| `%USERPROFILE%\SAG-main\src\services\inference-service.ts` | SAG 调用 Cognee 的接口 (1682行) |

## 五.5、备份与恢复

### 备份范围（哪些必须备份）

| 对象 | 路径 | 备份方式 | 说明 |
|---|---|---|---|
| **LanceDB 向量库** | `%USERPROFILE%\cognee\.cognee_system\databases\lancedb` | 复制目录 | 全部 chunk/实体向量（1024d v4），丢失需全量重嵌（~2300 次 API 调用） |
| **SQLite 缓存** | `%USERPROFILE%\cognee\.cognee_system\databases` 下 `.db` | 复制文件 | 检索缓存 + 元数据 |
| **Neo4j 11003 图数据** | Neo4j cognee 实例 | `neo4j-admin database dump` | 31253 实体/248417 关系 |
| **.env 配置** | `%USERPROFILE%\cognee\.env` | 复制文件 | API Key/DB 连接，含密钥不入 git |
| **server.py** | cognee 官方目录 | **无需备份** | 官方 Git 仓库可重新 clone |

### 恢复流程

```bash
# 1. 恢复 LanceDB（向量库）
robocopy "备份\lancedb" "%USERPROFILE%\cognee\.cognee_system\databases\lancedb" /E

# 2. 恢复 SQLite 缓存
copy 备份\*.db "%USERPROFILE%\cognee\.cognee_system\databases\"

# 3. 恢复 Neo4j 11003
cd %USERPROFILE%\neo4j\neo4j-community-5.26.27-cognee\bin
neo4j-admin database load cognee --from-path=备份目录

# 4. 恢复 .env
copy 备份\.env "%USERPROFILE%\cognee\.env"

# 5. 验证
curl http://127.0.0.1:8001/api/v1/health   # Cognee API 健康
# SAG 侧: 重启后 MCP pool 就绪日志 "cognee pool: 10/10"
```

### 备份时机（建议）

- 每次重大入库后（500 篇全量入库完成时必做）
- 每次向量模型升级前（v4→v5 时）
- 每次 cognify 大变更前

### 常见恢复场景

| 场景 | 恢复动作 |
|---|---|
| LanceDB 损坏/丢失 | 恢复目录 → 无需重嵌（向量都在） |
| Neo4j 11003 损坏 | `neo4j-admin database load` |
| .env 丢失 | 恢复配置 → 重启 MCP |
| server.py 被改坏 | `git checkout -- mcp_server/server.py`（官方仓库） |

## 六、SAG inference-service.ts 中的 Cognee 相关函数

| 函数 | 行数范围 | 功能 |
|------|---------|------|
| `stage2_cogneeCoarse()` | ~777 | 主入口: 并行启动 Cognee MCP + PG 双路 |
| `cogneeSearch()` | ~870 | 通过 MCP 工具 `cognee_search` 发起检索 |
| `getCognee()` | ~169 | 懒加载 + 重连 Cognee MCP |
| `discoverCogneeDataset()` | ~44 | 自动发现 dataset 名称 |
| `getText()` | ~49 | Cognee chunk 递归解包 |
| Cognee Neo4j 直连 | ~774 | subprocess python MATCH Entity CONTAINS |

---

## 附录: V25-V26 原始内容保留

### V25 SAG 联动更新 (历史保留)

| 修复 | SAG 文件 | 影响 |
|------|----------|------|
| P0-4: withTimeout 90s | `inference-service.ts:callG` | Cognee COT/Agentic 调用统一超时 |
| P2-14: Stage2 三路并行 | `inference-service.ts` | CHUNKS/RAG/HYBRID Promise.allSettled 并行 |
| P2-17: COT 增量融合 | `inference-service.ts` | Cognee COT/Agentic 结果增量拼接, 不重做全量融合 |
| P1-13: 全空告警 | `inference-service.ts` | Cognee 所有路由返回空时 warn |

### 原始评测数据 (历史保留)

- 30题 × 5维度, 最优 Overall=0.58
- 双引擎: Cognee F=0.44/O=0.51 vs Graphiti F=0.51/O=0.48
- COT 延迟: ~92s (vs qwen3.7-max ~400s, 4.3x 加速)
- 收敛模式: 2轮收敛 (confirmed by log)
- 故障恢复: CancelledError → fallback (qwen-plus)

### COT 推理机制完整参数 (历史保留)

```
终止条件:
  a. 达到自适应上限 (small图=2跳, medium=3跳, large=4跳)
  b. 连续两轮答案变化率 < 5% (收敛检测)
  c. 单次LLM调用超时 (60s) → 该轮降级跳过
  d. 连续2次LLM失败 → hard-break 返回已有结果
  e. total 超时 420s (外层 asyncio.timeout)

关键参数:
  max_iter: 2 (默认, 可显式传入覆盖)
  PER_LLM_TIMEOUT: 60s (单次结构化输出)
  CONVERGENCE_RATIO: 0.05 (语义变化阈值)
  LLM_MIN_RETRY_SECONDS: 60 (tenacity 重试下限)
  MAX_CONSECUTIVE_LLM_FAILURES: 2 (hard-break上限)
```

### 全量检索策略表 (历史保留, 17种)

| search_type | 实现 | 说明 |
|-------------|------|------|
| CHUNKS | ChunksRetriever (向量) | LanceDB 向量语义检索, 2675 chunk |
| RAG_COMPLETION | LLM 语义补全 | qwen-plus 生成的语义匹配文本 |
| HYBRID_COMPLETION | 向量+图混合 | 结合向量和图谱的混合检索 |
| CHUNKS_LEXICAL | LexicalRetriever (词法) | 纯词法匹配, 初始化时加载全部 2675 chunk |
| GRAPH_COMPLETION_COT | CoT 多跳推理 | 图谱驱动的多跳问答 |
| AGENTIC_COMPLETION | 多轮 Agentic | 多轮迭代验证推理 |
| CYPHER | Neo4j Cypher 直查 | Entity 节点查询 |
| TRIPLET_COMPLETION | 三元组补全 | 实体关系推理 |
| (其余 9 种) | — | 见原始 eval_output 目录 |

### LexicalRetriever 内部流程 (历史保留)

```
LexicalRetriever:
  1. 初始化: 从 Neo4j 加载全部 11550 DocumentChunk 到内存
     (日志: "Initialized with 11550 document chunks")
  2. 词法匹配: BM25/词频匹配 query 中的关键词
  3. 返回: top-K 匹配的 chunk
     (日志: "Retrieved N/11550 chunks for query (len=X)")
  4. 警告: DocumentChunk_text row has no paired TextSummary_text row
     (chunk-summary 配对不完整)
```

### Cognee 与业界 RAG 架构对比 (历史保留)

| 维度 | 标准 RAG | marx-graphiti | marx-cognee (本系统) |
|------|----------|---------------|-----------------|
| 知识组织 | 非结构化文本块 | 五层蒸馏 + 图 + 段落 | 三元组 + 向量 + 图 + 本体 |
| 检索方式 | 向量语义 | 向量+BM25+RRF+rerank | 向量+词法+图实体+CoT |
| 推理能力 | 无 | 实体展开+蒸馏 | CoT 多跳+本体推理 |
| 实体粒度 | 无 | Entity (五层蒸馏) | Entity (LLM抽取) |
| 评测方式 | RAGAS | LLM Judge 5维 | LLM Judge 5维 |

### Cognee Chunk 内部格式 (历史保留)

```
Cognee MCP 返回的 chunk 格式:
  [{text: "---\ntitle: 资本下乡与村庄的再造 - 问答\npaperTitle: ...\n---\n\n# 问答\n\n## 研究方法\n\n1. **本文...**\n   - **答:** ...(整篇论文全文)\n\n## 主要发现\n\n3. **根据论文，资本下乡后...**\n   - **答:** ...(更长的全文)\n\n## 理论框架\n..."}]

特征:
  - 整篇论文 Q&A 全文打包为单个 string (3000-8000字)
  - 包含论文标题、问答内容、研究方法、主要发现等全部章节
  - 粗粒度: 1.3 chunk/论文 (2675 chunk / 2031 TextDocument)
  - SAG V49 修复: splitQABlocks 按 ##/### 标题拆分
```

### Cognee MCP 启动与配置 (历史保留)

```bash
# 启动 (SSE 模式, 端口 8001)
cd %USERPROFILE%\cognee\cognee-mcp
%USERPROFILE%\cognee\.venv312\Scripts\python.exe src\server.py --transport sse --port 8001

# Cognee Neo4j
bolt://127.0.0.1:11003, neo4j/neo4j123

# LanceDB
%USERPROFILE%\cognee\cognee\.cognee_system\databases

# Dataset
capital_20260727_003144
```

### 原始启动命令 (历史保留)

```bash
# PostgreSQL (Docker)
docker start sag_lite_postgres

# Neo4j (两个实例)
%USERPROFILE%\neo4j\neo4j-community-5.26.27\bin\neo4j.bat console
%USERPROFILE%\neo4j\neo4j-community-5.26.27-cognee\bin\neo4j.bat console

# Cognee MCP + SAG
cd %USERPROFILE%\cognee\cognee-mcp && .venv312\Scripts\python.exe src\server.py --transport sse --port 8001
cd %USERPROFILE%\SAG-main && npx tsx src/index.ts &
```
| `discoverCogneeDataset()` | ~44 | 自动发现 dataset 名称 |
| `getText()` | ~49 | Cognee chunk 递归解包 |
| Cognee Neo4j 直连 | ~774 | subprocess python MATCH Entity CONTAINS |

---


---

# ========================================================================
# 以下为原始完整内容，从 .cc-switch 备份精确恢复 (2026-07-28)
# ========================================================================

> **评测**: 5版 (v6-v10), 30题 × 5维度, 最优 Overall=0.58, 天花板已量化
> **双引擎评测**: eval_unified_dual.py — Cognee+Graphiti 同卷同Judge对比。Cognee F=0.44/R=0.72/O=0.51; Graphiti F=0.51/R=0.78/A=0.92/O=0.48
> **Skill版本**: v9 — 双引擎统一评测 / Graphiti 防幻觉提示词 / 实体提取修复 / 双引擎互补策略

---

## 零、系统架构全景

### 0.1 框架选型与技术栈

| 层级 | 组件 | 说明 |
|------|------|------|
| 传输层 | FastMCP (mcp.server.fastmcp) | stdio 传输，11 工具注册 |
| 图数据库 | Neo4j 5.26.27 Community | bolt://127.0.0.1:11003，原生 Windows 非 Docker |
| 向量引擎 | text-embedding-v4 (1024d) | 阿里百炼 DashScope, openai_compatible 直连 (绕过 litellm)。两套引擎(Graphiti/Cognee)已统一 |
| 大模型 | qwen-plus (搜索), qwen3.7-max (校验+Judge) | 阿里百炼 DashScope compatible-mode 接口 (litellm 前缀 `openai/qwen-plus`) |
| 校验大模型 | qwen3.7-max | 仅用于 verify_faithfulness 后置校验 (默认关闭) |
| 关系库 | SQLite | 元数据 + 数据溯源 (59MB) |
| 向量库 | LanceDB | 嵌入式向量持久化, 8 集合 (含 Triplet_text + DocumentChunk_text) |
| 本体 | OWL/RDF (ladybug) | 本体验证 + 消歧 + 类型分类 |
| 原文注入 | raw_text_augmenter.py | Neo4j CONTAINS 全文检索 14122 Chunk + ov_import 目录匹配 |
| 评测体系 | 5-Dim LLM Judge (qwen3.7-max) | F/R/C/A/O 30q 评估 + 断点续跑 |
| 查询缓存 | SQLite (cache_kv 表) | sha256(query+type+dataset+top_k), TTL=1h, 260x 加速 |

### 0.2 CoT 推理机制 (v5 更新)

```
COT 推理流程:
  Step 1: 向量搜索 → 图谱投影 → 初始回答 (~20s)
  Step 2: 验证 → 追问 → 再检索 → 再回答 (1轮, ~30s)
  Step 3: 收敛检测 → 继续追问 或 终止
  终止条件:
    a. 达到自适应上限 (small图=2跳, medium=3跳, large=4跳)
    b. 连续两轮答案变化率 < 5% (收敛检测)
    c. 单次LLM调用超时 (60s) → 该轮降级跳过
    d. 连续2次LLM失败 → hard-break 返回已有结果
    e. total 超时 420s (外层 asyncio.timeout)

  关键参数:
    max_iter: 2 (默认, 可显式传入覆盖)
    PER_LLM_TIMEOUT: 60s (单次结构化输出)
    CONVERGENCE_RATIO: 0.05 (语义变化阈值)
    LLM_MIN_RETRY_SECONDS: 60 (tenacity 重试下限)
    MAX_CONSECUTIVE_LLM_FAILURES: 2 (hard-break上限)

  实际表现 (qwen-plus, 50K边图):
    COT 延迟: ~92s (vs qwen3.7-max ~400s, 4.3x 加速)
    收敛模式: 2轮收敛 (confirmed by log)
    故障恢复: CancelledError → fallback (RXMHHLH/qwen-plus)
```

### 0.2 架构类型定位

**Cognee 属于 "通用知识图谱 Memory Engine (General-Purpose Graph Memory)"**。

与业界主流 RAG 架构的对比：

| 维度 | 标准 RAG | marx-graphiti | marx-cognee (本系统) |
|------|----------|---------------|-----------------|
| 知识组织 | 非结构化文本块 | 五层蒸馏 + 图 + 段落 | 三元组 + 向量 + 图 + 本体 |
| 检索粒度 | chunk | entity/chunk/distill/domain 四级 | chunk/entity/triplet/graph/code/agentic 六级 |
| 图谱模式 | 无 | 手写 Cypher pipeline | 自动三元组抽取 + 38种关系类型 |
| 多跳推理 | 不支持 | 图遍历 1-hop | CoT / Decomposition / Agentic 多轮 |
| 本体约束 | 无 | 无 | OWL/RDF 本体验证 (58种 EntityType) |
| 检索策略 | 1 种 | 4 级 (19 工具) | 17 种 (含 CYPHER/NL/CODE/CoT/Agentic) |
| 对话记忆 | 无 | 无 | Session Memory (remember/recall/forget) |
| 可解释性 | 低 | 高 (每论断 [作者, 年份]) | 中 (三元组溯源 + 图路径 + description) |
| 评估体系 | v5.2 5-Dim LLM Judge (30q) / v10 统一脚本 | 三层七配置消融 + 604 测试集 | F=0.570, R=0.925, A=0.600 (5版最优) |
| 领域适配 | 通用 | 马克思主义理论专域 | 通用 + 资本下乡专域 |

### 0.3 数据全景

```
数据接入层:
  208 篇论文 → D:/Desktop/ov_import/ (每篇 .original.md + 摘要.md + 术语.md + 问答.md)
    → 832 个 TextDocument → SQLite content_hash 去重

知识抽取层:
  add() → 文本分块 → DocumentChunk (1,163)
  cognify() → LLM 实体抽取 → Entity (11,156, 具 description)
    → EntityType (58): 本体类型自动分类
    → Relation: 38+ 关系类型 (63,636 条边)

图谱存储层:
  Neo4j 11003 → 15,539 节点 / 63,636 关系
  LanceDB → 1024d 向量嵌入 (text-embedding-v4, 2026-07-08 全量重建)
  SQLite (59MB) → 元数据 + 数据溯源 + 查询缓存 (cache_kv)

原文注入层:
  raw_text_augmenter.py → Neo4j CONTAINS 全文检索 DocumentChunks + D:/Desktop/ov_import 目录匹配
```

### 0.4 与 marx-graphiti 的关键差异

| | marx-cognee | marx-graphiti |
|---|---|---|
| 图谱构建 | 自动 (LLM 三元组抽取) | 手动 (Cypher pipeline 5 轮抽取) |
| 关系类型 | 38+ 自动生成 | 14 手写类型 |
| 实体数 | 11,156 | 2,839 |
| 蒸馏 | 无 | 208 LiteratureDistill + 5 DomainKnowledge |
| Chunk | 14,122 DocumentChunk (500-char sliding) | 17,547 Chunk (FULLTEXT + VECTOR) |
| 社区聚类 | 无 | 138 Community + 63 Conflict |
| 评估 | **F=0.685 / R=0.880 / A=0.398** (5-Dim, 30q) | R@10=0.9354, E2E=4.96/5.00 |
| 优势 | 17种检索 + CoT推理 + 记忆 + Chunk注入 | 五层蒸馏 + 段落溯源 + 评估体系 |

---

## 一、调用决策树（Claude 必须遵守）

### 1.1 检索决策树

```
用户提问
  |
  |- 关于图谱状态 / 系统信息
  |   → list_datasets_json()                           列出所有数据集 (id + name)
  |   → get_client_info_json()                         获取版本+配置+节点统计
  |
  |- 关于某个概念 / 实体关系查询 ("什么是X""Y和Z的关系")
  |   → recall(query, metadata_filter)                            图遍历，快速
  |   → recall(query, search_type="GRAPH_COMPLETION_COT")  多跳推理
  |   → recall(query, search_type="GRAPH_COMPLETION")      标准图推理
  |
  |- 语义搜索 / 模糊查询 ("资本下乡如何影响农村")
  |   → recall(query, search_type="HYBRID_COMPLETION")            向量+文本混合
  |   → recall(query, search_type="GRAPH_COMPLETION_DECOMPOSITION")  自动问题拆解
  |   → recall(query, search_type="GRAPH_SUMMARY_COMPLETION")      图+摘要混合
  |
  |- 三元组/结构化查询 ("资本下乡→土地流转→农户权益")
  |   → recall(query, search_type="TRIPLET_COMPLETION")
  |
  |- 需要代码级/规则级检索
  |   → recall(query, search_type="CODING_RULES")
  |   → recall(query, search_type="CHUNKS_LEXICAL")             关键词精确匹配
  |
  |- 复杂多跳 / Agentic 推理 ("资本下乡失败案例的共同特征及成因")
  |   → recall(query, search_type="AGENTIC_COMPLETION")         ReAct 多轮交互
  |   → recall(query, search_type="GRAPH_COMPLETION_COT")       Chain-of-Thought
  |   → recall(query, search_type="GRAPH_COMPLETION_CONTEXT_EXTENSION")  上下文扩展
  |
  |- 时间序列分析 ("资本下乡政策的历史演变")
  |   → recall(query, search_type="TEMPORAL")
  |
  |- 快速探索 (不确定查询意图)
  |   → recall(query, search_type="FEELING_LUCKY")             自动选最优策略
  |
  |- 与 marx-graphiti 对比 ("Cognee和GraphRAG对X的检索差异")
  |   → 手动对比 (cognee_compare 工具已移除，用 SAG 的 cogneeSearch + graphiti refine 自行对比)
  |
  |- 摄入新文献 / 构建图谱
      → 切换到 marx-cognee-ingest skill
```

### 1.2 检索策略约束（强制执行）

1. **优先免费工具** — list_datasets_json / get_client_info_json 零 API 成本
2. **多跳推理用 GRAPH_COMPLETION_COT** — CoT 链式推理，逐跳展开图路径
3. **复杂拆解用 GRAPH_COMPLETION_DECOMPOSITION** — 自动分解子问题 + 分步推理
4. **Agentic 场景用 AGENTIC_COMPLETION** — ReAct 多轮交互，工具调用链
5. **编码/规则场景用 CODING_RULES** — 代码规则检索
6. **模糊搜索用 HYBRID_COMPLETION** — 向量语义 + 关键词混合排序
7. **marx-cognee 与 marx-graphiti 互补** — Cognee 提供 17 种通用策略 + CoT/Agentic 推理，Graphiti 提供五层蒸馏 + 段落溯源
8. **不能编造** — 图谱中没有的内容，明确告知用户 "知识图谱中没有找到相关信息"
9. **所有检索通过 recall 工具** — SAG inference-service.ts 中 cogneeSearch() 通过 `cognee_search` tool(映射到 recall) 执行，写操作被 Cognee 内部权限拦截

---

## 二、MCP 工具完整签名速查表

### 2.1 核心知识工具 (3个)

| 工具 | 参数 | 说明 | 成本 |
|------|------|------|:--:|
| recall | data(必), metadata_filter, top_k | 语义搜索: 从知识图谱检索相关信息 | API |
| remember | data(必), metadata | 写入: 将信息存入知识图谱 | API |
| forget | data_id(可选), dataset_id(可选), mode=soft | 删除: 软删除/硬删除知识 | 免费 |

### 2.2 运维/诊断工具 (8个)

| 工具 | 参数 | 说明 |
|------|------|------|
| cognify_file | file_path(必), dataset_name | 对单文件执行 cognify 全流程 |
| visualize_graph_ui | dataset_name (可选) | 知识图谱可视化 HTML |
| upload_file_ui | — | 文件上传 UI |
| open_cognee_workspace | — | 打开 Cognee 工作区 |
| list_datasets_json | — | 列出所有数据集 (JSON) |
| list_dataset_data_json | dataset_id (可选) | 列出数据集中的所有数据 |
| get_client_info_json | — | 客户端配置信息 |
| create_dataset_json | name(必), description | 创建新数据集 |

### 2.3 SAG 通过 `recall` 工具调用的检索类型 (17种)

```
检索类型                      适用场景
SUMMARIES                      摘要级检索 — 文档摘要搜索
CHUNKS                         分块级检索 — DocumentChunk 粒度
CHUNKS_LEXICAL                 分块关键词精确匹配 — 词法搜索
RAG_COMPLETION                 标准 RAG 补全 — vector + chunk
HYBRID_COMPLETION              向量 + 文本混合 — 语义+词法双路
TRIPLET_COMPLETION             三元组检索 — (s,p,o) 结构化
GRAPH_COMPLETION               图遍历 — 1-hop 邻居扩展
GRAPH_COMPLETION_COT           Chain-of-Thought 多跳 — 逐跳图推理
GRAPH_COMPLETION_DECOMPOSITION  自动问题拆解 — 子问题分步推理
GRAPH_SUMMARY_COMPLETION       图 + 摘要混合 — 高阶概述
GRAPH_COMPLETION_CONTEXT_EXTENSION 上下文扩展 — 长链推理
CYPHER                         原生 Cypher — 自定义图查询
NATURAL_LANGUAGE               自然语言转 Cypher — NL→图查询
FEELING_LUCKY                  探索式 — 自动选最优策略
TEMPORAL                       时间序列 — 时序分析
CODING_RULES                   代码/规则检索 — 结构化规则查询
AGENTIC_COMPLETION             ReAct Agentic — 多轮工具调用链
```

---

## 三、图 Schema 完整参考

```
核心节点:
  Entity (11,156)            — 实体节点
    属性: name, type(Entity), description, created_at, updated_at, version
    description 覆盖: 100% (所有实体具 LLM 生成的描述)
    例: "河北省保定市 — 中国河北省辖市，规定工商资本在不同农业产业类型的投资上限"
        "茶产业 — 以茶树种植、茶叶加工及品牌销售为主的农业产业，..."

  EntityType (897)           — 本体类型节点
    属性: 自动本体分类 (ladybug OWL/RDF)
    58种类型涵盖: 地点/人物/组织/政策/理论/事件/产业/...

  TextDocument (832)         — 原始文档节点 (208×4 MD文件)
    属性: raw_data_location, source_content_hash, created_at

  DocumentChunk (1,327)      — 文档分块节点
    属性: 文本内容 + 元数据

  TextSummary (1,327)        — 文档摘要节点
    属性: LLM 生成的文档级摘要

  __Node__ (15,539)          — 图根节点 (Neo4j 内部)

关键关系 (38+ 类型, 49,444 条边):
  自动抽取的关系类型示例:
    is_a, has_dependency_on, enables, supports, incorporates,
    accelerates, administers, adopts, achieves, addresses,
    characterized_by, constrained_by, criticized_by,
    depends_on, facilitates, governs, implements, leads_to, ...
  
  Cognee 的优势: 关系类型自动从文本中抽取，不限于预定义集合。
  劣势: 无手写 pipeline 的精炼度，关系名可能过于具体 (如 achieved_30000_mu_land_transfer_in)。

向量索引:
  LanceDB — 嵌入式向量存储，1024d，与 Neo4j 节点自动关联

元数据索引:
  SQLite — data.id (content_hash 去重) / raw_data_location / pipeline_status
```

---

## 四、完整使用示例

### 示例 1：概念多跳推理 (CoT)

**用户**: "资本下乡对乡村治理有什么影响？"

**操作序列**:
```
1. recall("资本下乡 乡村治理 影响", metadata_filter={"search_type":"GRAPH_COMPLETION_COT"})
   → CoT 链式推理:
     Step 1: "资本下乡" → 相关实体 (工商资本/政府/村组织/土地流转)
     Step 2: 每个实体 → 关系链 (enables/supports/governs/administers)
     Step 3: 关系链 → 结果实体 (治理结构变化/权力关系重构/公共性消解)
   
2. 返回结构化结果:
   [{entity: "资本下乡", relation: "enables", target: "土地流转"},
    {entity: "土地流转", relation: "leads_to", target: "治理结构变化"},
    {entity: "工商资本", relation: "administers", target: "产业投资"},
    ...]
```

### 示例 2：语义混合搜索

**用户**: "找到关于农地流转中农户权益保护的研究"

**操作序列**:
```
1. recall("农地流转 农户权益 保护", metadata_filter={"search_type":"HYBRID_COMPLETION"}, top_k=10)
   → 向量语义匹配 + 关键词全文检索 → 混合排序
   → 返回 top-10 匹配结果 (含 entity + description + relation)
```

### 示例 3：Agentic 多轮推理

**用户**: "资本下乡失败案例的共同特征及成因分析"

**操作序列**:
```
1. recall("资本下乡 失败案例 特征 成因", metadata_filter={"search_type":"AGENTIC_COMPLETION"})
   → ReAct 循环: 检索 → 分析 → 追问 → 再检索
   轮1: 检索 "资本下乡" 关联的负面实体 (conflict/failure/loss)
   轮2: 对每个负面实体检索其因果链 (causes/leads_to/results_in)
   轮3: 聚合结果，提取共同特征
   → 返回: [{特征: "土地流转违约", 关联实体: [...], 因果链: [...]}, ...]
```

### 示例 4：双引擎对比

**用户**: "比较 Cognee 和 GraphRAG 对'资本下乡'的检索差异"

**操作序列**:
```
1. 通过 SAG inference-service.ts 的 cogneeSearch + graphiti refine 分别检索，手动对比结果
   注意: cognee_compare 工具已从 Cognee MCP server.py 移除 (v1.2.2)
   替代方案: 使用 recall 检索 + SAG Graphiti MCP chunk_search_entities 检索，自行对比重叠
```
注意: Cognee 实体更多 (11,156 vs 2,839) 但无蒸馏深度；GraphRAG 实体精炼且具五层蒸馏。

### 示例 5：系统运维

**用户**: "Cognee 图谱现在什么状态？"

**操作序列**:
```
1. get_client_info_json
   → {version: "1.2.2-local",
      llm_provider: "custom", llm_model: "openai/qwen-plus",
      embedding_model: "openai/text-embedding-v3",
      graph_db: "neo4j", graph_db_url: "bolt://127.0.0.1:11003",
      vector_db: "lancedb",
      graph_nodes: 15539, graph_edges: 49444}
```

---

## 五、交互与反馈

### 5.1 进度与状态
- 调用 MCP 工具无需进度提示（除 batch_ingest 是长耗时操作）
- 如果 Neo4j 不可用，cognee SDK 返回连接错误 → 告知用户 "Neo4j 未运行 (11003)，请启动 Cognee Neo4j"

### 5.2 错误处理速查

| 错误信息 | 原因 | 修复 |
|---------|------|------|
| "Neo4j unavailable" / "ServiceUnavailable" | Neo4j 11003 未启动 | 启动 Cognee Neo4j |
| "LLMAPIKeyNotSetError" | .env 未加载 | 确认 `os.chdir` 到 cognee 根目录 |
| "model_not_found: text-embedding-v4" (旧) | 部署初期 v4 在 DashScope 标准端点返回 404 | **已修复**: 2026-07-08 验证 v4 可用，.env 已升级 `EMBEDDING_MODEL=text-embedding-v4`，LanceDB 全量重建 |
| "429 Too Many Requests" | DashScope 限流 | 脚本自动退避，等待恢复 |
| `insufficient_quota` (429) | API key 配额耗尽 | 切换到备选 key: `.env` 用替换 4 处。**注意**: reembed 任务累积消耗 ~1,163×2=2,326 次 embedding 调用 |
| "Access denied" on MAAS endpoint | Graphiti 原用的 MAAS 端点 (`ws-4cbe4oorrmbrzdya.cn-beijing.maas.aliyuncs.com`) 不支持 embedding | Graphiti embedder 已切换到 DashScope 标准端点 (`dashscope.aliyuncs.com`) + Cognee 的 key |
| "UNIQUE constraint failed: data.id" | SQLite 重复文件 | 非致命，cognee 内部跳过 |
| "PermissionDeniedError" | ACL 权限 | `.env: ENABLE_BACKEND_ACCESS_CONTROL=false` |
| "SubprocessTransportError exit 0xC0000005" | Kuzu segfault | rm SQLite + 重跑 |
| "database is locked" | SQLite 并发冲突 | 等待 10s 自动恢复 |
| `NoDataError: TRIPLET_COMPLETION` | Triplet_text 未创建 | 运行 `recognify_triplet.py` |
| `PipelineRunAlreadyCompleted` | 增量加载阻止 | 用 `create_triplet_embeddings()` 代替 `cognify()` |
| `Range of input length [1, 8192]` | 三元组文本超长 | `OpenAICompatibleEmbeddingEngine.py` 已修复自动分割 |
| COT 超时 (>300s) | `max_iter` 过大 + `LLM_MIN_RETRY_SECONDS` | 已改为自适应轮次 (2-4) + 60s 重试冷却 |
| `CancelledError` (COT 中) | DashScope 服务端不稳定 | tenacity 退避重试, 新配置 60s 快速失败 |
| `aiohttp Unclosed client session` | 脚本未管理驱动生命周期 | 非致命, cognee 内部清理, 不影响功能 |
| LLM Judge 全 0 分 | DashScope 模型名 `openai/qwen-plus` 报 404 | 去掉 `openai/` 前缀, eval_cognee_rag_full.py 已修复 |
| Recall@10 = 0.245 (虚低) | HYBRID 返回 str 非 Edge 对象 | eval_cognee_rag_full.py 已改用 keyword-in-text 匹配 |
| orphan Chunk warning | LanceDB subprocess transport 并发时延 | `hybrid/chunks.py` 已加重试 |

### 部署优化层 (54-58) — v8 新增 (2026-07-08)
54. **向量模型 v3→v4 升级** — Cognee 部署初期 v4 在 DashScope 标准端点返回 404 → 2026-07-08 验证 v4 已可用。.env 升级为 `EMBEDDING_MODEL=text-embedding-v4`，LanceDB 全量重建 1,167 行 v4 向量 (scripts/reembed_chunks_v2.py --reset-checkpoint)
55. **Graphiti MAAS 端点 embedding 不通** — `ws-4cbe4oorrmbrzdya.cn-beijing.maas.aliyuncs.com` 对 v3/v4 embedding 均返回 Access denied → Graphiti embedder 切换至 DashScope 标准端点 `dashscope.aliyuncs.com` + Cognee 的 key (`<REDACTED>`)
56. **cognee_compare 缺少交叉校验** — 旧版只返回 count，无法判定两引擎是否覆盖同一批实体 → 增加规范化名称重叠分析 + Jaccard 相似度 + shared_entities/only_graphiti/only_cognee 报告 + 自动诊断 (LOW_OVERLAP/PARTIAL_OVERLAP/GRAPHITI_SILENT/GRAPHITI_SPARSE)
57. **评测全靠人工解读指标** — eval_unified.py 输出原始分数，无缺陷归类 → eval_auto.py 新增 11 类缺陷自动诊断 (D01-D11) + 按根因分组 + 自动生成 fix_plan.json 含可执行修复脚本路径
58. **11 类图谱缺陷无自动化** — 仅 binary dirty_source 检查 → scripts/defect_detector.py 覆盖 C1-C11 (缺失类型/空描述/孤立实体/低度数/泛型/重名/脏数据/模糊关系/弱边/缺失嵌入/过期节点)，检测后自动触发修复 (对 C1/C2/C3/C6/C7/C9/C10)

### 双引擎评测层 (59-63) — v9 新增 (2026-07-08)
59. **双引擎首次同卷同Judge对比** — eval_unified_dual.py 跑通：30题 × Cognee(GRAPH+qwen-plus) + Graphiti(hybrid+passages)，均用同一外部Judge(qwen-plus) 0-1打分。Cognee F=0.44/R=0.72/A=0.54/O=0.51; Graphiti F=0.51/R=0.78/A=0.92/O=0.48
60. **Cognee 实体提取空列表bug** — search() 返回 list[str]（LLM答案文本），旧代码尝试解析对象属性失败 → 改为 10,987 实体名词典匹配答案文本，R@10 从 N/A 提升至 0.90
61. **Graphiti 幻觉根因定位** — 旧提示词"严格基于提供的材料"太弱 → LLM 自由发挥编造因果关系 (F 0.24)。6条防幻觉铁律提示词（禁止因果推断/禁止"可能"/禁止假设/每句必须能指回段落编号）→ F 从 0.24 翻升至 0.51
62. **include_references 引入 -0.08~0.10 F 系统性偏差** — Evidence块改变答案格式，Judge 扣分。关闭 include_references 后 Cognee Relevance 从 0.72 回升到正常水平
63. **双引擎互补策略确认** — Cognee 擅长实体密集型政策/结构查询，Graphiti 擅长论文原文冷门主题。4个冷门话题（城乡收入差距/数字乡村/农地价格/科技转化）两引擎均低分，原因是论文库本身未覆盖这些方向，非检索技术问题

### 5.3 危险操作确认

以下操作执行前必须向用户确认:
- `cognee_forget(everything=true)` → 确认: "这将清空 Cognee 全部数据，不可恢复，是否继续？"
- `cognee_forget(dataset="capital_208")` → 确认: "这将删除 capital_208 数据集及所有关联图谱数据"

---

## 六、安全与权限声明

### 6.1 权限模型 (最小权限)
- **MCP 工具**: 11 个，全部通过 Cognee SDK 执行 (非直接数据库访问)
- **Neo4j 访问**: 通过 Cognee SDK 内部权限控制
- **向量库 (LanceDB)**: 嵌入式，本地文件，无网络暴露
- **API Key 隔离**: `LLM_API_KEY` / `EMBEDDING_API_KEY` 存储在 .env 文件，不通过 MCP 返回

### 6.2 数据隐私
- 所有图谱数据、向量、元数据均本地持久化
- 云端 API (阿里百炼 DashScope) 仅提供 LLM 推理和 Embedding 计算，不存储查询文本
- `.env` 中的 API 密钥不会通过 MCP 工具返回

---

## 七、部署踩坑全集 (28坑, v5)

### 基础层 (1-4)
1. Python 3.14 segfault — Kuzu C 扩展不兼容, 必须用 `.venv312` (3.12.10)
2. Docker VPN 不可靠 — Python venv 直启
3. 端口 8000/8001 冲突 — cognee 用 stdio
4. Neo4j 会话级生命周期 — 每次手动启动

### 网络层 (5-6)
5. huggingface.co 国内不可达 — `HUGGINGFACE_TOKENIZER=false`
6. 内网 Docker 代理无缓存 — 原生 Windows 安装

### API 层 (7-8)
7. embedding 模型名错误 — `text-embedding-v4` → `text-embedding-v3`
8. DashScope 429 限流 — tenacity 阶梯退避

### 引擎层 (9-12)
9. DashScope embedding batch ≤ 10 — `EMBEDDING_BATCH_SIZE=10`
10. tiktoken KeyError — `HUGGINGFACE_TOKENIZER=false`
11. litellm dimensions 冲突 — `drop_params=True`
12. Kuzu 迁移 segfault — SQLite wipe per batch

### 权限+数据层 (13-14)
13. ACL PermissionDeniedError — `ENABLE_BACKEND_ACCESS_CONTROL=false`
14. SQLite UUID 适配 — `Column(UUID)` → `String(36)`

### 三元组嵌入层 (15-17)
15. TRIPLET_COMPLETION NoDataError — `COGNEE_TRIPLET_EMBEDDING=true` + `create_triplet_embeddings()`
16. cognify() 增量加载阻止重处理 — `create_triplet_embeddings()` 内部 `incremental_loading=False`
17. embedding 文本超 8192 token — `OpenAICompatibleEmbeddingEngine.py` 追加错误模式

### COT 推理层 (18-21)
18. COT 超时根因 — `max_iter=4` × `retry=240s` = 52 分钟理论下限
    修复: retry 240→60s, max_iter 4→2, per-LLM 60s timeout, 降级兜底
    → COT 从 400s 超时 → 92s 成功 (4.3x)
19. COT 自适应轮次 — 图规模分档 + 收敛检测 + 显式上限 → 2 轮即收敛
20. COT 分层超时 — 每 LLM 调用 60s 隔离, 异常 break
21. COT IO 缓存 — 首轮图复用, 空 follow-up skip merge

### 运维层 (22-23)
22. API 密钥配额轮换 — 3 keys, `.env` 保留注释备份
23. 图谱冗余诊断 — `check_dup.py`, 语义边 0% 重复, 4% 同名实体

### 评估体系层 (24-28) — v5 新增
24. RAG 评估体系从零建立 — 30 条真值 + LLM Judge + Retrieval 指标 + 断点续跑
    最终: C=0.65, F=0.58, ER=0.68, Recall@10=0.5617, MRR=1.0
25. 实体匹配器幻数 0.245 — HYBRID 返回 str(LLM答案), 非 Edge 对象
    修复: keyword-in-text 匹配 → Recall 2.3x 提升
26. LLM Judge 模型名 404 — `openai/qwen-plus` DashScope 不认 → 去掉前缀
27. COT 空 follow-up 仍走 IO — 加长度检查, < 10 字符 skip merge
28. HybridRetriever orphan warning — LanceDB subprocess transport 重试

### W1-W5 忠实度修复层 (29-38) — v6 新增 (2026-07-07)
29. verify_faithfulness 模板语法 — `{context}` → `{{ context }}` (Jinja2 引擎需要双花括号)
30. verify_faithfulness 参数硬编码 — `graph_completion_retriever.py:88` `self.verify_faithfulness = False` → `= verify_faithfulness`
31. 查询缓存污染评测 — 工厂配置修改后缓存未失效, 返回旧答案 → 每次评测前清空 cache_kv
32. verify=ON 过度删除 — qwen3.7-max 将合理推断全部删除导致 F 暴跌 → 改为标注模式 (TEXT ANNOTATOR)
33. Entity→Chunk 路径错误 — 图投影无 DocumentChunk 节点 → 通过 Neo4j Entity←contains←Chunk→is_part_of→TextDocument 查询
34. ov_import 原文未加载 — Cognify 只提取术语表为 Chunk, 论文全文仅存 .data_storage → raw_text_augmenter 注入
35. LanceDB 向量缺失 96.6% — ChunkDP 非 DataPoint 子类 → 继承 DataPoint + model_fields + 断点续存
36. CO_OCCURS_WITH 边缺 source_node_id — link_cooccurring_entities.py 创建的边无此属性 → Neo4j UPDATE 补全
37. publication 实体污染上下文 — 229 个文献引用被提取为 Entity → 标记 dirty_source + 降权 topological_rank
38. qwen-plus Judge 评分尺度 — 要求与标准答案逐字匹配, 系统学术发散被扣分 → 理解 F=0.69 是语料 + Judge 天花板

### 评测踩坑层 (39-49) — v7-v10 新增 (2026-07-08)
39. Prompt 强制引用 → LLM 伪造引用 (v7 灾难) — 修改 prompt 要求 [来源:N], F 0.57→0.18, 延迟 16s→94s
40. verify_faithfulness 双倍 LLM + 警告头污染 (v7) — 延迟翻倍, 警告头被 Judge 扣分
41. top_k=20 加噪声不加分 (v7) — top_k=10 是甜点
42. qwen3.7-max < qwen-plus 忠实度 (v8) — max 知识更丰富学术发散更强, F=0.49 vs 0.57
43. include_references 被 Judge 系统性低估 (v8/v10) — Evidence 块改变答案格式, Judge 扣 0.08-0.10 F
44. HYBRID_COMPLETION 上下文过载 (v9) — Chunk+图谱+neighbor 三倍信息, F=0.37 低于 GRAPH
45. HybridRetriever 缺 include_references (v9 bug) — 需三步修改: 构造函数+factory+get_completion_from_context
46. Session Cache 返回过期答案 (v9) — 修复后重跑全 0s 完成, 需 CACHING=false
47. Session cache 跨 search_type 撞 key (v9) — key 不含 search_type, HYBRID 返回 GRAPH 旧答案
48. LLM Judge 对"带引文答案"有审美偏见 (系统性) — Judge 做文本相似度而非事实核查
49. Ground Truth 与语料库不对齐 — 4 个冷门话题 (城乡收入差距/数字乡村/农地流转价格/科技转化) F=0.0-0.2

### Chunk 注入 + 向量化 (v6)
50. 论文重分块: 1327 chunks (avg 4KB) → 14122 chunks (500-char sliding window, 50% overlap)
51. 向量重建: LanceDB DocumentChunk_text 14,608 vectors (断点续存 + 自适应batch)
52. raw_text_augmenter: Neo4j CONTAINS 全文检索 + ov_import 目录匹配 + 内存缓存
53. 5-Dim 评测收敛: HYBRID→GRAPH_COMPLETION→+raw_text→+verify→最终 F=0.685 (旧 Judge 标准)
54. 验证闭环: 6 轮评测确认贡献 (v5.1→Step1→Step2→Step4→词匹配→实体名10篇)

---

## 八、国内网络部署关键决策

| 决策 | 原因 |
|------|------|
| EMBEDDING_PROVIDER=openai_compatible | OpenAI SDK 直连 DashScope，绕过 litellm HF 注册表 |
| EMBEDDING_MODEL=text-embedding-v4 | DashScope 标准端点可用 (2026-07-08 已验证 v3/v4 均 200 OK)。v4 与 Graphiti 端统一。LanceDB 已全量重建 (1,167 行 v4 向量) |
| Python 3.12 (.venv312) | Python 3.14 + Kuzu C 扩展 → segfault |
| Neo4j 5.26.27 原生 Windows | 无 Docker 依赖，直连 bolt |
| COGNEE_SKIP_CONNECTION_TEST=true | 跳过 LLM 连接测试 (litellm + DashScope openai/ 前缀) |
| ENABLE_BACKEND_ACCESS_CONTROL=false | 单用户模式，免 ACL/多租户 |
| HUGGINGFACE_TOKENIZER=false | 国内 HF 不可达 |
| COGNEE_TRIPLET_EMBEDDING=true | 启用三元组嵌入构建 Triplet_text 集合 |
| DISABLE_AIOHTTP_TRANSPORT=true | 强制 litellm 使用纯 httpx，避免 aiohttp 连接错误 |

---

## 九、评测体系 (v10 Final, 2026-07-08)

### 9.1 五版评测结果总览

| 版本 | 检索 | 模型 | refs | F | R | C | A | O | 延迟 |
|------|------|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| v6 | GRAPH | qwen-plus | ✗ | **0.570** | **0.925** | **0.537** | 0.017 | 0.542 | 16.0s |
| v7 | GRAPH | qwen-plus | ✗ | 0.183 | 0.775 | 0.373 | 0.110 | 0.313 | 94.2s |
| v8 | GRAPH | qwen3.7-max | ✓ | 0.493 | 0.898 | 0.490 | 0.585 | **0.579** | 18.2s |
| v9 | HYBRID | qwen3.7-max | ✓ | 0.370 | 0.828 | 0.342 | **0.600** | 0.486 | 8.8s |
| v10 | GRAPH | qwen-plus | ✓ | 0.473 | 0.863 | 0.438 | 0.543 | 0.533 | 10.8s |

**结论**: v6 (GRAPH + qwen-plus, 不开 refs) Faithfulness 最优; v8 (GRAPH + qwen3.7-max + refs) Overall 最高。

### 9.2 天花板分析

| 指标 | 天花板 | 限制因素 |
|------|:---:|------|
| Faithfulness | 0.57 | LLM 天然改写补充，图谱只有骨架三元组，非论文原文 |
| Relevance | 0.93 | 检索质量好，主要是 GT 覆盖问题 |
| Completeness | 0.54 | GT 与语料库内容不一致 |
| Attribution | 0.60 | 只有确定性后处理 (references.py) 能提供真实溯源 |
| Overall | 0.58 | 四个维度的加权瓶颈 |

### 9.3 为什么指标接近不了 1.0

1. **检索层**: GRAPH_COMPLETION 搜三元组(实体-关系-实体)，不是论文原文段落。LLM 拿到骨架后靠自己知识生成
2. **生成层**: LLM 天然会改写重组补充。即使 temperature=0，它会用自己的知识填补上下文空白
3. **评测层**: qwen-plus Judge 做"与标准答案文本相似度"，不是事实准确性。两个表述不同但正确的答案也会扣分
4. **数据层**: Ground Truth 是人工独立写的，208 篇论文只是学术界一部分。标准答案涵盖 ≠ 语料库包含

### 9.4 统一评测脚本

```bash
cd %USERPROFILE%/.claude/skills/marx-cognee/scripts

# 刷榜最优: GRAPH + qwen-plus (F=0.57)
%USERPROFILE%/cognee/.venv312/Scripts/python.exe %USERPROFILE%/.claude/skills/marx-cognee/scripts/eval_unified.py

# 溯源最优: GRAPH + qwen3.7-max + refs (A=0.59)
%USERPROFILE%/cognee/.venv312/Scripts/python.exe %USERPROFILE%/.claude/skills/marx-cognee/scripts/eval_unified.py --model qwen3.7-max --refs

# 折中: GRAPH + qwen-plus + refs (F=0.47, A=0.54)
%USERPROFILE%/cognee/.venv312/Scripts/python.exe %USERPROFILE%/.claude/skills/marx-cognee/scripts/eval_unified.py --refs

# 查看所有选项
%USERPROFILE%/cognee/.venv312/Scripts/python.exe %USERPROFILE%/.claude/skills/marx-cognee/scripts/eval_unified.py --help
```

### 9.5 评测前必检清单

- [ ] CACHING=false 已在脚本/环境变量中设置（默认）
- [ ] Neo4j 运行在 11003
- [ ] verify_faithfulness=False（工厂默认）
- [ ] top_k=10（不是 20）
- [ ] answer_simple_question.txt 是原始版（非强制引用版）
- [ ] 跨 search_type 评测已禁用缓存（session cache key 不含 search_type）

### 9.6 已知低分查询

| Query | F | 原因 |
|-------|---|------|
| 城乡收入差距变化趋势及原因 | 0.00 | 论文无收入比趋势数据 |
| 数字乡村建设对农业生产效率的提升 | 0.20 | 论文覆盖面不足 |
| 农地流转价格的决定因素 | 0.20 | 论文无定价机制研究 |
| 农业科技成果转化的障碍因素 | 0.20 | 论文无技术转化专题 |

### 9.7 外部 RAG 评测框架对比

业界有三款主流开源框架可以替代或补充当前的 LLM Judge 方案:

| 框架 | 核心指标 | 优势 | 对当前系统的价值 |
|------|---------|------|----------------|
| **Ragas** | Faithfulness, Context Precision/Recall, Answer Relevancy | 学术基准、RAG 专精、测试集生成器 | 自动检测"回答中的事实是否能从检索上下文中推断"——直接解决 Graphiti 的幻觉盲区 |
| **DeepEval** | 50+ 指标, G-Eval, DAG 决策树, pytest 原生 | CI/CD 集成、自定义中文 LLM (Qwen/DeepSeek) | 通过继承 `DeepEvalBaseLLM` 可接入 DashScope qwen-plus 作为评估模型，替代自建 Judge |
| **TruLens** | RAG Triad (Context Relevance/Groundedness/Answer Relevance), OpenTelemetry 追踪 | 排名质量最优 (NDCG@5=0.932, Spearman=0.750) | 统一追踪+评估，适合生产监控 |

**当前自建方案 vs 外部框架**:

| 维度 | 自建 (eval_unified_dual.py) | Ragas / DeepEval |
|------|--------------------------|-------------------|
| Faithfulness 定义 | "与标准答案的文本相似度" | "每个陈述是否能在检索上下文中找到" |
| 缺陷检测 | 11 类 (D01-D11) 自动诊断 | Context Precision/Recall 自动分解 |
| 评测模型 | qwen-plus (0-1 直接打分) | 支持 Qwen/DeepSeek/GPT-4o 等 |
| 测试集生成 | 人工 30 题 | 自动合成 + 人工校验混合 |
| 集成度 | 独立脚本 | pytest / CI / OTel |

**建议方案**: 保留 eval_unified_dual.py 作为快速冒烟 + 双引擎对比。补充 Ragas 的 Faithfulness + Context Precision + Context Recall 三个指标，用于深度诊断: 每次评测自动输出"多少比例的陈述是幻觉""哪些检索段落未被利用""哪些相关段落未被召回"。

---

## 十、Debug 速查

### 快速健康检查

```bash
# Neo4j 连通性
%USERPROFILE%/cognee/.venv312/Scripts/python.exe -c "
from neo4j import GraphDatabase
d = GraphDatabase.driver('bolt://127.0.0.1:11003', auth=('neo4j','neo4j123'))
d.verify_connectivity(); print('OK')
"

# LanceDB chunk 数量
.venv312/Scripts/python.exe -c "
import lancedb
db = lancedb.connect('cognee/.cognee_system/databases/cognee.lancedb')
print(f'Chunks: {db.open_table(\"DocumentChunk_text\").count_rows()}')
"

# verify_faithfulness 标志位检查
.venv312/Scripts/python.exe -c "
import asyncio, sys; sys.path.insert(0,'.')
from cognee.modules.search.methods.get_search_type_retriever_instance import get_search_type_retriever_instance
from cognee.modules.search.types import SearchType
async def t():
    r = await get_search_type_retriever_instance(query_type=SearchType.GRAPH_COMPLETION, query_text='test', top_k=5)
    print(f'verify_faithfulness={r.verify_faithfulness}')
asyncio.run(t())
"
```

### 缓存管理

```bash
# 查看缓存查询
python -c "import sqlite3; conn=sqlite3.connect('cognee/.cognee_system/databases/cache.db'); rows=conn.execute(\"SELECT key FROM cache_kv WHERE key LIKE 'query_result:%'\").fetchall(); print(f'{len(rows)} cached'); [print(r[0][:80]) for r in rows[:5]]"

# 清空所有查询缓存
python -c "import sqlite3; conn=sqlite3.connect('cognee/.cognee_system/databases/cache.db'); conn.execute(\"DELETE FROM cache_kv WHERE key LIKE 'query_result:%'\"); conn.commit(); conn.close(); print('Cleared')"
```

### 状态检查表

| 检查项 | 期望值 | 命令 |
|--------|--------|------|
| verify_faithfulness | False (生产) | 见上 |
| DocumentChunk 数 | 1,163 | `MATCH (dc:DocumentChunk) RETURN count(dc)` |
| LanceDB 向量数 | >= 1,163 | 见上 |
| Raw text augment | ENABLED | 检查 `ENABLE_RAW_TEXT_AUGMENT=true` |
| Dirty entities | 229 | `MATCH (e:Entity {dirty_source:'publication_citation'}) RETURN count(e)` |

### 常见修复

**verify_faithfulness 不触发**: 检查 factory 中的 `verify_faithfulness: False` → 确认 `graph_completion_retriever.py` 不是硬编码 `False`

**Chunk 注入不工作**: 检查 `ENABLE_RAW_TEXT_AUGMENT=true` → Neo4j DocumentChunk >= 1,163 → LanceDB 向量 >= 1,163

**评分看起来不对**: 先清缓存 (缓存污染是 #1 原因) → 检查 Judge 模型 (qwen3.7-max 比 qwen-plus 慷慨) → 确认 verify=False

**脏实体出现在搜索结果中**: `%USERPROFILE%/cognee/.venv312/Scripts/python.exe %USERPROFILE%/.claude/skills/marx-cognee/scripts/clean_dirty_entities.py`

---

## 十一、论文重分块

### Pipeline

```bash
# Step 1: 重新分块到 Neo4j (~30s)
%USERPROFILE%/cognee/.venv312/Scripts/python.exe %USERPROFILE%/.claude/skills/marx-cognee/scripts/rebuild_from_zero.py
.venv312/Scripts/python.exe scripts/rechunk_papers.py
.venv312/Scripts/python.exe scripts/rechunk_papers.py --dry-run  # 预览

# Step 2: 向量化到 LanceDB (~18min)
.venv312/Scripts/python.exe scripts/reembed_chunks_v2.py [--batch-size 50] [--reset-checkpoint]

# Step 3: 验证
.venv312/Scripts/python.exe -c "
import lancedb
db = lancedb.connect('cognee/.cognee_system/databases/cognee.lancedb')
tbl = db.open_table('DocumentChunk_text')
print(f'LanceDB rows: {tbl.count_rows()}')
"
```

### 关键参数
- 滑动窗口: 500 char, 250 char step, 50% overlap
- 断点续存: `scripts/.reembed_checkpoint.json` → 自动跳过已完成 chunk
- 自适应 batch: 初始 50, 遇 API 错误自动缩放 5-50
- 全局 try-except: 记录失败 chunk ID, 永不终止

### 重分块踩坑
1. **必须继承 DataPoint** — 简单类缺少 `model_fields`, LanceDB adapter 报 AttributeError
2. **重分块删除所有旧 Chunk** — Entity→Chunk 关系断裂但实体保留
3. **Checkpoint 文件持续增长** — 从零开始需删除 `scripts/.reembed_checkpoint.json`
4. **API 限流** — 自适应 batch 处理 429 错误, stable at batch=50
5. **Schema migration** — DataPoint 字段变化时 LanceDB 自动迁移

---

## 十二、服务启动与运维脚本

```bash
# 1. Cognee Neo4j (端口 11003)
%USERPROFILE%\neo4j\neo4j-community-5.26.27-cognee\bin\neo4j.bat console

# 2. Cognee Backend (端口 8000, HTTP API) — 按需
%USERPROFILE%\cognee\.venv312\Scripts\uvicorn cognee.api.client:app --host 0.0.0.0 --port 8000

# 3. MCP stdio 由 Claude Code 自动拉起 (mcp.json 已配置)
```

### 核心运维脚本

| 脚本 | 路径 | 用途 | 耗时 |
|------|------|------|:--:|
| 统一评测 | `eval_unified.py` | 参数化 5-Dim Judge, 支持 --search/--model/--refs | ~15min |
| 双引擎统一评测 | `eval_unified_dual.py` | Cognee+Graphiti 同卷同Judge对比 (30题)。支持 --sample/--engine/--judge-model/--resume | ~12min |
| 自动评测+缺陷报告 | `eval_auto.py` | 五阶段自动评测→缺陷诊断→修复计划生成。支持 --trigger-fixes / --retry-failed | ~20min |
| 论文重分块 | `scripts/rechunk_papers.py` | 208 篇→14,122 Chunk (500-char sliding) | ~30s |
| 向量重嵌入 | `scripts/reembed_chunks_v2.py` | LanceDB 向量入库 (断点续存 + 自适应batch)。v4 全量重建完成 | ~18min |
| 脏实体清理 | `scripts/clean_dirty_entities.py` | 标记 229 个 publication 引用实体 | ~1s |
| 实体别名重建 | `scripts/build_entity_aliases.py` | 1,752 组别名覆盖 4,457 实体 | ~30s |
| 跨图谱实体对齐 | `scripts/align_cross_graph.py` | 3 层匹配 (exact→embedding→fuzzy) Cognee↔Graphiti。输出 cross_graph_alignment.json | ~5min |
| 缺陷检测+修复 | `scripts/defect_detector.py` | 11 类缺陷 (C1-C11) 自动检测，C1/C2/C3/C6/C7/C9/C10 可自动修复 | ~30s |
| 共现边构建 | `cognee/memify_pipelines/link_cooccurring_entities.py` | 17,509 条 CO_OCCURS_WITH 边 | ~10s |
| RAG 快速冒烟 | `quick_smoke.py` | 单查询 CoT 冒烟测试 | ~2min |
| 三元组嵌入 | `recognify_triplet.py` | `create_triplet_embeddings()` 构建 Triplet_text | ~1.5h |
| 图谱诊断 | `check_dup.py` | Neo4j Cypher 诊断: 节点/边/重复/缺失 | <1min |
| orphan 检查 | `fix_orphan_summaries.py` | LanceDB orphan 检测 (留存) | <1min |
| API key 轮换 | `.env` 替换 4 处 key | 切换到备选配额 | <1s |

### 评测技术细节

#### 评测维度 (5维 LLM Judge)
1. **Faithfulness (忠实度)**: 回答中的事实声称是否在标准答案中找到对应？有无编造实体/数据/因果？
2. **Relevance (相关性)**: 回答与问题的匹配程度？有无答非所问？
3. **Completeness (完整性)**: 覆盖了标准答案的多少方面？
4. **Attribution (溯源度)**: 是否引用了具体来源/论文/数据？
5. **Overall (综合)**: 综合4个维度的整体质量

#### Judge 模型
- 评测用: qwen-plus (DashScope) — 统一脚本默认，更快的评测反馈
- 搜索用: qwen-plus/qwen3.7-max (按需)
- 温度=0，max_tokens=300

#### 关键注意事项
- **缓存污染**: 跨 search_type 必须 CACHING=false
- **Neo4j 依赖**: 端口 11003 必须在运行
- **verify_faithfulness**: 默认 False (永不用于生产评测)
- **评测耗时**: Phase 1 (采集) ~10min + Phase 2 (评分) ~5min = ~15min 总计

---

## 十三、与 marx-graphiti / marx-cognee-ingest 的分工

| | marx-cognee | marx-graphiti | marx-cognee-ingest |
|---|---|---|---|
| 用途 | 通用 KG 构建+检索 | 马理论领域精炼检索 | 批量入库 |
| 图谱 | Neo4j:11003 (15,539n) | Neo4j:11001 (21,027n) | 写入 Neo4j:11003 |
| 检索策略 | 17种 (CoT/Agentic/Code等) | 4级 19工具 (entity/chunk/distill/domain) | 不检索 |
| 部署 | Python venv stdio MCP | Python stdio MCP | Python venv stdio MCP |
| 数据 | 208篇/通用 KG | 208篇/领域精炼 | 增量 + 断点续传 |
| 蒸馏 | 无 | 五层 + 四层领域 | 无 |
| 实体 | 11,156 (自动抽取) | 2,839 (手写 pipeline) | N/A |
| 评估 | 无 | R@10=0.9354, E2E=4.96 | N/A |
| 入库 | add()→cognify() (API) | robust_pipeline_v3 (CLI) | batch_ingest MCP |

**互补模式**: marx-cognee 提供通用 AI Memory + 17种策略 + CoT/Agentic 推理，marx-graphiti 提供五层蒸馏 + 领域归纳 + 段落溯源 + 质量评估。marx-cognee-ingest 负责 Cognee 侧批量入库。三引擎 Claude Code 统一调度，双引擎同时查询时用 `cognee_compare()` 获取交叉验证。

---
*与 marx-graphiti、marx-cognee-ingest 共同构成完整的 208 篇论文双引擎知识图谱闭环。*
*Last updated: 2026-07-08 (v9 — 双引擎统一评测 / 59+5=64 坑 / eval_unified_dual.py / Graphiti 防幻觉提示词 / 实体提取修复 / 双引擎互补策略)*

---

## V89 模型迁移 (2026-07-31)

| 模型 | 用途 | 端点 | API Key |
|------|------|------|---------|
| qwen-plus | 全部 LLM (GenericAPIAdapter) | ws-*.maas.aliyuncs.com/compatible-mode/v1 | EIYLDIH MAAS |
| text-embedding-v4 | 全部 Embedding (OpenAICompatibleEmbeddingEngine) | ws-*.maas.aliyuncs.com/compatible-mode/v1 | EIYLDIH MAAS |
| qwen-plus (Fallback) | Fallback LLM | ws-*.maas.aliyuncs.com/compatible-mode/v1 | EIYLDIH MAAS |

> Cognee 无法迁移到 DeepSeek 原生 — litellm 不支持 deepseek provider
> LLM_PROVIDER="openai", LLM_MODEL="openai/qwen-plus" 是通过 litellm 的唯一路径
> custom/deepseek/deepseek-chat 都会被 litellm 拒绝

## SAG V88K 中 Cognee 的角色

Cognee 是 SAG Stage2 的 **主搜索引擎** (V88K 改造后):
- HYBRID_COMPLETION (BM25+向量RRF融合) 替代 CHUNKS (纯向量) 作为主路径
- 9路并行检索 (CHUNKS_LEXICAL + RAG + SUMMARIES + GRAPH + GRAPH_DECOMP + TRIPLET + SUMMARY + CONTEXT_EXT + TEMPORAL)
- 10路 → 9路 (移除了纯向量 CHUNKS 冗余)
- BM25 对精炼术语(如"三个突出")有精确匹配优势

## 关键限制

- **litellm deepseek 兼容性**: Cognee 必须保留 MAAS, 因为其内部的 litellm 栈不支持 deepseek provider
- **Embedding 只走 MAAS**: text-embedding-v4 在 MAAS OpenAI-compatible 端点可用 (dashscope 原生 embedding 端点在 MAAS 下不可用)
- **LLM_PROVIDER 模式**: custom → GenericAPIAdapter 直连; openai → OpenAIAdapter 包装

## CACHING 规则 (铁律)

- 评测前必须 `CACHING=false` 或清空 cache_kv
- 跨 search_type 评测必须禁用 session cache
- Config 变更 (verify toggle, factory) 不清缓存 → 结果不可复现

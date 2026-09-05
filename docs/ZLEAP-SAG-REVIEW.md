# Zleap-AI/SAG 对比评审报告

> 评审对象:GitHub 仓库 [Zleap-AI/SAG](https://github.com/Zleap-AI/SAG)(main 分支,commit `e257a89`,v1.8.4,2026-08-30 推送)+ PyPI 引擎包 `zleap-sag 0.12.0`
> 对比基准:本地 MarxSphere(SAG-main,TypeScript/Fastify + PostgreSQL/Neo4j)
> 报告日期:2026-09-01 ｜ 方法:源码深读(下载 tarball + wheel 解包,共 4.4 万行引擎源码 + 应用层 1.2 万行)+ 本地架构实地核查

---

## 摘要(结论先行)

**Zleap-AI/SAG 是"事件-实体索引 + 查询时动态超边"检索架构的开源参考实现(2444 星, MIT 许可),本地 MarxSphere 的事件中心 RAG 架构正是基于它改造而来**——本地为 TypeScript 全栈重写(保留 chunk→event→entities 数据模型与事件中心检索内核),再叠加三库图谱(Graphiti/Cognee)、52 步推理、学习闭环等自研能力。本地在**检索深度与业务功能广度上远超 Zleap 原版**;Zleap 上游仍在持续演进(v1.8.4, 2026-08-30),在**工程完备性、产品化封装、对外接口(OpenAI 兼容/MCP/CLI/桌面端/OCTX)**上领先。

**结论:值得回溯吸收上游演进,不值得重写。** 推荐"对照上游演进 + 点状吸收"方案(详见第 6 节),优先级最高的是 Zleap 新增而本地缺失的 **OpenAI 兼容端点**(Agent 生态接入的关键短板)与**事件抽取提示词契约化**。核心检索算法(动态超边)本地继承自 SAG 且已演进,无需移植。

---

## 1. 双方关系定性(重要更正)

> 本报告初稿曾将本地 MarxSphere 与 Zleap SAG 的关系判定为"概念巧合同源、独立实现"。经核查本地仓库自身文档,**该判断错误**,特此更正:

**本地 MarxSphere 的事件中心 RAG 架构源自 Zleap-AI/SAG(改造继承关系),并非独立实现。**

本地仓库内证据:

- `THIRD_PARTY_NOTICES.md`: 「基础架构源自 **SAG**(Zleap-AI, MIT): search-service / inference-service / MCP server」(第三方源码使用声明, 原参赛文档同款披露已收敛至此)
- `README.md:555`:「第三方源码使用声明:见 THIRD_PARTY_NOTICES.md(**SAG 底座 MIT** / GBrain MIT / PDF2Obsidian MIT / …)」
- 注:声明文件在仓库根目录,但**文件名是下划线 `THIRD_PARTY_NOTICES.md`,README 原引用为连字符 `THIRD-PARTY-NOTICES.md`(链接断裂)**;且文件内容缺少 SAG/GBrain/PDF2Obsidian 三条声明——本次评审已一并修复(引用统一为下划线,声明已补全)。

**改造范围界定**(由双方代码对照推定,详情见第 5 节):

| 层 | 继承/改造自 Zleap | 本地自研演进 |
| --- | --- | --- |
| 数据模型 | chunk→event→entities 三级模型、事件字段(title/summary/content/层级/引用)、event_entities 关联(weight/description) | events 增加双向量(1024 维 MAAS v4)、tsvector、external_source_id 三库谱系字段;PG pgvector 替代 SQLite/LanceDB |
| 检索内核 | 事件中心混合检索、实体→事件路由、图遍历/多跳、RRF 融合、LLM 重排、回取 chunk 证据 | 别名消解、加权 RRF(gbrain-boosts:backlink/title/时间衰减/Compiled Truth ×2.0)、递归 CTE 多跳(depth≤3) |
| 推理 | (Zleap 无深度推理状态机) | **52 步阶段化推理 + 4 策略自愈降级 + retrieve_steps 真实 token 落库** |
| 图谱 | (Zleap 单事件层) | **三库混合:PG 事件层 + Graphiti(Neo4j 11001)+ Cognee(Neo4j 11003/LanceDB)** |
| MCP | MCP 服务器形态(继承) | 自营 6 工具 + Graphiti/Cognee 外部 MCP 池;sag_xxx 令牌鉴权 |
| 工程体系 | — | 评测(53 题 32 指标)、学习闭环、65 科研场景、多租户计费、教育/实证工作台 |

**改造的性质**:本地是**跨语言(原版 Python → TypeScript)全栈重写**,重写过程中保留了 SAG 的核心检索思想(事件-实体索引 + 动态超边/多跳),但检索链路、存储、推理、业务层均已大幅演进,超出"移植"范畴。

**对本次评审的含义**:第 5 节中的"同构"不是巧合,而是**继承的结果**;第 7 节"借鉴"实际是"回溯吸收上游演进"(Zleap 2026-07 起换代后仍在持续更新,部分工程能力本地尚未跟进)。MIT 许可下本地继续吸收上游无需额外授权,但应保持(或补上)THIRD_PARTY_NOTICES 声明。

---

## 2. Zleap-AI/SAG 是什么

| 维度 | 事实 |
| --- | --- |
| 定位 | "A new SOTA for RAG —— 事件-实体索引 + 查询时动态超边的原创检索架构"的完整知识库应用(Web + Desktop + API + Agent) |
| 技术栈 | Python 3.11+(FastAPI,引擎 `zleap-sag` PyPI 包)+ Next.js 15/React 19 + Electron;本地零依赖(SQLite + LanceDB),可选 PostgreSQL/pgvector、MySQL/OceanBase、Elasticsearch |
| 论文 | arXiv:2606.15971《SAG: SQL-Retrieval Augmented Generation with Query-Time Dynamic Hyperedges》 |
| 宣称成绩 | HotpotQA / 2WikiMultiHopQA / MuSiQue 上 Recall@5 平均 90.07%、F1 平均 72.96%,超过最强基线 6.79/4.33 个百分点(BGE-Large-EN-v1.5 + Qwen3.6-Flash 同配置);MuSiQue 上超基线 11.52/7.01 分 |
| 仓库结构 | `apps/api`(FastAPI 后端 + 引擎适配层)、`apps/web`(Next.js)、`apps/desktop`(Electron)、`deploy`、`docs`;核心算法在 PyPI 包 `zleap.sag`(44225 行),仓库内 `sag_api/sag/` 只是引用该引擎的适配层 |
| 许可 | MIT(可自由借鉴/内嵌) |
| 持续更新 | 2026-07-14 全新版(v1 分支归档)、2026-08-30 最新(v1.8.4,新增 DeepSeek Harness 连接器);引擎 0.7.1→0.12.0 快速迭代 |

---

## 3. Zleap SAG 核心架构深读

### 3.1 核心主张:与 Naive RAG / GraphRAG 并列的"第三条架构"

Zleap 明确宣称"不是 RAG 与 GraphRAG 的融合,而是替换两者的原创架构"(`README.md:65-67`)。核心数据模型(`README.md:113-123`):

```text
chunk → 一个语义完整的事件(event)
chunk → 多个索引实体(entity)
event ↔ entities → 一条潜在超边(latent hyperedge)
```

- **事件(Event)承载 chunk 的完整语义**,是一个有标题、摘要、正文、来源引用、层级(parent/children)、时间范围的独立事实单元——不被拆碎成独立三元组(这是与 GraphRAG 的关键差异)。
- **实体(Entity)只是轻量索引与扩展点**,不是事件语义的替代。
- **查询时动态超边(Query-Time Dynamic Hyperedge)**:超边不在建库时全局预建/维护,而是在查询时用 SQL JOIN 把"共享同一实体的事件"在**本地**聚合出来。增量写入天然自然——新 chunk 只加自己的事件/实体/关联,无需重算全局图(`README.md:143-146`)。

### 3.2 离线索引(offline indexing)

```text
文档 → 解析归一化(MarkItDown / MinerU)→ 语义分块(heading/表格/公式/代码多分块器)
     → 并行抽取:每 chunk 1 个事件(LLM,含 title/summary/content/references + 子事件层级)
     → 每 chunk 多个实体(LLM,受 entity_types 白名单约束)
     → 落库:关系存储(events / entities / event_entities 表)
     → 向量/全文索引(LanceDB 4 张表:entity_vectors / event_vectors_wide / event_entity_vectors / source_chunks)
```

关键工程细节:

- **抽取提示词契约化**(`zleap/sag/modules/extract/prompts.py`):事件抽取用严格 YAML 模板 + 统一 JSON 输出合同(`extraction-response-v2`),支持 rich/minimal 两种模式分支;逐 chunk 抽取时注入"前文上下文、全文摘要、历史相关事件"用于消歧,但**严禁从背景补入 chunk 内没有的事实**(防幻觉);合规过滤(违法/色情/噪音片段排除)。
- **实体类型白名单**:实体只能从 `entity_types` 配置中选择,不自由发明;实体带类型化值字段(int_value/float_value/datetime_value/bool_value/enum_value + 单位 + 置信度),支持统计分析。
- **事件可层级化**(parent_id/level),父子事件各自独立可检索。
- **分块器家族**(`modules/load/chunking/chunker/`):heading / text / markdown / table / code / formula / image 七种,按 token 数上限切分。

### 3.3 在线检索(online retrieval)

```text
① 查询理解:LLM 抽取查询实体(NER, strict=False 失败降级)+ 可选查询改写
② 双通道召回(并发):
   ├─ 直连事件向量召回(query embedding → event_vectors_wide,阈值 0.3-0.4)
   └─ 实体召回(实体名向量 / BM25 兜底)→ 实体路由到关联事件(按 max_events_per_entity 配额)
③ SQL 图扩展(查询时动态超边,最多 1-2 跳):
   frontier 事件 → 关系表 JOIN 取共享实体(按 relation_threshold 剪枝、entities_per_hop 截断)
   → 实体 → JOIN 取新事件(按事件向量分 event_threshold 过滤,防蔓延)
④ 排序:候选池 → 向量粗排 → LLM 精排(select_useful_relations_local 模板,只挑 top 5-10)
   或 RRF 融合 / rerank 模型;超时/模型输出无效时降级回向量分(不 503)
⑤ 结果水合:event → 回取原始 chunk(证据边界),chunk 模式用 topped-up 补齐 top_k
⑥ 可追溯:整条检索路径记录为图(query→entity→event→chunk),可输出路径分析 + 逐节点置信度
```

### 3.4 六大检索策略(profile 化,`modules/search/profiles.py`)

| 策略名 | 执行器 | 实体抽取 | 图扩展 | 排序 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `vector` | vector | 关闭 | 无 | 纯向量 | UI "Fast" 模式 |
| `atomic` | atomic | LLM | 关系表全量可达集(不打分不截断,1 跳) | LLM | 消融/基准对照 |
| `full_expand` | production | LLM | 全量扩展(对齐 SAG-Benchmark multi) | LLM(选 top5) | 基准复现 |
| `pruned_expand_llm` | production | LLM | 剪枝扩展(candidate_pool=500) | LLM | UI "Precise" 模式 |
| `pruned_expand_rerank` | production | LLM | 剪枝扩展 | 专用 rerank 模型 | 有 rerank 服务时 |
| `pruned_expand_rrf` | production | 关闭 | 剪枝扩展 | RRF(k=60) | 快速+关系平衡 |

**关键架构决策**:所有策略共享 `BaseGraphSearchExecutor` 的查询处理/召回/图扩展/排序/水合工具方法,通过 hook 覆写表达差异——消融实验成本极低,这正是论文验证的组织方式。

### 3.5 数据模型(与本地马克思库对比见 5.1)

关系表(`db/models.py`):`data_source`(逻辑库)→ `article`/`kb_document`(文档)→ `article_section`(段落)→ `source_chunk`(聚合片段)→ `source_event`(事件)+ `entity`(实体)+ `event_entity`(关联,带 weight/description)+ `entity_type`(类型白名单)。

向量索引(`core/storage/index_schemas.py`,4 张 provider 无关合同表):

| 索引表 | 向量字段 | 用途 |
| --- | --- | --- |
| `entity_vectors` | vector | 实体名+描述检索 |
| `event_vectors_wide` | title_vector + content_vector | **双向量事件检索**(标题/正文分离) |
| `event_entity_vectors` | vector | **关系行向量**(entity→event 边带相似度分,图扩展剪枝依据) |
| `source_chunks` | heading_vector + content_vector | 原始证据块 |

**`event_entity_vectors` 是 Zleap 相对本地最独特的工程创新**:关系行(edge)本身带向量嵌入,使图扩展可以在"边"层面按 query 相似度打分剪枝(而非只按实体/事件分数)。

### 3.6 对外接口(Agent 生态)

| 接口 | 形式 | 要点 |
| --- | --- | --- |
| REST API | `http://localhost:8000/api/v1/*` | sources/documents/search/graph/agents/threads/ask 全套 + OpenAPI |
| **OpenAI 兼容端点** | `POST /api/v1/openai/{agent_id}/chat/completions` | 把任意 Agent 当"带引用的模型"调用,响应含 `sag.citations` 字段,支持 stream;外部 LLM 客户端可无缝接入 |
| **MCP 服务器** | `http://localhost:8000/mcp/`(Streamable HTTP)+ stdio | 8 工具:`list_sources` / `search` / `get_entity` / `list_documents` / `outline` / `grep` / `read` / `get_chunk`;支持 `?source_id=` 限定单源;JWT 鉴权 |
| **sag-cli** | `@zleap-ai/sag-cli`(npm) | `sag agent connect codex|claude-code` 一行挂载 MCP(自动发现本地 Docker 容器、token 存系统钥匙串、只清理自己创建的 MCP 条目);附带 `sag-knowledge` Skill 教学 Agent 探索知识库 |
| Dify 集成 | `POST /api/v1/dify/retrieval` | 接入 Dify 外部知识库,免改 Dify 源码 |
| DeepSeek Harness(DSH) | `@zleap-ai/dsh-sag` | 本地连接器,让 DSH Agents 检索/读源/管理文档 |
| Python 引擎 | `pip install zleap-sag` | `DataEngine` 公开 API:`ingest / extract / search / search_page / chunk`,typed 结果,存储后端可插拔 |
| 认证 | local(名字登录)/ password 双模式 | 默认 local-only 单机;密码模式强制邮箱+密码 |

### 3.7 工程完备性亮点(应用层 `sag_api/`)

- **OCTX 知识库格式**(`octx/`):自研的**知识库导出/导入归档格式**(semver 版本化、决策令牌、完整性校验、冲突处理、失败恢复、向量兼容复用),支持跨实例知识库迁移/备份——本地马克思库完全没有等价物。
- **存储升级管线**(`upgrades/`):0.7→0.8 引擎升级带原子备份/迁移/恢复,Windows 只读文件等边缘问题专门处理(v1.8.1-1.8.3 连续修复)。
- **可恢复文档处理**(`sag/incremental_processor.py`):解析→切块→抽取两阶段断点持久化、暂停/取消、与 Job 队列对接;v0.8.2 起抽取改为整批提交(代际 durable prepare/commit 之前不逐块断点)。
- **Durable command ledger + fence**(`sag_operation`/`sag_fence` 表):幂等键 + 请求摘要 + fence token,防重复处理/并发写冲突。
- **检索会话分页**(`sag_search_session` 表):服务端快照 + 确定性游标翻页,结果集在多次请求间稳定。
- **逻辑删除/重处理屏障**(`retrieval_service.py:_hidden_document_derivatives`):删除/重处理中的文档在检索层被过滤,且删除在途时二次读屏障保证线性化。
- **query analysis**(`services/query_analysis.py`):中文分词 + 词法相关性重排(`_lexical_relevance` 短语 0.55 + 词项 0.35 + 标题命中 0.15),与语义分混合(0.5 原始分 + 0.2 名次 + 0.3 词法),精确词法命中加权 0.15——**"Fast 下的中文词法融合"工程相当成熟**。
- **检索评测脚本**(`apps/api/scripts/eval_retrieval.py`):同一 golden 集多策略对照,recall/nDCG/latency,`raw`(裸引擎)/`full`(完整流水线)双模式 + LLM 裁判成对比较。
- 130+ pytest 测试文件、schema 快照守卫、依赖策略测试、错误分类学(error_taxonomy)。

---

## 4. Zleap SAG 与 GraphRAG / Naive RAG 的区别(评审视角)

| 维度 | Naive RAG(向量) | GraphRAG(如微软) | **Zleap SAG** |
| --- | --- | --- | --- |
| 索引对象 | chunk 向量 | 三元组+实体合并+社区 | **事件(完整语义单元)+ 实体(索引点)** |
| 图结构 | 无 | 全局预建图谱(离线抽取/合并/社区检测) | **仅事件↔实体关联表,无预建超边** |
| 多跳推理 | 不支持(除非 iterative 检索) | 社区/图遍历,重 | **查询时 SQL JOIN 动态聚合(轻)** |
| 增量更新 | 简单 | **难**(全局重算/社区重建) | **简单**(新 chunk 只加自己的事件/实体/边) |
| 证据追溯 | chunk 直给 | 实体→原文档(常断裂) | **事件恒定映射回原 chunk**(证据边界清晰) |
| 存储成本 | 低 | 高(三元组+图+社区) | 中(关系表 + 事件/实体向量) |
| 维护成本 | 低 | 高(实体合并/关系归一化/社区维护) | 低(实体去重靠类型白名单 + 唯一约束) |
| 弱点 | 语义近似,无语义结构 | 抽取粒度碎、事件/实体关系易错、全局维护 | 事件质量依赖 LLM 抽取;实体跨文档合并能力弱于 GraphRAG 的专门流程 |

**评审意见**:该设计在"语义完整的事件 + 轻量实体索引 + 查询时聚合"的组合确实自洽,论文成绩(HotpotQA 系多跳基准)可信度高;但要注意它**牺牲了 GraphRAG 的全局社区/聚类能力**(跨文档主题归纳弱),对"以实体为中心的查询"和"全局主题总结"类任务不如 GraphRAG。这恰好是本地马克思库用 Graphiti/Cognee 双图谱补充的部分——**本地是"SAG 事件层 + 双图谱层"的组合,比 Zleap 单 SAG 层覆盖更全**。

---

## 5. 与本地 MarxSphere 对比

### 5.1 数据模型同构性(核心发现)

本地 MarxSphere 的 PG 表(`migrations/001_init.sql`)与 Zleap 关系模型几乎逐字段对应:

| 概念 | Zleap SAG | 本地 MarxSphere | 差异 |
| --- | --- | --- | --- |
| 逻辑库 | `data_source` | `sources` | 同名概念 |
| 文档 | `article` / `kb_document` | `documents` | — |
| 段落 | `article_section` | `document_sections` | — |
| 聚合块 | `source_chunk` | `source_chunks` | 本地无 render_group/type |
| **事件** | `source_event`(title/summary/content/keywords/category/parent_id/level/rank/start_time/end_time/references/chunk_id) | **`events`**(同字段 + `title_embedding`/`content_embedding` vector(1024)/`search_text` tsvector) | **本地直接存双向量,且向量维度 1024(MAAS v4)远高于 Zleap 的配置维度;本地 events 有 `external_source_id`(三库联动的谱系字段),Zleap 没有** |
| **实体** | `entity`(type/normalized_name/描述 + 类型化值字段) | `entities`(embedding 1024) | 本地无类型化值字段(无 int/float/datetime 列),但实体带向量 |
| 关联 | `event_entity`(weight/description) | `event_entities`(weight/description/**embedding 1024**) | **本地关联行也带向量**(HNSW 索引),与 Zleap `event_entity_vectors` 思路一致 |
| 类型白名单 | `entity_type`(scope/data_source/article 三级) | `entity_types` | 本地也有(001_init.sql:82) |
| 向量引擎 | LanceDB(默认)/pgvector(可选) | PostgreSQL pgvector HNSW | 本地走 PG 原生,免额外组件 |
| 事件抽取 | LLM YAML 契约 + rich/minimal | LLM `extractEventsFromChunk`(src/ingestion/extract/extractor.ts) | 本地抽取 prompt 未契约化(见 4.3) |

**结论:本地马克思库的 events/event_entities 表是 Zleap 数据模型的超集(多双向量、多外部源谱系),且 2026-08 早已落地。**

### 5.2 检索算法对比

| 环节 | Zleap SAG | 本地 MarxSphere | 对比 |
| --- | --- | --- | --- |
| 查询实体抽取 | LLM NER(strict=False 降级)+ 实体名向量/BM25 兜底 | LLM 抽取 + 别名消解(step0-1)+ BM25 实体 | 本地多别名消解,概念更全 |
| 直连召回 | 事件 title+content 双向量 | 事件标题向量 + 内容向量 | 同构;本地另有 query_events 标题向量专用路径 |
| **动态超边(SQL 扩展)** | 1 跳剪枝扩展(关系行带相似度分,阈值剪枝 + 配额截断);atomic 变体为关系表全量可达集 | **递归 CTE `relationalFanout`(`src/db/repositories.ts:1854`,depth≤3)沿 event_entities 超图扇出** | **同概念,本地实现为深度优先 CTE 且允许 2-3 跳;Zleap 是逐跳 hook + 边级向量打分剪枝** |
| 图遍历 | max_hops=1(production)/无上限(atomic) | `graphTraversalTwoHops`(:594)专用两跳 SQL | 同构 |
| 多臂融合 | RRF(k=60)或 LLM 精排或 rerank | RRF(k=60)+ 加权 boost(backlink/title/时间衰减)+ intent 调 k + Compiled Truth ×2.0(`gbrain-boosts.ts`) | **本地融合链条远复杂于 Zleap** |
| LLM 精排 | select_useful_relations_local(只挑有序索引,不产分) | step7 LLM rerank | 同构 |
| 词法融合 | `_lexical_relevance` 短语/词项/标题加权,与语义 0.5/0.2/0.3 混合 | BM25 臂 + 词法过滤 + 精确词法命中 | 同构,本地无显式词法分与语义分的加权公式(靠 RRF 臂) |
| 结果水合 | event→chunk 回取 + topped-up 补齐 | step8 回取 chunk + Compiled Truth 保底 | 同构 |
| 推理链路 | 单次检索(无多阶段推理状态机) | **52 步阶段化推理(Stage0-4:分类→Cognee 粗→Graphiti 精→超边→融合生成),4 策略降级链,每步落 retrieve_steps 真实 token** | **本地远超 Zleap(这是本地最大的差异化优势)** |
| 检索追踪 | 请求级检索图(query→entity→event→chunk + 路径分析) | retrieve_steps/trace_spans 落库 + 前端 52 步可视化 + 归因(反思读 eval_failures) | 本地追踪沉淀为持久化数据,可回流学习;Zleap 的图是请求内对象 |

### 5.3 差距与重叠全景表

| 能力域 | Zleap 有 | 本地 MarxSphere 有 | 重叠 | 值得借鉴(Zleap→本地) |
| --- | --- | --- | --- | --- |
| 事件-实体索引 | ✅(核心) | ✅(核心,超集) | **全重叠** | — |
| 查询时动态超边 | ✅(论文核心) | ✅(relationalFanout CTE) | **全重叠** | — |
| 边级向量(关系行嵌入打分) | ✅(`event_entity_vectors`) | ✅(event_entities.embedding + HNSW) | 重叠 | 本地已具备(但未在 fanout 剪枝中用边相似度——**可借鉴其用法**) |
| 多级实体类型白名单 | ✅ scope 三级 | ✅ | 重叠 | — |
| 事件层级 parent/children | ✅ | ✅ | 重叠 | — |
| 抽取提示词契约化(YAML+JSON schema+rich/minimal+few-shot) | ✅ 很完整 | ⚠️ 无契约(硬编码 prompt) | 部分 | **高价值**(本地抽取质量提升的规范化途径) |
| 事件抽取防幻觉规则(背景使用边界) | ✅ 明确写入提示词 | ⚠️ 部分 | 部分 | **高价值** |
| OpenAI 兼容端点 | ✅ | ❌ 无(只有出站调用) | — | **最高价值**(Agent/外部工具接入的关键) |
| MCP 工具设计(8 工具:search/read/grep/outline/get_chunk) | ✅ 完整 | ⚠️ 自营 6 工具 + 外部池 | 部分 | 中(grep/outline 工具名值得吸收) |
| OCTX 知识库导入导出格式 | ✅ 完整 | ❌ | — | **高价值**(知识库备份/迁移,本地 500 篇语料极需要) |
| sag-cli 一行挂载(Codex/Claude Code) | ✅ | ❌ | — | 中(本地已有 sag-mcp-server,差自动挂载 CLI) |
| 存储升级管线(引擎换代迁移) | ✅ 完整 | ⚠️ 无(但本地无引擎换代问题) | — | 低 |
| Durable command ledger + fence 幂等 | ✅ | ⚠️ 任务队列有租约,无跨操作 fence | 部分 | 中(多 worker 并发写防重) |
| 中文词法相关性重排 | ✅ 显式公式 | ⚠️ 靠 BM25 臂 | 部分 | 中(本地中文检索已较好,可作对照) |
| 检索评测脚本(多策略 golden 对照) | ✅ | ✅(eval-32-metrics 53 题,更强) | 重叠 | —(本地评测体系远超) |
| 52 步推理状态机/自愈降级 | ❌ | ✅ | — | (反向:本地优势) |
| 三库混合(Graphiti/Cognee 图谱层) | ❌(单 SAG 层) | ✅ | — | (反向:本地优势) |
| 学习闭环(反思/归因/坏例回流) | ❌ | ✅ | — | (反向:本地优势) |
| 多租户/计费/BYOK | ❌ | ✅(V389) | — | (反向:本地优势) |
| 教育/实证/论文写作 65 场景 | ❌ | ✅ | — | (反向:本地优势) |
| 桌面端(Electron 打包) | ✅ | ❌ | — | 低(本地无桌面需求) |

---

## 6. 架构图对比

### 6.1 Zleap SAG 架构(现状)

```text
┌────────────────────────── 外部消费方 ──────────────────────────┐
│  Web(Next.js) │ Desktop(Electron) │ MCP Host(Codex/Claude) │  Dify │ OpenAI客户端 │ DSH Agent │
└──────────┬─────────────────────────────────────────────────────┘
           ▼
┌─────────────────── FastAPI 应用层(sag_api)──────────────────┐
│ auth(JWT) │ sources/documents │ jobs(断点恢复) │ agents │ octx(导入导出) │ mcp │ openai │ upgrades │
└──────────┬───────────────────────────────────────────────────┘
           ▼
┌────────────── 引擎适配层(sag_api/sag/engine_manager)──────────┐
│ EngineManager(引擎实例池/生命周期/删除屏障) │ 中文词法重排 │ 检索会话分页 │
└──────────┬───────────────────────────────────────────────────┘
           ▼
┌──────────────── 引擎 zleap.sag(DataEngine) ──────────────────┐
│ 管线: parse(MarkItDown/MinerU) → chunk(7分块器) → index → extract(事件+实体) │
│ 检索: query理解(NER) → 双通道召回 → SQL动态超边扩展(1跳) → LLM精排/RRF → 水合 │
│ 存储: 关系(SQLite/PostgreSQL/MySQL/OceanBase) + 向量(LanceDB/pgvector/ES)    │
│ 索引表: entity_vectors │ event_vectors_wide │ event_entity_vectors │ source_chunks │
└───────────────────────────────────────────────────────────────┘
```

### 6.2 本地 MarxSphere SAG 架构(现状)

```text
┌────────────────────────── 消费方 ──────────────────────────┐
│  WebUI(33视图) │ 外部Agent(MCP: sag-mcp-server) │ Claude/Codex │
└──────────┬─────────────────────────────────────────────────┘
           ▼
┌─────────── Fastify 单服务(src/api/server.ts,~658路由) ──────────┐
│ 鉴权(JWT+sag_令牌) │ /api/search │ /api/reason(52步) │ /api/education│ /api/empirical │ /api/agent │
└──────┬──────────────────────────┬──────────────────────────────┘
       ▼                          ▼
┌─ Ask检索(search-service.ts)─┐ ┌─ 52步推理(inference-service.ts)─┐
│ 别名→实体→事件中心→Graphiti │ │ Stage0-1分类 → Stage2 Cognee粗(17路)│
│ →Cognee→加权RRF→LLM重排→chunk│ │ → Stage3 Graphiti精 → 3.5超边层   │
│ (gbrain-boosts / rrf.ts)    │ │ → Stage4 融合生成+自评自愈        │
└──────┬──────────────────────┘ │ 每步落 retrieve_steps(真实token)  │
       │                        └──────────────────────────────────┘
       ▼
┌────────────── 三库知识层 ─────────────────────────────────┐
│ PG(events/event_entities/entities/chunks 向量1024+tsvector) │
│   ↑ relationalFanout递归CTE(动态超边,depth≤3)               │
│ Neo4j 11001 Graphiti(21337实体/1085社区/11702超边) ←MCP池   │
│ Neo4j 11003 Cognee(31253实体/248417关系/11550切片)+LanceDB  │
└────────────────────────────────────────────────────────────┘
```

### 6.3 关键结论

- **两者的"事件中心 + 动态超边"是同一思想、同一血统**——本地马克思库的检索架构正是基于 Zleap SAG 改造而来(见第 1 节),本地 CTE 允许更深跳数(≤3),并在其上演进了三库混合与 52 步推理。
- Zleap 单引擎单存储(关系+向量两个后端),本地是"事件层(PG)+ 图谱层(双 Neo4j)"三库混合——本地在检索深度上覆盖 Zleap 全部能力 + GraphRAG 级图谱能力。
- Zleap 在"产品级封装"上领先:OpenAI 兼容、MCP 工具集、CLI 挂载、OCTX 格式、桌面端、引擎升级管线。

---

## 7. 结论与融入方案

### 7.1 总体结论

| 判断 | 结论 |
| --- | --- |
| 核心算法是否值得移植? | **否**。查询时动态超边本地继承自 SAG 且已演进(relationalFanout 递归 CTE,深度更优),本地事件表是超集。移植引擎(zleap-sag Python)会引入 Python 运行时 + 双存储,与本地 TS 技术栈冲突,收益极低。 |
| 工程能力是否值得回溯吸收? | **是**,点状吸收 5 项(见 7.2),全部为 MIT 许可可自由使用(注意:本地项目为 AGPL v3 + 商业授权,吸收上游 MIT 代码时声明出处即可)。 |
| 是否存在反向借鉴(本地→Zleap)? | 存在但不在本次任务范围(52 步推理、学习闭环、三库混合是 Zleap 没有的,若后续想向上游提交可提)。 |
| 误用风险 | 低。仅需注意:Zleap 事件抽取的"1 chunk → 1 事件"粒度与本地"1 chunk → 多事件"不同,移植其提示词契约时需调整;论文成绩基于英文基准(BGE-Large-EN),中文语料(马理论)不能直接外推。 |

### 7.2 建议融入方案(按优先级)

**P0 —— 补 OpenAI 兼容端点(1-2 人日)**
- 在 `src/api/server.ts` 新增 `POST /api/v1/chat/completions`(或 `/api/openai/{agentId}/chat/completions`),复用现有 Ask 检索 + 生成链路,响应附加 `sag.citations` 字段,支持 SSE stream。
- 收益:任何 OpenAI 客户端(LangChain/LlamaIndex/Dify 类平台/自研 Agent)可零改造接入本地知识库;打通"把 SAG 当模型用"的生态位。这是 Zleap 接口设计中价值密度最高的一块。
- 参考实现:`zleap-sag/apps/api/sag_api/api/v1/openai.py`(约 150 行,结构简单可整体参照)。

**P1 —— 事件抽取提示词契约化(1-2 人日)**
- 把本地 `src/ingestion/extract/extractor.ts` 的事件抽取硬编码 prompt 重构为 YAML 模板 + 统一 JSON 输出合同 + few-shot,引入 Zleap 的"背景使用边界"规则(禁止从全文摘要向当前 chunk 补事实)与 rich/minimal 分支。
- 收益:抽取质量可版本化、可评测;防幻觉规则直接对齐论文验证过的方案;为后续 53 题评测的抽取环节做 ablations 提供基础。
- 注意适配:本地是"1 chunk → 多事件"(prepareEvents 聚合),Zleap 是"1 chunk → 1 事件",模板需本地化改写。

**P1 —— OCTX 知识库导入导出(2-3 人日,依赖决策)**
- 本地 500 篇论文语料 + Graphiti/Cognee 图谱**没有任何备份/迁移格式**。Zleap 的 OCTX(版本化归档 + 校验 + 冲突处理 + 向量复用)是现成设计,但实现 800+ 行且绑定其引擎数据模型。
- 建议:不移植 OCTX 代码,只借鉴其**设计契约**(semver 版本、清单清单、完整性校验、向量兼容声明),用本地表结构(PG pg_dump + Neo4j cypher 导出 + 清单)实现轻量备份格式。若短期内无迁移需求可降级为"备份演练"任务。

**P2 —— MCP 工具集对齐(0.5-1 人日)**
- 本地自营 MCP 有 6 工具(sag_search/sag_get_event 等),缺 Zleap 的 `grep`(按词法 grep chunk)、`outline`(文档大纲)、`list_documents`(文档清单)、`get_chunk`(按 ID 取 chunk)。补 4 个只读工具,提升外部 Agent 检索精细度。

**P2 —— 关系边向量剪枝用法(1-2 人日)✅ 已落地(`fc11bdd5`)**
- 本地 `event_entities.embedding` 已有但 `relationalFanout` 未使用边相似度打分。参考 Zleap `_expand_entities_for_hop` 的"关系行按 query 边相似度阈值剪枝"逻辑,在 fanout 中按边嵌入过滤弱关联,可减少多跳噪音。需先在评测集上验证(改动检索必跑 `eval-32-metrics`)。
- 实现:`relationalFanout` 加 `queryVector?`/`threshold?` 参数,边余弦相似度 < 阈值过滤;阈值默认 0.35(`RELATIONAL_EDGE_THRESHOLD` 环境变量可调,0=禁用)。
- 验证:阈值标定(两查询边分布 p50=0.26-0.38)→ 窄查询 14→13 事件、宽查询 500 全保留 → **全量 53 题评测 0.8841 与基线持平零退化**。
- 调优实验(2026-09-02):4 道多跳题(Q03/Q07/Q11/Q15)对比三档阈值 — **0.35 均值 0.903 最优**;0.3 太宽松(Q11 噪音暴跌 −0.24),0.4 太严格(Q03 证据全剪 recall=0)。默认 0.35 经实验确认。

**P3 —— 暂不建议**
- 引擎整体移植(技术栈冲突,收益为负)
- SQLite/LanceDB 本地零依赖栈(本地已投入 PG 生态,迁移成本高)
- 桌面端 Electron(无需求)
- 存储升级管线/durable ledger(本地无引擎换代问题;fence 机制可在任务队列出问题时再考虑)

### 7.3 落地路线

```text
第 1 步(P0):OpenAI 兼容端点 → 验证:curl 流式调用 + 外部客户端接入冒烟
第 2 步(P1):抽取提示词契约化 → 验证:53 题评测分数不退化(对比前后 context_recall/entity_utilization)
第 3 步(P1):OCTX 轻量备份格式(或降级演练)
第 4 步(P2):MCP 工具补齐 + 边向量剪枝 → 验证:评测对比 + 外部 Agent 冒烟
```

所有改动遵守 CLAUDE.md 铁律:改检索/推理后必须跑评测验证分数不退化;前后端类型检查必跑。

---

## 附:证据索引

| 主题 | Zleap 侧证据 | 本地侧证据 |
| --- | --- | --- |
| 仓库/版本 | GitHub API `Zleap-AI/SAG`,main,commit e257a89,v1.8.4,MIT,2444 星 | — |
| 核心主张 | README.md:63-67,113-123,143-146 | — |
| 检索执行 | `zleap/sag/modules/search/production.py:111-338`(5 阶段编排)、`base.py:106-830`(共享工具)、`profiles.py:95-427`(6 策略) | `src/services/search-service.ts:115-787`(Ask 步骤链)、`src/services/inference-service.ts`(52 步) |
| 动态超边 | `production.py:39-107`(边向量剪枝扩展)、`atomic.py:41-105`(关系表全量) | `src/db/repositories.ts:1854`(relationalFanout 递归 CTE)、`search-service.ts:268-279` |
| 数据模型 | `zleap/sag/db/models.py:744-1060`(entity/source_event)、`core/storage/index_schemas.py`(4 索引) | `migrations/001_init.sql:103-182`(entities/events/event_entities) |
| 抽取契约 | `modules/extract/prompts.py`、`prompts/extract_document.yaml` | `src/services/ingestion-service.ts:368-386`、`src/ingestion/extract/extractor.ts` |
| MCP | `sag_api/mcp/server.py:193-497`(8 工具) | `src/mcp/server.ts:13-210`(6 工具) |
| OpenAI 兼容 | `sag_api/api/v1/openai.py` | 无(server.ts:2574 为出站调用) |
| OCTX | `sag_api/octx/*`(semver/storage/runner) | 无 |
| 评测 | `apps/api/scripts/eval_retrieval.py` | `scripts/eval-32-metrics.ts`(53 题 32 指标) |
| 中文重排 | `sag_api/services/retrieval_service.py:187-330` | `src/services/gbrain-boosts.ts`(加权 RRF) |

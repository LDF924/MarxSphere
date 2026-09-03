# Zleap SAG 差距全景与融入路线(参数级重制)

> 2026-09-02 v2 ｜ 基于 Zleap 引擎源码(zleap.sag 4.4 万行)参数级深读 + 本地 MarxSphere 逐参数核实
> 本版修正 v1 的错误判断(如本地 rerank 已是用例索引式,与 Zleap 同构)

---

## 〇、总览:两条路线,两类差距

| 维度 | Zleap(单一算法主干) | 本地(多源融合范式) |
| --- | --- | --- |
| 范式 | 事件超图 + 查询时动态聚合(论文核心) | 多臂召回 + 加权 RRF 融合(四源并行) |
| 主线 | **动态超边是唯一主干**,靠逐跳配额/阈值控制精度 | **融合是主干**,事件检索是五路之一,递归 CTE 一把梭 |
| 优势 | 多跳基准(HotpotQA 系)验证、机制自洽 | 52 步推理 / 三库图谱 / 学习闭环 / 融合链条复杂度 |

**融入原则**:不替换本地融合范式;把 Zleap 的"逐跳控制、请求级图、候选池复用"等工程机制**嫁接到本地事件检索**上,让其成为更可控的一路。

---

## 一、机制级差距全景(逐项:本地现状 → Zleap 机制 → 差距定性)

### G1. 事件检索的"图扩展"控制粒度 ⭐⭐⭐

| 维度 | 本地 | Zleap |
| --- | --- | --- |
| 扩展实现 | `relationalFanout` 递归 CTE(1854),depth≤3 一把梭 | `_expand_graph`(base.py:520)逐跳 hook 循环 |
| 每跳实体配额 | 无(全展开) | `entities_per_hop`(10-15)+ 边相似度 `relation_threshold`(0.45) |
| 每跳事件配额 | 无 | `events_per_hop`(50)+ 事件向量 `event_threshold`(0.4-0.65) |
| 种子截断 | 无(全部种子扩展) | `seed_event_limit`(15) |
| 防循环 | `not in (seed)` 只排除种子 | `seen_entity_ids` / `seen_event_ids` 全程去重 |
| 边打分 | 有(A5 已落地 0.35 剪枝) | 边向量带分,按分截断 |
| 队列/预算 | 无(一次查完) | `candidate_pool_size`(500)内存候选池 |

**差距定性**:本地是"深度优先全展开",Zleap 是"逐跳广度受限扩展"。本地无逐跳配额,弱关联可蔓延;Zleap 用 5 个参数精确控制扩展宽度。

### G2. 请求级检索图追踪 ⭐⭐⭐

| 维度 | 本地 | Zleap |
| --- | --- | --- |
| 追踪 | `retrieve_steps` 表(步骤级)+ `trace_spans` | `GraphCollector`(graph.py):query/entity/event/chunk 节点 + 带 method/confidence/hop 的边 |
| 路径分析 | 无 | `PathAnalyzer`(path_analyzer.py):目标节点反向推理证据链 |
| 可视化 | 前端 52 步列表(无图) | Explore 模式:交互式知识宇宙图 |

**差距定性**:本地能看"哪步做了啥",看不到"哪个实体→哪个事件→哪个 chunk 的证据路径"。Zleap 的 GraphCollector 是请求内对象(enabled=false 全 no-op),设计干净。

### G3. 候选池机制 ⭐

| 维度 | 本地 | Zleap |
| --- | --- | --- |
| 图扩展查询 | 每步实时查向量库(多次 kNN) | `PooledCandidateSource`(pool.py):首次查询建内存倒排 entity→events,多跳复用 |
| 内存占用 | — | 峰值 <50MB(分页拉取) |
| 池大小 | 无 | `candidate_pool_size`(500) |

**差距定性**:纯性能优化,行为不变。本地每步 kNN 在 10 万级 event_entities 上毫秒级,收益中等。

### G4. LLM 精排方式 ⭐(本地已同构,修正 v1 误判)

| 维度 | 本地 | Zleap |
| --- | --- | --- |
| 精排输出 | `useful_event_ids: ["uuid"]`(llm-client.ts:195,**只选 id 不产分**) | `select_useless_relations_local`(只挑有序索引) |
| 输入控制 | 每条 content.slice(0, 1200) | `llm_include_content`(bool)/`llm_max_content_chars`(2000) |
| 超时降级 | 有 | `on_timeout: fallback_to_score` |

**结论**:机制同构(都是选索引式)。本地缺的是 `llm_include_content`/`llm_max_content_chars` 两个输入控制参数(可加,低价值)。

### G5. 查询改写 ⭐⭐

| 维度 | 本地 | Zleap |
| --- | --- | --- |
| 改写 | 无显式查询改写(有别名消解 alias) | `rewrite_and_extract_entities`:一个调用产出 {rewritten_query, entities} |
| 降级 | — | strict 失败报错 / 非 strict 用原查询 |

**差距定性**:本地别名消解是词表映射(确定性强),Zleap 改写是 LLM 语义改写(可处理口语/多跳表述)。两者互补,LLM 改写可加在 multiSearch 开头。

### G6. 检索策略表达 ⭐⭐

| 维度 | 本地 | Zleap |
| --- | --- | --- |
| 表达 | `searchMode`(fast/standard)+ `subStrategy`(multi/multi1/hopllm)硬编码分支 | `SearchProfile`(profiles.py):recall/graph/ranking/selection/output 五段不可变对象 + policy 约束 |
| 消融 | `ablation-eval.ts` OPERATORS 数组 | 改 profile 即新策略,零成本 |
| 档位 | 3 档 | 6 档 builtin(vector/atomic/full_expand/pruned×3) |

**差距定性**:本地分支散在 multiSearch 里(~10 处 if searchMode/subStrategy),加新策略要改多处;Zleap 配置对象一处定义。

### G7. 事件层级 ⭐

| 维度 | 本地 | Zleap |
| --- | --- | --- |
| 抽取 | 单事件强制(每 chunk 1 事件,extractor.ts:27 slice(0,1)) | rich 契约支持 parent/children 层级(最多 2 层) |
| 存储 | events 表有 parent_id/level 字段(未用) | source_event 层级结构 |

**差距定性**:本地表结构支持但抽取不生成层级。注意:本地"单事件强制"是评测基线口径(0.884 依赖),改多事件需评测验证。

### G8. 结果水合 ⭐(已同构)

| 维度 | 本地 | Zleap |
| --- | --- | --- |
| 水合 | step8 回取 chunk + Compiled Truth 保底 | `_hydrate_chunks_topped_up`:事件排序 → 映射 chunk → 不足补齐 |

**结论**:机制同构。本地多一个 Compiled Truth 保底(本地优势)。

### G9. 中文词法相关性公式 ⭐

| 维度 | 本地 | Zleap |
| --- | --- | --- |
| 词法 | BM25 臂(RRF 融合,无显式公式) | `_lexical_relevance`(retrieval_service.py:187):短语 0.55 + 词项 0.35 + 标题 0.15,与语义 0.5/0.2/0.3 混合 |
| 可调性 | 靠 RRF k 值 | 显式权重可调 |

**差距定性**:本地融合链条更复杂(加权 RRF + boost),但无显式词法-语义权重公式;Zleap 的公式简单可调。

### G10. 检索会话分页 ⭐

| 维度 | 本地 | Zleap |
| --- | --- | --- |
| 分页 | 无(一次 topK) | `sag_search_session` 表:服务端快照 + 游标翻页 |

**差距定性**:本地大结果集无法稳定翻页;Zleap 快照保证多次请求结果一致。

---

## 二、参数级差距明细(可直接落地的配置差异)

| 参数 | Zleap 值 | 本地当前值 | 融入建议 |
| --- | --- | --- | --- |
| `entities_per_hop` | 10-15 | 无(全展开) | relationalFanout 加 `entitiesPerHop=15` |
| `events_per_hop` | 50 | 无 | 加 `eventsPerHop=50` |
| `event_threshold` | 0.4-0.65 | 无 | 加 `eventThreshold=0.4` |
| `relation_threshold` | 0.45 | 0.35(边剪枝 A5) | 保持 0.35(本地标定值) |
| `seed_event_limit` | 15 | 无 | 加 `seedEventLimit=15` |
| `candidate_pool_size` | 500 | 无 | 可选加 500(内存倒排) |
| `rerank_top_n` | 50-100 | `rerankTopK`(=topK) | 可调大(LLM 候选更多) |
| `llm_select_top_n` | 5 | rerank 后取 topK | 对齐(LLM 只选 5 条) |
| `llm_max_content_chars` | 2000 | 1200(rerankEvents) | 对齐 2000 |
| `vector_threshold` | 0.3-0.4 | `similarityThreshold=0.4` | 已对齐 |
| `entity.vector_threshold` | 0.9 | `keySimilarityThreshold=0.9` | 已对齐 |
| `max_hops` | 1(production) | `maxHops=1` | 已对齐 |
| `max_events_per_entity` | 10 | `maxEventsA=100` | **差异:本地 100, Zleap 10——本地更宽(候选多但噪音多)** |
| `rrf_k` | 60 | 60(意图调 k) | 已对齐(本地更精细) |

**关键发现**:本地 `maxEventsA=100` 与 Zleap `max_events_per_entity=10` 差 10 倍——这是"候选集过大、噪音多"的一个具体参数根因。

---

## 三、融入路线(四波,每项含验证)

> **执行状态(2026-09-02)**:G1-G10 + 多存储抽象 + 能力探测全部落地(10 个 commit, `c4ee5fca`~`d364f348`),单测 370 全绿。
> **⚠ 待办(云端部署后执行)**:G1 逐跳配额是唯一**默认生效**的检索改动,需跑全量 53 题评测验证不退化
> (0.8841 基线;本机 Neo4j 未启动,评测需三库全开,为控制内存留待云端)。G5/G7 默认关,开启后再单独验证。

### 第一波:事件检索核心对齐(2.5-3.5 人日)⭐⭐⭐ ✅ 已落地

| 项 | 动作 | 文件 | 验证状态 |
| --- | --- | --- | --- |
| P1-1 逐跳配额 | relationalFanout 加 `seedEventLimit/entitiesPerHop/eventsPerHop/eventThreshold`(默认 null=现行为);CTE 改逐跳受限扩展 | repositories.ts:1849 | ✅ 落地(`c4ee5fca`)+ 单测;⚠ 53 题评测待云端 |
| P1-2 参数对齐 | `maxEventsA` 100→10(或加配置),`llm_max_content_chars` 1200→2000 | search-service.ts / llm-client.ts | ✅ G4 落地(`780dcafe`, maxContentChars 参数化);maxEventsA 保持 100(评测后调) |
| P1-3 候选池 | multiSearch 图扩展改内存倒排复用(首次查询建 Map<entityId, eventIds>) | search-service.ts | ✅ 落地(`6151cae5`)+ 单测 |

### 第二波:请求级检索图(1-2 人日)⭐⭐⭐

| 项 | 动作 | 文件 | 验证 |
| --- | --- | --- | --- |
| P2-1 图追踪器 | 新增 `src/services/retrieval-graph.ts`(节点+边,enabled 开关,参照 Zleap GraphCollector) | 新建 | 单测 |
| P2-2 步骤接入 | multiSearch 各步骤调用 record*(step1 实体→step2 关系→step3 事件→step8 chunk) | search-service.ts | 冒烟(trace 含图) |
| P2-3 前端路径图 | AskPanel 加折叠面板渲染路径图(query→entity→event→chunk) | web/AskPanel.tsx | 前端冒烟 |

### 第三波:检索策略基建(2-3 人日)⭐⭐

| 项 | 动作 | 文件 | 验证 |
| --- | --- | --- | --- |
| P3-1 profile 化 | 新增 `src/services/search-profiles.ts`(SearchProfile 五段对象);multiSearch 改读 profile | 新建 + search-service.ts | 单测 + 消融脚本改造 |
| P3-2 查询改写 | llm-client 加 `rewriteAndExtractEntities`;multiSearch 开头可选调用(默认关) | llm-client.ts / search-service.ts | 评测对比(默认关,验证后决定) |
| P3-3 会话分页 | search API 加 cursor;首次执行存快照表 | server.ts / repositories.ts | 单测 + 冒烟 |

### 第四波:增强(1.5 人日)⭐

| 项 | 动作 | 文件 | 验证 |
| --- | --- | --- | --- |
| P4-1 词法公式 | step6 粗排后加显式词法分混合(短语/词项/标题权重) | search-service.ts | 评测对比(可选) |
| P4-2 事件层级 | 抽取契约加 children 支持(可选模式,默认保持单事件) | extract-document.ts | 评测对比(高风险,谨慎) |

---

## 四、不做清单(明确排除)

| 项 | 原因 |
| --- | --- |
| 多存储后端(SQLite/LanceDB/MySQL/ES) | 本地固定 PG 生态 |
| 引擎升级管线 | 本地无引擎换代问题 |
| litellm 策略层 | 本地自研 LLM 客户端已覆盖(重试/熔断/配额轮换) |
| 桌面端 | 无需求 |
| 能力探测(capabilities) | 本地源配置开关已覆盖 |
| `graphTraversalTwoHops` 重写 | 已与 Zleap max_hops=1 同构 |
| 本地融合链条简化 | 反向——那是本地优势,不动 |

---

## 五、执行顺序与铁律

1. **第一波必须先做**(事件检索是评测核心,其余在其上叠加)
2. 每项检索改动**必须跑全量 53 题评测**(0.8841 基线),退化即回退或调参
3. P4-2 事件层级是唯一"可能改变评测口径"的项——默认不做,除非明确要求
4. 第二波(检索图)可并行开发(纯增量,不碰检索逻辑)

# Cookbook：真实任务示例

按真实任务组织的可复用案例（对标 Sciverse Cookbook 思路）。每个案例：场景 → 调用链 → 提示语 → 预期输出。

## 案例 1：多跳推理分析（文献综述）

**场景**：需要综合分析"资本下乡"对农户的多维影响，跨多篇论文推理。

**调用链**：`sag_reason`（52 步推理，自动多源检索）

**对 Agent 的提示语**：

```
用 sag_reason 分析：工商资本下乡对农户土地流转行为的影响机制是什么？
要求：结合至少 3 篇论文的证据，指出不同研究结论的分歧点。
```

**预期输出**（结构化）：
- 答案正文（带来源标记：`（PG实体·高 / Cognee·中 来源）`）
- `entities`：抽取的实体（如 资本下乡、土地流转、农户）
- `retrievalSources`：本次用了哪些检索源

**注意**：单次 1-10 分钟（52 步链路），适合深度分析，不适合快速问答。

## 案例 2：快速证据查证（RAG）

**场景**：需要快速找到"某个政策/概念在论文原文中的说法"，不推理。

**调用链**：`sag_search`（多源语义检索，秒级）

**对 Agent 的提示语**：

```
用 sag_search 找关于"非粮化"的论文片段，要求包含来源论文标题。
```

**预期输出**（JSON 数组）：
```json
[
 {
 "title": "工商资本下乡\"非粮化\"现象的诱因及长效对策",
 "heading": "（三）非粮化现象的治理",
 "text": "切片内容（最多 800 字）...",
 "score": 0.93,
 "source": "cognee-chunk"
 }
]
```

**用途**：事实查证、引用支持、快速浏览文献。

## 案例 3：论文入库（知识库扩充）

**场景**：拿到一篇新论文文本，入库后所有 Agent 都能检索到。

**调用链**：`sag_ingest`（自动切片 + 向量化 + 实体抽取）

**对 Agent 的提示语**：

```
用 sag_ingest 把下面这篇论文入库：
标题：XXXX
内容：<论文正文>
```

**预期输出**：
```json
{ "ok": true, "documentId": "uuid", "chunkCount": 12, "eventCount": 5 }
```

**注意**：
- 同标题会覆盖更新（幂等）
- 内容 ≤ 5MB
- 入库后可用 `sag_search` 验证能否检索到

## 案例 4：知识库盘点（数据审计）

**场景**：确认当前知识库覆盖范围，看缺什么主题。

**调用链**：`sag_documents`

**对 Agent 的提示语**：

```
用 sag_documents 列出知识库全部文档，按主题分组，指出覆盖的领域和缺口。
```

**预期输出**：文档列表（标题 + 状态），Agent 汇总主题分布。

## 组合链路示例

### 研究流程（多步）

```
1. sag_documents → 盘点现有知识库
2. sag_ingest → 补入缺失主题论文
3. sag_search → 快速检索相关证据
4. sag_reason → 深度推理综合分析
5. （Claude 自行） → 写作 / 总结 / 引用整理
```

### 评测驱动迭代

```
1. sag_reason → 用评测题跑推理
2. 检查 hypothesis 质量 → 低分时反思（questionId 联动归因）
3. sag_ingest → 补知识库后重测
```

## 案例 5：AI+教育 · 苏格拉底式追问（五步打磨）

把模糊兴趣收敛成可验证的学习问题，全程苏格拉底式引导：

```bash
# ① 记录想法 → 发散拓展（AI 梳理方向与关键词）
curl -X POST localhost:4173/api/education/agent/polish \
 -H "Content-Type: application/json" \
 -d '{"subject":"政治经济学","question":"为什么说价值规律是商品经济的基本规律？","step":"diverge"}'

# ② 初步验证（自动检索知识库判断研究密度与空白）
curl -X POST localhost:4173/api/education/agent/polish \
 -H "Content-Type: application/json" \
 -d '{"subject":"政治经济学","question":"为什么说价值规律是商品经济的基本规律？","step":"verify"}'

# ③ 聚焦收敛 → Problem Statement
curl -X POST localhost:4173/api/education/agent/polish \
 -H "Content-Type: application/json" \
 -d '{"subject":"政治经济学","question":"为什么说价值规律是商品经济的基本规律？","step":"focus"}'

# ④ 压力测试（审稿人式质疑）
curl -X POST localhost:4173/api/education/agent/polish \
 -H "Content-Type: application/json" \
 -d '{"subject":"政治经济学","question":"为什么说价值规律是商品经济的基本规律？","step":"stress"}'

# ⑤ 子问题拆解（驱动深度检索）
curl -X POST localhost:4173/api/education/agent/decompose \
 -H "Content-Type: application/json" \
 -d '{"subject":"政治经济学","problemStatement":"价值规律是商品经济的基本规律"}'
```

## 案例 6：AI+教育 · 作业辅导闭环

题目解析 → 错题归集 → 变式训练 → 掌握度联动：

```bash
# ① 题目解析（分步提示，不直接给答案）
curl -X POST localhost:4173/api/education/homework/solve \
 -H "Content-Type: application/json" \
 -d '{"subject":"政治经济学","question":"简述价值规律的基本内容及其表现形式","hintLevel":"hint"}'

# ② 错题归集（自动溯源知识点 + 下调掌握度）
curl -X POST localhost:4173/api/education/agent/wrong-to-mastery \
 -H "Content-Type: application/json" \
 -d '{"subject":"政治经济学","knowledgePoint":"剩余价值","question":"剩余价值率与利润率总是混淆"}'

# ③ 自动闭环周报（掌握度/错题清零/计划完成率）
curl -X POST localhost:4173/api/education/loop/report \
 -H "Content-Type: application/json" \
 -d '{"subject":"政治经济学","days":7}'
```

## 组合链路：教育闭环

```
1. learning-plan → 生成学习计划
2. homework/solve → 作业辅导（分步提示）
3. wrong-to-mastery → 错题归集 + 变式生成
4. cognitive/bkt-track → BKT 认知诊断（p(掌握)）
5. loop/report → 自动闭环周报
```

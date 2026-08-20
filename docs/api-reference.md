# API 参考

MarxSphere 对外 REST API。所有接口默认 `http://localhost:4173`（外部部署时替换为你的服务器地址）。

## 认证

外部调用需在请求头携带 Token：

```
Authorization: Bearer sag_xxx
```

无 Token 或无效 → `401`；权限不足 → `403`。

| 权限 | 覆盖接口 |
|---|---|
| `reason` | `/api/reason/query`、`/api/search` |
| `ingest` | `/api/documents/upload` |

---

## 1. 深度推理 `POST /api/reason/query`

52 步推理链路：大纲 → 多源检索（PG/Cognee/Graphiti）→ 假设生成 → 评估 → 反思。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sourceId` | string (uuid) | ✅ | 数据源 ID（默认 `c609acbf-1d6e-4bd5-9ae1-92fa6c64021a`） |
| `query` | string | ✅ | 问题 |
| `topK` | number | | 检索切片数，默认 15，最大 50 |
| `paperId` | string | | 限定单篇论文 |
| `sources` | string[] | | 检索源过滤：`pg` / `graphiti` / `cognee` |
| `ablation` | string[] | | 消融（关闭某组件，实验用），最多 15 项 |
| `mode` | string | | `template`（固定52步，默认）/ `adaptive`（LLM动态算子） |
| `sessionId` | string (uuid) | | 记忆层：会话 ID（注入短期记忆） |
| `questionId` | string | | 评测联动题号（反思查归因用） |

**响应**（200）：

```json
{
 "taskId": "uuid",
 "trace": {
 "outline": [...],
 "retrieveSources": ["cognee_coarse", "graphiti_refine"],
 "entityNames": ["资本下乡", "土地流转", ...],
 "fusedContext": "拼接后的检索上下文...",
 "hypothesis": { "content": "最终答案...", "confidence": 0.87, "citations": [...] },
 "evaluation": { "dimensions": {...}, "overallScore": 0.85, "passed": true },
 "timings": { "stage2_coarse": 1234, "stage3_refine": 567, ... },
 "_debugCoarse": { "chunks": [...], "pgChunks": [...], ... }
 }
}
```

**错误**：
- `400` 参数无效（Zod 校验失败）
- `503` 检索超时
- `500` 推理服务异常

**curl 示例**：

```bash
curl -X POST http://localhost:4173/api/reason/query \
 -H "Content-Type: application/json" \
 -H "Authorization: Bearer sag_xxx" \
 -d '{
 "sourceId": "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a",
 "query": "资本下乡对农户土地流转的影响机制是什么？",
 "topK": 15
 }'
```

---

## 2. 多源检索 `POST /api/search`

轻量语义检索（不推理），返回论文切片。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | ✅ | 检索词 |
| `sourceIds` | string[] | ✅ | 数据源 ID 列表 |
| `strategy` | string | | `vector`（纯向量）/ `multi`（多跳） |
| `searchMode` | string | | `standard` / `fast` |
| `topK` | number | | 返回条数，默认 10，最大 50 |
| `returnTrace` | boolean | | 是否返回检索轨迹 |

**响应**（200）：

```json
{
 "traceId": "uuid",
 "sections": [
 {
 "chunkId": "neo4j-entity-0",
 "sourceId": "uuid",
 "heading": "[graphiti] 论文标题",
 "content": "切片内容（最多 800 字）",
 "rank": 0,
 "score": 0.96,
 "sourceStep": "graphiti-entity"
 }
 ]
}
```

**curl 示例**：

```bash
curl -X POST http://localhost:4173/api/search \
 -H "Content-Type: application/json" \
 -H "Authorization: Bearer sag_xxx" \
 -d '{
 "query": "土地流转 农户收入",
 "sourceIds": ["c609acbf-1d6e-4bd5-9ae1-92fa6c64021a"],
 "topK": 10
 }'
```

---

## 3. 文档入库 `POST /api/documents/upload`

上传文本，自动切片 + 向量化 + 实体抽取（幂等：同标题覆盖更新）。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sourceId` | string (uuid) | | 数据源 ID（默认值同上） |
| `fileName` | string | ✅ | 文件名（`xxx.md`） |
| `title` | string | | 标题（默认取 fileName） |
| `content` | string | ✅ | 文档正文（Markdown/纯文本，≤5MB） |
| `extract` | boolean | | 是否抽取实体（默认 true） |
| `chunking` | object | | 切片参数：`mode`（heading_strict/token）、`maxTokens`、`overlapTokens` |

**响应**（200）：

```json
{
 "sourceId": "uuid",
 "documentId": "uuid",
 "actualDocumentId": "uuid",
 "chunkCount": 12,
 "eventCount": 5,
 "taskId": "uuid"
}
```

**错误**：`400` 参数无效 / 内容超 5MB。

**curl 示例**：

```bash
curl -X POST http://localhost:4173/api/documents/upload \
 -H "Content-Type: application/json" \
 -H "Authorization: Bearer sag_xxx" \
 -d '{
 "sourceId": "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a",
 "fileName": "论文标题.md",
 "title": "论文标题",
 "content": "# 论文内容\n\n正文..."
 }'
```

---

## 4. 文档列表 `GET /api/sources/:sourceId/documents`

列出数据源下所有已入库文档。

**参数**：`includeArchived=true` 可选。

**响应**（200）：

```json
{
 "documents": [
 {
 "id": "uuid",
 "title": "论文标题",
 "status": "COMPLETED",
 "chunkCount": 12
 }
 ]
}
```

---

## 5. Token 管理（本机管理端）

| 接口 | 说明 |
|---|---|
| `GET /api/tokens` | 列出全部令牌 |
| `POST /api/tokens` | 创建令牌 `{ name, permissions: ["reason","search","ingest"] }` → 返回 `{ token, record }` |
| `POST /api/tokens/:id/revoke` | 撤销令牌 |
| `DELETE /api/tokens/:id` | 删除令牌记录 |

> 管理接口对 localhost 豁免认证；部署后建议限制管理接口访问。

---

## 6. AI+教育 `POST /api/education/*`

教育能力共 **80+ 路由**，按能力分组（请求体均为 JSON，响应 `{ ok: true, ... }`）：

### 6.1 核心六能力

| 接口 | 说明 | 关键入参 |
|---|---|---|
| `POST /api/education/learning-plan` | 个性化学习规划 | `subject, goal, currentLevel?, hoursPerWeek?, deadline?` |
| `POST /api/education/tutoring` | 课程辅导（分步引导） | `subject, topic, difficulty?` |
| `POST /api/education/diagnosis` | 学情诊断 | `subject, answers[]` |
| `POST /api/education/preview-review` | 预习/复习 | `subject, topic, mode: preview\|review` |
| `POST /api/education/lesson-plan` | 教师备课 | `subject, chapter, classMinutes?, studentLevel?` |
| `POST /api/education/companion` | 学习陪伴 | `subject, message, history?` |

### 6.2 自适应学习

`/api/education/adaptive/record-answer`（作答建模）、`/profile`（学情画像）、`/push`（内容推送）、`/pace`（节奏适配）、`/layered`（分层教学）

### 6.3 作业辅导闭环

`/api/education/homework/solve`（题目解析，4 模式）、`/wrong`（错题归集）、`/variant`（变式生成）、`/wrong-list`、`/wrong-mastered`、`/qna`（追问式答疑）

### 6.4 学情诊断

`/api/education/diagnostic/gaps`（薄弱点）、`/behavior`（行为分析）、`/report`（诊断报告）、`/risk`（风险预警）

### 6.5 教师助手

`/api/education/teach/lesson`、`/exam`（组卷）、`/grade`（批改）、`/class-summary`（班级学情）、`/syllabus`（大纲）、`/courseware`（课件）、`/layered`（分层设计）、`/questions`（智能出题）、`/wrong-report`（错题报告）、`/discussion`（课堂讨论）、`/quiz`（随堂测验）、`/lecture-summary`（课堂总结）

### 6.6 教育专属 Agent

| 接口 | 说明 |
|---|---|
| `POST /api/education/agent/socratic` | 苏格拉底式提问（首轮） |
| `POST /api/education/agent/socratic-continue` | 苏格拉底继续追问 |
| `POST /api/education/agent/scaffold` | 阶梯式启发（hint/guided/full） |
| `POST /api/education/agent/wrong-to-mastery` | 错题-知识点联动 |
| `POST /api/education/agent/progress` | 学习进度追踪 |
| `POST /api/education/agent/polish` | 五步打磨（diverge/verify/focus/stress） |
| `POST /api/education/agent/decompose` | 子问题拆解 |
| `POST /api/education/agent/follow-up` | 步骤结果苏格拉底追问 |
| `POST /api/education/agent/idea-cards/*` | 想法卡管理（list/create/update/delete） |
| `POST /api/education/agent/policy-check` | 教育策略校验 |

### 6.7 自动闭环 / 认知诊断 / 知识图谱 / 合规

| 分组 | 接口 |
|---|---|
| 自动闭环 | `/api/education/loop/hook-answer`、`/hook-plan-progress`、`/diagnose`、`/iterate`、`/report` |
| BKT 认知诊断 | `/api/education/cognitive/bkt-track`、`/bkt-diagnose` |
| 知识点先修图 | `/api/education/kg/check-prereq`、`/plan-path`、`/validate-path` |
| 思政审核 | `/api/education/audit/content`、`/calibrate` |
| 多模态 | `/api/education/multimodal/photo-solve`、`/speech-assessment`、`/blackboard` |
| 数据合规 | `/api/education/compliance/classification`、`/cleanup-student`、`/cleanup-expired`、`/status` |
| 学生服务 | `/api/education/student/cognitive-dims`、`/recommend`、`/review-reminder` |
| 语言学习 | `/api/education/lang/reading`、`/vocab-grammar`、`/writing`、`/record` |
| 编程教育 | `/api/education/coding/decompose`、`/tutor`、`/interview`、`/path` |

> 完整路由清单见源码 `src/api/server.ts`（搜索 `app.post("/api/education`）。

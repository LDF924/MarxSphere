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

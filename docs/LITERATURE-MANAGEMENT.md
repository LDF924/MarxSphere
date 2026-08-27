# Agentero 对照：文献管理能力

MarxSphere 文献管理（2026-08-27）：对齐 Agentero（Agent 友好的文献管理）能力清单。

## 能力对照

| Agentero 能力 | SAG 实现 | 状态 |
|---|---|---|
| Agent 原生文献管理（ACP 连接本地 Agent） | Agent + 文献库 + PDF 解析（pdf2obsidian/literature-service） | ✅ |
| **Zotero 生态**（导入书库/标签/笔记/BibTeX 导出） | `zotero-service.ts`：HTTP API（Zotero 桌面）优先 + sqlite 兜底；external_id 判重；标签/DOI/作者存 metadata；BibTeX 导出（article/book/report/thesis/inproceedings） | ✅ |
| **论文导入源**（RSS/arXiv 今日推荐） | `rss-service.ts`：RSS 解析（免依赖）+ arXiv API 按主题查询（sortBy=submittedDate）；订阅存 sources | ✅ |
| 文献阅读（Markdown 笔记/翻译/高亮/批注/图表解析） | AnnotationWorkspace（框选高亮/笔记/导出）+ agent-pdf-tool（翻译/图表） | ✅ |
| **云同步（S3）** | `s3-sync-service.ts`：AWS SigV4 手写签名，文献快照同步 S3/MinIO/OSS/COS | ✅ |
| **远程访问（SSH 隧道）** | `ssh-tunnel-service.ts`：ssh -L 端口转发浏览远程 SAG；隧道管理/空闲回收 | ✅ |
| 多系统 | electron-builder mac/linux/win | ✅ |
| 内置 CLI/MCP | MCP server + 脚本 CLI | ✅ |

## 使用

### Zotero
```bash
# 需 Zotero 桌面运行（本地 API http://127.0.0.1:23119）
POST /api/zotero/import {"sourceId": "项目ID"}   # 导入书库
GET  /api/zotero/export                          # 导出 BibTeX
GET  /api/zotero/status                          # 连通性
```

### RSS / arXiv
```bash
GET /api/rss/fetch?url=https://...rss          # 抓取 RSS
GET /api/rss/arxiv?topic=资本下乡               # arXiv 今日推荐
POST /api/rss/subscribe {"url","name","sourceId"}  # 订阅
```

### S3 云同步
```bash
# .env: S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY
POST /api/s3/sync      # 文献快照 → S3 (sag-sync/literature-YYYY-MM-DD.json)
GET  /api/s3/backups   # S3 里同步文件
```

### SSH 远程访问
```bash
# .env: SSH_HOST / SSH_USER / SSH_KEY_PATH / SSH_REMOTE_SAG_PORT
POST /api/ssh/tunnel {"localPort": 24173}      # 建隧道
GET  /api/ssh/proxy?port=24173&path=/api/projects  # 浏览远程知识库
DELETE /api/ssh/tunnel/24173                   # 关隧道
```

## 安全

- Zotero：只读导入（HTTP API 只读 / sqlite 只读）
- S3：凭证只存 .env；同步需显式触发
- SSH：凭证只存 .env；隧道 30 分钟空闲自动回收；默认未配置返回明确错误

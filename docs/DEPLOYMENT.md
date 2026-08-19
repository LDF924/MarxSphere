# MarxSphere 部署指南

本指南覆盖从源码到生产运行的完整部署流程（开发环境 / Docker / 生产服务器）。

## 1. 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20 | 全栈 TS 运行时 |
| PostgreSQL | 16 + pgvector | 向量检索核心（1024 维） |
| Neo4j（可选） | 5.x | Graphiti 11001 / Cognee 11003，图谱增强 |
| Python（可选） | 3.12 + venv | 推理 MCP 池 / 实证分析 |
| pnpm | ≥ 10 | 仅 vendor/pdf2obsidian 构建需要 |

## 2. 快速部署（Docker 一键）

```bash
# 1. 克隆 + 配置
git clone https://github.com/LDF924/MarxSphere.git
cd MarxSphere
cp .env.example .env          # 填入 API Key（见下方 3）

# 2. 启动依赖数据库（PG + 可选 Neo4j）
docker compose up -d

# 3. 安装依赖 + 初始化
npm install
npm run db:setup              # 迁移 + 种子数据

# 4. 构建并启动
npm run build                 # 后端 tsc + 前端 vite
npm start                     # http://localhost:4173
```

## 3. 环境变量配置

### 必需（不配服务不可用/功能缺失）

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | PG 连接串（`postgres://user:pass@host:5432/sag_lite`） |
| `LLM_API_KEY` | LLM 推理密钥（OpenAI 兼容，DeepSeek/Qwen 均可） |
| `LLM_BASE_URL` | LLM 端点（如 `https://api.deepseek.com/v1`） |
| `LLM_MODEL` | 模型名（如 `qwen-plus`） |
| `EMBEDDING_API_KEY` | Embedding 密钥（向量检索必需） |
| `EMBEDDING_BASE_URL` | Embedding 端点 |
| `EMBEDDING_MODEL` | Embedding 模型（如 `text-embedding-v4`） |

### 可选（数据源路径）

| 变量 | 说明 | 缺省影响 |
|---|---|---|
| `LITERATURE_DIR` | 文献库 PDF 目录（按主题分子目录） | 文献库页面为空 |
| `POLICY_DIR` | 政策库目录 | 政策库页面为空 |
| `VAULT_ROOT` | 资料库根目录 | 资料库页面为空 |
| `COGNEE_PYTHON` | Cognee MCP venv 路径 | 推理图谱检索降级 |
| `EMPIRICAL_PYTHON` | 实证分析 venv | 实证功能不可用 |
| `HTTP_PORT` | 服务端口（默认 4173） | — |

> **注意**：文献库/政策库/资料库指向**任意本地文件夹**即可，无需 Obsidian。
> 启动时服务会打印「启动环境检查」报告，缺失项有明确提示。

## 4. 生产服务器部署

### 4.1 systemd（Linux）

```ini
# /etc/systemd/system/marxsphere.service
[Unit]
Description=MarxSphere API
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/MarxSphere
EnvironmentFile=/opt/MarxSphere/.env
ExecStart=/usr/bin/node dist/src/index.js
Restart=on-failure
RestartSec=5
User=marxsphere

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now marxsphere
```

### 4.2 反向代理（Nginx）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # SSE 必需（推理/Agent 流式输出）
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

## 5. 桌面端

```bash
npm run build:desktop        # 生成 NSIS 安装包 release/MarxSphere Setup <ver>.exe
```

## 6. 发布流程（GitHub Actions 自动化）

- **CI**：push/PR 自动跑 typecheck + 154 测试 + E2E 冒烟 + 构建
- **Release**：打 tag 自动构建桌面端安装包并上传 GitHub Release：

```bash
git tag v0.3.0
git push origin v0.3.0
```

## 7. 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| 服务起不来（EADDRINUSE） | 端口被占 | `netstat -ano \| grep 4173` 查占用进程 |
| `/health` 的 `db: down` | PG 未启动/连接串错 | `docker compose up -d` 后重试 |
| 文献库/政策库/资料库为空 | 目录路径未配置/不存在 | 设置 `LITERATURE_DIR` 等，见启动检查报告 |
| 推理/检索无结果 | Embedding Key 未配 | 配 `EMBEDDING_API_KEY` |
| typecheck 报 pdf2obsidian module-not-found | vendor dist 未构建 | `cd vendor/pdf2obsidian && pnpm install && pnpm -r --filter "./packages/**" build` |

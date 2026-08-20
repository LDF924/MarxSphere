# MarxSphere 桌面端

AI Agent 桌面端封装 — Electron + NSIS 安装包。单进程架构：Electron 主进程 spawn 后端（`ELECTRON_RUN_AS_NODE` 复用内置 Node），同时提供 Fastify API + 前端静态服务。

## 安装包

- 产物：`release/MarxSphere Setup 0.1.0.exe`（~156MB）
- 安装：双击安装（NSIS 向导），或静默安装 `MarxSphere Setup 0.1.0.exe /S`
- 卸载：开始菜单/控制面板卸载（用户数据保留在 `%APPDATA%\MarxSphere`）

## 首次启动引导流程（全量自动引导）

1. **数据库（必需）**：检测 PostgreSQL（5540/5432）→ 未就绪时提供「🚀 一键启动 PostgreSQL」按钮（自动检测 Docker → 启动 pgvector 容器 → 等待就绪）；未装 Docker 则提示安装指引
2. **知识图谱（可选）**：检测 Neo4j（Graphiti 11001 / Cognee 11003）→ 未就绪提示"推理降级为 PG 向量检索"
3. **Python 环境（可选）**：检测 Cognee/实证 venv → 未检测时自动探测系统 Python（PATH/常见安装路径）→ 支持手动填写路径 + 实时验证按钮
4. **AI 密钥（必需）**：LLM API Key + Base URL（默认阿里云 MaaS）+ Embedding Key
5. **保存启动**：写入 `%APPDATA%\MarxSphere\sag-root\.env`，后端完整模式重启

## 架构要点

| 组件 | 说明 |
|---|---|
| Electron main | 单实例锁 / 端口预检(TCP connect) / spawn 后端 / 健康轮询 / 崩溃自动重启 / 进程树清理(taskkill /T) |
| 后端 | `resources/sag/dist/src/index.js`，`SAG_ROOT` 指向资源根，`cwd` 指向 userData（dotenv 加载 .env） |
| 端口 | 默认 4173，被占自动递增（最多 +10），`AGENT_API_BASE` 联动 |
| 首次启动 | 无 .env → preview 模式（不拉 Python MCP 池）→ 引导页；配置后完整模式 |
| 资源 | extraResources 真实目录（非 asar）：dist/scripts/migrations/data/web/node_modules |
| 密钥 | 安装包不含 .env/API key（打包后断言），首次启动引导配置 |

## 开发与打包

```bash
# 开发态启动桌面端（源码直跑, 资源指项目根）
npm run dev:desktop

# 打包安装包（前置: npm run build）
npm run build:desktop
# 产物: release/MarxSphere Setup <ver>.exe

# 仅编译 electron main/preload
npm run build:electron
```

## 环境变量

| 变量 | 用途 |
|---|---|
| `SAG_ROOT` | 资源根目录（安装目录，只读） |
| `COGNEE_PYTHON` | Cognee/Graphiti venv Python 路径 |
| `EMPIRICAL_PYTHON` | 实证分析 venv Python 路径 |
| `AGENT_EDGE_PATH` | Edge 浏览器路径（sag_browse 工具） |
| `AGENT_API_BASE` | 后端自调用地址（随端口联动） |
| `MARXSPHERE_PREVIEW` | preview/full 模式（main 自动设置） |

## 已知说明

- PostgreSQL 需本机运行（docker-compose up -d，镜像 pgvector/pgvector:pg16，端口 5540）
- 完整模式 MCP 池需 cognee venv（未配置时推理降级用 PG 向量）
- 卸载保留用户数据，手动删除 `%APPDATA%\MarxSphere` 完全清除

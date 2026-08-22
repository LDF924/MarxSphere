# MarxSphere 一键部署指南

> 目标：**从 clone 到可用的全自动流程**，无需手动安装 Node / PostgreSQL / Docker，也无需手动配置。

## 一、快速开始（一条命令）

```bash
git clone https://github.com/LDF924/MarxSphere.git
cd MarxSphere
npm run deploy
```

`npm run deploy` 自动完成：

| 步骤 | 做什么 | 需要手动吗 |
|---|---|---|
| ① Node 检查 | 缺则自动安装（Windows 用 winget） | 自动 |
| ② Docker 检查 | 缺则提示安装 Docker Desktop | 提示一次 |
| ③ 数据库启动 | `docker compose up -d`（PostgreSQL + Neo4j × 2）；**无 Docker 自动装本地 PostgreSQL**（华为云镜像，免管理员/免注册） | 自动（首次拉镜像较慢） |
| ④ 依赖安装 | `npm install` | 自动 |
| ⑤ .env 准备 | 自动复制 `.env.example → .env` | 填入 LLM_API_KEY（可选） |
| ⑥ 数据库迁移 | `npx tsx src/db/migrate.ts` | 自动 |
| ⑦ 种子语料入库 | 自动导入 `examples/seed-corpus/`（演示数据） | 自动（可选） |
| ⑧ 启动 | 服务启动在 http://localhost:4173 | 自动 |

**最终**：浏览器打开 **http://localhost:4173** 即可使用（无需 LLM Key 可先看界面，配置 Key 后推理/教育功能全开）。

---

## 二、手动部署（可选）

```bash
# 1. 前置：Node ≥ 20 + Docker
node --version          # ≥ 20
docker ps               # Docker 运行中

# 2. 数据库
docker compose up -d

# 3. 依赖 + 配置 + 迁移
npm install
copy .env.example .env  # Windows；Linux: cp .env.example .env
# 编辑 .env 填入 LLM_API_KEY（DeepSeek 等）
npx tsx src/db/migrate.ts

# 4. 种子数据（可选）
npx tsx examples/seed-corpus/ingest-seed-corpus.ts

# 5. 启动
npm start               # http://localhost:4173
```

---

## 三、桌面端安装包

- **Windows 安装包**（含全部依赖，无需 Node/Docker）：从 [GitHub Releases](https://github.com/LDF924/MarxSphere/releases) 下载 `MarxSphere.Setup.*.exe`，双击安装即可
- 安装包**自带**：后端 dist + node_modules（82MB zip，首次启动自动解压）+ 数据库 docker-compose + 教育资产（模板/案例库）
- 首次启动自动：解压依赖 → 引导数据库（`docker compose up -d`）→ 迁移 → 启动

---

## 四、Windows 虚拟机测试指南（验证干净环境安装）

> 目标：在**全新 Windows** 环境验证「clone → 部署 → 可用」全流程，排除本机历史残留干扰。

### 4.1 创建虚拟机（VMware Workstation）

> ⚠️ **已知问题（2026-08 实测）**：**VirtualBox 7.2 + Win11 24H2/25H2 OOBE 不兼容**——安装程序能装完系统，但首次设置界面（OOBE）反复卡死（鼠标/键盘无响应），尝试 VBoxVGA/VBoxSVGA 显卡、断网、注册表 BypassNRO 均无效。**建议使用 VMware Workstation 或 Hyper-V**（对 Win11 OOBE 兼容性最好）。

1. **镜像**：Windows 11 专业版 ISO（微软官网或 MSDN 渠道下载）
2. **配置**：4 GB 内存 / 60 GB 磁盘 / 2 核 CPU（Docker Desktop 最低要求）
3. **网络**：NAT 模式（可联网下载依赖）
4. **安装**：全新安装 Windows 11（不登录微软账号，本地账户即可）

### 4.2 测试流程

```bash
# ① 装 Git（https://git-scm.com 或 winget install Git.Git）
winget install Git.Git

# ② 装 Node（LTS ≥ 20）
winget install OpenJS.NodeJS.LTS

# ③ 装 Docker Desktop（或用 deploy 脚本自动提示）
winget install Docker.DockerDesktop

# ④ clone + 一键部署
git clone https://github.com/LDF924/MarxSphere.git
cd MarxSphere
npm run deploy
```

### 4.3 验证清单

| 检查项 | 预期 |
|---|---|
| `docker compose ps` | 3 个容器 running（postgres/neo4j×2） |
| `http://localhost:4173` | 打开界面（无 500） |
| 顶部「AI+教育」Tab | 学生端/教师端可进 |
| 教育资产（模板/案例） | 可加载（随包/种子） |
| 文档中心 | 21+ 篇文档可读 |

### 4.4 桌面端验证（安装包）

1. 下载 `MarxSphere.Setup.*.exe` 到虚拟机
2. 双击安装（验证 NSIS 安装 + node_modules 解压 + 首次引导）
3. 启动后功能冒烟（同上清单）

> **为什么值得做**：虚拟机是"干净环境"——能发现本机开发环境掩盖的问题（缺依赖/缺数据/路径硬编码）。发现的问题反馈到仓库修复后再发布新包。

---

## 五、常见问题

| 问题 | 解决 |
|---|---|
| Docker 拉镜像慢 | 配置镜像加速（`.docker` 配置 registry-mirrors） |
| 端口 4173 被占 | 换 `HTTP_PORT` 或关掉占用进程 |
| 数据库起不来 | `docker compose ps` 看状态；首次拉镜像需等待 |
| 教育功能空 | 确认 `education-templates/` 存在（仓库自带）；案例库需 `data/education-cases.json`（已随仓库） |
| 桌面端报依赖缺失 | 确认安装目录 `resources/sag/node_modules.zip` 存在；解压失败会降级 Expand-Archive |

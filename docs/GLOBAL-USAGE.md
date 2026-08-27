# 全局使用（Global Usage）

MarxSphere 可在任意目录启动（2026-08-27）：服务端通过 `SAG_ROOT` 定位资源，不依赖 cwd。

## 任意目录启动

```bash
# 在任意目录启动服务（资源从 SAG_ROOT 定位）
SAG_ROOT=C:/Users/HUAWEI/SAG-main npx tsx src/index.ts

# 或 Windows:
set SAG_ROOT=C:/Users/HUAWEI/SAG-main
npx tsx src/index.ts
```

服务启动后：
- 静态资源：`<SAG_ROOT>/web/dist`
- 迁移：`<SAG_ROOT>/migrations`（自动应用）
- 脚本：`<SAG_ROOT>/scripts`（评测/入库）
- 数据：`<SAG_ROOT>/.cache`（任务/上传/日志）
- 配置：`<SAG_ROOT>/.env`

## SAG_ROOT 解析优先级

```ts
const rootDir = process.env.SAG_ROOT || process.cwd();
```

1. `SAG_ROOT` 环境变量（显式指定）
2. 当前工作目录（兜底）

## 桌面端

Electron 内嵌：`SAG_ROOT = process.resourcesPath/sag`（安装目录的 resources/sag）
→ 桌面端自带完整资源（dist/scripts/migrations/data），任意机器可跑。

## 一键启动脚本

| 脚本 | 用途 |
|---|---|
| `start_sag.bat` | Windows 一键启动（含依赖检查） |
| `sag-bootstrap.vbs` | 开机自启（启动文件夹） |
| `sag-start.vbs` | 静默启动 |
| `sag-healthcheck.sh` | 健康检查（PG/Neo4j/venv/服务） |

## 环境变量（.env）

核心配置见 `docs/agent-env.md`；模型配置见 `docs/MODELS.md`。

## 数据目录约定

| 目录 | 内容 |
|---|---|
| `<SAG_ROOT>/data` | 文献库/资料库（可配置） |
| `<SAG_ROOT>/.cache` | 任务/上传/日志（jupyter-uploads/empirical 任务等） |
| `<SAG_ROOT>/evaluation` | 评测输出 |
| `<SAG_ROOT>/release` | 桌面端安装包 |

# 贡献与质量门禁（Contribution & Quality Gates）

MarxSphere 的质量门禁（2026-08-27）：本地测试 → 真实模型 baseline → CI → PR/release。

## 质量门禁流程

```
代码改动 → 本地 typecheck + 单测 → 前端构建 → CI 自动检查 → PR 评审 → release 发布
```

### 1. 本地检查（提交前必须过）

```bash
# 类型检查（后端 + 前端）
npm run typecheck          # tsc -p tsconfig.json + tsc -p web/tsconfig.json

# 单元测试（vitest）
npm test                   # 当前 177 例（28 文件）

# 前端构建
npx vite build
```

### 2. 真实模型 baseline

- **评测体系**：`scripts/eval-32-metrics.ts`（32 指标 A12+B9+C3+D7）
- **数据指纹**：评测输出携带 dataFingerprint（501 篇文献 → 6d74cb5f…）
- **stale 判定**：数据变更后旧评测结果标记 ⚠️（不可与当前基线直接对比）
- **回归**：轨迹前缀回归集（16 题）+ 显著性检验（significance.ts）

### 3. CI 自动检查（.github/workflows/ci.yml）

| 步骤 | 内容 |
|---|---|
| Setup | Node 20 + PG 16（pgvector 容器） |
| Install | npm ci + vendor/pdf2obsidian 构建 |
| **Typecheck** | 后端 + 前端 tsc |
| **Unit tests** | vitest 全量 |
| Frontend build | vite build |
| Server E2E | 起服务 → PG 连通 → Playwright smoke |

### 4. PR 门禁

- PR 必须通过全部 CI 检查
- 新功能需配套单测（参考 test/ 现有风格）
- 前端改动需 web tsc + build 通过

### 5. Release 门禁（scripts/release.mjs）

```bash
node scripts/release.mjs v1.1.0 "发布说明"
```

自动：构建 → 桌面打包（NSIS）→ GitHub Release 创建 → 安装包上传。
版本号语义化（1.0.0 → 1.1.0 minor 递增），CHANGELOG 同步更新。

## 代码规范

- SPDX 头：`// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception`
- 中文注释（关键逻辑说明"为什么"）
- 新服务放 `src/services/`，脚本放 `scripts/`，测试放 `test/`
- 迁移文件 `migrations/NNN_*.sql` 幂等写法（if not exists）

## 仓库结构

- **SAG-open-source** = 开发主线（GitHub 推送）
- **SAG-main** = 工作副本（同步刷新，`scripts/sync-repos.mjs --check` 检测差异）
- 每日自动一致性检查（计划任务 MarxSphere-SyncCheck）

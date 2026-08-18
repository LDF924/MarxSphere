# 更新日志（Changelog）

本项目按语义化版本管理，主要变更记录于此。

## [0.2.2] - 2026-08-18

### 桌面端发布（marx-icon）

- 桌面端 v0.2.2（Marx 图标）打包发布，安装包上传 GitHub Release
- 马克思图标纳入仓库（`docs/assets/marx-logo-512.png` / `marx-logo.png`）

### 示例数据与文档

- 新增种子语料 `examples/seed-corpus/`：50 篇评测金标同源文献（1化6 产物）+ 一键入库脚本，clone 后无需私有文献即可体验四源检索
- 文档数字统一：Agent 工具 44（26 Agent + 18 视图）、场景 66、技能约 190+
- 架构图同步（`docs/assets/marxsphere-architecture.svg`）

## [0.1.0] - 2026-08-17

### 开源发布

MarxSphere 马研星环首个开源版本（MIT 许可）。

#### 核心能力

- **52 步深度推理链路**：问题分类 → 17 路粗检索 → Graphiti 精炼 → 超边三路检索 → 融合生成 → 自评自愈（template/adaptive 双模式）
- **Ask 18 步检索流水线**：多臂召回 → 加权 RRF → Cosine 重打分 → Boost 链 → LLM 重排
- **三库知识图谱**：Graphiti（超边/社区）+ Cognee（实体/切片）+ PG pgvector（向量 1024 维）
- **66 科研场景工作台**：8 大阶段全覆盖，含分步引导与专属算法
- **AI Agent**：50+ 能力项、44 工具（26 Agent + 18 视图）、5 层安全、5 层记忆、Agent 轨迹评测
- **实证研究工作台**：问卷生成/信效度/诊断/LLM 插补/回归（M1-M6）/证据账本/质量闸门
- **桌面端**：Electron + NSIS 安装包，首次启动全量引导
- **自研 Skill 10 个**：cnki/pdf2obsidian/md-clean/三库入库/三库检索/推理/Agent 调度

#### 评测

- 53 题 31 指标评测综合分 **0.884**（检索 0.795 / 答案 0.985 / 推理 0.886，通过率 100%）
- 154 项单元测试
- 双轨评测（规则 + LLM judge）+ 消融体系（21 算子）

#### 基础设施

- 单进程架构（Fastify API + 静态前端一体）
- MCP Server（8 工具，Claude Code/Codex 直连）
- 商业化底座（多租户/JWT/计费/BYOK，可选启用）
- 告警中心/自愈巡检/运营管理

#### 文档

- README（中英双版）+ AGENTS.md + SECURITY.md + CONTRIBUTING.md
- 合规披露（商业 API/闭源模型/数据治理/PII 声明）
- 功能规格详解 + 项目概述 + 评测标准（V96）

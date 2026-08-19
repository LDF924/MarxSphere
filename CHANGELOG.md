# 更新日志（Changelog）

本项目按语义化版本管理，主要变更记录于此。

## [0.4.0] - 2026-08-20

### 📜 许可证变更（重要）

- **MIT → AGPL v3 + 商业授权双许可**
- 保留 Logo/版权声明、衍生作品必须开源（AGPL 传染性）
- **商用（销售/付费托管/商业产品捆绑）需单独商业授权**（联系 2665834886@qq.com）
- 科研/教学/个人使用保持免费
- 贡献者条款：维护者可在 AGPL 家族内修订协议、贡献可用于商业运营
- 旧版本（v0.3.3 及之前）按 MIT 分发，不受影响

## [0.3.3] - 2026-08-20

### ✨ 新功能
- **问卷上传支持 PDF/Word/Excel/PPT**：实证研究问卷识别页可上传 10 类格式文件，服务端 Python 解析转文本（PyMuPDF/docx/openpyxl/pptx）
- **载入真实问卷文本**：内置《农村经营形态调查问卷》16 页 167 题演示文本

### 🐛 修复
- **Fastify bodyLimit 30MB**：修复大文件上传被拒（Request body is too large）
- **PyMuPDF 新 API**：fitz 弃用警告不再污染解析输出
- **PYTHON 未配置栈溢出**：实证工作台不再因 execFile 空调用崩溃（Maximum call stack）
- **启动检查补 RERANK**：缺配置时提示降级而非静默 404

### 🛠 其他
- Release Notes 自动生成（从 git 提交，CI 拉全 tag）

> 本版由本地打包发布（安装包同时上传 GitHub 与同步主仓库）

## [0.3.2] - 2026-08-19

### 🐛 修复
- **桌面端评测结果缺失**：打包白名单（electron-builder extraResources）补上 evaluation/reports/docs 目录——评测页现在能显示 53 题评测结果（0.884 等数据）
- 安装包体积 215MB → 224MB（新增评测/报告/文档文件）

> 前一版 v0.3.1 只修了复制层（build-desktop），打包白名单仍漏——本版两层都补齐。

### 使用
- 下载安装后，桌面端「评测」页可查看完整评测结果与报告

## [0.3.1] - 2026-08-19

### 🐛 修复
- **桌面端窗口离屏残留**：异常退出后重启，窗口可能显示在屏幕外（看起来像蓝屏/黑屏）——改为渲染就绪后再显示（ready-to-show）+ 屏幕位置校验，不在可见区域自动居中
- **打包复制层修复**：build-desktop.mjs 补 evaluation/reports/docs 目录复制（本版修复不完整，打包白名单仍漏——**v0.3.2 已彻底修复**）

> ⚠️ 本版评测文件仍缺失（白名单问题），请升级到 v0.3.2

## [0.3.0] - 2026-08-19

### 🎨 UI 改进
- 政策库/资料库/知识页/文献库：双栏布局加高 + 页面滚动，预览撑满容器
- 文献库三栏间距统一
- 首页数据带动画（staggered 入场）+ 卡片 hover 反馈
- Markdown 阅读区 A4 舒适版式（行宽限制 + 行高）

### 🛡 生产级保障
- 新增 GitHub Actions CI：每次推送自动 typecheck + 154 单测 + E2E 浏览器冒烟
- 新增发布自动化：打 tag 自动构建桌面端安装包并上传 Release
- 启动环境检查：密钥/数据目录缺失时给出明确警告（不再静默空库）
- 修复依赖缺陷：bcryptjs/jsonwebtoken 补入 dependencies（旧安装包在干净机器可能启动失败）

### 📚 文档与体验
- 新增部署指南（Docker / systemd / Nginx）
- 新增 GitHub Pages 文档站
- README 三语 + 架构图 + 核心能力一览
- 新增 E2E 冒烟测试（Playwright）

### 🐛 修复
- paper_id_map.json 路径改为绝对路径（非仓库目录启动时 paperFilter 失效）
- 消息压缩链路补全（1M 窗口防 token 超限）
- 文献库/政策库/资料库数据源路径可配置（LITERATURE_DIR 等）

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

# 更新日志（Changelog）

本项目按语义化版本管理，主要变更记录于此。

## [0.10.0] - 2026-08-23

### ✨ 新增

- **登录认证开关**（`SAG_AUTH_ENABLED=true`）：桌面端引导页保存配置时自动启用（写 `SAG_AUTH_ENABLED=true` + 生成 `JWT_SECRET`，等价 `openssl rand -hex 32`）；已存在密钥不重新生成（避免重启后登录会话失效）；WebUI AuthGate 登录页随之生效。`env:save` 改为 map 合并——重复保存不再丢失旧配置
- **技能双目录统一**：`getSkillsRoots()` 重构所有读路径（`listSkills`/`getSkillDetail`/`auditSkillsLive` 统一读 `~/.claude/skills` + 随包 `SAG_ROOT/skills`，同名用户目录优先）
- **OpenViking 优雅降级**：连接失败一次性警告（明确提示服务地址与 `OPENVIKING_URL` 配置）；`memoryHealth` 返回 `url/degraded/reason` 供健康面板展示

### 🐛 修复

- skills-service：`listSkills` 内层 `records` 遮蔽外层导致返回空数组（上次提交引入，typecheck 不报）
- electron：`dlSpawn` 作用域越界（pgvector 下载段 ReferenceError，本地 PG 首次安装必失败）
- 打包验证：新增 `scripts/verify-asar.mjs`（检查 app.asar 含关键修复，可复用于后续版本）

## [0.9.0] - 2026-08-23

### 🐛 修复

- NSIS 安装后放开 Users 写权限 — 普通用户可解压 node_modules（Program Files 只读）
- PG initdb/启动/建库全异步 + 轮询等待 — 修复 pg_ctl ETIMEDOUT
- winget 装 Docker + compose up 改异步 — 引导页不再卡死
- 进度条=文字百分比 — 下载 100% 进度条满，安装各阶段直接对应
- icacls 改用 ExecWait（nsExec 插件可能未打包进 NSIS）
- 解压前检查写权限 — Program Files 只读时 icacls 提权放开（UAC）

## [0.8.0] - 2026-08-23

### 🐛 修复

- 打包时移除 emoji 文件名 — Windows tar/Expand-Archive 解压兼容
- PG 下载卡死修复 + 本地 PG 按钮直接触发 + 下载提示归位
- PG 解压异步流式 + 20min 超时（修复 spawnSync ETIMEDOUT）
- 等待引导页 ready 后再启动后端 — 解压/进度 IPC 事件不丢失
- 依赖解压提前到 DB 等待之前 — 修复 DB 未就绪时解压永不触发
- 进度条百分比匹配 — 下载 5-80%（100% 满条）+ 安装 50-100% 分段

## [0.3.0] - 2026-08-23

### 🚀 无 Docker 模式（国内用户友好）

- **数据库五级降级链**（桌面端引导页 + `db:setup`）：有 Docker 用 Docker → 无 Docker 自动装 Docker → Docker 装不了/失败/超时 → **自动装本地 PostgreSQL 16 便携版**（华为云镜像，免管理员/免注册/免外网）
- **deploy.mjs 无 Docker 模式**：`npm run deploy` 检测到无 Docker 自动装本地 PG（initdb → 启动 5540 → 建库 + pgvector → 写 DATABASE_URL）
- **node_modules 解压修复**：Expand-Archive 优先 + 递归容错（干净 Windows 环境不再"后端依赖缺失"）

### 🐛 修复

- release.mjs：POST 422 竞态降级 PATCH（CI 与手动发布并发不再崩溃）
- 教育反馈闭环 / 12 项评测（V397，随 v0.2.0 已发布）

## [0.5.0] - 2026-08-21

### ✨ AI+教育（重大新增）

- **AI+教育工作台**：顶部「AI+教育」Tab（学生端「我的学习」/ 教师端「教师工作台」双子 Tab），84 教育路由
- **教育专属 Agent**：苏格拉底式提问 / 阶梯式启发 / 错题-知识点联动 / 学习进度追踪 / 五步打磨（记录→发散→验证→聚焦→压力测试）/ 想法卡 / 步骤追问 / 策略校验
- **教育专属技术**：BKT 认知诊断（p(掌握) 推断）/ 知识点先修图 + 拓扑路径规划 / 思政内容四维核验 + Compiled Truth 权威校准
- **端到端自动闭环**：自动采集 → 自动诊断 → 自动迭代（计划重排）→ 自动验证周报
- **作业辅导闭环**：题目解析（4 模式）/ 错题归集 / 变式生成 / 错题本 / 标记掌握 / 作业批改 / 错题报告
- **教师助手 13 项**：课程大纲 / 教案 / 课件 / 分层设计 / 智能出题 / 组卷 / 批改 / 错题报告 / 课堂讨论 / 随堂测验 / 课堂总结 / 班级学情
- **教育多模态**：作业拍照识别 / 口语测评（三维评分）/ 板书识别
- **学生服务**：认知维度（布鲁姆六维）/ 千人千策推荐 / 复习提醒（艾宾浩斯遗忘曲线）
- **教育复用资产**：场景模板（5）/ 教学案例库（10）/ 示例课程（2 门 5 切片）/ 外部资源源接入（学校资源库/公开平台），按角色空间隔离（学生/教师独立）
- **教育数据合规**：数据分级 / 最小化采集 / 权限隔离 / 保留期清理 / 语音即删

### 🔧 AI Agent 架构

- **education_service 工具**：83 个教育动作全覆盖（对话一句话触发教育功能）
- **A3 前端插件化**：viewRegistry 面板注册表（registerView 一行注册）
- **A2 服务插件化确认**：LlmProvider/SandboxProvider/GuardProvider 接口（已实现）

### 📚 文档中心

- 文档索引扩至 25 篇（指南/参考/架构/Agent/评测/集成/合规 7 组）
- 系统架构 / 功能明细 / 推理链路调用图按当前系统重写
- DeepSeek Harness 集成文档 + overview/quickstart/API 参考教育章节
- 项目简报更新（教学科研一体化定位）

### 🐛 修复

- 前端输入 state 拆分（各功能区独立，不再全局联动）
- 结果渲染结构化（不再暴露原始 JSON）
- 教育资产加载兜底 / 路径过滤 / 角色空间隔离

---

## [0.4.0] - 2026-08-20

### 📜 许可证变更（重要）

- **MIT → AGPL v3 + 商业授权双许可**
- 保留 Logo/版权声明、衍生作品必须开源（AGPL 传染性）
- **商用（销售/付费托管/商业产品捆绑）需单独商业授权**（联系 2665834886@qq.com）
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

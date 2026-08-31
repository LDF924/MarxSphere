## [1.3.0] - 2026-09-01

### 🚀 Rimagination 开源生态融入(V399, 2026-08-31)

- **PDF/文档双模式转换**(mineru-go): vendor 源码直用 + `pdf_convert` 工具(Agent 轻量 ≤10MB≤20页 / Precision 精准, 扫描件 OCR); `cleanMarkdown()` md 清洗(scansci-pdf 提炼, 变音符号折叠+NFC+替换字符审计)
- **科研技能 ×6 源码直用**: good-question(选题打磨, 挂 S01/S04 场景+教育 stress 注入) / gongwen-draft(23 文种公文起草, `gongwen_draft` 工具) / bili-note+dy-note(视频笔记, `video_note` 工具) / good-story(科学叙事, `view_truth_narrative`) / thu-digitizer(图表数字化, `view_chart_digitize` 两阶段)
- **元分析第 17 方法**(easymeta 方法论移植): 固定/随机效应+Q/I²/τ²+HK 校正+森林图/漏斗图+依赖审计; 前端表单+契约对齐
- **英文文献 OA 回退**(instsci 提炼): `view_openalex_search` / `view_oa_lookup`(OpenAlex+Unpaywall, 国内可达; arXiv 被墙→替代)
- **引文三维核验**(citation-lab 移植): `POST /api/citations/verify`(元数据真伪 Crossref+OpenAlex / 语境相关性 / 断言支持度)+ 前端核验面板
- **引用网络图算法**(paper-atlas 提炼): 文献耦合+共被引 0.5/0.5 余弦 → 加权度裁剪 → top-K 边
- **技能注册 195→201**, 基线 v29 确认归类; 合规 15 项声明; 桌面端 vendor 随包携带

### ⚙️ Codex 开源对齐(V400, 2026-09-01)

- **预算/时间提醒注入**: agent-reminder-service(Rollout 50K / TokenBudget 6_144 / 时间 / 压缩回退四提醒, 窗口 claim 去重, 注入 reflect prompt)
- **Mid-turn 压缩不终止**: 上下文超窗 90% → compressContext → 继续(不再失败); 滚动窗口推进
- **Elicitation 暂停协调**: agent-elicitation-service(计数暂停, 工具结果等追问完成)
- **钩子系统对齐**: Stop(should_stop/block) / PreToolUse(输入改写) / PostToolUse(反馈替换) / PermissionRequest(三级链第一级) / SessionStart(上下文注入)
- **审批三级链**: PermissionHook→Guardian→User + 审批缓存(指纹, 同任务免重复)
- **Guardian 拒绝熔断**: 连续 deny≥3 触发
- **世界状态 diff**: reflectLog.reviewedStepIds 增量注入(防多轮上下文爆炸)
- **Steer 转向输入**: POST /api/agent/tasks/:id/steer(运行中注入, 隐含 resume)
- **Mailbox 双通道**: agent-mailbox-service(入队/drain/deferToNextTurn)
- **挂起优雅关停**: pause/cancel 前写检查点+邮箱延迟(可恢复)
- **工具暴露矩阵**: buildAgentTools exposure=read-only(评审会话只读)
- **评审会话隔离 + 共享上下文 LRU**: reviewer 只读工具+约束; sharedResults 容量 5 淘汰
- **测试 287→295**; CODEX-GAP-ROADMAP 六层 30 项差距清零; Apache 2.0 合规声明

## [1.2.0] - 2026-08-30

### 🎓 学习引擎(LingxiLearn 借鉴, V396-V397)

- **深度调研报告**(docs/LINGXILEARN-REVIEW.md): 单循环图/三词汇表分层/GoalStack 可撤销路由/证据系统/教学 Skills/四层评测/差距清单
- **verification_debt 验证债务**(101 迁移): 强帮助后记债务, 独立正确还债, 进到期队列排序
- **内容寻址去重**: sha256 摘要即 evidence_digest, 同观察重复追加自动坍缩
- **闭式状态转移表**: 组件状态 pending→started→completed 闭式校验, 非法转移拒绝
- **评测纪律**: not_observed≠pass, 缺失维度显式报告不抬分
- **状态提案(proposal-only)**: 事件压缩成谨慎提案(needs_recheck 需≥2次/答错=misconception), 只提案不写入
- **review_priority 单尺子**: 0.45×逾期+0.35×薄弱+0.20×不确定
- **Capability 注册表**: 封闭 20 tag 词表 + 确定性候选生成(收益/成本排序) + 意图过滤; E9 能力推荐 tab + Agent capability-recommend
- **可视化产物**: visual_map 执行器生成 SVG 关系图(节点/连线), 画布直接渲染
- **学习多 Agent 协作**: 讲解(content.lesson)→出题(assess.generate)→反馈(assess.grade) 链式共享上下文, 失败降级; E9 多Agent tab + Agent learn-agents

### 🎓 学习引擎(TraitTutor 借鉴, V386-V393)

- **学习者事件账本 + BKT 概念掌握**(096 迁移): append-only 账本 + void amendment + 强证据闸门(仅服务端判分进 BKT) + 诚实读(未校准/观察<3 不显示数字) + 时间衰减读投影
- **BKT 离线校准脚本**(scripts/calibrate-bkt.ts): 约束随机搜索 2 万候选 + 学生级 5 折 + 质量门
- **版本化学习计划链**(097 迁移): 只重规划未开始尾部(已开始前缀不可变) + supersede 审计链 + 组件状态机(依赖前置校验)
- **确定性组件选择器**: 源码移植 TraitTutor select/_stage(BKT 四阶段分支 / 评估-校准成对 / 孤儿评估抑制 / 14 种组件中文文案)
- **产物审查三态机**(098 迁移): needs_review→confirmed/discarded, 未确认不可挂载不可评分, 审查历史可审计
- **材料分析快照**(098): 学科/难度/概念候选/页证据/模态适配 + augmentation 补充决策(LLM 判定+启发式降级)
- **一材多工件**: artifacts(courseware/flashcards/quiz)挂载到学习计划, 仅 confirmed 经 generation_id, 投影剥除答案键(correct_answer/is_correct/explanation/back)
- **间隔重复复习队列**(100 迁移): 4 类知识间隔序列 + 连中 2 跳 2 档/答错退 1 档/连错 2 重置 + 错误未修复优先 + 与事件账本联动
- **Compass 记忆治理**(099 迁移): 偏好三态(显式/推断/拒绝) + 90 天 TTL + 候选确认门(≥2 证据) + 删除即重建 + 边界声明随数据走
- **学习意图双层路由**: 5 类注入扫描(中英双语) + LLM 分类(conversation vs learning_path) + 低置信度 fail-closed 需确认 + 附件文本永不进分类器 prompt
- **Quota Rotation LLM 网关**: 总 deadline + per-model 路由熔断(连续失败≥3/60s) + 配额/认证立即轮换 + 错误摘要不静默
- **组件白名单 + 答案服务端持有**: 类型/字段白名单 + 答案键物理缺席 + 可执行标记拒绝 + 违规降级文本页
- **全屏学习画布**: 路径侧栏/组件/"为何此步"证据同屏 + 挂载折叠 + 状态推进(幂等/409 自愈/依赖锁定)
- **前端**: E9 学习引擎面板(材料分析/意图路由/复习队列/Compass/熔断) + 产物中心(确认/丢弃/挂载) + learning.css 设计体系(40+ 类移植)
- **Agent 接入**: education_service 工具新增 plan-chain/intent/material-analyze/pref-*/reviews-* action


## [1.1.0] - 2026-08-27

### ✨ 文献入库哈希版本化（P0-P2 + ScienceX 补齐）

- **内容哈希判重**（087 迁移）：文献入库按正文 sha256 判重，同内容重灌跳过（堵换标题重灌漏洞），content_version 变化感知
- **评测数据指纹**（3.3）：评测输出携带 dataFingerprint（501 篇文献 → 6d74cb5f…），数据变更 → 指纹变 → 旧结果可判 stale
- **eval_run 参数/环境快照**（088/089）：评测 run 记录 EVAL_* 参数 + node/tsx 环境 + 数据指纹，runId 幂等 upsert
- **stale 判定 + 前端展示**（改动点E）：评测启动对比历史指纹警告；/api/eval/results 返回 currentFingerprint + 每文件 stale；前端指纹条 + ⚠️数据已变更徽标
- **document_versions 版本历史表**（090）：文献内容变化自动登记历史版本
- **实验表格哈希版本化**（091/092）：数据版本登记内容哈希判重 + 数据本体存储 + 登记时自动画像（列类型/缺失率/数值分布）
- **agent 评测快照**：runEvalSuite 记录参数/环境
- **产物哈希登记**（3.6）：评测输出 artifactHash

### 🛡️ 仓库同步防错机制

- sync-repos.mjs: --check 差异检测 / package.json 版本保护 / 同步后自动校验 / --to-open 禁止（主线保护）
- 每日自动一致性检查（计划任务 MarxSphere-SyncCheck 09:30）
- 修复 8/27 同步方向错误覆盖的 V4xx 桌面端修复（AuthGate V424 退出登录 / authHeaders 鉴权等）

### ✨ 新能力（ScienceX 对照）

- **Notebook 工作台**：轻量 Jupyter — 代码/Markdown 单元格、9 种图表模板（三线表/热力图/箱线图等）、文件上传（pandas 可读）、Restart & Run All、载入演示
- **模型中立**：Anthropic 原生端点自动识别（/messages）、Claude Sonnet/Opus/Haiku 入注册表、前端可选
- **IM 接入**：飞书/钉钉/Telegram webhook 机器人 — 远程对话（状态/项目/评测/审批/告警）
- **Computer Use**：桌面控制（截屏/鼠标/键盘/窗口列表）— PowerShell 无依赖，Agent computer_use 工具
- **跨平台打包**：electron-builder mac(dmg/zip) + linux(AppImage/deb) + 正式图标
- **Agent 图表模板工具**：chart_template 一键出图（与 Notebook 对齐）
- **Agent 持久运行时出图**：runtime_exec 支持 matplotlib 图表返回 + 复用实证 venv

## [1.0.0] - 2026-08-25

### 🚀 正式版 v1.0.0

- package.json 版本对齐 + CHANGELOG 补档
- 桌面端安装包（NSIS）正式发布

# 更新日志（Changelog）

本项目按语义化版本管理，主要变更记录于此。

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

- **AI+教育工作台**：顶部「AI+教育」Tab（学生端「我的学习」/ 教师端「教师工作台」双子 Tab），112 教育路由 + 32 学习引擎顶层
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
- 263 项单元测试
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

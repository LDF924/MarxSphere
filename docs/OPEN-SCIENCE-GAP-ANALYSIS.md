# open-science(ai4s-research)→ MarxSphere 差距分析与移植路线

> 2026-09-04 · 分析对象: `ai4s-research/open-science` v(1579★, MIT, ResearchClawBench #1)
> 参考物: `C:\Users\HUAWEI\open-science-ref` + `C:\Users\HUAWEI\ai4s-skills-main`

## 一、open-science 是什么

Open Science Desktop — local-first、模型无关的 AI 科研工作台(Tauri 2 + React + OpenCode runtime + MCP)。
核心不是 UI,而是三件事:**可追溯产物链(provenance)、结构化审查协议、研究技能流水线(ai4s-skills)**。

## 二、六大机制差距(按移植价值排序)

### 1. 文件级溯源 + 环境锁 + run 链接【高价值】
- open-science: 每次 write/edit 成功调用 → 推导 `ProvenanceRecord` → append 到 `.openscience/provenance.jsonl`;每次记录带环境快照(实际用到的 Python 解释器版本 + pip freeze 内容寻址 `.openscience/env/<hash>.txt`);run 产物以 `tool:"run"+runId` 链接复现配方。路径越界拒绝。
- MarxSphere 现状: 任务/会话级日志有,但缺 **文件版本级** 溯源与环境锁定。
- 移植量: 中(事件订阅 + JSONL append + 按需 SQLite 读模型,前端 RunsPage 展示)。
- 关键参考: `crates/osd-core/src/provenance.rs`、`apps/desktop/src/lib/runs.ts`、`crates/osd-core/src/runs_index.rs`。

### 2. fenced-JSON 审查协议 + ReviewerCard 渲染【高价值】
- open-science: agent 消息末尾输出一个 ` ```review ` fenced JSON `{findings:[{level:error|warn|ok,check:…,title,evidence,tag}],note}`;前端解析后剥除、渲染成可折叠/逐条 dismiss 的 ReviewerCard(底层文本仍在对话中不丢审计)。
- MarxSphere 现状: 引文核验面板、论文质量检查已有,但以固定 UI API 呈现;**无通用的 fenced-JSON 审查协议**。
- 移植价值: 协议极轻、无 UI 依赖,审查类技能(引文核验/格式评测/统计完整)可直接产出该格式,前端一个通用组件消费。
- 关键参考: `apps/desktop/src/lib/review.ts`、`components/thread/ReviewerCard.tsx`、`runtime/skills/core/*/SKILL.md`。

### 3. 技能-确定性脚本-产物 闭环(不以提示词为孤岛)【高价值】
- open-science 审查技能(traceability-review/stats-integrity)模式: 确定性 Python 脚本产初步 finding(PDF 引文抽取、数值 claim,绝不靠 LLM 记忆)→ LLM 现场核验 → fenced-JSON 输出。note 恒声明"非无错保证"。
- MarxSphere 现状: 技能(SKILL.md)多,但确定性工具脚本与 LLM 的分工可更强。
- 移植量: 低-中(把 pdf_extract.py 等脚本迁入,把现有审查服务对齐此分工)。

### 4. git 无痕快照 + checkpoint fork 审查【中-高】
- 每会话 idle 提交到专用 ref `refs/openscience/snapshots/<branch>`(专用 index,绝不碰用户分支/HEAD),大文件排除。
- 可选自动审查: 写工具成功后,在完成 checkpoint 的 fork 里跑只读 `reviewer` agent,前台不抢锁。

### 5. runs 系统范式【中】
- bash 命令按段分析 → 白名单解释器才记为 run → `.openscience/runs.jsonl` 为真相,SQLite 只是可弃读模型(按字节水位懒重建)。Reproduce 按钮生成预填 prompt 由用户发送(人机环,永不自动执行)。
- MarxSphere 已有任务队列/任务页;此范式对"马克思语料重跑"可借鉴。

### 6. 领域产物查看器生态【中】
- 30+ 领域预览器(分子 3D/基因组/FITS/VASP DOSCAR/量子 qcode…),对马克思研究场景增量低;若做理工类学术产物可参考。

## 三、ai4s-skills 技能链(独立包,可整体移植)

`ai4s-research/ai4s-skills`(MIT,本地已解压于 `C:\Users\HUAWEI\ai4s-skills-main`,钉死 commit)7 技能,全部是**纯流程型**(SKILL.md 方法论 + references playbooks + LaTeX 模板,无 Python 运行时、无 LLM SDK,agent 用自己的工具执行)。**无代码调度器** —— 编排靠契约:slug 公式(小写→连字符→40 字符+sha1-8) + 路径约定 `output/<skill>/<slug>/<ts>/latest/` + `results.json` 的 `simulated` 披露一致性;宿主(Claude Code)按提示词原生加载。

| 技能 | 输入 → 产物 | 对 MarxSphere 的增量 | 建议 |
|---|---|---|---|
| ai4s-agent(编排) | 方向 → 触发探索→综述→实验→论文→审计 | **场景串联协议**(slug 路径+披露一致性+单阶段直出),把 65 场景串成长链的骨架 | **高**: 移植契约 |
| research-explorer | 模糊方向 → research_exploration.md + topic_matrix.md(三级矩阵,可渲染图)+ literature_pre_survey.md(20-30 篇,每条本会话实取 URL) | 选题前置漏斗 + 结构化新产物 | **高**: 移植 topic_matrix 格式 |
| literature-survey | 主题 → 6-20 页 PDF 综述(60+ 实引,时间剖面 ≥60% 近三年)+ LaTeX + 分类表 | 语料库(死库存)→ 实时重建综述的生成式用法;`check_bibliography_freshness.py` 可挂语料库校验新鲜度 | **高**: 移植 playbooks + 新鲜度脚本 |
| paper-writer | 主题 → 8-14 页 PDF(200+ 实引,无 unknown key)+ 4-8 图 | 与写作语料库重叠最多;增量在**硬性质量门**(G1-G8、200 实引硬停、禁编造、`\thanks` 披露)与 LaTeX 编译链 | **中**: 吸收"门限+诚实失败"纪律 |
| experiment-suite | 实验包 → design + data_contract + 可运行代码 + results.json(schema: per-seed/均值±std/provenance/simulated)+ figures + report | 增量在**审计契约**:results.json 统一 schema 把场景输出变可审计对象 | **中**: 场景输出对齐 schema |
| integrity-auditor | 外部论文 → 三证据轨(image/numerical/logical)+ L1-L4 分级 + audit_report.md + Requested raw data 清单 | 引文核验面板只查"引用存在";此补**图/数/逻辑取证**:image_dup.py(phash+ORB 旋转/翻转检测)、panel_split、channel_check、decimal_match(跨单元格尾数,含实证基线)、magnitude_consistency(SI 前缀感知,含 Nature 千倍误差基线)、xlsx_aggregate_consistency | **高**: forensics_tools 纯 Python 单目,核验面板可直接调,天然第 2/3 轨 |
| mindmap-render | topic_matrix.md → 思维导图图 | 低(前端图组件已有) | 低 |

移植最小路径: 复制技能目录为自有 SKILL.md 包 + 保留 slug/路径/披露契约;无需写调度器。

## 四、移植路线建议(分期)

**P1(低工作量、高价值)**
1. fenced-JSON 审查协议 → 前端 ReviewerCard 通用组件;把引文核验/格式评测输出对齐
2. ai4s-skills 的 literature-survey / paper-writer 的 **references playbooks**(增量执行/文献扩展/分段写作)并入 MarxSphere 写作服务(参考其方法论,不依赖其 LaTeX 环境)

**P2(中工作量)**
3. 文件级 provenance JSONL + 环境快照 + runs 索引(写服务端,复现 prompt 人机环)
4. git 专用 refs 无痕快照(每会话可复现点)

**P3(高工作量、按需)**
5. ACP 双向互操作接管外部 CLI agent(若需让 Claude Code/Codex 在 MarxSphere 会话里跑任务)
6. 30+ 领域产物查看器(若需理工类产物)

## 五、关键文件索引

open-science 侧:
- provenance: `crates/osd-core/src/provenance.rs` / `apps/desktop/src/lib/provenance.ts`
- runs: `crates/osd-core/src/runs.rs` / `runs_index.rs` / `apps/desktop/src/lib/runs.ts`
- review: `apps/desktop/src/lib/review.ts` / `components/thread/ReviewerCard.tsx`
- 快照: `crates/osd-core/src/git_snapshot.rs`
- 技能: `runtime/skills/core/{traceability-review,stats-integrity}/SKILL.md` + .py

ai4s-skills 侧(独立包): `skills/{research-explorer,literature-survey,experiment-suite,paper-writer,integrity-auditor,ai4s-agent,mindmap-render}/`

## 六、结论

MarxSphere(220 服务 / 237 组件 / 65 场景)能力体量远超 open-science,差距不在"有没有",而在 **"溯源是否到文件级、审查是否有通用协议、写作技能是否含 PDF/LaTeX 级产出"** 三个具体点。建议按 P1 → P2 推进,避开 P3 中与马克思研究场景弱相关的大项。

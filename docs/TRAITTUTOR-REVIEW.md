# TraitTutor 深度调研报告

> 调研日期:2026-08-29
> 仓库:https://github.com/traittutor/traittutor(浅克隆 @ 7d73e93,brand-fix)
> 定位:**目标优先(goal-first)的 AI 学习教练** —— 把目标/问题/真实材料变成"证据感知的自适应学习路径"
> 技术栈:Python 3.11 + FastAPI(后端)/ Next.js 16(前端)/ 双语 UI(zh+en)
> 规模:约 1367 文件;后端 pytest ~960 用例 / 174 文件;前端 Playwright 17 spec;9 条 ADR

---

## 一、产品是什么

TraitTutor 把 **一个目标、一个问题、或一份真实学习材料** 转化为**持续自适应学习路径**。学习者零上传即可开始,之后按需添加 PDF/文档/卡片/表格/图片/文本。核心主张:

- **证据感知**:只有**服务端判分、可靠归属**的作答才更新学习证据(BKT 概念掌握)
- **来源锚定**:材料分析快照、概念候选、页级证据都落库可复用
- **可解释**:学习画布同屏展示路径 + 当前组件 + "为什么这步"证据
- **诚实边界**:个性画像"引导组件/节奏/反馈",但**永不变成诊断、能力标签或 BKT 证据**

三种等价起点(目标 / 问题 / 材料)统一收敛到同一数据模型:**Learning Pack(学习包)= 目标 + 材料 + 组件计划 + 学习证据**。

---

## 二、核心架构(数据流)

```text
目标 / 来源 / 问题
   ↓  (注入扫描 → LLM 意图分类,置信度 <0.8 必须用户确认)
LearningPack + MaterialAnalysis(材料分析快照)
   ↓
BKT 概念证据 + 学科支持(SLR) + 材料适配(模态)
   ↓
LearningComponentPlan(14 种组件,确定性调度 + 可选 LLM 重排)
   ↓
全屏 Learning Canvas(路径 / 组件 / 证据同屏)
   ↓
lesson / assessment / retrieval / visual / audio 执行器
   ↓
LearnerEvent → BKT / 知识图谱 / 学习者模型(仅强证据)
   ↓
只重规划"未开始的尾部" → 下一组件
```

两条产品轨道:
- **Learn(学习路径)**:持续学习的默认目的地 —— 课程/测验/检索卡/可视化
- **Assistant(一次性问答)**:研究/分析/解题/写作;Learn 只在分类器高置信度时自动路由,否则给学习者明确选择

---

## 三、五大子系统深度剖析

### 1. BKT 概念掌握模型 —— "诚实的贝叶斯"

**参数**(`learning_model/parameters.py`):`transition/guess/slip/prior` + `version` + `calibrated` 标志。冷启动用明确标注的 `UNCALIBRATED_FALLBACK_PARAMS`(t=0.12, g=0.2, s=0.1, p0=0.2);生产参数来自校准工件 `config/bkt-parameters/current.json`,由 `BKTParameterArtifact` 校验器强制约束。

**更新公式**(`personalization/bkt_math.py`,唯一入口 `learning_model/bkt.py:update_with_evidence`):

```python
predicted  = prior + (1 - prior) * transition          # 先施加学习转换
likelihood = correct ? predicted*(1-slip) + (1-predicted)*guess
                     : predicted*slip + (1-predicted)*(1-guess)
posterior  = likelihood<=0 ? predicted : predicted*(1-slip if correct else slip)/likelihood
result     = clamp(prior*(1-w) + posterior*w)          # 权重 w=1.0 全量更新
```

**强证据单闸门**(`learning_model/events.py:154`):

```python
def is_strong_evidence(event):
    return (event.evidence_strength == "strong"
            and event.attribution_status == "reliable"
            and event.answer_correct is not None)
```

- ✅ 进 BKT:仅 `guided_practice`、`transfer_challenge`(服务端持有标准答案的作答)
- ❌ 永不进 BKT:诊断题、自我报告置信度、阅读/书签/提问/搜索/停留等全部曝光信号(记入账本但 `evidence_strength="exposure"`)
- 纠错只能追加 `LearnerEventAmendment(action="void")`,原始裁决永远可回放

**诚实读策略**(`knowledge_state.py:display_mastery` + `mastery_read_view.py`):
- `calibrated=True` 且观察数 ≥3 → 给出后验 + Wilson 置信区间
- 否则 → `probability=None`,只暴露定性状态(insufficient_evidence / needs_support / developing / supported)
- **时间衰减是纯读投影**(`decay.py`):`effective = prior + (posterior-prior)*exp(-ln2·days/half_life)`,半衰期按知识类型 MEMORY=30/ PROCEDURE=60/ CONCEPT=90/ DESIGN=120 天;**永不写状态**;"最近答错永不向上衰减"

**掌握门**:MEMORY/PROCEDURE ≥0.9(定量);CONCEPT/DESIGN 用 Feynman 式定性解释判定。

### 2. 学习路径生成 —— "确定性调度 + 只重规划未开始尾部"

**14 种组件**:goal_map / concept_explanation / worked_example / visual_map / video_explanation / audio_explanation / diagnostic_check / guided_practice / calibration_checkpoint / retrieval_card / progress_checkpoint / reflection_prompt / transfer_challenge / review_queue;执行器类型 deterministic | lesson | retrieval | assessment | image | video | audio。

**确定性调度**(`LearningComponentSelector.select`,按 BKT 阶段分支):

```
unobserved:    goal_map → concept_explanation → diagnostic_check(可选,永不进 BKT)
needs_support: concept_explanation → worked_example
developing:    guided_practice → calibration_checkpoint
supported:     transfer_challenge → calibration_checkpoint
+ 可选媒体(材料适配) + retrieval_card(必选) + SLR 支持组件 + review_queue
```

**两个结构不变量**(校验器强制):
1. 每个评分评估后**必须**紧跟 `calibration_checkpoint`(元认知置信度校准)
2. 两个评分评估**永不相邻**

**只重规划未开始尾部**(`build_learning_component_plan`):

```python
last_started = max(i for i,item in enumerate(prev) if item.status != "pending")
preserved = prev[:last_started+1]     # 已开始前缀不可变(审计)
# 若前缀末尾是评估,连带保留其后的校准检查点
```

理由:已开始工作是**不可变历史证据**,重写破坏审计;LLM 只重排尾部、确定性选择器保底;计划 supersede 而非覆盖,旧计划保留审计。

### 3. 个性化与记忆治理 —— "引导但不诊断"

**LearnerProfile 五类数据**:preferences(显式/推断/拒绝三态 + 90 天 TTL)、concept_signals(BKT 状态)、strategy_evidence(策略接受/拒绝加权计数,≥3 事件才生效)、understanding(科目汇总)、inference_enabled(全局开关)。

**"不变成诊断"四层代码防护**:
1. payload 敏感字段校验器:硬拒绝 `iq/intelligence/ability/diagnosis/personality_score/learning_style/mood` 键
2. `is_strong_evidence` 单点闸门:曝光信号结构上进不了 BKT
3. 未校准后验序列化置 None(防伪精确)
4. 策略阈值:"当前答错永远 needs_support"(不看后验)

**Reflection/Compass 记忆治理**(四层):Trail(append-only 证据)→ Reflection(proposed→confirmed|rejected|expired)→ Compass(仅编译 confirmed,版本化最小输入)→ 生成快照记录 compass_version/evidence_refs/degraded。Compass 的 prompt 上下文自带边界声明:"Personalization cues adjust teaching strategy only; they do not diagnose or measure ability."

**删除语义 = 追加 void + 全量重放重建**:删除即从审计账本移除信号 + 清空派生状态按剩余信号**从头确定性重放**;内存冻结快照失效后下一会话自动重编。记忆条目状态机 candidate → active|superseded|dormant|deleted,推断事实激活需**用户确认或 ≥2 条独立证据**。

### 4. 编排/网关/安全 —— "一次点击不能变成无界支出"

**Gateway 唯一模型边界**(ADR-0004):GatewayRequest 携带 purpose/user_id/messages/tools;llm_config **仅服务端注入,配置不出服务器**。

**Quota Rotation Policy**(`gateway/quota_rotation.py`):双层有界循环 —— 外层路由(本地模型目录 active profile 去重),内层每路由 ≤2 次尝试;总 deadline 180-240s。配额/认证错误**立即轮换**;timeout/5xx 先同路由重试一次。熔断器 file-backed(连续失败 ≥3 次,cooldown 60s,opt-in)。每次尝试发 `gateway.route_attempt` 审计事件(脱敏:无 prompt/密钥/用户 id,含 cost_picousd)。

**Learn vs Assistant 路由**(`learning/intent.py`):先 5 类注入正则扫描(中英双语,中文模式刻意收紧防误伤)→ 再 LLM 分类器(temperature=0, `{mode, confidence, safety_action}`)→ `confidence<0.80` 或异常 → **fail-closed 回落"请你确认"**,绝不擅自启动学习路径。附件文本只走确定性扫描,**从不进分类器 prompt**。

**needs_review 三态机**(人工质量确认):质量未过关的生成物**可预览/可丢弃/可确认/可重试,但不可保存、不可发布 PageSchema、不可评分**(评分会暴露答案,所以未发布前禁止评分)。Research Workspace 同构。

**组件白名单 + 答案服务端持有**:模型只能产出注册过的组件类型与 props;answer/rubric/back/key 在公共 schema 中物理缺席;页面验证失败 → 确定性文本降级页,体验永不死亡;SVG 被拒(可夹带 script)。

### 5. 前端产品设计

**全屏三栏 Learning Canvas**:左路径侧栏(状态点/Lock/Check,lg 以下折叠为横向滚动条)/ 中组件内容(PageSchemaRenderer 白名单渲染)/ 右学习问答助手抽屉。进入时侧栏无条件折叠(全屏专注),退出时"用户手动展开的偏好胜出"。

**双语策略的分层**(核心):UI 语言纯展示层(react-i18next 双轨:静态文案 i18n + 组件内 `{zh,en}` 映射表);**生成内容语言 = 材料检测语言 > 显式请求**,`detect_material_language` 用 CJK/Latin 字符比例确定性判定(无 LLM)—— "English UI 不强制英文输出中文学习输入"。

**Playwright 全 mock e2e**:`page.route('**/api/v1/**')` 注入 mock JSON,断言精确请求序列(`mutations == ['with-plan']`),不依赖真实 LLM。

---

## 四、9 条 ADR 一览

| ADR | 决策要点 |
|---|---|
| 0001 | 派生工作用持久化租约(CAS + token fencing);下游靠 `event_id+operation` 幂等 |
| 0002 | `LearnerEventLedger` 为事实源,`MasteryReadView` 版本化读视图;公开输出隐藏未校准后验;永不回写 legacy map |
| 0003 | 版本化 `ProductEventEnvelope` + 事件注册表;运营/安全审计/产品分析三类分离;遥测失败不阻塞产品路径 |
| 0004 | Gateway 是唯一模型协议与策略边界;领域 runner 保留结构化解析 |
| 0005 | (被 0008 取代)L3 Markdown 仅展示投影,typed sidecar 存证据元数据 |
| 0006 | 人格是冻结版本化类型化白名单,确定性编译"人格契约",自由文本不进生产 prompt |
| 0007 | ResearchWorkspace 为真值源;Run 状态机服务端持有,先持久化再发布事件 |
| 0008 | 产品用语只准"长期记忆/索引";canonical memory 唯一可回忆来源;历史 Markdown 导入为零置信度候选,需显式确认 |
| 0009 | 统一 `/api/v1/ws`;CapabilityRegistry 确定性策略预检;禁止第二个分类器 |

---

## 五、SAG 教育能力对照与差距

### SAG 已有(12 个教育服务 + 84 路由)

| SAG 能力 | 实现 |
|---|---|
| 学情建模 | `adaptive-learning-service.ts` recordAnswer:答题→knowledge_mastery(加权平滑:对+0.15/错-0.25,阈值 0.7/0.4 分三档) |
| 自适应推送/节奏/分层 | adaptivePush / paceAdapt / layeredTeaching(掌握度→微课/例题/拔高) |
| 六大教育能力 | 学习规划/课程辅导/学情诊断/预习复习/教师备课/学习陪伴(education-service,走 52 步推理+三库检索+OpenViking 记忆) |
| 认知维度/推荐/复习提醒 | student-learning-service |
| 编程/语言教育 | coding-education-service(拆解/辅导/面试/职业)、language-learning-service(阅读/词汇/写作/记录) |
| 教育合规/多模态/资源/评估/反馈 | education-compliance / multimodal / resource-sources / eval / feedback |
| 前端 | EducationPanel / EducationWorkspacePanel / EducationAssetsPanel(33 视图体系) |

### 差距(按价值排序)

**P0 — 值得直接借鉴(高价值/低工作量)**

1. **强证据单闸门 + 事件账本**:SAG 的 `recordAnswer` 由**前端/调用方传 isCorrect**,无归属校验 —— 任何"答题"都能改掌握度。TraitTutor 的 `is_strong_evidence`(服务端判分 + 可靠归属 + 答案非空)三条件 + 纠错追加 void 的模型,直接可移植到 `answer_history` 表。
2. **掌握度诚实读策略**:SAG 用加权平滑 0.15/0.25 猜的常数且**无条件显示百分比**;TraitTutor 的 BKT 公式(30 行)+ 未校准不显示 + Wilson 区间 + 时间衰减读投影,替换成本低。
3. **BKT 离线校准 + 质量门**:SAG 无参数校准;TraitTutor 的 owner 级 5 折 + 约束随机搜索 20k + log-loss/Brier/bootstrap 门,可直接做成脚本跑 SAG 的 answer_history 存量数据。
4. **"只重规划未开始尾部"**:SAG 的 `adaptivePush` 每次全量生成计划;保留已开始前缀 + 计划 supersede 链,改造成本低。

**P1 — 有 SAG 基建可落(中价值/中工作量)**

5. **needs_review 三态机**:SAG 评测/生成已有 evaluate 环节,把"可审查但不附加"接到教育产物生成链(与 SAG 的 education-eval 结合)。
6. **Learn/Assistant 路由 + 注入扫描**:SAG Agent 有 prompt 注入防护,但学习场景无"意图分类 + 低置信度确认"双层;可借鉴中英双语正则 + confidence<0.8 fail-closed。
7. **"答错永远 needs_support"策略**:SAG 有"模糊/未掌握"三档,但无"最近失败优先"语义。

**P2 — 架构级(高价值/高工作量,需独立排期)**

8. **材料分析快照 + 模态适配**:SAG 有材料入库(PDF→md→chunks),但无"学科/难度/页级证据/模态适配"快照。
9. **组件白名单 + 答案服务端持有**:SAG 教育生成物直接进库,无"答案字段物理缺席 + 验证失败文本降级"层。
10. **Quota Rotation 网关**(SAG agent-model-router 已有雏形,可对照补 deadline 预算 + 路由健康熔断)。
11. **Compass 记忆治理**(SAG OpenViking 已有记忆,可补"候选→确认门 + 90 天 TTL + 边界声明随数据走")。
12. **删除即重建**(SAG 无事件账本,需先建账本才有意义)。

---

## 六、落地建议(按序)

1. **立即**:把 `recordAnswer` 升级为"服务端判分 + 归属校验"入口,新增 `learner_event_ledger` 表(append-only + void amendment),`knowledge_mastery` 改为从账本重放重建 —— 一次改动同时获得审计性、纠错能力、可复现性。
2. **第二步**:BKT 参数化 + 校准脚本(用存量 answer_history 拟合,门槛不过就 fallback 未校准参数)。
3. **第三步**:学习计划改"只重规划未开始尾部"(保留前缀 + supersede 链),前端画布加"为什么这步"证据展示。
4. **第四步(排期)**:needs_review 三态机 + 材料分析快照 + 组件白名单。

---

## 七、关键文件索引(TraitTutor 仓库)

| 主题 | 文件 |
|---|---|
| BKT 更新公式 | `traittutor/personalization/bkt_math.py` |
| 强证据闸门 | `traittutor/learning_model/events.py:154` |
| 掌握度读视图 | `traittutor/learning_model/mastery_read_view.py`、`knowledge_state.py` |
| 时间衰减读投影 | `traittutor/learning_model/decay.py` |
| 组件调度 | `traittutor/learning_components.py`(1104-1452) |
| 学习包 | `traittutor/learning_packs.py` |
| 校准流水线 | `traittutor/learning_model/calibration.py` |
| 意图路由/注入扫描 | `traittutor/learning/intent.py` |
| Quota Rotation | `traittutor/gateway/quota_rotation.py` |
| needs_review | `traittutor/generate/service.py:127-133`、`traittutor_generate.py:547-582` |
| 记忆治理 | `traittutor/personalization/service.py`、`traittutor/services/evolution/core.py` |
| 学习画布 | `web/components/learning/LearningCanvas.tsx`(1292 行)+ `canvas-views.tsx`(1752 行) |
| 双语策略 | `traittutor/generate/service.py:1236`(`_resolve_output_language`) |
| ADR | `docs/adr/`(9 条) |

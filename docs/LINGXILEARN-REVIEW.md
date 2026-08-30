# LingxiLearn 深度调研报告

> 调研日期:2026-08-30
> 仓库:https://github.com/LingXi-Org/LingxiLearn(浅克隆)
> 定位:**面向个人学习任务的 AI 学习工作台**
> 核心信条:**Everything is a Skill. State decides next.**
> 技术栈:Python FastAPI + Next.js 16 + PostgreSQL 16 + Python Scheduler + LingxiIdentity(BFF/Logto)
> 规模:31 个教学 Skill · 236 个后端测试 · 8 个 FastAPI router

---

## 一、产品是什么

LingxiLearn 将一次学习请求组织为**持续运行的学习任务**:理解目标 → 读取学习状态 → 选择合适的能力执行 → 根据新学习证据动态决定下一步。

**它不是固定的「意图 → 工作流」系统。** 运行时只规划 **Capability**,再由 Skill Registry 解析到具体 Skill 与 Provider。

```text
Goal → Plan → Act → Observe → Update State → Re-plan
```

## 二、核心架构(单循环图 + 三词汇表分层)

### 2.1 唯一的图(runtime/graph.py)

```
START → interpret_goal → orchestrate → dispatch → observe
      → update_state → evaluate_goal
evaluate_goal ──(runtime_status only)──> orchestrate | await_user | END
```

- 全系统**只有一个图**,边只编码循环形状(plan/act/observe/learn/decide),条件边只读 `runtime_status`
- 图上没有领域概念——新增能力/技能/主题**只改数据不改图**

### 2.2 三词汇表分层(防"能力腐化为 agent 第二个名字")

| 层 | 词表 | 说明 |
|---|---|---|
| 意图层 | `Goal` | 只带 goal_type/topic/knowledge_points,docstring 明言 "Carries no execution plan";goal_interpreter 禁止输出 route/agent/workflow,模型输出中的这些字段被强制删除 + 测试守护(`test_no_fixed_routing.py`) |
| 规划层 | `Capability` 枚举(24 tag) | 词表外 tag 是**硬错误**(UnknownCapability),不是新的隐式路由 |
| 执行层 | `Provider` 名 | 唯一 name-keyed 查找,不 consult 学习者说了什么 |

### 2.3 确定性候选生成 + 模型只能重排(核心创新)

- **确定性一半**(runtime/candidates.py):对每个 skill 的 capability × subject 算候选——前置条件检查(关于状态而非意图)+ 收益估计(纯函数规则打分)+ `utility = gain/cost` + 确定性排序
- **模型一半**(runtime/orchestrator.py):候选列表打包给 LLM,**禁止发明列表之外的动作**;每个任务必须提交 `candidate_id`(绑定 skill/provider/version/checksum);验证层不匹配即整轮作废
- **"provider 返回 ≠ 任务完成"**:声明式 `done_when` 谓词(artifact_exists/evidence_observed/profile_reaches/quiz_graded…),不满足 → incomplete → 循环重规划

## 三、GoalStack 目标栈(路由可撤销)

```python
@dataclass(frozen=True)
class StackOperation:
    op: str          # push | pop | replace | abandon
    before: list     # 操作前完整栈快照
    after: list      # 操作后完整栈快照
    reason: str
```

- **push**=打断(压住旧目标)/ **pop**=达成(标记 SATISFIED 不删除)/ **replace**=纠偏(换掉,保留 id)/ **abandon**=放弃
- **撤销路由决策 = 事件重放**:每次操作同事务写入 `agent_task_state_events`(sequence/before/after/reason),撤销 = 重放到某事件前的 `before` 快照——"不是猜测,是重放"
- 每个操作带 `reason`("纠偏:...""打断:...")使路由变更可审计

## 四、RuntimeStatus 闭环状态机

```
PLANNING → EXECUTING → OBSERVING → UPDATING → REPLANNING →(回到 PLANNING)
    ↘ WAITING_FOR_USER ↘ COMPLETED / FAILED(终止, 无出边)
```

- 闭式转移表(`_TRANSITIONS` dict),非法转移抛 `IllegalTransition`
- **唯一写路径** `transition_status()`:以数据库当前状态为源(非图 checkpoint),先落库再出 patch,杜绝双写漂移
- 任何时刻读到 runtime_status 都保证循环有合法下一步(或已终止)

## 五、证据系统(append-only 账本 + 唯一写入者)

- `EvidenceRecord`:8 种信号(CORRECT/INCORRECT/NO_ANSWER/SELF_REPORT/DWELL_TIME/ERROR_PATTERN/ARTIFACT_VIEWED/HINT_USED)——"行为观察,绝不是评判";仅 3 种 graded 信号带分数驱动 mastery
- **内容寻址去重**:`digest = sha256(kp, signal, score, locator, payload)`,同观察重复追加自动坍缩
- **Agent 只能说证据,不能说档案**:learning_evidence 表无 update/delete 路径;profile 唯一写入者 StateUpdater;`ProfileDelta` 强制要求 `evidence_ids` 非空(`UnsourcedProfileWrite` + 测试守护)
- **双水位投影**:全局游标 + 每知识点 last_evidence_seq,增量折叠精确
- **刻意保守**:一次高分观察只算 `needs_recheck` 而非 `demonstrated`;误区只能被"零提示 + ≥0.9 正确作答"退役

## 六、教学 Skills(差异化核心)

### 6.1 adaptive-pedagogy — LLM 内核 + 确定性基线双轨

9 种策略,每轮只选一个主策略;确定性路由规则(`decide_action.py`):

```
model_challenge → learner_model_challenge
support_choice == direct_explain → targeted_explanation
checkpoint && verification_debt → transfer_check
correct == True → advance
correct == False && stable_rule && confidence >= 0.7 → conceptual_conflict
correct == False && (attempts >= 2 || hint_level >= 2) → worked_example_fade
correct == False → progressive_hint
默认 → retrieve_or_predict
```

**verification_debt(验证债务)**:强帮助后不立即盘问,记账推迟到自然检查点——贯通 4 个 skill(adaptive 记账/reflector 提案/retrieval 出题还债/eval 检查还债)。

### 6.2 quiz-generator — 私有证据图防"考没讲过的"

- 先建私有证据图:`概念 → 已讲授的事实/关系/例子/误区`;**任何落不了图的内容不出题**
- 材料稀疏 → 更少更安全的题 + assumptions 记录;历史日期/轶事不自动变考点
- 干扰项来自六种真实近错(反转/相邻/漏条件/越边界/表面相似/过度泛化)
- **答案隔离**:公开快照程序化删除 answer/explanation/keywords(`quiz_contract.py sanitize`)

### 6.3 learner-state-reflector — 提案模式

- `state-write-mode: proposal-only`:**只返回提案,host 决定是否写入**
- 非阻塞后台运行,记忆压缩移出学习者关键路径;失败降级保留原始事件

### 6.4 curriculum-graph-builder — 增量补丁

- 8 种规范关系(prerequisite_of/foundation_for/part_of/leads_to/applies_to/contrasts_with/commonly_confused_with/related_to)
- **只增不删**:v1 禁止删除节点/边,Skill 永不重写全图,只回 `add/update + base_revision` 补丁交 host 单事务合并

### 6.5 skill-eval-harness — 四层评测

| 层 | 维度 |
|---|---|
| component | frontmatter 完整性/必需输出字段/已知结果契约/产物形态 |
| trajectory | learner-facing writer ≤1/无意外交接/无新证据不重复提问/预算 |
| pedagogy | 答案泄露扫描/证据接地/提示数上限/问题价值门控 |
| learner_outcome | 独立迁移通过/前后测增益/verification_debt 解除/可追溯 |

**not_observed ≠ pass**:缺失层显式报告,不静默当成功;`required_layers` 可把"独立迁移证据"变成硬门。

## 七、API 与前端

- **SSE 从持久化事件日志重放**(非实时流):单调 sequence + Last-Event-ID 精确续传,断连零成本;"中断是持久化线程状态,绝非阻塞 await"
- 交互 outbox 单事务:答案提交+状态转移+公共事件同一事务,公共状态不可能矛盾
- 双状态投影:runtime_status + 派生 turnStatus/threadStatus;PublicProjector denylist 过滤(reasoning/api_key)
- 前端 V1 极简(4s 轮询代替 SSE),依赖方向铁律 app→features→entities→shared(dependency-cruiser 强制)

## 八、SAG 对照差距(可落地项)

### P0 — 直接借鉴(高价值/低工作量)

1. **verification_debt(验证债务)机制**:SAG 间隔复习有 needs_repair,但无"强帮助后记账、推迟到自然检查点、独立题还债"的完整概念链
2. **closed 状态转移表 + IllegalTransition**:SAG agent 任务状态无闭式转移校验;learning-plans 组件状态机有依赖校验但无全局状态机
3. **证据内容寻址去重**:SAG 事件账本用幂等键,可补 digest 内容寻址(同观察重复追加自动坍缩)

### P1 — 有基建可落(中价值/中工作量)

4. **`not_observed ≠ pass` 评测纪律**:SAG education-eval 12 项,可补"缺失层显式报告不抬分"
5. **proposal-only 状态写入**:SAG 执行器产物已走 needs_review 三态机(同哲学),可补"状态更新提案"模式
6. **SM-2 形状 review_priority 单尺子**:SAG spaced-repetition 已有间隔序列,可补 `0.45×逾期+0.35×薄弱+0.20×不确定` 的复习优先级打分

### P2 — 架构级(需排期)

7. **三词汇表分层(Goal/Capability/Provider)**:SAG 是意图路由(education_intent),LingxiLearn 是能力规划——重构成本高
8. **Skill Registry 动态化**:SAG 技能 190+ 但无"capability tag + candidate_id 绑定"的规划语义
9. **单循环图 + 唯一状态写路径**:SAG 多服务各自管理状态,统一为循环图是大工程

---

## 九、最值得借鉴的 5 个设计(综合)

1. **三词汇表分层 + 封闭 Capability 词表**——意图/规划/执行彻底分离,词表外 tag 硬错误,能力永不腐化为 agent 第二个名字
2. **确定性候选生成 + 模型只能重排**——candidate_id 绑定 skill/version/checksum,dispatch 精确回找,防幻觉三合一
3. **声明式 done_when**——"provider 返回 ≠ 任务完成",上一步产物推翻下一步计划成为结构化机制
4. **GoalStack 可撤销路由**——push/pop/replace 各带 before/after 快照,撤销=重放
5. **LLM 内核 + 确定性基线双轨决策**——同一套教学策略规则既有可测试的 Python 基线又有 LLM 策略内核,决策逻辑永不漂移

## 十、关键文件索引

| 主题 | 文件 |
|---|---|
| 唯一循环图 | `server/lingxilearn/runtime/graph.py` |
| Capability 词表 | `server/lingxilearn/state/capabilities.py` |
| GoalStack + 状态机 | `server/lingxilearn/state/agent_task_state.py` |
| 候选生成 | `server/lingxilearn/runtime/candidates.py` |
| 计划编排 | `server/lingxilearn/runtime/orchestrator.py` |
| 证据系统 | `server/lingxilearn/state/evidence.py` |
| StateUpdater | `server/lingxilearn/runtime/state_updater.py` |
| 教学策略内核 | `skills/adaptive-pedagogy/references/strategy-kernel.md` |
| 策略基线脚本 | `skills/adaptive-pedagogy/scripts/decide_action.py` |
| 出题规则 | `skills/quiz-generator/references/quiz-design-rules.md` |
| 四层评测 | `skills/skill-eval-harness/references/rubric.md` |

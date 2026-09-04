# OpenSquilla → MarxSphere 差距分析(Apache-2.0, 可移植参考)

> 2026-09-04 · TokenRhythm/opensquilla ★6911 · Python · Apache-2.0
> 参考: C:\Users\HUAWEI\opensquilla-main(23MB 已下载)
> 定位: token 高效 AI Agent("同预算更多能力"), SquillaRouter + 微内核 + MetaSkill

## 一、六大机制差距(按价值排序)

### 1. 模型路由是"可训练闭环"而非"开环轮换"【高】
| | OpenSquilla | MarxSphere |
|---|---|---|
| 选模型 | **本地 LightGBM(390 维特征)+ ONNX MLP 双头融合**把每轮分 R0-R3 四档 → 每档绑最便宜够用模型;降级到启发式→默认档 | llm-common rotation 规则/随机轮换(开环) |
| 特征 | 8 通道 390 维:手工 51 + TF-IDF + 上下文 + 轨迹 + BGE 嵌入 + 助手信号 | 无 |
| 护栏 | 6 层后处理(margin/安全网/flag/context/sticky tier)+ 引擎 8 策略 | 有熔断,无档位 |
| **数据飞轮** | 推理特征入库 → 用户 👍👎 → 离线对齐造隐式标签 → 重训 → 冻结 golden 集 promote → **上线后回归自动回滚**(complaint-rate/downvote-rate 超阈回滚) | **无**(开环) |
| 关键洞察 | **KV-cache 感知**:降档省 token 但打爆 prompt cache 反更贵 → sticky tier/anti-downgrade | 轮换未考虑 cache |

### 2. 单结果工具压缩 + 按需取回【高】
- 压缩**单次工具结果**(上下文最大杀手),非整体对话
- runtime view(审计)与 provider view(给模型看的)分离
- 大结果移出上下文 → `ToolResultStore`(gzip, handle `tr-<32hex>`)→ 模型拿小预览 + `retrieve_tool_result` 工具**按需精确取回**(行号/测试名/原始切片)——防截断丢信息,提示模型不要臆测
- 模式:truncate(结构化 JSON 投影)/ summarize(语义)

### 3. KV-cache 感知档位保持【高】
缓存基座前置、易变内容靠尾 + 路由 anti-downgrade(KV 窗口 600s 不降档)——把缓存命中损失纳入轮换决策。MarxSphere 若用 API 级 prompt caching,值得照搬。

### 4. MetaSkill = 声明式 DAG 工作流【高】(技能/场景层最大差距)
- 元技能 = SKILL.md + `composition.steps` 声明 DAG;6 步型:agent/llm_chat/llm_classify/user_input/tool_call/skill_exec;`depends_on` 并行、`route:` 条件路由、`on_failure:` 备胎
- **执行顺序/门控/暂停/重试由运行时强制**(asyncio 拓扑调度),非模型自律
- 46 步论文写作 DAG 示例:收集→澄清表单→检索→逐节 agent 写作→拼接→LaTeX 消毒→篇幅门→引用门→质量门
- **技能自我进化**:auto_propose 从会话日志发现高频共现 → proposal → 人工 accept
- vs MarxSphere 65 场景 = 提示词流程(编排在模型头脑)

### 5. 记忆 Dream 巩固【中高】
回合捕获 → 证据门控 → 确定性评分(频率/信号/来源/跨天)→ LLM 生成补丁 → **人工可审 MEMORY.md 提升**(quarantine/收据/水合)+ 压缩记录 repair 联动。

### 6. B5 融合(难档多模型互证)【中】
难档(c3)= 4-5 模型各成稿 + 1 aggregator 融合;阵容按 slot 评分(质量/亲和/多样性/成本/角色);**proposer 永不持工具边界**(只有 aggregator 能调工具,防放大副作用)。MarxSphere 的 rotation 若只是主备切换,此为升级方向(需验证成本账)。

## 二、可借鉴最小切口(按 ROI)
1. **工具结果压缩+按需取回**(直接移植,高收益:日志/网页/搜索长输出)
2. **路由决策日志 + "用户抱怨=上次选错"对齐 + 小样本重训 + 自动回滚**(轻量闭环)
3. **1-2 个高频场景改写成 MetaSkill DAG 试点**(编排从模型头脑搬到运行时)
4. **拖拽上传加暂存语义**(file_uuid 短命→回合接受逐出→失败重试;直接升级刚做的批量上传)
5. **路由诊断面**(每轮可见 tier/置信/节省 %,observe-only 灰度)

## 三、参考文件索引
- 路由: src/opensquilla/squilla_router/.../router/{predictor,features}.py · engine/routing/{policy,heuristic}.py
- 飞轮: squilla_router/self_learning/{alignment,train,evaluate,promotion,feedback}.py
- 工具压缩: engine/result_budget.py · engine/tool_result_store.py
- MetaSkill: docs/authoring/meta-skills.md · src/opensquilla/skills/meta/
- 记忆: docs/features/memory.md · memory/{turn_capture,dream}
- 上传: docs/features/attachment-drag-upload-spec.md
- 压缩: session/compaction.py · engine/steps/prompt_cache.py

## 四、结论
OpenSquilla 与 MarxSphere 同做"多模型+记忆+技能"Agent,但它在**路由智能化(本地模型+数据飞轮)与工具结果压缩**上领先,MetaSkill 则给场景编排提供运行时强制范式。Apache-2.0 可直接移植参考。建议按"最小切口"逐项推进,先做工具结果压缩(高收益低风险)。

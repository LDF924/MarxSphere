# OpenSquilla 差距移植报告

> 2026-09-05 · 按 docs/OPENSQUILLA-GAP-ANALYSIS.md 最小切口(ROI)序逐项完成
> 参考源码: TokenRhythm/opensquilla ★6911(Apache-2.0, C:\Users\HUAWEI\opensquilla-main)
> 全部实现为自写 TS 代码, 未复制 Python 源; 提交已同步 SAG-open-source 并 push GitHub(LDF924/MarxSphere)

## 总览

| # | 项 | 状态 | 实现文件 | Commit |
|---|---|---|---|---|
| 0 | 批量上传双模式验证(前置, 代码已在 open) | ✅ | BatchUploadPanel.tsx 验证 + yaml 依赖修复 + p2o-deps-fix 增强 | 52389c1 |
| 1(2a) | 工具结果压缩 + 按需取回 | ✅ | src/services/tool-result-store.ts + agent-tool-router.ts | c87e878 |
| 2(2b) | 路由决策日志 + 用户抱怨对齐 | ✅ | src/services/routing-log.ts + llm-common.ts + agent-feedback.ts + agent-exec-log.ts | 0bc2c7d |
| 3(2c) | MetaSkill 声明式 DAG 试点 | ✅ | src/services/meta-skill-runtime.ts + meta-skill-defs.ts + server.ts + web/src/components/MetaSkillPanel.tsx + App.tsx | b36671c |
| 4(2d) | 拖拽上传暂存→提交两步语义 | ✅ | web/src/components/BatchUploadPanel.tsx(重写为状态机) | 895b927 |
| 5 | 移植报告 | ✅ | docs/OPENSQUILLA-PORT-REPORT.md(本文件) | — |
| 6 | KV-cache 感知档位保持 | ✅ | src/services/agent-model-router.ts(routeAgentModel 加 sticky tier) | abc0691 |
| 7 | 记忆 Dream 巩固闭环 | ✅ | src/services/dream-consolidation-service.ts + server.ts + web/src/components/DreamPanel.tsx | 7b48932 |
| 8 | auto_propose 技能进化 + 技能体检 | ✅ | src/services/skill-auto-propose.ts + agent-skill-distill.ts(minResultChars) + server.ts | a1b08ed |
| 9 | B5 难档多模型互证融合(试点) | ✅ | src/services/b5-ensemble-service.ts + b5_ensemble 工具 + docs/OPENSQUILLA-B5-COST.md | 302a940 |
| 10 | auto_propose→MetaSkill DAG 衔接 | ✅ | src/services/meta-skill-propose-service.ts + 迁移100 agent_meta_dags + defs 动态合并 | (第三批) |
| 11 | Dream 巩固定时触发 | ✅ | src/index.ts 每日调度 + dream-consolidation.startDreamDailyScheduler | (第三批) |
| 12 | B5 迷你评测(3题子集) | ✅ | 证据入 docs/OPENSQUILLA-B5-COST.md §6(3:0 全胜) | (第三批) |
| 13 | 路由诊断面(差距最小切口⑤) | ✅ | routing-log.routingDiagnostics + API + web/src/components/RoutingDiagPanel.tsx | ad098c3 |
| 14 | SKILL.md 全量技能体检(机制5) | ✅ | skill-import-service.healthCheckAllSkills + API + AgentConsole 体检卡片 | 3579281 |
| 15 | WriterLease/ChangeSet/锚点批注(最小) | ✅ | 迁移101 + src/services/doc-session-service.ts + API(acquire/apply/anchors) | (第四批末) |
| 16 | 技能语义分类审计(做法vs记忆) | ✅ | skill-import-service.classifySkillSemantics + API semantic-audit | (第五批) |
| 17 | meta_invoke/meta_list 运行时触发 | ✅ | agent-tool-router(2 工具) + user_input 字段 LLM 抽取兜底 | (第六批) |
| 18 | KV-cache 命中观测+sticky 实证 | ✅ | routing-decisions 落盘 cacheHitTokens + 诊断聚合 cacheRate; 实证 93.8% 命中/换模型归零 | (第七批) |
| 19 | 体检引用解析三态化 | ✅ | resolveScriptRef found/env/missing(跨包+仓库根+占位符豁免) | (第七批) |

工具性: sync-open.mjs 支持 `--msg` 自定义功能名提交(4131629)。
第二批(KV-cache/Dream/auto_propose/B5)为差距文档六大机制第 3/5/4(后半)/6 项, 全量单测 681 项通过; 第三批后 684 项; 第四批(WriterLease 等)后全量 688 项通过。

---

## 逐项实现 + 冒烟证据

### 1. 工具结果压缩 + 按需取回(参考 engine/tool_result_store.py + result_budget.py)

**实现**:
- `src/services/tool-result-store.ts`(新): 工具输出 >6000 字符(TOOL_RESULT_CHAR_THRESHOLD)时 gzip 存 `data/tool-results/tr-<sha256前32>.json.gz`, 7 天保留(每次写前清理过期), 内容寻址去重 + 原子写(tmp+rename); 单条 >8MB 拒存返回截断说明; 返回给模型的文本 = 小预览(400 字符) + 句柄 + 取回说明(提示模型"绝不臆测缺失内容, 需要时调 retrieve_tool_result")
- 取回支持三模式: 全文(超阈值引导分块防二次压缩死循环)/ 行窗口 `lines="1-200"` / 关键词聚焦 `keyword` ±context(默认 3 行, 上限 10 行/200 行); sha256 校验一致性; 非法/过期句柄明确报错
- 接入点: `agent-tool-router.ts` `executeAgentTool` 成功返回处(所有工具统一经过, 单点覆盖全局)——`storeLargeResult` 后模型拿到压缩视图; 工具清单注册 `retrieve_tool_result`(run 处理器直接调 store)
- 存储失败降级: 不阻塞执行, 截断末尾 6000 字符给模型
- 测试隔离: `SAG_TOOL_RESULT_DIR` 环境变量重定向目录

**冒烟证据**:
- 单测 `test/tool-result-store.test.ts` **9/9 通过**: 小结果原样不包装 / 大文本 20032 字符→720 字符视图(含句柄)→取回逐字节一致 / 行窗口 10-12 精确 / 关键词 k150 ±3 行 / 未命中提示 / 非法句柄 / >8MB 拒存 / 过期清理(8 天后记录消失+取回报"已过期")/ parseLineRange
- 实测(agent-tool-router 直调): attachment_read 返回 20032 字符 → 视图 720 字符(句柄 tr-d30e… 落盘 1.5KB gzip)→ retrieve 关键词 k150 命中带行号上下文 / 行窗口 5-7 精确 / 全量取回引导行窗口分块 / 未命中关键词给出全文行数提示
- 回归: agent-tool-router.test.ts 41→42 全过

### 2. 路由决策日志 + 用户抱怨对齐(参考 SquillaRouter 数据飞轮, 轻量版不做 ML)

**实现**:
- `src/services/routing-log.ts`(新): JSONL 追加 `data/routing-decisions.jsonl`; 决策字段 {ts, role, model, tier(cheap/standard/strong/other 由模型名推断), contextTokens(消息粗估), attempts, retried, ok, errorType, ms, purpose}; 低估率统计 `routingUnderestimateStats`(underestimate/decisions, 阈 0.15 → flagged, observe-only 不自动改路由); `trimRoutingLog`(>5MB 按 7 天裁剪); pool 动态导入, 模块顶层零 DB 依赖
- 接入点: `llm-common.ts` `callLlmWithRotation` 每个候选模型尝试成功/失败各记一条决策
- 对齐: `agent-feedback.ts` 负评 → `logUnderestimateSample`: 查 exec_logs 该任务最近模型, cheap 档 → 记 `underestimate`("用户抱怨 = 上次选便宜了"), 否则记 `negative_feedback`
- 配套: `logAgentExec` 增加 model 字段回填(迁移 076 已有 model 列), `callLlmInner` usage 采集处回填实际模型——负评才能查到用过的模型

**冒烟证据**:
- 单测 `test/routing-log.test.ts` **7/7 通过**: 档位推断 / 上下文粗估 / 决策落盘字段完整 / 低估率 2/6=1/3 超阈 flagged / trim 小文件不动 / 便宜档 counted=true 强档 false / 非低估负评也落盘带 note
- 实测: 真实 callLlmWithRotation(配置错误触发全链失败)→ jsonl 依次 3 条决策(qwen-plus standard / deepseek-v4-flash cheap / deepseek-v4-pro strong, 各带 errorType=auth); 插入 flash exec_log + 提交负评 → jsonl 追加 `underestimate`(model=deepseek-v4-flash, tier=cheap); 冒烟数据已回滚(任务反馈/规则/exec_log/jsonl)
- 回归: llm-call-policy 10 项全过

### 3. MetaSkill 声明式 DAG 试点(参考 docs/authoring/meta-skills.md)

**实现**:
- `src/services/meta-skill-runtime.ts`(新): 步骤 6 型 `agent`(复用 SAG 综述能力)/ `llm_chat` / `llm_classify`(闭集)/ `user_input`(澄清表单)/ `tool_call`(executeAgentTool)/ `llm_gate`(质量门 JSON 判定); `depends_on` → DFS 拓扑排序(带环检测); `route` 条件路由(`==`/`contains`/存在/非 四种表达式); `on_failure` 单步备胎(约束: 备胎无依赖无嵌套); 模板引擎 `{{inputs}}/{{user.x}}/{{outputs.x|slice(n)}}/{{user.x || '默认'}}`; `final_text_mode`: auto/raw/step:<id>; 校验器 `validateMetaSkill`(引用完整性/闭集/备胎约束); liveRuns 注册表支持 user_input 挂起 → `resumeMetaSkillInput` 续跑(10 分钟窗口)
- llm_gate 判定不过 → 走失败语义触发 on_failure 备胎; 备胎输出顶原步骤, 原步骤 stepLog 诚实标 failed
- `src/services/meta-skill-defs.ts`(新): 试点场景 = S51 文献综述改写 DAG: clarify(user_input 3 字段)→ retrieve(agent 检索)→ draft(llm_chat 结构模板综述)→ citation_gate(llm_gate 引用检查)→ draft_retry(llm_chat 备胎返工补引用)
- API(server.ts): `GET /api/meta-skill/list` / `POST /run` / `GET /progress` / `POST /input`
- 前端: `web/src/components/MetaSkillPanel.tsx`(新, 独立工作台视图 "MetaSkill DAG"): 技能选择/主题输入/运行 → 步骤徽章实时亮起(运行/完成/失败/等待输入分色)→ waiting_input 弹澄清表单 → 提交续跑 → 最终产出展示

**冒烟证据**:
- 单测 `test/meta-skill-runtime.test.ts` **12/12 通过**: 模板渲染(含默认值/slice/未渲染标记)/ 条件表达式 / 拓扑序+环检测 / 校验器引用错误 / extractJson 裸-围栏-尾部杂文本-无 / 全步骤跑通(备胎不主动跑)/ gate 判 fail→备胎顶替输出 / 主步骤抛错→备胎成功整体 done / 备胎也失败→failed / user_input 预填跳过 / 超时 failed / resume 真实通道(挂起→提交→续跑完成)
- 真实端到端(全 LLM+检索): 主题"资本下乡对农村集体经济的影响研究综述" → 5 步按序执行, **citation_gate 真实判定失败**(缺多作者交叉验证)→ **draft_retry 备胎自动重写 5963 字** → done; 产出为结构化综述(研究缘起/发展脉络… 带 张社梅等2024 等来源标注)
- API 实测: list 返回技能定义; run 返回 runId; progress 逐步显示 5 步状态; input 提交后续跑(等待字段 topic/years/focus 正确弹出)

### 4. 拖拽上传暂存→提交两步语义(参考 docs/features/attachment-drag-upload-spec.md)

**实现**(BatchUploadPanel.tsx 整体重写, 以 2d 增强覆盖待办1 双模式最终形态):
- 显式文件状态机 `staged → parsing → parsed_ok | parsed_err → submitted`(对齐 spec 的 staged/uploading/ready/failed/sendable 语义)
- **暂存**: 拖入/选择仅读取 base64 置 staged, 不自动解析(贴合"文件先传/解析暂存, 用户确认后才处理"); 空文件/超 40MB 拒绝并提示
- **解析**: 单项"解析"按钮 / "批量解析暂存"; 失败置 parsed_err 显示原因, 可**单独重试**(↻)不拖累其它, 或"重试失败(N)"批量
- **提交前确认**(两段式核心): "确认提交(N)…"弹确认层, 列出全部待提交文件清单+字数, P2O 模式提醒非 PDF 将被跳过(可切直接入库), "返回修改"可回退
- 提交后 submitted 状态徽章, "清空已完成"收拾
- 双模式保留: P2O 深度加工(逐文件 POST /api/p2o/tasks)与直接入库(uploadDocument)
- 提交失败文件计入 failedList 留在列表可重试

**冒烟证据**:
- 前端 typecheck 通过 + vite build 成功 + bundle 校验含全部新文案("批量上传·暂存·提交"/"确认提交"/"批量解析暂存"/"重试失败")
- 底层 API 均已在前置验证: POST /api/p2o/tasks 201+queued→completed 6 步; /api/files/batch-parse; /api/documents/upload

---

## 与既有系统的融合点

| 能力 | 融入位置 |
|---|---|
| 工具压缩 | executeAgentTool 唯一出口 → 覆盖全部 agent 工具(任务/工作流/主动研究/评审/MCP) |
| retrieve_tool_result | buildAgentTools 工具清单(LLM 动态选工具可见), 注册进 toolRegistry |
| 路由日志 | callLlmWithRotation(每个候选) + callLlm 全部收敛点 |
| 低估对齐 | submitAgentFeedback(负评) + exec_logs.model(回填) |
| MetaSkill | 场景 S51 声明式化; 运行时独立服务; 前端独立工作台视图(33→34 视图) |
| 暂存提交 | BatchUploadPanel(文献库内嵌) — 前端纯状态机无后端改动 |
| KV-cache 档位保持 | agent-model-router.routeAgentModel(routeAgentModel 内部登记 sticky); plan/reflect 调用登记 taskId 档位 |
| Dream 巩固 | task_experience 扫描(query 列归一聚合); strategic_memory 落库(source=agent); 前端 DreamPanel 视图 |
| auto_propose | task_experience 高频聚合 + agent_skills 覆盖判定 + agent-skill-distill.proposeSkill(EDV 异步) |
| B5 融合 | b5_ensemble 显式工具(proposer 零工具); 默认 B5_ENABLED=0 不触全局路由 |

## 第二批实现 + 冒烟证据(差距文档六大机制第 3/4/5/6 项)

### 6. KV-cache 感知档位保持(sticky tier / anti-downgrade, abc0691)
**实现**: `agent-model-router.ts` `routeAgentModel` 落档前查 sticky——上下文(key=taskId 或 _global 近似)在 `AGENT_TIER_HOLD_MS`(默认 600s)内见过更高档 → 不降档(保 prompt cache: 同前缀换模型 = 全量重算); sticky 只升不降(强模型调用登记, cheap 调用不覆盖); plan/reflect(agent-task-service)实际模型登记; env 可关(KEYED_ONLY=1 仅显式 key; HOLD_MS=0 关闭)
**证据**: 单测 5 项(档位推断/只升不降/strong 上下文 retrieve 不降档/过期清理/TTL 边界/userModel 覆盖); 冒烟: 同任务先 strong 后 cheap 步骤 → 日志明确打出"V404-6 sticky 保持: cheap → strong", retrieve 路由到 pro 而非 flash; 对照新任务正常 cheap

### 7. 记忆 Dream 巩固(回合捕获→证据门控→评分→打磨→人工审提升, 7b48932)
**实现**: `dream-consolidation-service.ts`(新): 扫描 task_experience 30 天(query 列, 归一聚合 ≥2 次) → 证据门控(负评模式直接拦, 扫描层+评分层双保险) → 确定性评分(频率 log1p + 跨天跨度 + 正评信号, 标定: 2次/1天=0.37 拦, 6次/5天/正评=1.0) → 打磨(确定性断言式 或 LLM 可选) → proposals 隔离区(data/dream/proposals.jsonl); **人工可审**: accept → 写 strategic_memory(回执 receipt)→ reject → quarantine 隔离区 → rollback 可回滚删除+流水
**证据**: 单测 7 项(归一化/评分标定/负评硬拦 0/确定性打磨/空库降级/不存在 id/无回执回滚报错); **真实链路**(283 条 task_experience 数据): run 产出 10 候选(最高 22次/21天) → accept 落库 strategic_memory#6(回执) → rollback 删除归零; 前端 DreamPanel 独立视图(待审/隔离/回执/回滚按钮)
**注**: DB schema 适配(query 列非 goal; task_experience 无 task_id; strategy 为 jsonb → ::text)

### 8. 技能自我进化 auto_propose + 技能体检(a1b08ed)
**实现**: `skill-auto-propose.ts`(新): 扫描高频任务(≥3次/7天, query 聚合) → **二元字符组重叠覆盖判定**(免中文分词, ≤4 字走包含)对照 approved 技能 → 未覆盖 → proposeSkill 自动蒸馏(带高频上下文)→ EDV 异步验证 → 技能库人工审(既有 UI); `skillHealthCheck` 体检(空名/缺 when/skill_md<20/非 manual 无来源); proposeSkill 支持 minResultChars 可配(默认 200 保轨迹, auto-propose 60)
**证据**: 单测覆盖判定(覆盖/未覆盖/短词包含/空目标); **真实链路**: 14 天 3 条高频任务(5× 论文直接原因/5× 小农户间接效应) → 自动蒸馏 2 提案("多跳归因推理"/"论文因果机制提取", pending)→ EDV 验证; 体检 total 8 broken 0; 冒烟产物已清理
**坑**: task_experience.strategy 是 jsonb(SQL 需 ::text); max(id) 与 id 类型不匹配(uuid)改用 array_agg

### 9. B5 难档多模型互证融合(试点, 302a940)
**实现**: `b5-ensemble-service.ts`(新): 默认 **B5_ENABLED=0 关闭**(不自动改全局路由红线); 显式 `b5_ensemble` 工具: N 模型(squad 默认 pro+max+flash cheap 锚点)并行成稿(纯文本, **proposer 零工具边界**)→ aggregator 单次调用融合(共识为主+分歧说明, 不引入新事实); 降级链: 单模型成功直接返回不融合, 全败抛错; 成本估算暴露(字符/2 估 tok, 输入 0.5 输出 2 元/1M); 成本账文档 [OPENSQUILLA-B5-COST.md](OPENSQUILLA-B5-COST.md)(放大 4-6×、ROI 判定表、实施红线)
**证据**: 单测 3 项(默认关闭红线/阵容含 cheap 锚点/服务面); 实测 B5_ENABLED=1: 真实 3 模型调用 → qwen3.7-max 失败但 **pro+flash 两稿融合成功**(含分歧说明, 输出正确劳动二重性阐述), 成本 ≈0.005-0.01 元量级
**红线落实**: 成稿模型不碰 executeAgentTool/检索(服务内只 callLlmWithRotation); 默认关闭; 每次暴露 costCentsEst

## 决策留档(执行纪律: 不阻塞, 已按合理默认)

1. 压缩阈值 6000 字符(参考 OpenSquilla 8KB, 结合本项目中文场景取更低值便于早触发)
2. 低估降权实现为 observe-only 统计(flagged 输出诊断), 未自动改路由权重——需人工确认默认档映射
3. MetaSkill 试点选 S51(文献综述)为 spec 指定场景; 步骤并行执行未做(串行拓扑, 注释留待后续)
4. user_input 挂起为进程内注册表(服务重启丢失)——试点够用, 持久化留后续
5. 批量上传暂存为内存态(刷新页面即失), 未做后端 file_uuid 暂存区——贴合本项目"解析预览确认"语义
6. KV-cache sticky 默认 key=_global 近似(单用户场景 ≈ per-task), KEYED_ONLY=1 可切显式 key; 未接真实 cache 命中率(需数据积累)
7. Dream LLM 打磨默认关(确定性断言式已可用, 控成本); 高频问答类 query 是否值得沉淀交由人工 accept 把关(rollback 兜底可纠正)
8. auto_propose 产出 agent_skills(既有技能库)而非 MetaSkill DAG——衔接改造留后续
9. B5 默认关闭 + 显式工具 opt-in; aggregator 也纯文本(比原版更保守, proposer 零工具红线落实); 成本口径为估算, 真实账单需 provider 用量

## 遗留与后续建议

- 路由: KV-cache 档位保持已做(6), cache 命中率观测未接(提供商 usage.prompt_cache_hit_tokens 已有采集——可加面板); 路由诊断面已做(13)
- Dream: 每日定时已接(11); LLM 打磨为可选默认关(确定性足够, 控成本)
- MetaSkill: auto_propose→DAG 衔接已做(10: 提案隔离区→accept 注册 agent_meta_dags 动态可跑); 更多场景 DAG 化留后续
- B5: 迷你评测已做(12: 3题全胜); 扩大评测集验证后决定是否放宽默认; aggregator 接工具检索为下一步(proposer 仍零工具)
- SKILL.md 体检已做(14): 检出的问题(paper-writer 重复名/academic-paper 引用缺失)待人工清理
- 暂存语义后端化: 若要跨刷新保留, 参考 spec 的 file_uuid + TTL 模式
- 架构级已做最小版(15): 文档级 WriterLease(fencing)+ ChangeSet(乐观锁/原子)+ 文本锚点重映射; 全量制品会话(制品blob/多修订史/回滚恢复)留后续
- 技能=做法/记忆=事实全量梳理(190+ 技能分类审计)留后续

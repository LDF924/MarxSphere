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

工具性: sync-open.mjs 支持 `--msg` 自定义功能名提交(4131629)。

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

## 决策留档(执行纪律: 不阻塞, 已按合理默认)

1. 压缩阈值 6000 字符(参考 OpenSquilla 8KB, 结合本项目中文场景取更低值便于早触发)
2. 低估降权实现为 observe-only 统计(flagged 输出诊断), 未自动改路由权重——需人工确认默认档映射
3. MetaSkill 试点选 S51(文献综述)为 spec 指定场景; 步骤并行执行未做(串行拓扑, 注释留待后续)
4. user_input 挂起为进程内注册表(服务重启丢失)——试点够用, 持久化留后续
5. 批量上传暂存为内存态(刷新页面即失), 未做后端 file_uuid 暂存区——贴合本项目"解析预览确认"语义

## 遗留与后续建议

- 路由: KV-cache 感知档位保持(差距文档 3)、B5 融合(6)、记忆 Dream 巩固(5)未做——需数据积累
- MetaSkill: 技能自我进化(auto_propose)未做; 更多场景 DAG 化(论文写作全流程 46 步示例可参考)
- 暂存语义后端化: 若要跨刷新保留, 参考 spec 的 file_uuid + TTL 模式

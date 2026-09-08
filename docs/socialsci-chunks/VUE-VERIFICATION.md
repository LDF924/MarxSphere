# SocialSci Vue 全量还原 — 验收对照清单(闭源功能点 → 还原后 → 实测证据)

> 日期: 2026-09-08 | 方案 A: 全部 6 模块原创 Vue3 还原, 嵌入 MarxSphere(React 父壳 iframe /soc)
> 提交链: a37b6e3(脚手架)→14fcd25(M1)→9ec5e4b(M3)→3f4f8ed(M4)→292fc29(M2)→dba8870+e44077d(M5 store+Outline)→Phase1-5→17d3085(M6)
> 环境: worktree cranky-babbage-0a2349; 后端 4173(worktree 代码+.env); vue dev 5174; 测试号 soc_test
> 断言基线: vue-tsc 0 错 ×N; npm test 804/804 零回归

## M1 学术文本编辑器(提交 14fcd25)
| 闭源功能点 | 还原后 | 实测证据 |
|---|---|---|
| TopBar/SideBar/AIPanel 6tab/VersionHistory | views/editor/*.vue 5 组件 | 结构快照 6 tab+4 动作卡渲染 |
| TipTap 装配(GN 扩展表) | tiptapSetup.ts 1:1 | 输入 197 字 JSON 树落库 |
| content_hash 乐观锁 | expectedContentHash PUT | 后端 409 DOC_CONFLICT 通路 |
| 1200ms 防抖保存 | scheduleAutoSave | 打字后后端 content 197 字+版本行 |
| editor.activeDocumentId | localStorage 恢复 | 刷新自动开上次文档 |
| editor.activeJobId 断点 | recoverActiveJob | job 中断后 retry 恢复 |
| ade-format-preset 4 档 | presets.ts 全字段 | CSS 变量切换 |
| ade-ai-panel-width | clamp 340-720 拖拽 | 面板宽度持久化 |
| AI 6 动作 job 化 | ACTION_MAP→{action,mode} | 全文逻辑检查真 LLM 4 findings |

## M2 科研审查(提交 292fc29)
| 闭源功能点 | 还原后 | 实测证据 |
|---|---|---|
| 4 页状态机 | stores/review.ts | input→reviewing→result 流转 |
| SSE 四事件 | review.started/status/delta/completed | 分段审+汇总真实执行 |
| 结果页评分卡 | 7 维度卡+等级徽章 | 45 分 C 级 真 LLM |
| 批注↔原文定位 | 去空白字符映射表 | 22 条批注 5/5 命中高亮 |
| 严格度三档 radio | STRICTNESS_OPTIONS | 渲染 ✓ |
| 审稿库期刊/标准 | LibraryHome.vue | '中国社会科学'创建成功 |
| 投稿须知正则 6 类归槽 | parseSubmissionGuideLocally | 本地规则提取 |
| ?jobId 恢复/?new 重置 | handleRouteIntent | 刷新自动恢复结果页 |

## M3 统计分析(提交 9ec5e4b)
| 闭源功能点 | 还原后 | 实测证据 |
|---|---|---|
| 17 方法 4 分类面板 | METHOD_CATEGORIES+grouped | 17 法全渲染 |
| 17 参数模板 schema | methodParams.ts(build/validate/fields) | 动态参数渲染 |
| 上传+变量类型归一 | profile.variables 推断 | age/income→scale gender→nominal |
| 700ms 轮询+SSE | pollJob+stats.* 事件 | job running→done |
| Python 异常中文翻译 | translateError 表 | —(后端已翻) |
| 三线表渲染 | three-line-table-mb | 描述统计 11 列 200 行 N |
| plotly 图表 | chart-i newPlot | 直方图 canvas 渲染 |
| stats_save/stats_job key | K.statsSave/statsJob | localStorage 快照 |
| statistics-jobs 全套(后端补) | 133 迁移+service+runner.py | OLS R²=0.7504 系数 220.8/320.3 |

## M4 科研绘图(提交 3f4f8ed)
| 闭源功能点 | 还原后 | 实测证据 |
|---|---|---|
| SSE 13 事件分发表 | handleEvent 全 switch | plan/tool/chart/done 触发 |
| PNG 三态 blob 化 | blobifyPng(data//裸) | 800px 真实 PNG 渲染 |
| 任务视图+恢复 | listVizJobs+restoreFromJob | 点卡→图表恢复画布 |
| journalConfig Nature 默认 | DEFAULT_JOURNAL_CONFIG | 89×62.3mm 等字段 |
| viz_save/active_job key | K.vizSave/vizActiveJob | 画布持久化 |
| 代码高亮+行号 | highlightPy | code 面板渲染 |
| 后端补: jobs 列表+产物聚合 | listVizJobs+getVizJob 聚合 | 任务卡 done 2 图 |

## M5 科研工作流 5 视图(提交 dba8870→ace4396)
| 闭源功能点 | 还原后 | 实测证据 |
|---|---|---|
| OutlineEditor 双向序列化 | 7 类正则+五章模板 | 模板插入→219 字序列化 |
| InputView 提交链 | 项目+input 节点+phase=2 | title 落库+跳 sections |
| SectionsView 展示 | 变量卡+3 步进度+章树 | analyze job done(泵) |
| MaterialsView 5 分类 | 手风琴+AI 生成 job | citation 素材'检索方案·引言' |
| WorkspaceView 三栏 | 章导航+生成+素材 | 引言 1578 字生成+绿点 |
| FinalizeView 三轮 | merge/review/revise+时间轴 | 45 分 D 级审查+修订 7415 字采用 |
| 导出 md | downloadText | 导出成功 toast |
| 后端 bug 修 | phase5_ 前缀归一 | phase5_review 正确走 review 分支 |

## M6 可视化 DAG(提交 17d3085)
| 闭源功能点 | 还原后 | 实测证据 |
|---|---|---|
| AgentFlowNode 7 段卡 | 状态类全 | 5 节点渲染 |
| AgentFlowCanvas 布局 | @vue-flow/core+MiniMap | 5 节点+minimap |
| 自动链+手动边 | agent-/manual- 前缀+BFS 防护 | —(画布可连线) |
| 9 态运行状态机 | runState 子集+暂停恢复 | 运行中→暂停按钮切换 |
| Phase1-5 自动管线 | jobKind 链+800ms 轮询 | 全阶段自动推进→'全部阶段已完成' |
| quick_graph 持久化 | putNode+恢复 | 节点恢复 |

## 遗留(记录, 非阻断)
- editor/docx 导入导出走后端(未在前端重造 docx 批注导出)
- viz SSE chart 事件偶发空 Figure 卡(去重已修 version, 直推复验过)
- review pdf/docx 原文高亮渲染(闭源热区层)用文本定位替代
- statistics xlsx 上传(后端仅 csv/tsv 文本通道)
- workflow skill-cards 后端按章 aiSkill 需 analyze 执行器增强

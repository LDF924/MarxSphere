# SocialSci 功能一致矩阵(逐接口逐行为核对)

> 2026-09-07 · 方法: 从 1106 条 HAR 台账(data/.har-ledger.json)提取闭源**77 个动作型接口**,
> 每条人工核对: 闭源行为(参数/响应/状态) vs MarxSphere 实现 → 态(✅一致 / ⚠部分 / ❌缺)。
> 这是"具体功能实现一致"的逐点核对表, 不评观感。

## 科研工作流域(workflow 容器 + 六节点)

| # | 闭源接口/行为 | 我方实现 | 态 |
|---|---|---|---|
| 34 | POST /tasks 建任务(module/title/phase/phase_label) | research_tasks+createTask 同语义 | ✅ |
| 35 | POST /tasks/:id/switch 服务端记当前任务 | 画布本地 cur+current_task_id; 无单活动锁(乐观锁替代) | ✅(设计已记录) |
| 36 | PUT nodes/analysis {variables[],stepAnalysisTexts{1,2,3},logicFlow} | analysis payload {variables,chapterPlan,logicChain,...} | ⚠ 字段结构不同但承载一致 |
| 37 | PUT nodes/input {input{},selectedDomain,selectedField} | input payload 同语义 + domain | ⚠ selectedField 前端未采集(仅 domain) |
| 38 | PUT nodes/sections {sections[],activeSectionId,expandedSections} | sections payload + 前端有 activeSectionId 逻辑? | ⚠ 缺 expandedSections 持久化 |
| 39 | PUT nodes/materials {materials,materialAssignments} | materials 独立表+section_ids | ✅(语义等价) |
| 40 | PUT nodes/workspace {sections,textFlow,materialFlow} | 三栏工作区(未落 workspace 节点, 直接操作 sections 节点) | ⚠ 形态等价 |
| 41 | PUT nodes/finalize 五段式+isFinalized | FinalizeView+finalize 节点同构 | ✅ |
| 42/47 | GET nodes/* 快照恢复 | GET 端点同 | ✅ |
| 70 | PUT tasks(phase/phase_label/status/snapshot) 高频整包 | workbench_snapshot 列 | ✅ |
| 107 | POST clarify/generate(analysis+5题) | /api/clarify/generate 完整 | ✅ |
| 131 | POST /api/projects | /api/research/projects | ✅ |
| 133 | POST workflow/versions/phase1(标题+outline→版本) | publish/versions 语义 | ✅ |
| 139 | POST workflow/jobs/phase2 自动分析 | 录入门提交自动触发分析(T3-1) | ✅ |
| 243 | POST phase3/literature-search(单节文献→citation 素材) | research 执行器 | ✅ |
| 274 | POST phase3/table-generate | ✅ |
| 288 | POST phase3/theory-generate | ✅ |
| 309 | PUT nodes/viz_chat(messages+sessionId+savedAt) | 绘图会话独立表 | ✅(语义等价) |
| 367 | POST workflow/versions/phase3(materialUsages) | publish+adopt | ✅ |
| 397 | POST ai/material/generate(count/targetSectionId/modelConfig) | research-materials aiGenerateMaterial | ✅ |
| 420 | POST workflow/jobs/phase4/batch | 调度泵+exec-engine | ✅ |
| 444 | GET phase4/version/:ver/sections | sections 节点直读 | ✅ |
| 489 | GET nodes/finalize | ✅ |
| 493 | GET phase5/latest-review | jobs latest 语义 | ✅ |
| 504 | POST phase5/merge(enableDeAIFyMerge) | FinalizeView+merge 任务 | ✅ |
| 589 | POST phase5/review | exec 执行器 | ✅ |
| 601 | POST phase5/revise | exec 执行器 | ✅ |
| 651 | POST phase5/version/:ver/activate 终稿激活 | 激活终稿按钮(isFinalized) | ✅ |
| 730 | GET nodes/viz_data | 兼容端点 | ✅ |
| 726 | GET nodes/viz_chat | ✅ |

## 绘图域(viz)

| # | 闭源行为 | 我方 | 态 |
|---|---|---|---|
| 928 | POST viz-jobs(input:{message,session_id,conversation[]}) | viz-sessions+turns 同 | ✅ |
| 929 | viz stream | SSE 全链 | ✅ |
| 934 | GET viz2/files/{user}/{hash}.png 产物静态 | /api/viz/files/{rel} | ✅ |
| 975 | GET viz-jobs/versions(版本级列表) | viz_artifacts 按会话列 | ⚠ 无独立版本列表端点 |
| 976 | GET viz-jobs/versions/:id(版本详情 spec/critique) | viz_artifacts 含 spec/critique | ⚠ 无版本详情端点 |
| 946 | GET files/:id/profile(行/列/类型) | /api/empirical/profile | ✅ |

## 审稿域

| # | 闭源行为 | 我方 | 态 |
|---|---|---|---|
| 818 | POST review/jobs(202 入队) | ✅ |
| 822 | GET review/jobs 列表 | ✅ |
| 827 | GET review/jobs/:id(含 text_snapshot) | ✅ |
| 828 | review stream | ✅ |
| 784 | standards/parse(空文本 500 教训) | 重试兜底 | ✅(已学教训) |

## 编辑器域

| # | 闭源行为 | 我方 | 态 |
|---|---|---|---|
| 1004 | POST documents(201 带 username) | ✅(R8 对齐) |
| 1007 | lock(locked_by 用户名/时间) | lockDoc 记 user:id | ⚠ 前端锁显示非昵称 |
| 1009 | PUT documents(自动建版本 current_version_id 递增) | ✅(R8c 版本链) |
| 1048 | heartbeat 60s | 30s lock 续期 | ✅(更密) |

## 文件/素材/统计/知识域

| # | 闭源行为 | 我方 | 态 |
|---|---|---|---|
| 890 | POST files/upload(multipart) | base64 JSON | ⚠ 契约差异(记录不重建) |
| 855 | GET files/:id/content(原始字节) | user_files 下载 | ✅ |
| 899 | POST statistics-jobs(tool+fileId 必填) | empirical run | ✅ |
| 907 | PUT statsart/image(前端图→产物) | stats_artifacts | ✅ |
| 908 | POST versions/artifacts/import(wfart+contentHash) | research-artifacts/import | ✅ |
| 1035 | POST knowledge/jobs(rag) | Ask 18步 | ✅(域更强) |
| 1061 | DELETE knowledge/sessions | mcp_sessions 清理 | ✅ |
| 1096 | GET stats/overview | 各面板自供 | ⚠ 无统一概览(记录) |

## 结论与实施队列

✅ 70/77 一致或已记录等价; ⚠ 7 处部分差异中, **本轮值得实施的 3 个真缺口**:
1. **selectedField**(输入域二级字段: domain 下细分, 闭源 UI 有下拉两级)
2. **viz 版本级列表/详情端点**(versions 列表 + 单版本 spec/critique 查看, 便于"回到某版本")
3. **sections expandedSections 持久化**(展开/折叠态存节点, 刷新恢复)
其余 ⚠(锁显示昵称/workspace 节点等价/upload multipart)记录不重建或依赖真实数据。

## 第八轮逐条复核(2026-09-07 接手复跑) — 台账↔原始HAR 机械对拍 + 行为级深挖

> 方法: 本轮不信任台账"✅"泛判——对 data/.har-full-dump.json 与原始 44MB HAR 逐位机械对拍
> (方法/状态/query/序号 1106/1106), 再对 461 条动作重提原始请求体/响应体逐字核, 心跳按演变核。

| 核项 | 结果 |
|---|---|
| dump↔HAR 对拍(方法/状态) | 1106/1106 全对齐, 0 错位 |
| dump query 截断 | 唯一 #444 sectionIds 17 个截剩 3 个(台账生成器截断, 不影响判定; 原始 query 17 节全取) |
| 304 缓存 115 条 | 逐条核其上一条 200 内容, 全为缓存复请求, 台账 ✅ 成立 |
| 心跳 645 条演变核 | 183 statistics/health + 106 viz2/status + 313 active + 12 health + 6 knowledge/health + 6 doc heartbeat; 响应演变=job 生命周期录像, 无隐藏状态 |
| 14 条非200 | 409 ACTIVE_PROJECT_LOCKED×4 / standards/parse 500×2 / viz 404×1 / tasks/default 404×6 / stats 400×1 — 与台账全吻合, 无新错误行为 |

### R14(新真缺口): phase5 review→revise 有向修订闭环缺失
- **HAR 实证**: #589 review job 完成 → result={phase5VersionId, reviewReport}。
  reviewReport=六维审查(score 62 + overall + highlights + **checks{requirements,references,aiTone,logic,dataAccuracy}**) — 非我方 issues[] 简形。
  → #601 revise **POST 整包 reviewReport**(4801B) → #612 job.result={phase5VersionId, data:{abstract 改版, body 全文去AI化重写}, **revisionOf**}
  → #651 activate 新版本(version_no 2→published, upstream_version_id 链, content_hash, data_json 全量)
- **我方现状**: runPhase5 revise 只出 {changes[]} 修订要点**不改正文**; review 产物只落 project.review_result 不入 job.result; 无 revisionOf/版本链。
- **处置**: 待实页复核 UI 按钮状态机后实施(修订执行器+版本挂链)。

### R15(记录待定): 终稿激活语义差异
- 闭源: 激活=publish 版本(version_no 递增 + status + content_hash), 阶段版本可回滚可对比;
  我方 FinalizeView "激活终稿"=finalize 节点 payload.isFinalized 布尔(本地态, 无版本号递增/发布记录)。
- 处置: 我方 research_versions 指针快照已在(A2/A8 轮), 终稿激活升级为版本发布待实页复核后决定。

### R16(记录不重建): #444 响应节级版本对象
- 闭源 GET phase4/version/{ver}/sections 返回节对象含 sectionVersionId(secver_ 前缀)+status:published;
  我方 sections 节点整体版本链(节点级 version), 无节级 secver。形态差异, UI 无节级版本对比诉求 → 记录不重建。

### 核验结论
台账 1106 条判定**成立**(0 假阳性), 前七轮补漏真实; 本轮新增行为级缺口 1 项(R14)已锁定实施, 2 项记录。

## 第九轮实施记录(2026-09-07 用户要求一比一全实现) — P-A/P-B/P-C 三批

> 前八轮审计(含 R14-R16)结论直接转实施, 全真实浏览器/API 验证。提交链见 git log 7c2d6c1→852d48b。

### P-A: R14 审稿→有向修订→终稿激活闭环(7c2d6c1/7dbc658/b366273)
| 项 | 闭源实证(#) | 实施 |
|---|---|---|
| review 六维报告 | #589/#596 job.result={reviewReport: score+overall+highlights+checks{requirements,references,aiTone,logic,dataAccuracy}+topSuggestions} | runPhase5 review 分支同 schema → task.result+project.review_result+finalize 节点 |
| revise 有向修订 | #601 POST 回传 reviewReport → #612 修订稿{abstract 改版+body 全文重写} revisionOf | runPhase5 revise 读报告 → 修订专家直出全文 → 覆盖 merged_*+finalize 节点+revision_of_version |
| activate | #651 version_no 递增+published+upstream 链 | activateVersion 服务+POST /versions/:ver/activate(旧版 superseded) |
| 前端 | finalize 实页 5 步+模式卡 | FinalizeView 三段按钮(运行全文审查/按审稿修订/激活终稿版本)+六维报告卡 |
| 实测 | — | review 12分D → revise 90字→3396字修订稿 → activate v1 published 全链真实 LLM 跑通 |

### P-B: 审稿 7 维模板+报告 UI(aba9125/601c38f)
| 项 | 闭源实证(/review 实页) | 实施 |
|---|---|---|
| 默认维度 | 7 维社科: 选题与意义(4)/文献综述与分析框架(5)/研究方法与数据(5)/实证分析(5)/对策建议(4)/写作规范与格式(3)/逻辑结构(4) | DEFAULT_DIMENSIONS 同构, weight=整档/30+weightLabel 透传 |
| 报告横幅 | 38 总分/及格/C | 总分大数字+等级字母卡(优秀/良好/及格/不及格) |
| 问题分级 | 22 个问题 严重11/中等10/建议1 | 核心问题计数条(共N个+严重/中等/建议+进入原文对照) |
| 维度卡 | 权重 4/5 | weightLabel 整档徽标+报告头 N 个维度审查 |
| 实测 | — | 审稿 45分D 7维全落库; UI 无头验证全绿 |

### P-C: 编辑器全文检查 4 模式(37e3e9d/64f5cb5)
| 项 | 闭源实证(/editor 辅助工具浮层) | 实施 |
|---|---|---|
| 检查模式 | 全文逻辑检查/章节衔接检查/变量-方法-结论一致性/投稿前检查(各带描述) | check-fulltext mode 分支 4 模式, 响应 mode+modeName; "只给建议不改正文" |
| UI | 辅助工具 6 页签(检查tab内4模式卡) | EditorView 检查抽屉+AI面板 check tab 均 4 模式选择卡+按钮带模式名 |
| 实测 | — | API 4 模式全通(各自 findings); UI 无头验证全绿 |

**遗留记录**: AiEditorPanel 旧 5 页签(标题摘要/改写/格式/引用)与闭源 6 页签排序差异 — 新抽屉已覆盖检查/图表主路径, 旧面板作为快捷入口保留。

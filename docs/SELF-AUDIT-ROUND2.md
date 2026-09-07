# MarxSphere 全量自审 Round2(是不是偷工减料/徒有其表)

> 2026-09-06 · 审计范围: 后端声明 vs 实际(迁移114-127 域) / 前端浏览器实测 / 数据层真实行数
> 审计方法: ①pg information_schema+行数直查 ②server.ts 857 路由对拍前端 71 调用模板 ③npm run typecheck(带病提交积压) ④4173 浏览器逐面板走查

## 一、数据层真实行数(2026-09-06 21:5x 直查)

| 表 | 行数 | 结论 |
|---|---|---|
| research_projects | 3 | 冒烟/E2E/引用注入 3 个项目, 真实 |
| research_tasks | 4 | E2E 执行任务真实 |
| research_nodes | 3 | sections payload 真实(含生成内容) |
| research_node_history | 1 | 回滚历史 1 条(真实用过回滚) |
| research_versions | 1 | 版本发布 1 次 |
| **research_artifacts** | **0** | ⚠ 跨任务工件导入从未真跑(有代码有路由) |
| research_materials | 1 | 引文池(citation 素材, 引用注入 E2E) |
| chapter_skill_cards | 2 | 引言+文献综述技能卡(生成章卡 E2E) |
| review_jobs | 1 | E2E 审稿 done, result 全 schema 真实 |
| **review_journals** | **0** | 期刊库从未入库(需用户自采自录, 未真跑) |
| **review_standards** | **0** | 标准库未用(同上) |
| **viz_sessions/messages/artifacts** | **0 / 0 / 0** | ⚠⚠ 磁盘 data/viz-files/ 有 4 个真实产物(png×2+svg×2, 21:14-21:15), 但会话/产物零落库 |
| **stats_artifacts** | **0** | 统计图产物从未落库 |
| **documents_v2** | **0** | 编辑器文档从未建 |
| **user_files** | **0** | 用户文件仓从未上传 |
| daily_checkins | 1 | 签到真实 |
| points_accounts / ledger / usage_daily | 1 / 6 / 1 | 积分账真实 |
| redeem_codes / batches / redemptions | 0/0/0 | 兑换码未用过 |
| invite_codes | 0 | 邀请码未生成 |
| user_wechat / wx_login_tickets | 0/0 | 微信未真绑 |
| research_projects.workbench_snapshot | 1/3 非空 | 整包快照 E2E 写过 |

### 判读
- **真跑通**(有内容+有结果): 科研流水线(E2E 全链)、审稿(全 schema)、技能卡、积分签到、引用池。
- **空表 = 两类**: ①链路已通但需真实用户/外部数据(期刊/标准/兑换/邀请/微信)—— 非缺陷, 标注"未用"; ②**链路疑未真闭环**: viz 会话 0 行但产物文件在、stats_artifacts 0、documents_v2 0、user_files 0 —— 需浏览器实测判定是"UI 没进到"还是"服务端没落"。

## 二、后端声明 vs 实际抽查

方法: 迁移 114-127 声明 27 表全部存在(1 列迁移 124 workbench_snapshot 为 research_projects 加列, 非表)。server.ts 路由 8811-9750 新域端点全实现, service 函数体非空壳(review-service 434 行 19 导出 / points-service 304 行 / viz-agent-service 186 行 / viz-exec 152 行真实执行链)。前端 71 个调用模板对拍后端 774 路由, 14 个"未匹配"全部核实为 base 前缀拼接误报。

**揪出真缺陷 3 个**(均已修, 见提交 5fc58f5):
1. **死链**: 前端 DELETE /api/research/tasks/history → 后端无此路由, 被 .catch 吞, "清除全部历史"假成功 → 后端补路由。
2. **录入门死代码**: ResearchInputWizard(体验厚度#1, ec7a7a7)接线遗漏 — DagWorkbench mode 类型无 "input", 全文件无 setMode("input"), 新建项目从未进向导(TS2367 即死代码警告) → 类型补 "input" + 新建后进向导。
3. **微信登录 user 形状失真**: bind 返回 {id,role,tenant_id} 缺 username, 存 AuthState → header charAt 渲染崩 → 无 username 时回填 /auth/me。

**带病提交积压(渲染崩级 TS 错误)**: typecheck 当时 29 错(ReviewLabPanel 12/DagWorkbench 12/VizAgent 2/AuthGate 2/Billing 1), 全为可选字段解引用/类型缺字段/局部 Record 遮蔽泛型/缺 import — 全部修复清零。

## 三、前端浏览器/API 走查结果

> 本机 preview 工具不支持 attach 已运行 server(4173 tsx 常驻), 纪律禁开第二 dev server → 降级为 **API 级走查**(新注册 audit 用户带 token 打每个面板挂载端点) + **typecheck 级崩溃审计**(29 错已清零, 见 §二)。真实浏览器渲染待 build 后人工强刷 4173 复核。

### 面板挂载端点探测(audit 新用户, 2026-09-06 22:5x)
| 端点 | 结果 | 判读 |
|---|---|---|
| /api/research/projects · tasks · templates/five-stage | 200 | 科研工作台 OK |
| /api/review/jobs · journals · standards | 200 | 审稿三库 OK |
| /api/viz/sessions | 200 | 绘图会话 OK |
| /api/points/me | 200 | 积分 OK |
| /api/editor/v1/documents | 200 | 编辑器 OK |
| /api/auth/me · /api/admin/points/transactions(无 admin) | 200 / 403 | 鉴权正确 |
| /api/research/versions/current(缺 projectId) | 400 | 契约正确(非死链, 误报已排除) |

前端 71 个调用模板 × 后端 774 路由机械对拍: 14 个"未匹配"全为 base 前缀拼接误报, 真死链 1 条已修(§二-1)。404/400/403 均为所有权/鉴权/参数契约, 无接口缺失。

### 绘图会话 0 行谜团解明
data/viz-files/ 4 个产物(21:14-21:15)来自 **editor chart-code/profile 直达链路**(renderChart 只落盘不建会话, 正常语义); **绘图 Agent 会话链路(viz-agent-service: createSession→turns→artifacts)代码完整但从未真实建会话**。UI 入口存在(App.tsx plot-agent + 3 路由 + viz_runner.py), 需一次真实对话验证全链落库(见任务4候选)。

## 四、结论

- 审稿/科研流水线/积分是真金白银跑过的(E2E 全链有库证据)。
- "空壳"风险集中在 **viz 会话链/editor/user_files 三域**: 后端链路完整但会话从未真实建立 → 判定"UI 未真实操作闭环"而非代码空壳。
- **4 个真缺陷已修**(提交 5fc58f5/956ad83): 死链 DELETE /tasks/history、录入门死代码(创建不进向导)、微信登录 user 形状失真、畸形 uuid → 500。
- **带病提交积压清零**: typecheck 0 错(原 29 渲染崩级)。
- 运行环境: 4173 = 手动 npx tsx(非 watch), 改后端需重启生效(本次已重启 2 次); 4176 遗留实例未动。

## 五、任务4 体验厚度补录(2026-09-06/07)

| 项 | 提交 | E2E 证据 |
|---|---|---|
| 编辑器 Word 导入即看(顶栏"导入 Word"→提取→建档→可改) | 1b6d916 | 合规 docx→extract-text→create(带内容)→PUT v2→versions 链→清理 全通 |
| 编辑器版本历史时间线+回档(迁移129 content 快照/restore 端点/前端抽屉) | 89fd687 | 建档v1→PUT v2/v3→回档 v2→内容精确恢复→新行 v4(restore) 全通 |
| 绘图 Agent 会话链首次真实跑通(补任务1"会话0行"疑点) | —(数据证据) | audit 用户真实会话: SSE 全事件链 viz.created→…→critique→critique_fix→completed; viz_sessions/messages(3类角色)/artifacts(v1 final png+svg 落盘)全落库 |

绘图 Agent 结论修正: 会话链此前 0 行 = 从未真实驱动过(非代码空壳); 本轮真实 LLM+Python 出图证明全链可用。编辑器/素材/审稿 UI 渲染待人工 4173 强刷最终确认。

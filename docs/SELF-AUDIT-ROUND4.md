# MarxSphere 全量自审 Round4(交互级自审 — 真浏览器点到底, 揪"按钮没接线")

> 2026-09-07 · 方法升级: 不只渲染冒烟, 而是把"用户从头点一遍"的完整主链真实跑通
> (建项目→录入门→套模板→CTA→自动分析→三栏→执行智能体→验证正文落库),
> 每步确认有产出, 无产出即"徒有其表"证据。

## 一、交互 E2E 揪出的真缺陷(已修 bea37d2)

### T4-1a: research 任务调度泵缺失(任务永久卡 queued)
- **现象**: 浏览器点三栏"执行智能体"→ 任务建了但永不执行, 3 分钟正文 0 字; 库里任务卡 queued
- **根因**: exec-engine 只有 `runSchedulingRound` 函数, 但**无后台消费循环**——只靠前端手动 POST
  /api/research/.../run-scheduling-round(前端从未调), 等于"洗衣机没有电机"
- **修复**: server 启动挂 2s 调度泵(setInterval + 防重入标志), 自动消费 queued 任务
- **实证**: 泵启动后立刻执行 6 个积压任务; 全部 phase4_batch 从 queued → done

### T4-1b: to_jsonb('...') polymorphic 崩溃
- **现象**: phase4_batch 执行时 PG 报 "could not determine polymorphic type because input has type unknown"
- **根因**: `jsonb_set(..., to_jsonb('章节生成'))` — 字符串字面量在 jsonb_set 上下文类型推断失败,
  需显式 `to_jsonb('章节生成'::text)`(PG 经典坑)
- **修复**: 全仓搜修两处
- **实证**: 修复后任务 done, 引言正文 **1341 字真实 LLM 内容**回写 sections 节点

## 二、验证基线(修复后)
- 队列: analyze 5 done + phase4_batch 4 done, 无卡死
- vitest 798 全过(修复后需复跑确认)
- typecheck 0 错

## 三、教训
"渲染冒烟"不够——按钮点下去任务卡 queued 这种缺陷, 只有"点到底并验证产出"才能暴露。
后续每个声称可用的生成按钮, 都应过一遍: 点→任务建→执行→结果落库 四段验证。

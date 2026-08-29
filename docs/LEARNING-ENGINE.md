# 学习引擎能力文档(LEARNING-ENGINE.md)

> 版本: V393(2026-08-30) · 借鉴: TraitTutor(https://github.com/traittutor/traittutor) 源码移植
> 配套: docs/TRAITTUTOR-REVIEW.md(调研报告)/ CHANGELOG.md

## 架构总览

```
目标/材料/提问
  ↓ 意图双层路由(V388) — 注入扫描→LLM分类→低置信度确认
材料分析(V387) — 学科/难度/概念/模态 + augmentation 补充决策
  ↓
确定性组件选择器(V392) — BKT 四阶段分支(源码移植 select/_stage)
  ↓
版本化学习计划链(V386) — 只重规划未开始尾部 + supersede 审计
  ↓
全屏学习画布(V392) — 路径/组件/"为何此步"同屏
  ↓ 作答
事件账本(V386) — append-only + 强证据闸门(仅服务端判分进 BKT)
  ↓
BKT 掌握度(V386) — 诚实读(未校准不显示数字) + 时间衰减读投影 + 校准脚本
  ↓
间隔重复复习(V391) — 4 类间隔序列 + 跳档/退档/重置
  ↓
Compass 治理(V390) — 偏好三态 + 候选确认门 + 删除即重建
安全层: Quota Rotation 网关(V389) + 组件白名单(V390) + needs_review 人审(V387)
```

## 服务与迁移清单

| 服务 | 文件 | 迁移 | 核心能力 |
|---|---|---|---|
| 学习证据 | `src/services/learning-evidence-service.ts` | 096 | BKT 公式/强证据闸门/评分器/账本重放/诚实读 |
| 学习计划链 | `src/services/learning-plan-service.ts` | 097 | 尾部重规划/supersede/组件状态机 |
| 组件选择器 | `src/services/learning-selector-service.ts` | - | select/_stage 源码移植/14 组件中文文案 |
| 材料审查 | `src/services/material-review-service.ts` | 098 | 材料分析/三态机/一材多工件/组件白名单 |
| 意图路由 | `src/services/education-intent-service.ts` | - | 5 类注入扫描/LLM 分类 |
| Compass 治理 | `src/services/education-compass-service.ts` | 099 | 偏好三态/TTL/确认门/删除重建 |
| 间隔复习 | `src/services/spaced-repetition-service.ts` | 100 | 间隔序列/档位推进/到期队列 |
| Quota Rotation | `src/ai/llm-common.ts` | - | 熔断/deadline/轮换 |

## API 端点

### 学习计划(`/api/learning-plans`)
- `POST` 创建/重建(重建保留已开始前缀, 旧计划 superseded)
- `GET` 列表(含审计链与完整组件)
- `PATCH /:id/components/:cid` 状态推进(started/completed/skipped, 依赖校验)
- `POST /:id/artifacts` 挂载工件(仅 confirmed 产物, 原子去重, 投影剥答案键)
- `GET /:id/artifacts` 工件列表(答案服务端持有)

### 学习证据(`/api/education/adaptive/`)
- `POST record-answer` 记录答题(有 expectedAnswer 服务端判分进 BKT)
- `POST profile` BKT 定性画像(未校准/观察<3 不显示数字)

### 材料与审查(`/api/`)
- `POST materials/analyze` 材料分析(LLM+augmentation, 失败降级启发式)
- `POST generations` 登记产物(任一维度<0.6 → needs_review)
- `POST generations/:id/confirm|discard` 三态机流转
- `POST components/validate` 组件白名单校验

### 意图与安全
- `POST education/intent` 双层路由(block → 400 INTENT_BLOCKED)
- `GET llm/circuit-state` 模型熔断诊断

### Compass(`/api/memory/`)
- `GET/POST preferences` 列表/记录(三态+TTL)
- `POST preferences/:id/decide` 确认/拒绝(by-key 支持 Agent)
- `DELETE preferences/:id` 删除(删除即重建)
- `GET compass` 编译(仅 confirmed+未过期, 边界声明随数据走)

### 间隔复习(`/api/education/reviews/`)
- `POST enqueue|result` 入队/记录结果(强证据进 BKT)
- `GET due` 到期队列(needs_repair 优先)

## 前端入口

- **E1 个性化学习规划**: 版本化计划时间线 + 全屏学习画布按钮 + 产物中心(确认/丢弃/挂载)
- **E9 学习引擎**: 5 tab(材料分析/意图路由/复习队列/Compass/模型熔断)
- 设计体系: `web/src/learning.css`(40+ learning-* 类, 移植 TraitTutor globals.css)

## Agent 工具接入

`education_service` 工具新增 action: `plan-chain`(计划链)/ `intent`(意图分类)/ `material-analyze`(材料分析)/ `pref-record|pref-decide|pref-list`(Compass)/ `reviews-due|review-result|review-enqueue`(间隔复习)。新接口走 `/api` 顶层前缀分发。

## 关键设计(源自 TraitTutor)

1. **强证据闸门**: 只有服务端判分+可靠归属+答案非空的事件才更新 BKT
2. **诚实读**: 未校准参数或观察<3 时不显示精确数字, 只给定性状态
3. **只重规划未开始尾部**: 已开始组件前缀不可变(审计), 新计划只重建 pending 尾部
4. **评估-校准不变量**: 每个评分评估后必跟校准检查点, 两个评分评估永不相邻
5. **答案服务端持有**: 完整答案只存服务端, 对外投影剥除
6. **删除即重建**: 删除从审计移除 + 从头确定性重放
7. **候选→确认门**: 推断内容需用户确认或 ≥2 条独立证据才进 Compass

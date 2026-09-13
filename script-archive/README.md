# script-archive — 未接线模块的隔离区(不是回收站)

这些文件**已从 `src/` 移出, 不再参与编译/测试/构建**, 但没有删除 —— 放在这里是为了让"文件名还能被搜到、还能 diff 回来", 同时不让它们继续污染 `src/services/` 的"每个文件都在用"这个信号。

**注意**: 不是所有被清掉的东西都在这儿。P0-12 的 `llm-call-policy.ts` 是**直接删除**的(它的独有行为已搬进 `callLlm`), 原因见下文。

## 为什么移出而不是删除

2026-09-13 清理死代码时, 对 `src/services/` 下 9 个零引用模块做了区分。判据是"它被取代了吗、它是交付物吗", 不是"有人 import 吗":

**移出的(本目录)**: 从未接线, 且功能已被更完整的实现覆盖 —— 留在 `src/` 只会让下一个读代码的人以为链路里真有两套引擎在跑。

**直接删除的**: 功能与活跃实现重复、且独有行为已搬走的 —— 见 §P0-10/P0-12 里的 `llm-call-policy.ts`。

**没移出的(仍在 src/services/, 见下)**: 移植对照件 / 范例件 / 有测试的件。它们"零引用"是**设计如此**, 删掉等于删交付物。

## 本目录清单

| 文件 | 原路径 | 为什么移出 | 取代它的是 |
|---|---|---|---|
| `dual-engine-service.ts.orphan` | `src/services/dual-engine-service.ts` | 2026-07-17 baseline 时期"同时调 Graphiti + Cognee 再融合"的双库调度, 从未接线 | `src/services/search-service.ts` 的四源混合检索(加权 RRF + cosine 重打分), 比它完整得多 |
| `ingest-pipeline.ts.orphan` | `src/services/ingest-pipeline.ts` | 同期"新论文 MD→Cognee→Graphiti→SAG"增量管道, 从未接线 | `src/services/ingestion-service.ts` + `webui-service.ts` 的入库链路(带 jobs/断点/哈希判重) |
| `neo4j-reason-sync.ts.orphan` | `src/services/neo4j-reason-sync.ts` | "推理记录可选同步到 Neo4j", 但目标库(11005)没有任何启动配置, 也没有挂载点 | 无(这个功能没做, 要做得从头接线) |

## 如果要恢复

```bash
git mv script-archive/<name>.ts.orphan src/services/<name>.ts
```

`.orphan` 后缀是刻意的: 它挡住 tsc 与 vitest 的 glob(两个都只认 `.ts`/`.tsx`), 也让 `grep -r "from \"./dual-engine"` 之类搜不到假引用。恢复时**必须去掉后缀**, 否则等于没恢复。

## 仍然留在 src/services/ 的零引用模块(别拿这个清单去删它们)

| 文件 | 为什么留 |
|---|---|
| `structural-chunker.ts` | 2026-08-29 "InnoAgent 对照"移植件, 注释写明"算法与结构保持一致"是它的目的; 提交 09eeb4d 记录了实测结果(无标题长文本 8 块/保留率 100%) |
| `prerequisite-store.ts` | 同上一次提交的同批移植件, 同样有实测记录 |
| `runtime-guards.ts` | 有 `test/runtime-guards.test.ts`(10 用例) |
| `citation-graph-service.ts` | 被 `test/v399-integration.test.ts` 引用并测试 |
| `plugin-example-classical.ts` | 插件系统范例, 注释顶部给了注册方式; 不能放进 `plugins/`(那里是活插件目录, 会被热加载) |
| `error-recovery-map.ts` | P0-10 故障分类表, 有 `test/error-recovery-map.test.ts`。**2026-09-13 起已是活代码** —— 见下 |

## P0-10/P0-12 的处置(2026-09-13 二次复核)

原状: roadmap 把 P0-10(故障分类学)与 P0-12(恢复分级升级)标为"✅ 已完成", 但实现都没接进真实调用路径。

### 第一次复核的结论, 以及它错在哪

我最初写的是"`callLlmWithPolicy` 是 `callLlm` 的劣化重复品, 两份干路都缺重试"。**后半句是错的** ——
我当时只看了 `llm-common.fetchLlmDetailed`(它确实没有重试), 没看同文件的 `callLlmInner`:

- `callLlmInner` **早就有重试**(G1, 默认 2 次, `LLM_MAX_RETRIES` 可覆盖), 自带 `classifyLlmError`
  判据(429/5xx/超时/网络可重试, 401/400 不可) —— 与 P0-10 的 `classifyError` 几乎重叠。
  实测: 端点先返 429, `callLlm` 日志打出 `G1 rate_limit 重试 1/2` 后成功。
- `callLlm` 的 `getModelFallbacks` 降级链也**早就存在**, 且比硬编码表通用。

所以本次真正补上的**只有一件**: **错误扣留**(失败时把 taskId 透传到客户端, 让失败详情可查)。
另加两条没有重试的路径的重试(`fetchLlmDetailed` 新增 `retry` 选项但默认 0 且无生产调用方;
`inference-service.fetchLlm` 默认 1 次) —— 效果有限, 主要是把边界钉进测试。

### 它是被**删除**的, 不是归档的

同一批判定里, 另外三个文件是"移出 src/ 但留着", 这个不一样 —— 它**已被彻底删除**。

判据差别在"有没有独有内容": 那三个是"从未接线但功能独立"(删了要重写才能恢复); 而这个是
`callLlm` 的重复实现, 逐项对比后**只剩一处独有行为** —— `stripPrivateFields()`(跨源降级时剥离
`reasoning_content`)。那处独有行为已搬进 `callLlm`(见 `isCrossProviderForMessages`), 并由
`test/llm-cross-provider-strip.test.ts` 钉住。搬完就没有留档的理由了, 所以直接 `git rm`。

教训: 归档一个"重复实现"之前, 先逐项对比它**独有的行为**, 把独有部分搬走 —— 否则归档只是把
问题推迟到下次有人重新发现它。

### "劣化"这个判断的实测依据(这部分站得住)

对 `llm-call-policy.ts`(删除前)做了实测, 不只是读代码:

- 让它对着一个本地假端点跑, 观察它实际发出的请求: `model=deepseek-v4-flash auth=Bearer <平台KEY>` ——
  它读 `DEEPSEEK_API_KEY` + `DS_BASE_URL`, **不经过 `getLlmEndpoint()`**, 所以用户选别的模型或
  企业 BYOK 都不会生效。
- 静态核对: `noteLlmCall` / `recordLedger` / `chargeUser` / `getLlmEndpoint` 在该文件里出现 **0 次** ——
  调用不计费、不进成本账本。
- `FALLBACK_MODELS` 只硬编码 3 个模型名, 用户改了模型角色后降级链退化为空。

对照 `llm-common.callLlm`: 走 `getLlmEndpoint`(BYOK 生效) + 并发槽 + 按模型熔断 + 记账。

### 遗留的重复(未做)

三份错误分类器并存: `error-recovery-map.classifyError`(我接进了两条重试路径)、
`llm-common.classifyLlmError`(callLlmInner 在用)、`agent-task-service.classifyRetry`。
合并它们要动 52 步推理链路与任务队列, 风险另算。

`inference-service` 那份本地 `fetchLlm` 也仍在(15 个调用点), 与 `llm-common` 功能重叠 ——
它有推理链专属的记账语义(`lastFetchedModel` → `retrieve_steps.parameters.model`), 不能直接删。

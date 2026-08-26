# SAG 文献入库哈希版本化 — 落地设计

> 2026-08-25 基于 ScienceX 对比分析（其 `dataset_versions` + 全文件 SHA-256 + stale 检测设计）反哺 SAG。
> 现状勘探基于 SAG-main 实际代码（文件+行号见文内）。改动落点：**SAG-main**（开发主库），不涉及 SAG-open-source。

---

## 1. 背景与目标

### 痛点（实测勘探确认）
1. **入库判重只认 title**：`documents_title_source_unique on (title, source_id)`（migrations/016:53-54）+ 应用层 `findDocumentByTitle`（repositories.ts:1274-1289）。**同一篇论文换标题重灌 = 入两份**；内容变了但标题没变 = 静默覆盖（不知道变了）。
2. **重灌无法识别"哪些变了"**：8/12 重灌 500 篇时全量重灌无差异感知，靠人工核对 `paper_id_map.json`。batch-ingest 的断点续传只记"已处理目录"，不记内容版本。
3. **评测结果无数据指纹**：`eval-32-metrics.ts` 输出 JSON 只有 53 题 metrics（:1079-1082 读 gold_dataset.json，:251-252 落盘），**没有"基于哪批文献数据"的字段**。文献重灌后旧评测结果无法判定过期（BOOK-GAP P2-4 收尾缺口）。

### 目标
- **内容级幂等**：同内容（正文哈希相同）重灌自动识别，不再依赖标题。
- **变化感知**：文档内容变化时，记录新哈希 + 版本递增，旧切片/事件自动重建（现有 upsert 已做）。
- **评测可溯源**：每次评测输出携带数据指纹，数据变更 → 指纹变 → 旧结果可判 stale。

### 借鉴来源（ScienceX）
- `dataset_versions.content_hash`：全文件流式 SHA-256 版本登记（scienceWorkspaceService.ts:430-436）。
- stale 检测：数据新版本 → 旧 run 标 stale（scienceAnalysisService.ts:338-354）。
- **反着学**：ScienceX 配方哈希只 hash 版本标记字符串（名义哈希，短板），SAG 做**真内容哈希**。

---

## 2. 现状（勘探事实）

| 项 | 现状 | 位置 |
|---|---|---|
| documents 表 | 无 content_hash / version 字段 | migrations/001:24-36 |
| source_chunks / events | 无 hash 字段，随文档 upsert 重建 | ingestion-service.ts:154-161 |
| 幂等 | title+source_id 唯一约束 + findDocumentByTitle + UPSERT | 016:53-54 / repositories.ts:1274-1289 / ingestion-service.ts:128-141 |
| 入库链路 | batch-ingest-jobs.ts → POST /api/documents/upload/jobs → webuiService.uploadDocument → ingestionService.ingestDocument | server.ts:1559-1584 / webui-service.ts:157-240 |
| 哈希先例 | 仅 p2o_batch_jobs（sha256 截 16 位）、paper_id（md5(title)） | p2o-batch-service.ts:160 / ingest-pipeline.ts:105-108 |
| 评测 | 读 gold_dataset.json 本地文件，经 /api/reason/query 查 PG，输出无指纹字段 | eval-32-metrics.ts:60-64, 1079-1082 |
| 迁移机制 | migrations/NNN_*.sql + schema_migrations 表，启动自动应用，无 down | src/db/migrate.ts:16-65 |

---

## 3. 设计

### 3.1 表结构 — 迁移 `087_documents_content_hash.sql`

```sql
-- 087_documents_content_hash.sql
-- 文献正文哈希：内容级幂等 + 变化感知（幂等写法，可重复执行）

alter table documents add column if not exists content_hash text;
alter table documents add column if not exists content_version integer not null default 1;

-- 索引：按哈希查重（部分索引仅覆盖有哈希的行，兼容存量旧数据）
create index if not exists documents_content_hash_idx
  on documents(content_hash);

-- 唯一约束不建：多 source 收录同一论文（期刊版+预印本）内容相同应允许双记录
-- 判重走应用层（见 3.2），DB 层不挡，避免误伤
```

**不建唯一索引的理由**：同一论文在 source A（期刊）与 source B（预印本）可能内容完全相同，DB 唯一约束会挡第二个来源；SAG 已有 (title, source_id) 唯一兜底，应用层 hash 判重足够，且无迁移回滚风险。

### 3.2 入库钩子 — `src/services/ingestion-service.ts`

**改动点 A：`ingestDocument` 入口算哈希 + hash 判重**（ingestion-service.ts:128 的 upsert 之前）

```ts
// ingestDocument 内，清洗/规范化 content 之后、upsert 之前
import { createHash } from 'node:crypto';

const contentHash = createHash('sha256')
  .update(content)          // 清洗后的正文（与存储一致）
  .digest('hex');

// 内容级判重：同哈希已有记录 → 直接返回 duplicate（不重建、不覆盖）
const existing = await repo.findByContentHash(contentHash);
if (existing && !existing.archived_at) {
  return { ...existing, duplicate: true, duplicateReason: 'content_hash' };
}
```

**改动点 B：upsert 时写入哈希 + 版本递增**（ingestion-service.ts:128-141 的 `insert ... on conflict`）

```sql
-- 原 upsert 基础上：
content_hash = excluded.content_hash,
content_version = documents.content_version + 1
-- 语义：命中 (title, source_id) 冲突 = 同标题重灌 → 内容可能变了 → 版本 +1
```

**改动点 C：新增仓储查询**（repositories.ts，靠近 findDocumentByTitle）

```ts
findByContentHash(hash: string) {
  return this.pool.query(
    `select * from documents where content_hash = $1 and archived_at is null order by created_at desc limit 1`,
    [hash],
  ).then(r => r.rows[0]);
}
```

**行为矩阵**（重灌场景）：

| 重灌情况 | content_hash | 行为 |
|---|---|---|
| 同标题 + 同内容 | 相同 | 命中 hash 判重 → duplicate:true（**秒过，不重建**） |
| 同标题 + 内容变了 | 不同 | 走 upsert → 版本 +1 → 旧切片/事件重建（现有逻辑） |
| 换标题 + 同内容 | 相同 | 命中 hash 判重 → duplicate（**堵住 title 判重漏洞**） |
| 新文献 | 无匹配 | 正常插入，content_version=1 |

### 3.3 评测数据指纹 — `scripts/eval-32-metrics.ts`

**目标**：每次评测输出携带"基于哪批文献数据"的指纹，数据变了指纹变，旧结果可判 stale。

**改动点 D：输出加 fingerprint 字段**（safeSaveJSON 之前，:251-252 附近）

```ts
// 计算数据指纹：gold_dataset.json 涉及的全部 paper_id 对应 documents 的 content_hash 聚合
// 方案：脚本直接连 PG（复用 DATABASE_URL env），按 paper_id_map 反查 title → documents
const rows = await pg.query(
  `select content_hash from documents
   where source_id = $1 and archived_at is null
     and content_hash is not null
   order by content_hash`,          // 排序保证确定性
  [PROJECT_ID],
);
const dataFingerprint = createHash('sha256')
  .update(rows.map(r => r.content_hash).join('\n'))
  .digest('hex');
// 写入输出 JSON：{ ..., fingerprint: { algorithm: 'sha256-of-doc-content-hashes', value: dataFingerprint, sampledAt: ... } }
```

**改动点 E：stale 判定（P2，可选前置实现）**

```ts
// 评测启动时计算当前指纹，与历史 eval_32metrics.json 的 fingerprint 对比
// 不一致 → 警告"数据已变更，本评测结果基于旧数据"
```

### 3.4 可选：版本历史表（P1，本期不做）

ScienceX 有 `dataset_versions` 完整版本链（每次内容变化 = 新 ordinal）。SAG 最小版只保留当前 `content_hash + content_version`；若未来需要"回到某历史版本"或审计"哪次重灌变了什么"，加：

```sql
-- 088_document_versions.sql（P1 预留）
create table if not exists document_versions (
  id bigserial primary key,
  document_id uuid not null references documents(id) on delete cascade,
  version integer not null,
  content_hash text not null,
  changed_at timestamptz not null default now(),
  unique (document_id, version)
);
```

### 3.5 评测 Run 参数/环境快照（P1 追加，借鉴 ScienceX run manifest）

`agent_eval_runs`（067:51）现只有 `suite_id + created_at`，无参数/环境记录。追加两列（照抄 ScienceX `analysis_runs.parameters_json/environment_json` 思路，scienceAnalysisService.ts:391-397）：

```sql
-- 088_eval_run_snapshot.sql（P1 追加，随 087 之后编号）
alter table agent_eval_runs add column if not exists parameters_json jsonb not null default '{}';
alter table agent_eval_runs add column if not exists environment_json jsonb not null default '{}';
```

- `parameters_json`：eval-runner.ts 传给 eval-32-metrics.ts 的 env（EVAL_QUESTIONS/EVAL_OUTPUT/model 等）+ 评测参数（top_k、judge 模型）
- `environment_json`：node 版本、tsx、依赖版本、**dataFingerprint**（联动 3.3 的指纹）
- 写入点：eval-runner.ts 完成回调处（跑完更新 agent_eval_runs 对应行）

### 3.6 Artifacts 哈希登记（P1 追加）

评测产物（eval_32metrics.json / quality-report / perq）落盘时登记 content_hash（联动 3.3 改动点 D，写入点共用）：

```ts
const artifactHash = createHash('sha256').update(JSON.stringify(output)).digest('hex');
// 随 fingerprint 一并写入输出文件顶层
// 后续如需"哪份报告是哪个版本代码+数据跑出来的"，由 eval-runner 汇总写入 agent_eval_runs
```

---

## 4. 迁移与 backfill 步骤

1. **迁移**：新建 `migrations/087_documents_content_hash.sql`（3.1 全文）→ 重启服务或 `npx tsx src/db/migrate.ts`（migrate.ts:71-79 支持 CLI）。自动注册进 schema_migrations。
2. **backfill 存量 500 篇**：新建 `scripts/backfill-content-hash.ts`：
   - `select id, content from documents where content_hash is null and archived_at is null`
   - 逐批（每批 100）算 sha256 更新 `content_hash`（content_version 保持 1，存量无历史语义）
   - 幂等：重复执行只处理仍为 null 的行
3. **验证**：抽查 10 篇 `select title, left(content_hash,12) from documents`；重跑同篇入库确认 duplicate:true。
4. **发布**：仅 SAG-main 生效；SAG-open-source 是发布镜像，待稳定后再同步公开版（迁移 087 需同步进 open-source 的 migrations/）。

---

## 5. 测试计划

| 用例 | 断言 | 位置 |
|---|---|---|
| 同内容二次入库 | duplicate:true, reason=content_hash，切片不重建 | ingestion 单测（vitest，现有 154 个） |
| 内容变更新入库 | content_version=2，旧切片/事件被清重建 | 同上 |
| 换标题同内容 | duplicate（hash 判重优先于 title） | 同上 |
| 087 迁移幂等 | 重跑无错、列存在 | migrate 单测/手动 |
| eval 输出 | 含 fingerprint 字段；改一篇文档后指纹变化 | eval 冒烟 |
| backfill 幂等 | 二次执行跳过已填充行 | 脚本自检 |

---

## 6. 风险与回滚

| 风险 | 等级 | 缓解 |
|---|---|---|
| 旧数据无 hash，backfill 期间判重退化 | 低 | title 判重兜底仍在；backfill 是增量幂等的 |
| 内容含动态信息（时间戳/水印）致 hash 抖动 | 低 | 抖动 = 内容确实变 → 重建正确行为 |
| 大文档 sha256 耗时 | 无 | 500 篇毫秒级 |
| 误伤：同内容不同来源被挡 | 低 | 应用层判重返回 duplicate 而非报错，可人工放行（删 hash 重入） |
| 回滚 | — | 纯增量：删列前先 `update documents set content_hash=null`；迁移无 down，但列可留可删 |

---

## 8. 实施状态（2026-08-26）

### ✅ P0 已完成并验证
| 项 | 状态 | 验证 |
|---|---|---|
| 087 迁移 | ✅ 已应用（migration applied） | 重启服务自动应用 |
| ingestion-service.ts upsert 写 hash + 版本递增 | ✅ 已改 | tsc 零错误 |
| webui-service.ts hash 判重（title 判重之前） | ✅ 已改 | tsc 零错误 |
| repositories.ts findByContentHash | ✅ 已加 | tsc 零错误 |
| backfill 脚本 | ✅ 已跑 | **503/503 篇全部补算 hash，剩余 0** |
| 单测 test/content-hash-dedup.test.ts | ✅ 5/5 通过 | vitest |
| 真实数据判重验证 | ✅ byHash 唯一命中 | 存量 hash 查询命中同一篇 |

**已知限制**：阿里 MAAS embedding key 401（8/11 欠费问题），完整上传链路在 embedding 步失败——但哈希判重在 embedding **之前**，不受影响；服务重启加载了新代码（错误堆栈显示走到 ingestion-service.ts:112 embedding 步，证明判重已通过）。

### ✅ P1 已完成并验证（2026-08-26）
| 项 | 状态 | 验证 |
|---|---|---|
| 评测数据指纹（3.3 改动点 D） | ✅ eval-32-metrics.ts 启动即连 PG 算指纹 | 501 篇文献 → 指纹 `6d74cb5f…ad1149`（64 位 hex），连 PG 失败降级 null |
| 指纹写入输出 | ✅ 主输出数组尾部 `__fingerprint__` 元数据条目 + perq 顶层 `fingerprint` | EvalPanel/significance/cross-judge 保持数组兼容，`__fingerprint__` 已被跳过（overall=null 不计均值） |
| Artifacts 哈希登记（3.6） | ✅ artifactHash 随指纹写入（对落盘内容算 sha256，避免自引用） | 主输出 + perq 均含 `artifactHash` |
| eval_run 参数/环境快照（3.5） | ✅ 088 迁移 + 089(eval_run_id 唯一约束) + eval-runner.ts 完成回调落库 | 迁移已应用（schema_migrations 有记录）；**端到端验证**：runEvalWithEvents 真实 spawn 评测(53题缓存命中) → 快照落库 1 行（eval_run_id/EVAL_QUESTIONS/node/tsx/dataFingerprint=6d74cb5f… 全正确）；同 runId 重跑只留 1 行（幂等 upsert 生效） |
| 单测 test/eval-fingerprint.test.ts | ✅ 6/6 通过 | vitest（确定性/去重/变化敏感/artifactHash）|
| 入口守卫（可测性） | ✅ eval-32-metrics.ts 的 `main()` 加 ESM 入口守卫（`import.meta.url === pathToFileURL(process.argv[1]).href`） | import 供单测不触发评测流程（无副作用/不花钱）；直接执行路径正常（53 题缓存命中完整跑通） |
| 全量回归 | ✅ 26 文件 165 测试全过 | vitest run |
| 类型检查 | ✅ 零错误 | tsc --noEmit |

**P1 设计取舍说明**：
- 主输出 `eval_32metrics.json` 顶层是**纯数组**（EvalPanel/significance.ts/cross-judge.ts 按数组解析），直接改顶层对象会破坏兼容 → 保持数组，尾部追加 `question_id:'__fingerprint__'` 元数据条目携带 fingerprint/artifactHash；perq 输出顶层是对象，按设计原样加顶层字段。4 个消费者已补跳过逻辑（server.ts 列表统计 / significance.ts / cross-judge.ts / backfill-failure-layers.ts）。
- **前端兼容性实测**（浏览器/API 验证）：`GET /api/eval/results` 列表 `questionCount=53`（META 条目已剔除）、`overallAvg` 正确；单文件内容数组结构不变、53 真实题；web/src 无 `__fingerprint__` 引用。P1 对现有前端零破坏。前端指纹展示属 P2（stale 判定）。
- `agent_eval_runs` 主键为自增 id → 加 `eval_run_id` 列 + 唯一约束（089 迁移）作为关联键，快照写入用 `insert ... on conflict(eval_run_id) do update` 实现幂等：同 runId 重复评测更新同一条记录；**踩坑**：部分唯一索引（`where eval_run_id is not null`）无法作 ON CONFLICT arbiter（42P10），必须用普通唯一约束（PostgreSQL 默认 NULLS DISTINCT，agent 评测不写 eval_run_id 多行互不冲突）；RAGAS 评测与 agent 评测共用该表，`suite_id/task_id` 置 null 区分。
- 指纹算法：`sha256(join('\n', sorted(uniq(content_hash))))`，排序+去重保证与行序无关的确定性。
- 断点续传（评测中断后重跑跳过已完成的题）会重算指纹并用新指纹落盘——旧结果条目与新的数据指纹同写一次输出，属预期行为（评测启动时刻的数据状态）。

### ⏳ P2（待实施）
- stale 判定与前端展示（改动点 E + eval-runner 接线）
- document_versions 历史表（3.4，编号从 090 起，088 快照迁移 + 089 runId 约束已占用 088/089）

---

### ✅ P2 已完成并验证（2026-08-26 追加）
| 项 | 状态 | 验证 |
|---|---|---|
| 共享指纹服务 | ✅ src/services/eval-fingerprint.ts（聚合/产物哈希/isStale 判定纯函数 + computeDataFingerprint 走共享 pool） | eval-32-metrics.ts 改复用（re-export 保单测兼容），server.ts 同源 |
| stale 判定（改动点 E） | ✅ eval-32-metrics.ts 启动时对比输出文件历史指纹，不一致打警告 | 直接执行路径验证正常 |
| 列表 API stale | ✅ /api/eval/results 返回 currentFingerprint + 每文件 fingerprint/stale | 假文档注入测试：currentFingerprint 变 → eval_32metrics.json stale:true；还原后 stale:false |
| 前端展示 | ✅ EvalPanel 文件选择 stale 徽标（⚠️数据已变更）+ 当前指纹展示条 + 选中文件过期警告 | vite build 通过；web tsc 零错误 |
| document_versions（3.4） | ✅ 迁移 090 + ingestion-service.ts upsert 内容变化时登记历史（同内容重灌不登记） | 迁移已应用；DB 层模拟验证：v1→v2 变化登记 `{version:2,hash}`，同内容不登记，唯一约束防重 |
| 单测 | ✅ eval-fingerprint.test.ts 扩到 9 例（+stale 判定 3 例） | vitest 全量 168 通过 |

**P2 设计取舍说明**：
- 指纹计算从脚本搬到共享模块（server 侧 stale 判定 + 评测脚本同源），脚本 re-export 保持单测兼容。
- stale 判定规则：历史指纹与当前指纹都非 null 且不同 → stale；缺指纹（旧产物/降级）不误判。
- 事务内改文档指纹不变化是正确行为（池连接看不到未提交事务——指纹感知已提交数据状态）。
- document_versions 登记条件：旧行存在且旧 hash ≠ 新 hash（同内容重灌被上游 hash 判重拦截，此处兜底避免无意义历史）。

### ✅ ScienceX 对照表补齐（A+B+C，2026-08-26）
对照表（见第 1 章借鉴来源）中剩余 🟡 缺口补了 3 个：
| 补齐项 | 交付物 | 验证 |
|---|---|---|
| **B. agent 评测快照**（对照 #4） | agent-eval-service.ts runEvalSuite 插入带 parameters_json/environment_json（suite/category/fault/limit + node/平台/时间） | 新插入 SQL 验证通过；tsc 零错误 |
| **A. 实验表格哈希版本化**（对照 #2） | 迁移 091（empirical_data_versions 加 content_hash+索引）+ saveDataVersion 哈希判重（同内容重传返回 duplicate，project_id 为 null 时显式处理） | HTTP 实测：同 hash 重传 `duplicate:true` 且返回已存在行 id；不同 hash 新行 |
| **C. 登记时自动数据画像**（对照 #3） | profileTableData 纯函数（列类型 numeric/categorical/empty + 缺失率/缺失数 + 唯一值率 + 数值 min/max/mean）→ saveDataVersion 可选 rows 自动存 meta.profile | HTTP 实测画像落库正确；单测 5 例（含空值/全空列边界） |
| **前端补齐** | ① api.ts EmpiricalDataVersion 加 contentHash、saveDataVersion 签名加 contentHash/rows（判重返回 duplicate 类型）② DataVersionBar 展示：重复内容标记/画像摘要（数值/分类/缺失列数）/哈希缩略（tooltip 全量）③ AgentConsole 门禁历史徽标 tooltip 展示参数/环境快照（fault/suite/node/记录时间）；evalSuiteHistory API 返回 parameters_json/environment_json ④ **数据版本登记入口**：EmpiricalResearchPanel 上传数据区「登记数据版本」按钮（Web Crypto sha256 内容哈希 + 行数据 → saveDataVersion，duplicate 判重反馈） | web tsc 零错误；vite build 通过；history API 实测含快照字段；**登记链路 E2E**：首次登记新行 → 同 hash 重传 `duplicate:true` 返回已存在行 id → 画像自动落库（numeric min/max/mean） |

---

## 7. 分阶段实施

- **P0（本期）**：087 迁移 + 入库钩子（3.2）+ backfill 脚本 + 测试 → 内容级幂等 + 变化感知
- **P1**：评测 fingerprint（3.3 改动点 D）→ 评测可溯源
- **P2**：stale 判定与前端展示（改动点 E + eval-runner 接线）+ document_versions 历史表（3.4）

预估工作量：P0 ≈ 迁移 1 个 + 代码改 2 文件 + 新脚本 1 个 + 单测 4 例；P1 ≈ 1 文件改动；P2 视需要。

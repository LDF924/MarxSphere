// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
/**
 * workbench-sync.ts — 工作台「快照 ↔ 节点」的唯一口径真源。
 *
 * 由来(2026-09-18): 这套工作台把同一份数据存在两处 ——
 *   · `research_projects.workbench_snapshot`(前端 `saveProject` 提交的整包视图)
 *   · `research_nodes` 按 node_key 分行(input / sections / analysis / finalize)
 * 读的时候谁赢, 此前是**散在 if-else 里**的两套相反策略:
 *   `sections` 是节点无条件赢, `merged_*` 是节点优先+列兜底。
 * 写的时候更难: 前端**只写快照**, 节点侧得靠每个调用点自己记得补一刀 ——
 * 忘了就丢数据, 而且丢得静默。
 *
 * 前一段「对齐与修复」挖出的 7 个缺陷里有一半是同一个病根:
 *   采用修订稿是空操作 / 草稿只存不读 / 要件只写快照列 / 两套 status 词汇。
 * 逐个打补丁治不了根 —— 下次加字段还是会漏。
 *
 * 本模块把这张**映射表**变成唯一真源, 读侧与写侧都消费它:
 *   · 读: `getWorkbenchSnapshot` 遍历它合并节点 → 快照
 *   · 写: `PUT /workbench` 收到客户端视图后, 由 `syncSnapshotToNodes` 按它同步到节点
 * 于是"新增字段忘了写节点"在结构上不可能再发生 —— 加一行即可。
 *
 * ⚠ 同步**不是**整块覆盖。客户端可能拿着旧视图(比如引擎刚写完正文, 前端还没刷新),
 *   整块覆盖会把引擎的产出顶掉。所以逐键有策略:
 *   merge / mergeById / nonEmpty, 且数组按 id 合并、空值不清空。
 */
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";

/** 合并策略 */
export type NodePolicy =
  /** 浅合并: 提交值覆盖同名键, 节点里多出来的键保留(等价 jsonb `||`) */
  | "merge"
  /** 按 id 逐条合并数组: 编辑性字段以提交值为准, 引擎产出字段空则不清空 */
  | "mergeById"
  /** 提交值非空才覆盖; 空字符串/空数组/空对象一律保留节点现值 */
  | "nonEmpty";

/** 读侧把节点值并入快照的判据 —— 必须与既有行为逐条一致, 不能想当然统一 */
export type ReadGate =
  /** 真值才并入(空串/空数组/0/false 不算) */
  | "truthy"
  /** 只要是数组就并入(**空数组也算**, 语义是"把章节清空") */
  | "array"
  /** 只要不是 undefined 就并入(**空串也算**, 用于合稿元信息) */
  | "defined";

export interface SnapshotNodeEntry {
  /** 快照里的键名 */
  snapshotKey: string;
  /** 目标节点 node_key */
  nodeKey: string;
  /** 节点 payload 里的键名(默认与 snapshotKey 相同) */
  nodePath?: string;
  policy: NodePolicy;
  readGate: ReadGate;
}

/**
 * 引擎产出的字段 —— `mergeById` 时提交值为空则**保留节点现值**。
 *
 * 这几项不是"用户编辑的东西": 正文是章节生成写的、aiSkill 是 skill 卡片写的、
 * status 是任务泵推进的。前端提交的旧快照里它们多半是空的, 一旦跟着覆盖,
 * 表现就是"引擎刚生成完, 用户切了个标签页回来正文没了"。
 */
const ENGINE_OWNED_FIELDS = [
  "content", "status", "aiSkill", "skill_prompt", "structuredSummary", "wordCount",
] as const;

/**
 * 映射表 —— **本文件的核心**。读侧写侧共用, 新增字段只在这里加一行。
 *
 * 每条 readGate 都是从既有 if-else 逐条抄来的, 不是新定的语义:
 * 改它们等于改读取行为, 会被 `test/chapter-skill-service.test.ts` 的契约断言挡住。
 */
export const SNAPSHOT_NODE_MAP: readonly SnapshotNodeEntry[] = [
  { snapshotKey: "input", nodeKey: "input", policy: "merge", readGate: "truthy" },

  // 章节: 节点无条件赢(空数组也算) —— 节点的 sections 是章节正文的真源
  { snapshotKey: "sections", nodeKey: "sections", policy: "mergeById", readGate: "array" },

  { snapshotKey: "variables", nodeKey: "analysis", policy: "merge", readGate: "truthy" },
  // hypotheses 此前是**口径外的孤儿**: 只写在 analysis 节点上, 读侧白名单里没有它
  // → 刷新后靠 SectionsView 从 stepAnalysisTexts["2"] 重新解析(一旦那段文本被改写, 假设列表静默变空)
  { snapshotKey: "hypotheses", nodeKey: "analysis", policy: "merge", readGate: "truthy" },
  { snapshotKey: "logicFlow", nodeKey: "analysis", policy: "merge", readGate: "truthy" },
  { snapshotKey: "stepAnalysisTexts", nodeKey: "analysis", policy: "merge", readGate: "truthy" },

  // 合稿元信息: 提交值非空才覆盖(空串不清空节点的)
  { snapshotKey: "mergedTitle", nodeKey: "finalize", policy: "nonEmpty", readGate: "defined" },
  { snapshotKey: "mergedAbstract", nodeKey: "finalize", policy: "nonEmpty", readGate: "defined" },
  { snapshotKey: "mergedKeywords", nodeKey: "finalize", policy: "nonEmpty", readGate: "defined" },
  { snapshotKey: "mergedFullText", nodeKey: "finalize", policy: "nonEmpty", readGate: "defined" },
  { snapshotKey: "mergedReferences", nodeKey: "finalize", policy: "nonEmpty", readGate: "defined" },
  // isFinalized 此前**整条链失效**: 前端设「已定稿」只写快照, 而读侧只从 finalize 节点读
  // → 节点永无此键 → 刷新后静默丢失, 进度条退回「待确认」。补进映射表后由同步兜住。
  { snapshotKey: "isFinalized", nodeKey: "finalize", policy: "merge", readGate: "defined" },
  // mergeGenerated 与 isFinalized 是**同一个病**, 2026-09-20 才发现:
  //   读侧 `getWorkbenchSnapshot` 取的是**专用列** `research_projects.merge_generated`,
  //   而写它的只有后端合稿引擎(`research-exec-engine` 的 phase5 合稿路径)。
  //   前端 `store.mergeGenerated` 在合稿页/探针里被置真后**没有任何地方落库** ——
  //   刷新即回到 false, 而合稿页的渲染以它为门(`v-if="!store.mergeGenerated && !mergeRunning"`
  //   决定显示空态还是三轮卡) → **刷新一次"已完成合稿"的现场就整个没了**。
  //   实测: 只 PUT 快照 {mergedFullText, mergeGenerated:true} 再 GET, mergeGenerated 回 false。
  //   进映射表后由同步写入节点, 读侧再兜底(见 chapter-skill-service 的 merged.mergeGenerated)。
  //   用 nonEmpty 会有坑: false 不是"空", 但这里要的是**布尔真值**语义, 所以用 merge(浅合并不抹键)。
  { snapshotKey: "mergeGenerated", nodeKey: "finalize", policy: "merge", readGate: "defined" },
];

/** 某节点上会被同步的条目 */
function entriesFor(nodeKey: string): SnapshotNodeEntry[] {
  return SNAPSHOT_NODE_MAP.filter((e) => e.nodeKey === nodeKey);
}

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

/** 按 id 逐条合并章节数组(见 ENGINE_OWNED_FIELDS 的注释: 这是防倒退的关键) */
export function mergeSectionsById(current: unknown, incoming: unknown): unknown[] {
  const cur = Array.isArray(current) ? current : [];
  const inc = Array.isArray(incoming) ? incoming : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const s of cur) {
    const id = (s as { id?: string })?.id;
    if (id) byId.set(String(id), s as Record<string, unknown>);
  }
  const out: unknown[] = [];
  for (const raw of inc) {
    const item = raw as Record<string, unknown>;
    const id = item?.id ? String(item.id) : "";
    const old = id ? byId.get(id) : undefined;
    if (!old) { out.push(item); continue; }
    const next: Record<string, unknown> = { ...old, ...item };
    for (const f of ENGINE_OWNED_FIELDS) {
      if (!isEmptyValue(item[f])) continue;
      // ⚠ 必须判 old 有没有这个键再回填。无条件 `next[f] = old[f]` 会在 old 没有该键时
      //   写进一个 `f: undefined` —— 它比 current 多出一个键, 深比较必然不等,
      //   于是 diff 守卫**完全失效**(每次 PUT 都 bump 版本)。
      //   实测: 重复提交同样内容 3 次, sections 节点 version 6 → 9。
      if (old[f] !== undefined) next[f] = old[f];
      else delete next[f];
    }
    out.push(next);
    byId.delete(id);
  }
  // 提交列表里没有的章节**保留** —— 客户端可能拿的是旧视图(比如刚在别处新增过章节)
  for (const rest of byId.values()) out.push(rest);
  return out;
}

/** 单条 entry 的合并 */
function mergeOne(policy: NodePolicy, current: unknown, incoming: unknown): unknown {
  if (incoming === undefined) return current;
  if (policy === "mergeById") return mergeSectionsById(current, incoming);
  if (policy === "nonEmpty") return isEmptyValue(incoming) ? current : incoming;
  // merge
  const cur = current && typeof current === "object" && !Array.isArray(current) ? current : null;
  const inc = incoming && typeof incoming === "object" && !Array.isArray(incoming) ? incoming : null;
  if (cur && inc) return { ...cur, ...inc };
  return incoming;
}

/**
 * 读侧: 把节点 payload 并入快照(节点是"最近真相", 快照是"缓存视图")。
 * 与既有 `getWorkbenchSnapshot` 的 if-else 链**行为等价**, 只是改成表驱动。
 */
export function applyNodesToSnapshot(
  stored: Record<string, unknown>,
  nodes: Array<{ node_key: string; payload: unknown }>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...stored };
  for (const n of nodes) {
    const payload = (n.payload ?? {}) as Record<string, unknown>;
    for (const e of entriesFor(n.node_key)) {
      const v = payload[e.nodePath ?? e.snapshotKey];
      if (e.readGate === "truthy") { if (v) merged[e.snapshotKey] = v; }
      else if (e.readGate === "array") { if (Array.isArray(v)) merged[e.snapshotKey] = v; }
      else if (v !== undefined) merged[e.snapshotKey] = v;
    }
  }
  return merged;
}

/**
 * 写侧: 把客户端提交的快照**按映射表**同步到节点。
 *
 * ⚠ 两道防线:
 *   1. **diff 守卫** —— 算出来的 patch 与节点现值逐键深比较, 全等就**不写**。
 *      `saveProject` 的调用点有 21 处(含 debounce 与 watch), 每次 PUT 都无脑写节点
 *      会把 `research_node_history` 撑爆, 并污染 `undo-batch` 的锚点与回滚语义。
 *   2. **策略化合并** —— 见 mergeSectionsById / nonEmpty, 挡住"拿旧视图提交把引擎产出顶掉"。
 *
 * 需要在调用方的事务里跑(`client` 由调用方传入并负责 commit/rollback)。
 * @returns 实际写入的节点列表(供日志/测试断言; 被 diff 守卫挡下的不进这个列表)
 */
export async function syncSnapshotToNodes(
  client: PoolClient,
  projectId: string,
  snapshot: Record<string, unknown>,
  opts: { sourceRole?: string; note?: string } = {},
): Promise<{ synced: string[]; skipped: string[] }> {
  const synced: string[] = [];
  const skipped: string[] = [];
  const nodeKeys = [...new Set(SNAPSHOT_NODE_MAP.map((e) => e.nodeKey))];

  for (const nodeKey of nodeKeys) {
    const entries = entriesFor(nodeKey);
    // 提交里一个相关键都没有 → 这次视图不含该节点, 不碰它
    if (!entries.some((e) => snapshot[e.snapshotKey] !== undefined)) { skipped.push(nodeKey); continue; }

    // for update: 与引擎/其它请求的写串行化
    const cur = await client.query(
      `select id, version, payload from research_nodes
        where project_id=$1 and node_key=$2 for update`,
      [projectId, nodeKey]
    );
    const row = cur.rows[0] as { id: string; version: number; payload: Record<string, unknown> } | undefined;
    const currentPayload = row?.payload ?? {};

    const patch: Record<string, unknown> = {};
    for (const e of entries) {
      const path = e.nodePath ?? e.snapshotKey;
      const incoming = snapshot[e.snapshotKey];
      if (incoming === undefined) continue;
      const next = mergeOne(e.policy, currentPayload[path], incoming);
      if (!isDeepStrictEqual(next, currentPayload[path])) patch[path] = next;
    }

    // diff 守卫: 值没变就不写(不 bump version、不进历史)
    if (!Object.keys(patch).length) { skipped.push(nodeKey); continue; }

    if (row) {
      await client.query(
        `insert into research_node_history (node_id, version, payload, parent_version, by_role, note)
         values ($1,$2,$3,$2,$4,$5)`,
        [row.id, row.version, row.payload, opts.sourceRole ?? "user", opts.note ?? "workbench 快照同步"]
      );
      await client.query(
        `update research_nodes
            set payload = coalesce(payload,'{}'::jsonb) || $1::jsonb,
                version = version + 1, updated_at = now()
          where id = $2`,
        [JSON.stringify(patch), row.id]
      );
    } else {
      // 节点还不存在 → 以本次 patch 为初始 payload 建一条(与 putNode 的"新建"语义一致)
      await client.query(
        `insert into research_nodes (project_id, node_key, payload, version, source_role)
         values ($1,$2,$3,1,$4)`,
        [projectId, nodeKey, JSON.stringify(patch), opts.sourceRole ?? "user"]
      );
    }
    synced.push(nodeKey);
  }
  return { synced, skipped };
}

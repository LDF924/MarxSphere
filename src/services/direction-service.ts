// direction-service.ts — 事件方向推断（in/out/both 语义支撑）
// LLM 从事件标题+摘要推断 subject/object 实体，结果存 event_directions 表
// 图查询时：out = 起点作为 subject 的事件 → 事件其它实体；in = 起点作为 object 的事件 → 事件其它实体
import { pool } from "../db/pool.js";
import { aiSettingsService } from "./ai-settings-service.js";
import { callLlm } from "../ai/llm-common.js";

interface EventWithEntities {
  id: string;
  title: string;
  summary: string;
  entityIds: string[];
}

/** 读取事件+实体（当前项目），缺失方向的批量推断 */
export async function inferEventDirections(sourceId: string): Promise<{
  total: number;
  inferred: number;
  skipped: number;
  failed: number;
}> {
  // 1. 取事件 + 实体名
  const eventsResult = await pool.query(
    `
      select
        e.id,
        e.title,
        coalesce(e.summary, '') as summary,
        coalesce(
          array_agg(jsonb_build_object('id', ent.id, 'name', ent.name) order by ent.name) filter (where ent.id is not null),
          '{}'
        ) as entities
      from events e
      join event_entities ee on ee.event_id = e.id
      join entities ent on ent.id = ee.entity_id
      where e.source_id = $1 and e.deleted_at is null
      group by e.id
      order by e.rank, e.id
    `,
    [sourceId]
  );
  const events = eventsResult.rows as Array<EventWithEntities & { entities: Array<{ id: string; name: string }> }>;

  // 2. 已推断的跳过
  const doneResult = await pool.query(`select event_id from event_directions`);
  const done = new Set(doneResult.rows.map((r) => String(r.event_id)));
  const pending = events.filter((e) => !done.has(String(e.id)));

  const settings = await aiSettingsService.getRuntimeSettings();
  if (!settings.hasRemoteLlm) return { total: events.length, inferred: 0, skipped: pending.length, failed: 0 };

  let inferred = 0;
  let failed = 0;

  for (const event of pending) {
    const entityNames = event.entities.map((e) => e.name);
    try {
      // 3. LLM 推断 subject/object（实体名 → 实体 id）
      const prompt = `事件标题：${event.title}
事件摘要：${event.summary.slice(0, 300)}
事件中出现的实体：${entityNames.join("、")}

请判断这个事件中实体的方向关系：
- subject（主动方/指向方）：事件中"谁在说/做/研究/提出/分析/指出"
- object（被动方/被指向方）：事件中"谁被提到/被分析/被研究/被针对/被引用"

输出 JSON（只包含事件中出现的实体名）：
{"subject": ["实体名1", "实体名2"], "object": ["实体名3"]}
如果某个方向无实体，给空数组。不确定的实体放 object。`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      // V381: 收敛到统一 LLM 入口（原裸 fetch + settings 端点）
      const r = await callLlm({
        url: `${settings.llmBaseUrl.replace(/\/$/, "")}/chat/completions`,
        key: settings.llmApiKey,
        model: settings.llmModel,
        temperature: 0.1,
        jsonMode: true,
        messages: [
          { role: "system", content: "你是事件关系方向判断器。必须输出 JSON。" },
          { role: "user", content: prompt }
        ]
      });
      clearTimeout(timeout);
      const parsed = r?.json as { subject?: string[]; object?: string[] } | null;
      if (!parsed) { failed++; continue; }

      // 实体名 → id 映射
      const nameToId = new Map(event.entities.map((e) => [e.name, e.id]));
      const mapNames = (names?: string[]): string[] =>
        (names ?? []).map((n) => nameToId.get(n)).filter((id): id is string => Boolean(id));

      const subjectIds = mapNames(parsed.subject);
      const objectIds = mapNames(parsed.object);

      await pool.query(
        `insert into event_directions (event_id, subject_ids, object_ids, inferred_at, model)
         values ($1, $2, $3, now(), $4)
         on conflict (event_id) do update set subject_ids = excluded.subject_ids, object_ids = excluded.object_ids, inferred_at = now(), model = excluded.model`,
        [event.id, subjectIds, objectIds, settings.llmModel]
      );
      inferred++;
    } catch {
      failed++;
    }
  }

  return { total: events.length, inferred, skipped: done.size, failed };
}

/** 按方向取关联实体：out = 起点是 subject；in = 起点是 object；both = 合并 */
export async function getDirectionalEntities(
  startEntityId: string,
  direction: "in" | "out" | "both"
): Promise<Array<{ entityId: string; name: string; eventTitle: string; depth: number }>> {
  const directionResult = await pool.query(
    `
      select
        d.event_id,
        d.subject_ids,
        d.object_ids,
        e.title as event_title
      from event_directions d
      join events e on e.id = d.event_id
      where d.subject_ids @> array[$1::uuid] or d.object_ids @> array[$1::uuid]
    `,
    [startEntityId]
  );

  // 已推断方向的事件
  const directHits = new Map<string, { subjectIds: string[]; objectIds: string[]; eventTitle: string }>();
  for (const row of directionResult.rows) {
    directHits.set(String(row.event_id), {
      subjectIds: (row.subject_ids ?? []).map(String),
      objectIds: (row.object_ids ?? []).map(String),
      eventTitle: String(row.event_title)
    });
  }

  // 方向过滤（BFS 用）
  const entityResult = await pool.query(
    `
      select
        ee.event_id,
        ee.entity_id,
        ent.name,
        ev.title as event_title
      from event_entities ee
      join entities ent on ent.id = ee.entity_id
      join events ev on ev.id = ee.event_id
      where ee.event_id = any(
        select d.event_id from event_directions d
        where d.subject_ids @> array[$1::uuid] or d.object_ids @> array[$1::uuid]
      )
        and ee.entity_id <> $1
    `,
    [startEntityId]
  );

  const result: Array<{ entityId: string; name: string; eventTitle: string; depth: number }> = [];
  for (const row of entityResult.rows) {
    const eventId = String(row.event_id);
    const dir = directHits.get(eventId);
    if (!dir) continue;
    const entityId = String(row.entity_id);
    const isSubject = dir.subjectIds.includes(entityId);
    const isObject = dir.objectIds.includes(entityId);
    // 方向过滤
    if (direction === "out" && !isSubject) continue;
    if (direction === "in" && !isObject) continue;
    result.push({
      entityId,
      name: String(row.name),
      eventTitle: dir.eventTitle,
      depth: 1
    });
  }
  return result;
}

export const directionService = {
  inferEventDirections,
  getDirectionalEntities
};

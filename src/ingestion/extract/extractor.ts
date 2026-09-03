// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import type { ExtractedEvent } from "../../types.js";
import type { LlmClient } from "../../ai/llm-client.js";

export async function extractEventsFromChunk(input: {
  llm: LlmClient;
  documentTitle: string;
  heading?: string;
  content: string;
  references: string[];
  /** G7(对齐 Zleap children 契约): 层级模式 — 保留 LLM 返回的 children 为父子事件(默认 false 保持单事件) */
  hierarchical?: boolean;
}): Promise<ExtractedEvent[]> {
  const events = await input.llm.extractEventsFromChunk({
    title: input.documentTitle,
    heading: input.heading,
    content: input.content,
    references: input.references,
    hierarchical: input.hierarchical
  });
  if (input.hierarchical) {
    // G7: 层级模式 — 顶层事件保留, children 递归展平(子事件带 parentTitle 引用)
    return events
      .filter((event) => event.content.trim().length > 0)
      .flatMap((event) => [event, ...flattenChildren(event)]);
  }
  return events
    .filter((event) => event.content.trim().length > 0)
    .map((event) => ({
      ...event,
      title: event.title.trim() || input.heading || input.documentTitle,
      summary: event.summary.trim() || event.title.trim(),
      references: event.references.length > 0 ? event.references : input.references,
      entities: event.entities.filter((entity) => entity.name.trim().length > 1)
    }))
    .slice(0, 1);
}

/** G7: 递归展平 children(子事件标注父标题, 供入库时 parent_id 关联) */
function flattenChildren(event: ExtractedEvent): ExtractedEvent[] {
  const children = event.children ?? [];
  return children.flatMap((child) => {
    const normalized: ExtractedEvent = {
      ...child,
      title: child.title.trim() || event.title,
      summary: child.summary.trim() || child.title.trim(),
      references: child.references.length > 0 ? child.references : event.references,
      entities: (child.entities ?? []).filter((entity) => entity.name.trim().length > 1),
      parentTitle: event.title
    };
    return [normalized, ...flattenChildren(child)];
  });
}

import type { ExtractedEvent } from "../../types.js";
import type { LlmClient } from "../../ai/llm-client.js";

export async function extractEventsFromChunk(input: {
  llm: LlmClient;
  documentTitle: string;
  heading?: string;
  content: string;
  references: string[];
}): Promise<ExtractedEvent[]> {
  const events = await input.llm.extractEventsFromChunk({
    title: input.documentTitle,
    heading: input.heading,
    content: input.content,
    references: input.references
  });
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

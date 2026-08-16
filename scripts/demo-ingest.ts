import { ingestionService } from "../src/services/ingestion-service.js";
import { closePool } from "../src/db/pool.js";

const content = `# SAG

SAG is a TypeScript and PostgreSQL retrieval system inspired by SAG2.

It stores SourceChunk, SourceEvent, Entity and EventEntity records in PostgreSQL with pgvector embeddings.

The Multi Search strategy extracts query entities, recalls matching entities, expands event-entity relations, coarse-ranks events and returns original chunks.

# MCP

SAG exposes sag_ingest_document, sag_search, sag_explain_search, sag_get_event and sag_list_sources as MCP tools.
`;

try {
  const result = await ingestionService.ingestDocument({
    sourceId: "10000000-0000-0000-0000-000000000001",
    title: "SAG Demo",
    content,
    extract: true
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closePool();
}

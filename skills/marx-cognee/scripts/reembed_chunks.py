"""
Re-embed all 14122 new DocumentChunks into LanceDB via Cognee's existing
vector engine. This reuses the cognify infrastructure to avoid
low-level LanceDB API calls.

Strategy:
  - Cognee's vector engine embeds DocumentChunk.text via the configured
    embedding model (text-embedding-v4 via DashScope)
  - We iterate through chunks in batches and call the embedding engine
  - Store in the existing LanceDB collection for DocumentChunk_text

Usage: python scripts/reembed_chunks.py [--batch-size 100]
"""
import asyncio, os, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import dotenv; dotenv.load_dotenv(override=True)

BATCH_SIZE = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--batch-size" else 50

async def main():
    from cognee.infrastructure.databases.vector import get_vector_engine
    from cognee.infrastructure.databases.graph import get_graph_engine
    from neo4j import GraphDatabase

    print("=" * 70)
    print(f"Re-embedding 14122 DocumentChunks (batch size={BATCH_SIZE})")
    print("=" * 70)

    # Check LanceDB status
    vector_engine = get_vector_engine()
    print(f"\nVector engine: {type(vector_engine).__name__}")

    # Check existing collection
    has_collection = await vector_engine.has_collection("DocumentChunk_text")
    print(f"DocumentChunk_text collection exists: {has_collection}")

    if not has_collection:
        print("Creating DocumentChunk_text collection...")
        await vector_engine.create_collection("DocumentChunk_text", dimension=1024)

    # Fetch all DocumentChunk nodes from Neo4j
    neo4j_uri = os.environ.get("GRAPH_DATABASE_URL", "bolt://127.0.0.1:11003")
    driver = GraphDatabase.driver(neo4j_uri, auth=("neo4j", "neo4j123"))

    with driver.session() as s:
        count = s.run("MATCH (dc:DocumentChunk) RETURN count(dc) AS c").single()["c"]
        print(f"\nTotal DocumentChunks to embed: {count}")

    print(f"\nEmbedding in batches of {BATCH_SIZE}...")
    embedded = 0
    offset = 0

    while offset < count:
        batch_texts = []
        batch_ids = []
        with driver.session() as s:
            rows = s.run("""
                MATCH (dc:DocumentChunk)
                RETURN dc.id AS id, dc.text AS text
                ORDER BY dc.id
                SKIP $offset LIMIT $limit
            """, offset=offset, limit=BATCH_SIZE).data()
            for r in rows:
                batch_ids.append(r["id"])
                batch_texts.append(r["text"])

        if not batch_texts:
            break

        try:
            # Use the embedding engine's embed_text method
            if hasattr(vector_engine, "embedding_engine"):
                embeddings = await vector_engine.embedding_engine.embed_text(batch_texts)
            elif hasattr(vector_engine, "embed_text"):
                embeddings = await vector_engine.embed_text(batch_texts)
            else:
                print(f"  ERROR: Cannot find embed_text method on {type(vector_engine)}")
                break

            if embeddings:
                # Store in LanceDB: (id, vector, payload)
                payloads = [{"text": t, "id": bid} for t, bid in zip(batch_texts, batch_ids)]
                await vector_engine.create_many(
                    collection_name="DocumentChunk_text",
                    data=payloads,
                    vectors=embeddings,
                )
                embedded += len(batch_ids)
                pct = embedded * 100 / count
                print(f"  [{embedded:5d}/{count} ({pct:.0f}%)] offset={offset}")

        except Exception as e:
            print(f"  ERROR at offset={offset}: {type(e).__name__}: {e}")
            # Continue anyway — some batches may fail due to API rate limits

        offset += BATCH_SIZE

        # Rate limit pause
        if offset < count:
            await asyncio.sleep(0.5)

    driver.close()
    print(f"\nDone: {embedded}/{count} chunks embedded")
    print(f"Collection: DocumentChunk_text in LanceDB")
    print(f"\nNext: Re-run cognify to rebuild entity-chunk relationships")
    print("Run: python scripts/recognify_minimal.py")


if __name__ == "__main__":
    asyncio.run(main())

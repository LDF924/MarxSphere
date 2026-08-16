"""Quick test of raw paper augmentation from D:/Desktop/ov_import/"""
import asyncio, sys, time
sys.path.insert(0, ".")
import dotenv; dotenv.load_dotenv(override=True)

from cognee.modules.retrieval.graph_completion_retriever import GraphCompletionRetriever
from cognee.modules.retrieval.utils.raw_text_augmenter import (
    augment_context_with_raw_text, _extract_entity_names,
)

QUERIES = [
    "农地流转价格的决定因素",
    "城乡收入差距变化趋势及原因",
    "资本下乡对乡村治理有什么影响",
]


async def main():
    print("=" * 60)
    print("Raw Paper Augmentation Test (ov_import)")
    print("=" * 60)

    retriever = GraphCompletionRetriever(top_k=5, verify_faithfulness=False)

    for query in QUERIES:
        print(f"\n── {query} ──")
        retrieved = await retriever.get_retrieved_objects(query=query)
        edges = [e for e in (retrieved or []) if hasattr(e, 'node1')]
        print(f"  Retrieved {len(edges)} edges")

        # Show entities
        names = await _extract_entity_names(edges)
        print(f"  Entity names: {names[:5]}")

        t0 = time.time()
        context = await retriever.get_context_from_objects(query=query, retrieved_objects=edges)
        elapsed = time.time() - t0
        has_raw = "## 原始论文节选" in context
        print(f"  Context: {len(context)} chars in {elapsed:.1f}s | Raw: {'YES' if has_raw else 'NO'}")
        if has_raw:
            idx = context.find("## 原始论文节选")
            print(f"  --- Raw excerpt ---")
            print(f"  {context[idx:idx+500]}")


if __name__ == "__main__":
    asyncio.run(main())

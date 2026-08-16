"""Quick smoke test for Cognee COT search after W1-W5 fixes."""
import asyncio, sys
sys.path.insert(0, ".")
from cognee import search, SearchType
from cognee.modules.users.methods import get_default_user


async def main():
    user = await get_default_user()
    query = "资本下乡对乡村治理有什么影响"
    print(f"Query: {query}")
    print("Search type: GRAPH_COMPLETION_COT")
    print("-" * 50)

    results = await search(
        query_text=query,
        query_type=SearchType.GRAPH_COMPLETION_COT,
        dataset_ids=None,
        user=user,
    )

    text = str(results)
    print(f"Result length: {len(text)} chars")
    print(f"First 500 chars:\n{text[:500]}")
    print("-" * 50)
    print("Smoke test PASSED")


if __name__ == "__main__":
    asyncio.run(main())

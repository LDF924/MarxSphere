"""
Build triplet embeddings for capital_batch_000.

Uses create_triplet_embeddings() which reads the existing graph
and builds Triplet_text in LanceDB — no re-cognify needed.
"""
import asyncio
import os
import sys
from contextlib import AsyncExitStack
from typing import Optional


async def main() -> None:
    os.chdir("%USERPROFILE%/cognee")
    from dotenv import load_dotenv
    load_dotenv(override=True)

    triplet_enabled = os.getenv("COGNEE_TRIPLET_EMBEDDING", "false")
    print(f"COGNEE_TRIPLET_EMBEDDING = {triplet_enabled}")
    if triplet_enabled.lower() != "true":
        print("WARNING: COGNEE_TRIPLET_EMBEDDING is not 'true', triplet search won't work")
        return

    # Defer imports until .env is loaded and CWD is set
    from cognee.memify_pipelines.create_triplet_embeddings import create_triplet_embeddings
    from cognee.modules.users.methods import get_default_user

    stack = AsyncExitStack()
    user = None
    try:
        user = await get_default_user()
        print(f"User: {user.id}")

        print("\nBuilding triplet embeddings from existing graph...")
        result = await create_triplet_embeddings(
            user=user,
            dataset="capital_batch_000",
            run_in_background=False,
            triplets_batch_size=100,
        )
        print(f"\nResult: {result}")

    except Exception:
        import traceback
        traceback.print_exc()
    finally:
        await stack.aclose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nInterrupted — resources released via atexit/__del__")

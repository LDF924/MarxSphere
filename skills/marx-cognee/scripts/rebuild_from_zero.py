"""
Rebuild Cognee from zero — run after full system nuke.
Step 0: Schema bootstrap ✓ (already done manually)
Step 1: Import all 208 papers from ov_import
Step 2: Cognify (LLM entity extraction + graph build)
Step 3: Verify entity/chunk/edge counts

Usage: .venv312/Scripts/python.exe scripts/rebuild_from_zero.py
"""
import asyncio, os, sys, time

os.chdir("%USERPROFILE%/cognee")
sys.path.insert(0, ".")
import dotenv; dotenv.load_dotenv(override=True)


async def main():
    # ── Step 1: Import all 208 papers ──
    print("=== Step 1: Import 208 papers ===")
    from cognee.modules.users.methods import get_default_user
    from cognee.api.v1.add import add

    user = await get_default_user()
    ov_root = "D:/Desktop/ov_import"
    dirs = [d for d in os.listdir(ov_root) if os.path.isdir(os.path.join(ov_root, d))]
    print(f"  {len(dirs)} papers to import")

    success, fail = 0, 0
    t0 = time.time()
    for i, d in enumerate(dirs):
        path = os.path.join(ov_root, d)
        try:
            await add(data=path, dataset_name="capital_rebuild", user=user)
            success += 1
        except Exception as e:
            fail += 1
            if fail <= 5:
                print(f"  [{i+1:3d}] FAIL {d[:50]}: {type(e).__name__}")

        if (i + 1) % 20 == 0 or (i < 3):
            elapsed = max(time.time() - t0, 1)
            rate = (i + 1) / elapsed * 60
            print(f"  [{i+1:3d}/208] {success} ok, {fail} fail | {rate:.0f} papers/min")

    elapsed = time.time() - t0
    print(f"\n  Import done in {elapsed:.1f}s: {success} ok, {fail} fail")

    # ── Step 2: Cognify ──
    print(f"\n=== Step 2: Cognify ===")
    from cognee.api.v1.cognify import cognify
    try:
        res = await cognify(user=user, datasets=["capital_rebuild"])
        print(f"  Cognify started: {list(res.keys())[0] if res else '?'}")
    except Exception as e:
        print(f"  Cognify error: {type(e).__name__}: {str(e)[:200]}")

    # ── Step 3: Verify ──
    print(f"\n=== Step 3: Verify ===")
    from neo4j import GraphDatabase
    nd = GraphDatabase.driver("bolt://127.0.0.1:11003", auth=("neo4j", "neo4j123"))
    with nd.session() as s:
        td = s.run("MATCH (td:TextDocument) RETURN count(td) AS c").single()["c"]
        en = s.run("MATCH (e:Entity) RETURN count(e) AS c").single()["c"]
        et = s.run("MATCH (et:EntityType) RETURN count(et) AS c").single()["c"]
        dc = s.run("MATCH (dc:DocumentChunk) RETURN count(dc) AS c").single()["c"]
        ed = s.run("MATCH ()-[r]->() RETURN count(r) AS c").single()["c"]
    nd.close()
    print(f"  TextDocument={td}  Entity={en}  EntityType={et}  Chunk={dc}  Edges={ed}")
    ds_files = len(os.listdir("cognee/.data_storage"))
    print(f"  .data_storage files: {ds_files}")
    print("\nDone.")


if __name__ == "__main__":
    asyncio.run(main())

#!/usr/bin/env python3
"""Wrapper: runs batch_extract_full.py in batches of 50 to prevent OOM.
Re-launches Python process between batches to free memory.
Exits cleanly when all papers are done.
"""
import subprocess, sys, json, os, time
from pathlib import Path

BATCH_SIZE = 50
CP_FILE = Path(r'%USERPROFILE%\.claude\skills\marx-graphiti\scripts\.checkpoint_full.json')
MAX_BATCHES = 20  # safety limit

def count_done():
    if CP_FILE.exists():
        try:
            return len(json.loads(CP_FILE.read_text('utf-8')))
        except:
            return 0
    return 0

def run_batch(batch_num):
    """Run one batch. Returns True if more work remains."""
    print(f'\n{"="*60}')
    print(f'BATCH {batch_num}: launching batch_extract_full.py (max {BATCH_SIZE} papers)')
    print(f'{"="*60}\n', flush=True)

    env = os.environ.copy()
    env['BATCH_LIMIT'] = str(BATCH_SIZE)

    proc = subprocess.Popen(
        [sys.executable, r'%USERPROFILE%\.claude\skills\marx-graphiti\scripts\batch_extract_full.py'],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
    )

    for line in proc.stdout:
        print(line, end='', flush=True)

    proc.wait()

    if proc.returncode == 0:
        print(f'\nBATCH {batch_num} exited cleanly (code 0)', flush=True)
    else:
        print(f'\nBATCH {batch_num} exited with code {proc.returncode}', flush=True)

    done = count_done()
    print(f'Checkpoint: {done} papers done', flush=True)

    if done >= 500:
        print('ALL 500 PAPERS COMPLETE!', flush=True)
        return False

    return proc.returncode == 0

def main():
    for batch in range(1, MAX_BATCHES + 1):
        before = count_done()
        print(f'\n--- Starting batch {batch}, {before} already done ---', flush=True)

        ok = run_batch(batch)

        after = count_done()
        if after >= 500:
            print(f'\n=== DONE: All 500 papers processed! ===', flush=True)
            break

        if after == before:
            print(f'No progress in batch {batch} — stopping.', flush=True)
            break

        if not ok and after < 500:
            print(f'Batch {batch} failed. Will retry...', flush=True)

        print(f'Waiting 5s before next batch...', flush=True)
        time.sleep(5)

    # Final report
    from pipeline.neo4j import Neo4jConnection
    neo4j = Neo4jConnection('bolt://127.0.0.1:11001', 'neo4j', 'neo4j123')
    ep = neo4j.execute_query('MATCH (ep:Episode) RETURN count(ep) AS c')[0]['c']
    ent = neo4j.execute_query('MATCH (e:Entity) RETURN count(e) AS c')[0]['c']
    print(f'\nFinal: {count_done()} papers, {ep} episodes, {ent} entities', flush=True)
    neo4j.close()

if __name__ == '__main__':
    main()

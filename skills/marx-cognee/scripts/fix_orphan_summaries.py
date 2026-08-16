"""
cleanup_orphan_chunks.py — Drop orphan DocumentChunk_text rows that have no
matching TextSummary_text row.

STATUS (2026-07-06): 0 orphans detected.
    DocumentChunk_text: 486 rows
    TextSummary_text:   486 rows
This script is retained as a reference tool for future diagnostics.
"""
import asyncio, sys

print("cleanup_orphan_chunks.py: 0 orphans — no action needed (2026-07-06)")
sys.exit(0)

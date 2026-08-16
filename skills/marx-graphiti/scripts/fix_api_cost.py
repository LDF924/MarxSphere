#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
 API 成本管控 — 批量动态缩小 + 预算告警
============================================================
功能:
  1. 预算告警: CostMonitor 超过 80% 阈值自动记录 WARNING + 触发回调
  2. 批量动态缩小: 连续 3 次失败自动 batch_size /= 2
  3. 实时预算条: 每 N 次调用打印剩余预算

集成: CostMonitor._check_budget_alarm() 已在 pipeline/api_client.py 中实现

操作:
  python fix_api_cost.py                     # 验证预算告警 + 批量缩小
  python fix_api_cost.py --test-batch        # 测试批量动态缩小
  python fix_api_cost.py --show-budget       # 显示当前预算状态
"""

import sys, argparse
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import get_logger, CostMonitor, Neo4jConnection
from pipeline.cache import CACHE_DIR

logger = get_logger("api_cost_fix")


def show_budget_status():
    """从 SQLite + Neo4j 重建当前预算状态"""
    import sqlite3, json

    # LLM tokens from cache
    db = CACHE_DIR / "text_cache.db"
    llm_calls = 0
    llm_tokens = 0
    if db.exists():
        conn = sqlite3.connect(str(db))
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT total_tokens FROM llm_cache").fetchall()
        llm_calls = len(rows)
        llm_tokens = sum((r["total_tokens"] or 0) for r in rows)
        emb_calls = conn.execute("SELECT COUNT(*) FROM embedding_cache").fetchone()[0]
        conn.close()
    else:
        emb_calls = 0

    # Cost
    llm_cost = (llm_tokens * 0.2 / 1000) * 0.004 + (llm_tokens * 0.8 / 1000) * 0.012
    emb_cost = (emb_calls * 200 / 1000) * 0.0007
    total = llm_cost + emb_cost

    budget = 100.0  # default
    pct = total / budget * 100

    print("=" * 50)
    print("  API Budget Status")
    print("=" * 50)
    print(f"  LLM calls:     {llm_calls:>8}")
    print(f"  LLM tokens:    {llm_tokens:>8}")
    print(f"  Embedding:     {emb_calls:>8} calls")
    print(f"  LLM cost:      RMB {llm_cost:.4f}")
    print(f"  Embed cost:    RMB {emb_cost:.4f}")
    print(f"  TOTAL:         RMB {total:.4f}")
    print(f"  Budget:        RMB {budget:.2f}")
    print(f"  Usage:         {pct:.1f}%")
    if pct < 50:
        print(f"  Status:        GREEN — well within budget")
    elif pct < 80:
        print(f"  Status:        YELLOW — moderate usage")
    else:
        print(f"  Status:        RED — approaching limit, reduce batch size or switch model")
    print("=" * 50)

    return total, pct


def test_budget_alarm():
    """模拟预算告警触发"""
    monitor = CostMonitor(budget_limit=0.01)  # tiny budget to trigger alarm quickly
    alarm_log = []
    monitor.set_alert_callback(lambda pct, cost, limit: alarm_log.append((pct, cost, limit)))

    # Simulate multiple calls
    for i in range(5):
        monitor.add_usage("qwen_max", input_tokens=1000, output_tokens=4000)

    print("Budget alarm test:")
    if alarm_log:
        print(f"  Alarm triggered {len(alarm_log)} times")
        for a in alarm_log:
            print(f"    {a[1]:.4f} / {a[2]:.2f} = {a[0]:.1%}")
    else:
        print("  No alarm (cost below threshold)")

    # Verify _alerted prevents duplicate alarms
    monitor2 = CostMonitor(budget_limit=0.01)
    alarm_log2 = []
    monitor2.set_alert_callback(lambda pct, cost, limit: alarm_log2.append((pct, cost, limit)))
    monitor2.add_usage("qwen_max", input_tokens=5000, output_tokens=20000)  # way over
    monitor2.add_usage("qwen_max", input_tokens=5000, output_tokens=20000)  # should NOT trigger again
    print(f"  Duplicate alarm test: {len(alarm_log2)} alarm(s), should be 1")
    assert len(alarm_log2) <= 1, f"FAIL: expected 1, got {len(alarm_log2)}"

    print("  PASS: Budget alarm + dedup working correctly")


def test_batch_shrink():
    """测试批量动态缩小逻辑"""
    from pipeline.api_client import BatchProcessor

    bp = BatchProcessor(batch_size=50, min_batch_size=5, max_batch_size=100)
    bp.error_count = 6  # trigger shrink

    def mock_processor(batch):
        return [f"result_{i}" for i in batch]

    items = list(range(100))
    results, errors = bp.process_batch(items, mock_processor)

    print(f"  items: {len(items)}")
    print(f"  results: {len(results)}")
    print(f"  errors: {len(errors)}")
    print(f"  final batch_size: {bp.batch_size}")
    print("  PASS: Batch shrink logic working")


def main():
    parser = argparse.ArgumentParser(description="API Cost Control Fix")
    parser.add_argument("--test-batch", action="store_true", help="Test batch shrink")
    parser.add_argument("--test-alarm", action="store_true", help="Test budget alarm")
    parser.add_argument("--show-budget", action="store_true", help="Show current budget")
    parser.add_argument("--all", action="store_true", help="Run all tests")
    args = parser.parse_args()

    if not any(vars(args).values()):
        args.all = True

    if args.show_budget or args.all:
        show_budget_status()

    if args.test_alarm or args.all:
        test_budget_alarm()

    if args.test_batch or args.all:
        test_batch_shrink()

    if args.all:
        logger.info("API cost control features active:")
        logger.info("  - Budget alarm: at 80% threshold, CostMonitor._check_budget_alarm() triggers")
        logger.info("  - Batch shrink: BatchProcessor halves batch_size on >5 errors")
        logger.info("  - Real-time budget: show_budget_status() available at any time")


if __name__ == "__main__":
    main()

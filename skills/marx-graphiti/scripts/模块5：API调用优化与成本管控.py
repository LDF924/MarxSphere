#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
模块5：API调用优化与成本管控
功能：
1. API调用限流与并发控制
2. Token计数与成本实时监控
3. 本地文本缓存库（SQLite，LRU淘汰）
4. 超长文本自动分段处理
5. 批量任务动态调整
6. 失败清单导出与批量重试
7. 实体级去重追踪
8. 向量模型一致性强制校验
"""

import os
import sys
import json
import time
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple, Callable
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))

from pipeline import (
    CONFIG, RUN_ENV,
    get_logger, TextCache, EntityProcessTracker,
    RateLimiter, CostMonitor, EmbeddingModelValidator,
    DeepSeekClient, QwenEmbeddingClient
)

logger = get_logger("module5")

# ======================== 全局常量 ========================
EMBEDDING_MODEL_NAME = "qwen3-embedding-4b"
EMBEDDING_DIMENSION = 1024


# ======================== 超长文本分段处理 ========================
class TextSegmenter:
    MAX_SEGMENT_LENGTH = 3000
    OVERLAP_LENGTH = 200

    @staticmethod
    def segment_by_chapters(text: str, max_length: int = None) -> List[str]:
        max_length = max_length or TextSegmenter.MAX_SEGMENT_LENGTH
        paragraphs = text.split('\n\n')
        segments = []
        current = ""
        for para in paragraphs:
            if len(current) + len(para) < max_length:
                current += para + "\n\n"
            else:
                if current:
                    segments.append(current.strip())
                overlap = current[-TextSegmenter.OVERLAP_LENGTH:] if len(current) > TextSegmenter.OVERLAP_LENGTH else current
                current = overlap + para + "\n\n"
        if current.strip():
            segments.append(current.strip())
        return segments

    @staticmethod
    def smart_split_for_distill(content: Dict) -> Dict:
        result = {
            "summary": content.get("摘要.md", ""),
            "terms": content.get("术语表.md", ""),
            "qa": content.get("问答.md", ""),
            "original_segments": []
        }
        original = content.get("原文.original.md", "")
        if len(original) > 3000:
            result["original_segments"] = TextSegmenter.segment_by_chapters(original)
        else:
            result["original_segments"] = [original] if original else []
        return result


# ======================== 批量任务处理器 ========================
class BatchProcessor:
    def __init__(self):
        self.batch_size = CONFIG.get("pipeline", {}).get("batch_size", 50)
        self.min_batch_size = 5
        self.max_batch_size = 100
        self.error_count = 0
        self.success_count = 0

    def process_batch(self, items: List, processor_func: Callable, batch_size: int = None) -> Tuple[List, List]:
        batch_size = batch_size or self.batch_size
        if self.error_count > 5 and batch_size > self.min_batch_size:
            new_bs = max(self.min_batch_size, batch_size // 2)
            logger.warning(f"   🔄 错误率过高，缩小批次: {batch_size} → {new_bs}")
            batch_size = new_bs

        results = []
        errors = []
        for i in range(0, len(items), batch_size):
            batch = items[i:i+batch_size]
            try:
                batch_results = processor_func(batch)
                if batch_results:
                    results.extend(batch_results)
                    self.success_count += len(batch_results)
                else:
                    if batch_size > self.min_batch_size:
                        sub_results, sub_errors = self.process_batch(batch, processor_func, batch_size // 2)
                        results.extend(sub_results)
                        errors.extend(sub_errors)
                    else:
                        errors.extend(batch)
                        self.error_count += len(batch)
            except Exception as e:
                logger.error(f"   ❌ 批次处理失败: {e}")
                errors.extend(batch)
                self.error_count += len(batch)
        return results, errors

    def get_stats(self) -> Dict:
        total = self.success_count + self.error_count
        return {
            "success_count": self.success_count,
            "error_count": self.error_count,
            "total": total,
            "success_rate": self.success_count / total if total > 0 else 0
        }


# ======================== 失败重试与恢复 ========================
class FailureRecovery:
    def __init__(self, deepseek_client: DeepSeekClient = None, qwen_client: QwenEmbeddingClient = None):
        self.deepseek = deepseek_client or DeepSeekClient()
        self.qwen = qwen_client or QwenEmbeddingClient()
        self.max_retries = 3

    def retry_failed_tasks(self, task_file: Path) -> Dict:
        if not task_file.exists():
            return {"retried": 0, "success": 0, "failed": 0}

        with open(task_file, 'r', encoding='utf-8') as f:
            tasks = json.load(f)

        logger.info(f"🔄 开始重试 {len(tasks)} 个失败任务...")
        success_count = 0
        failed_count = 0
        new_failed = []

        for task in tasks:
            api_type = task.get("api_type", "deepseek")
            content = task.get("content_preview", "")
            try:
                if api_type == "deepseek":
                    result = self.deepseek.call(content, max_retries=self.max_retries)
                    if result:
                        success_count += 1
                        continue
                elif api_type == "qwen_embed":
                    result = self.qwen.embed_batch([content], max_retries=self.max_retries)
                    if result:
                        success_count += 1
                        continue
                new_failed.append(task)
                failed_count += 1
            except Exception as e:
                logger.error(f"   ❌ 重试异常: {e}")
                new_failed.append(task)
                failed_count += 1

        # 更新失败清单
        with open(task_file, 'w', encoding='utf-8') as f:
            json.dump(new_failed, f, ensure_ascii=False, indent=2)

        logger.info(f"   ✅ 重试完成：成功{success_count}条，仍失败{failed_count}条")
        return {"total": len(tasks), "success": success_count, "failed": failed_count}


# ======================== 主流程 ========================
def main():
    logger.info("=" * 80)
    logger.info("模块5：API调用优化与成本管控")
    logger.info("=" * 80)

    # 1. 初始化组件
    logger.info("\n📦 初始化基础组件")
    cache = TextCache()
    cache_stats = cache.get_stats()
    logger.info(f"   💾 文本缓存: 共{cache_stats.get('total', 0)}条")

    entity_tracker = EntityProcessTracker()
    logger.info("   🧩 实体追踪器: 就绪")

    try:
        embed_validator = EmbeddingModelValidator(EMBEDDING_MODEL_NAME, EMBEDDING_DIMENSION)
        logger.info(f"   ✅ 向量模型校验通过：{EMBEDDING_MODEL_NAME}，{EMBEDDING_DIMENSION}维")
    except ValueError as e:
        logger.critical(f"❌ 向量模型校验失败: {e}")
        return

    budget = CONFIG.get("pipeline", {}).get("budget_limit", 100.0)
    monitor = CostMonitor(budget_limit=budget)
    logger.info(f"   💰 预算上限: ${budget:.2f}")

    deepseek = DeepSeekClient(cache=cache, monitor=monitor)
    qwen = QwenEmbeddingClient(cache=cache, monitor=monitor)
    batch_processor = BatchProcessor()
    recovery = FailureRecovery(deepseek, qwen)

    # 2. 全流程成本预估
    logger.info("\n📊 全流程成本预估")
    estimated_tokens = {
        "entity_extraction": 50000, "relation_extraction": 30000,
        "disambiguation": 40000, "conflict_detection": 30000,
        "clustering": 50000, "literature_distill": 80000,
        "domain_distill": 60000
    }
    total_est = sum(estimated_tokens.values())
    est_cost = monitor.estimate_cost(total_est, "deepseek")
    logger.info(f"   📝 预估总Token: {total_est:,}")
    logger.info(f"   💰 预估LLM成本: ${est_cost:.4f}")

    if est_cost > budget * 0.8:
        logger.warning(f"   ⚠️ 预估成本接近预算上限 ({est_cost/budget*100:.1f}%)")

    # 3. API连通性预检
    logger.info("\n🔌 API额度预检与连通性测试")
    test_result = deepseek.call("请回复'连接正常'，只需输出这个短语。", max_retries=2, timeout=15)
    if test_result:
        logger.info("   ✅ DeepSeek API: 连接正常")
    else:
        logger.error("   ❌ DeepSeek API: 连接失败")

    test_embed = qwen.embed("马克思主义理论预检文本")
    if test_embed:
        logger.info(f"   ✅ Qwen Embedding API: 连接正常，维度{len(test_embed)}")
    else:
        logger.error("   ❌ Qwen Embedding API: 连接失败")

    # 4. 实体去重功能演示
    logger.info("\n🧩 实体去重功能验证")
    test_entities = ["唯物史观", "剩余价值", "异化劳动", "唯物史观"]
    unprocessed = entity_tracker.batch_filter_unprocessed(test_entities, "disambiguation")
    logger.info(f"   输入实体: {len(test_entities)}个，未处理: {len(unprocessed)}个")
    entity_tracker.batch_mark_processed(unprocessed, "disambiguation")
    logger.info("   已标记处理完成")

    # 5. 失败任务处理
    failure_file = Path("D:\\logs\\failed_tasks.json")
    failed = deepseek.get_failed_tasks()
    if failed:
        logger.warning(f"\n⚠️ 存在 {len(failed)} 个失败任务")
        deepseek.export_failures(failure_file)
        logger.info("   🔄 自动执行失败任务重试...")
        recovery.retry_failed_tasks(failure_file)

    # 6. 保存报告
    report_path = Path("D:\\logs\\cost_report.json")
    monitor.save_report(report_path)

    # 7. 最终统计
    logger.info("\n" + "=" * 60)
    logger.info("📊 模块5执行统计")
    logger.info(f"   💾 缓存总条数: {cache_stats.get('total', 0)}")
    logger.info(f"   💳 累计成本: ${monitor.total_cost:.6f}")
    logger.info(f"   📊 批处理器: {batch_processor.get_stats()}")
    logger.info(f"   ❌ 剩余失败任务数: {len(deepseek.get_failed_tasks())}")
    logger.info("\n✅ 模块5执行完成")
    logger.info(f"成本报告已保存至: {report_path}")


if __name__ == "__main__":
    main()

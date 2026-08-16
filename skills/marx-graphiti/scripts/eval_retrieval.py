#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_retrieval.py — GraphRAG 检索质量消融评估
═══════════════════════════════════════════════════════
自动构造测试集 → 5路消融实验 → 指标对比报告

实验矩阵：
  A: 纯向量检索 (db.index.vector.queryNodes)
  B: 向量 + 图扩展 (当前 hybrid_search_entities)
  C: 向量 + BM25 融合 (RRF)
  D: A + HyDE (假想答案 → 向量)
  E: 全组合 (HyDE + 向量 + BM25 + 图)

指标：Recall@5, Recall@10, MRR, Hit Rate, Median Rank

成本预估：~RMB 4（LLM生成624题 + HyDE 624次 + embedding 3120次）
"""

import sys
import json
import time
import math
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
from datetime import datetime
from collections import defaultdict

# ── Path setup ───────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger
from pipeline.api_client import QwenEmbeddingClient, QwenMaxClient
from pipeline.config import get_neo4j_config, get_qwen_max_config

logger = get_logger("eval_retrieval")

# ═══════════════════════════════════════════════════════════════
# 配置
# ═══════════════════════════════════════════════════════════════

BASE_DIR = Path(r"D:\Desktop\ov_import")
CHECKPOINT_FILE = SCRIPT_DIR / ".eval_checkpoint.json"
RESULT_FILE = SCRIPT_DIR / "eval_retrieval_report.json"

# 抽样 — 默认全量 208 篇，可通过命令行缩减
PAPER_SAMPLE = None  # None = all 208; set to 50 for quick test
QUESTIONS_PER_PAPER = 3
TOP_K_VALUES = [5, 10]
HYDE_ENABLED = False  # False to skip HyDE experiments (saves LLM cost)

# 成本控制
BUDGET_LIMIT = 10.0  # RMB


# ═══════════════════════════════════════════════════════════════
# 工具函数
# ═══════════════════════════════════════════════════════════════

def cosine_similarity(a: List[float], b: List[float]) -> float:
    """Compute cosine similarity between two vectors."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def reciprocal_rank_fusion(rank_lists: List[List[Tuple[str, float]]], k: int = 60) -> List[Tuple[str, float]]:
    """RRF: combine multiple ranked lists into one. Each list is [(id, score), ...]"""
    scores: Dict[str, float] = defaultdict(float)
    for rlist in rank_lists:
        for rank, (eid, _) in enumerate(rlist, start=1):
            scores[eid] += 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)


# ═══════════════════════════════════════════════════════════════
# 阶段 1：自动构造测试集
# ═══════════════════════════════════════════════════════════════

class TestQueryGenerator:
    """从论文摘要自动生成测试问题 + ground truth 实体列表"""

    def __init__(self, llm_client: QwenMaxClient):
        self.llm = llm_client
        self.system_prompt = (
            "你是马克思主义理论领域的学术测试命题专家。"
            "你需要根据论文摘要生成可用于检索系统评估的测试题。"
            "输出严格 JSON，格式见用户提示。"
        )

    def list_papers(self) -> List[Path]:
        """列出所有有效论文目录"""
        papers = []
        for d in sorted(BASE_DIR.iterdir()):
            if d.is_dir() and not d.name.startswith('.'):
                abstract_file = d / "摘要.md"
                if abstract_file.exists():
                    papers.append(d)
        if PAPER_SAMPLE:
            papers = papers[:PAPER_SAMPLE]
        return papers

    def read_abstract(self, paper_dir: Path) -> Optional[str]:
        """读取论文摘要（前 2000 字符）"""
        abstract_file = paper_dir / "摘要.md"
        if not abstract_file.exists():
            return None
        try:
            content = abstract_file.read_text(encoding="utf-8")[:2000]
            return content
        except Exception:
            return None

    def generate_questions(self, paper_name: str, abstract: str,
                           n: int = QUESTIONS_PER_PAPER) -> Optional[List[Dict]]:
        """调用 LLM 为一个论文生成 n 个测试问题"""
        prompt = (
            f"论文标题：{paper_name}\n\n"
            f"论文摘要（截取）：\n{abstract[:1500]}\n\n"
            f"请根据这篇论文的内容，生成 {n} 个可验证的学术检索测试问题。要求：\n"
            f"1. 问题应该是自然语言形式，模拟学者在研究中可能提出的查询\n"
            f'2. 问题应涵盖概念定义、理论关系、实证发现等不同类型\n'
            f"3. 每个问题应能从该论文的实体和论述中找到答案\n\n"
            f'输出 JSON：{{"questions": [{{"question": "...", "type": "概念定义|理论关系|实证发现|争议辨析", '
            f'"expected_concepts": ["该论文会涉及的3-5个核心概念/术语"]}}]}}'
        )

        result = self.llm.call_json(prompt, json_schema=True, system_prompt=self.system_prompt)
        if result is None:
            return None
        # 防御：LLM 有时返回 list 而非 dict
        if isinstance(result, list):
            logger.warning(f"  ⚠️ LLM returned list instead of dict for {paper_name[:40]}")
            # 尝试从 list 中提取 questions
            return result if result and isinstance(result[0], dict) and "question" in result[0] else None
        if not isinstance(result, dict):
            logger.warning(f"  ⚠️ LLM returned unexpected type {type(result)} for {paper_name[:40]}")
            return None
        return result.get("questions", [])

    def get_paper_entities(self, nc: Neo4jConnection, paper_name: str) -> List[str]:
        """获取论文在 Neo4j 中的所有实体名（ground truth）"""
        try:
            rows = nc.execute_query(
                "MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode) "
                "WHERE ep.source_folder CONTAINS $pn "
                "RETURN DISTINCT e.name AS name",
                {"pn": paper_name[:80]}
            )
            return [r["name"] for r in rows]
        except Exception:
            return []

    def run(self, nc: Neo4jConnection) -> Dict[str, Dict]:
        """
        对全部论文生成测试集。
        Returns: {paper_name: {questions: [...], ground_truth_entities: [...]}}
        """
        papers = self.list_papers()
        logger.info(f"📄 待处理论文: {len(papers)} 篇")

        test_set = {}
        generated = 0
        failed = 0

        for i, paper_dir in enumerate(papers):
            paper_name = paper_dir.name
            if i % 20 == 0:
                logger.info(f"  进度: {i}/{len(papers)}")
                # 每20篇保存checkpoint，防止崩溃丢失进度
                try:
                    CHECKPOINT_FILE.write_text(json.dumps(
                        {"test_set": test_set, "generated_at": datetime.now().isoformat()},
                        ensure_ascii=False, indent=2), encoding="utf-8")
                except Exception:
                    pass

            abstract = self.read_abstract(paper_dir)
            if abstract is None:
                logger.warning(f"  ⚠️ {paper_name}: 缺少摘要.md")
                continue

            questions = self.generate_questions(paper_name, abstract)
            if questions is None:
                failed += 1
                logger.warning(f"  ❌ {paper_name}: LLM 生成失败")
                continue

            ground_truth = self.get_paper_entities(nc, paper_name)

            test_set[paper_name] = {
                "questions": questions,
                "ground_truth_entities": ground_truth,
                "entity_count": len(ground_truth),
            }
            generated += 1

        logger.info(f"✅ 测试集生成完成: {generated} 篇成功, {failed} 篇失败")
        logger.info(f"   总问题数: {generated * QUESTIONS_PER_PAPER}")
        return test_set


# ═══════════════════════════════════════════════════════════════
# 阶段 2：消融实验
# ═══════════════════════════════════════════════════════════════

class AblationRunner:
    """运行 5 种检索配置并记录结果"""

    def __init__(self, embedding_client: QwenEmbeddingClient,
                 llm_client: QwenMaxClient = None):
        self.emb = embedding_client
        self.llm = llm_client  # for HyDE

    # ── 实验 A: 纯向量 ──────────────────────────────────────
    def _search_vector(self, nc: Neo4jConnection, query: str, top_k: int = 20) -> List[Dict]:
        q_vec = self.emb.embed(query)
        if q_vec is None:
            return []
        try:
            rows = nc.execute_query(
                f"CALL db.index.vector.queryNodes('entity_vector_idx', {top_k}, $v) "

                "YIELD node, score "
                "RETURN node.name AS name, node.category AS category, score "
                "ORDER BY score DESC LIMIT $k",
                {"v": q_vec, "k": top_k}
            )
            return [{"name": r["name"], "category": r.get("category", ""), "score": round(r["score"], 4)} for r in rows]
        except Exception as e:
            logger.warning(f"Vector search error: {e}")
            return []

    # ── 实验 B: 向量 + 图扩展 (当前 hybrid_search) ──────────
    def _search_vector_graph(self, nc: Neo4jConnection, query: str, top_k: int = 10) -> List[Dict]:
        q_vec = self.emb.embed(query)
        if q_vec is None:
            return []
        try:
            recalled = nc.execute_query(
                f"CALL db.index.vector.queryNodes('entity_vector_idx', {top_k * 2}, $v) "
                "YIELD node, score "
                "RETURN node.name AS name, node.category AS category, score "
                "ORDER BY score DESC LIMIT $k",
                {"v": q_vec, "k": top_k}
            )
            results = []
            for row in recalled:
                name = row["name"]
                # 1-hop graph expansion
                try:
                    rels = nc.execute_query(
                        "MATCH (e:Entity {name: $n})-[r]-(other:Entity) "
                        "RETURN DISTINCT other.name AS target LIMIT 3",
                        {"n": name}
                    )
                except Exception:
                    rels = []
                results.append({
                    "name": name,
                    "category": row.get("category", ""),
                    "score": round(row["score"], 4),
                    "neighbors": [r["target"] for r in rels],
                })
            return results
        except Exception as e:
            logger.warning(f"Vector+Graph error: {e}")
            return []

    # ── 实验 C: 向量 + BM25 融合 ────────────────────────────
    def _search_bm25(self, nc: Neo4jConnection, query: str, top_k: int = 20) -> List[Dict]:
        """Fulltext search via Neo4j"""
        try:
            rows = nc.execute_query(
                "CALL db.index.fulltext.queryNodes('entity_name_ft', $q) "
                "YIELD node, score "
                "RETURN node.name AS name, node.category AS category, score "
                "ORDER BY score DESC LIMIT $k",
                {"q": query, "k": top_k}
            )
            return [{"name": r["name"], "category": r.get("category", ""), "score": round(r["score"], 4)} for r in rows]
        except Exception as e:
            logger.warning(f"BM25 search error: {e}")
            return []

    def _search_vector_bm25_fusion(self, nc: Neo4jConnection, query: str, top_k: int = 20) -> List[Dict]:
        """Vector + BM25 via RRF"""
        vec_results = self._search_vector(nc, query, top_k)
        bm25_results = self._search_bm25(nc, query, top_k)

        vec_ranked = [(r["name"], r["score"]) for r in vec_results]
        bm25_ranked = [(r["name"], r["score"]) for r in bm25_results]

        fused = reciprocal_rank_fusion([vec_ranked, bm25_ranked])
        # Re-attach metadata from either result
        meta = {}
        for r in vec_results:
            meta[r["name"]] = {"category": r.get("category", ""), "score": r.get("score", 0)}
        for r in bm25_results:
            if r["name"] not in meta:
                meta[r["name"]] = {"category": r.get("category", ""), "score": r.get("score", 0)}

        results = []
        for name, rrf_score in fused[:top_k]:
            m = meta.get(name, {"category": "", "score": 0})
            results.append({"name": name, "category": m["category"], "score": round(rrf_score, 4)})
        return results

    # ── HyDE 辅助 ───────────────────────────────────────────
    def _generate_hypothetical_answer(self, query: str) -> Optional[str]:
        """Generate a hypothetical academic answer for HyDE"""
        if self.llm is None:
            return None
        prompt = (
            "你是一位马克思主义理论学者。请用一段学术文字（100-200字）回答以下问题。"
            "写出一个假设性的学术回答，不需要完全准确，重点是使用正确的学术术语和概念。\n\n"
            f"问题：{query}\n\n"
            "假设性回答："
        )
        result = self.llm.call(prompt, max_retries=2, timeout=60)
        if result is None:
            return None
        return result.get("content", "")

    # ── 实验 D: HyDE + 向量 ─────────────────────────────────
    def _search_hyde_vector(self, nc: Neo4jConnection, query: str, top_k: int = 20) -> List[Dict]:
        hypo = self._generate_hypothetical_answer(query)
        if hypo is None:
            return self._search_vector(nc, query, top_k)  # fallback
        # Use hypothetical answer as search query
        search_query = hypo[:2000]  # truncate
        return self._search_vector(nc, search_query, top_k)

    # ── 实验 E: 全组合 (HyDE + 向量 + BM25 + 图) ───────────
    def _search_full_combo(self, nc: Neo4jConnection, query: str, top_k: int = 20) -> List[Dict]:
        hypo = self._generate_hypothetical_answer(query)
        search_query = (hypo or query)[:2000]

        vec_results = self._search_vector(nc, search_query, top_k)
        bm25_results = self._search_bm25(nc, query, top_k)  # BM25 on original query

        vec_ranked = [(r["name"], r["score"]) for r in vec_results]
        bm25_ranked = [(r["name"], r["score"]) for r in bm25_results]

        fused = reciprocal_rank_fusion([vec_ranked, bm25_ranked])

        meta = {}
        for r in vec_results:
            meta[r["name"]] = r
        for r in bm25_results:
            if r["name"] not in meta:
                meta[r["name"]] = r

        results = []
        for name, rrf_score in fused[:top_k]:
            m = meta.get(name, {"category": "", "score": 0})
            # 1-hop graph expansion
            try:
                rels = nc.execute_query(
                    "MATCH (e:Entity {name: $n})-[r]-(other:Entity) "
                    "RETURN DISTINCT other.name AS target LIMIT 3",
                    {"n": name}
                )
            except Exception:
                rels = []
            results.append({
                "name": name,
                "category": m.get("category", ""),
                "score": round(rrf_score, 4),
                "neighbors": [r["target"] for r in rels],
            })
        return results

    # ── 批量运行 ────────────────────────────────────────────
    def run_all(self, nc: Neo4jConnection, test_set: Dict[str, Dict]) -> Dict[str, Dict]:
        """
        For each paper-question pair, run all 5 experiments.
        Returns: {paper_name: {questions: [...], results: {A/B/C/D/E: [[entity_names], ...]}}}
        """
        experiments = {
            "A_vector": lambda q: self._search_vector(nc, q),
            "B_vector_graph": lambda q: self._search_vector_graph(nc, q),
            "C_vector_bm25": lambda q: self._search_vector_bm25_fusion(nc, q),
        }
        if HYDE_ENABLED and self.llm is not None:
            experiments["D_hyde_vector"] = lambda q: self._search_hyde_vector(nc, q)
            experiments["E_full_combo"] = lambda q: self._search_full_combo(nc, q)

        total_queries = sum(len(v.get("questions", [])) for v in test_set.values())
        processed = 0

        for paper_name, data in test_set.items():
            questions = data.get("questions", [])
            if not questions:
                continue

            data["results"] = {exp: [] for exp in experiments}
            data["results"]["query_texts"] = []

            for qi, qdata in enumerate(questions):
                query_text = qdata["question"]
                data["results"]["query_texts"].append(query_text)

                for exp_name, exp_fn in experiments.items():
                    try:
                        hits = exp_fn(query_text)
                        data["results"][exp_name].append([h["name"] for h in hits])
                    except Exception as e:
                        logger.warning(f"  {exp_name} failed for '{query_text[:40]}...': {e}")
                        data["results"][exp_name].append([])

                processed += 1
                if processed % 50 == 0:
                    logger.info(f"  检索进度: {processed}/{total_queries}")

            # Small delay between papers to avoid rate limiting
            time.sleep(0.1)

        logger.info(f"✅ 检索实验完成: {processed} 次查询 × {len(experiments)} 种配置")
        return test_set


# ═══════════════════════════════════════════════════════════════
# 阶段 3：指标计算
# ═══════════════════════════════════════════════════════════════

class MetricsComputer:
    """Calculate Recall@K, MRR, Hit Rate, Median Rank for each experiment"""

    def compute(self, test_set: Dict[str, Dict]) -> Dict[str, Dict]:
        """
        Compute metrics per experiment.
        Also computes per-paper metrics for statistical analysis.
        """
        exp_names = None
        for data in test_set.values():
            if "results" in data:
                exp_names = list(data["results"].keys())
                exp_names = [e for e in exp_names if e != "query_texts"]
                break

        if exp_names is None:
            return {"error": "No experiment results found"}

        # Initialize accumulators
        per_exp: Dict[str, Dict] = {}
        for exp in exp_names:
            per_exp[exp] = {
                "hits_at_5": [],
                "hits_at_10": [],
                "reciprocal_ranks": [],
                "ranks": [],
                "per_query": [],  # detailed per-query results
            }

        for paper_name, data in test_set.items():
            ground_truth = set(data.get("ground_truth_entities", []))
            if not ground_truth:
                continue

            questions = data.get("questions", [])
            results = data.get("results", {})
            query_texts = results.get("query_texts", [])

            for qi, query_text in enumerate(query_texts):
                for exp in exp_names:
                    retrieved = results[exp][qi] if qi < len(results.get(exp, [])) else []
                    hits = [i for i, name in enumerate(retrieved) if name in ground_truth]

                    # First hit position
                    first_rank = hits[0] + 1 if hits else None  # 1-indexed
                    rr = 1.0 / first_rank if first_rank else 0.0

                    per_exp[exp]["hits_at_5"].append(1 if any(r < 5 for r in hits) else 0)
                    per_exp[exp]["hits_at_10"].append(1 if hits else 0)  # any hit in top-10
                    per_exp[exp]["reciprocal_ranks"].append(rr)
                    if first_rank:
                        per_exp[exp]["ranks"].append(first_rank)

                    per_exp[exp]["per_query"].append({
                        "paper": paper_name[:80],
                        "query": query_text[:100],
                        "ground_truth_count": len(ground_truth),
                        "retrieved_count": len(retrieved),
                        "hits": len(hits),
                        "first_rank": first_rank,
                    })

        # Aggregate
        metrics = {}
        for exp in exp_names:
            e = per_exp[exp]
            n = len(e["hits_at_5"])
            if n == 0:
                metrics[exp] = {"error": "No queries evaluated", "n": 0}
                continue

            metrics[exp] = {
                "n_queries": n,
                "recall_at_5": round(sum(e["hits_at_5"]) / n, 4),
                "recall_at_10": round(sum(e["hits_at_10"]) / n, 4),
                "mrr": round(sum(e["reciprocal_ranks"]) / n, 4),
                "hit_rate": round(sum(e["hits_at_10"]) / n, 4),
                "median_rank": round(sorted(e["ranks"])[len(e["ranks"]) // 2], 1) if e["ranks"] else None,
                "mean_rank": round(sum(e["ranks"]) / len(e["ranks"]), 1) if e["ranks"] else None,
                "first_hit_pct": round(sum(e["hits_at_5"]) / n * 100, 1),
            }

        return metrics


# ═══════════════════════════════════════════════════════════════
# 阶段 4：报告
# ═══════════════════════════════════════════════════════════════

def print_report(metrics: Dict[str, Dict]):
    """Print a formatted comparison table"""

    exp_labels = {
        "A_vector": "A: 纯向量",
        "B_vector_graph": "B: 向量+图",
        "C_vector_bm25": "C: 向量+BM25",
        "D_hyde_vector": "D: HyDE+向量",
        "E_full_combo": "E: 全组合",
    }

    print("\n" + "=" * 80)
    print("  GraphRAG 检索质量消融评估报告")
    print("=" * 80)

    header = f"{'实验':<22} {'N':>5} {'R@5':>8} {'R@10':>8} {'MRR':>8} {'Hit%':>8} {'MedRank':>8}"
    print(header)
    print("-" * 80)

    # Sort: A, B, C, D, E
    order = ["A_vector", "B_vector_graph", "C_vector_bm25", "D_hyde_vector", "E_full_combo"]
    baseline_r5 = None

    for exp in order:
        if exp not in metrics:
            continue
        label = exp_labels.get(exp, exp)
        m = metrics[exp]
        if m.get("n_queries", 0) == 0:
            continue

        if baseline_r5 is None and exp == "A_vector":
            baseline_r5 = m.get("recall_at_5", 0)

        delta = ""
        if baseline_r5 and baseline_r5 > 0 and exp != "A_vector":
            d = (m.get("recall_at_5", 0) - baseline_r5) / baseline_r5 * 100
            delta = f" Δ={d:+.0f}%"

        print(f"{label:<22} {m.get('n_queries',0):>5} "
              f"{m.get('recall_at_5',0):>8.4f} {m.get('recall_at_10',0):>8.4f} "
              f"{m.get('mrr',0):>8.4f} {m.get('first_hit_pct',0):>7.1f}% "
              f"{str(m.get('median_rank','-')):>8} {delta}")

    print("-" * 80)
    print()

    # Analysis
    best_exp = max(metrics.items(), key=lambda x: x[1].get("recall_at_5", 0))
    try:
        print(f">> Best Recall@5: {exp_labels.get(best_exp[0], best_exp[0])} ({best_exp[1].get('recall_at_5', 0):.4f})")
    except UnicodeEncodeError:
        print(f"Best Recall@5: {exp_labels.get(best_exp[0], best_exp[0])} ({best_exp[1].get('recall_at_5', 0):.4f})")
    print()

    # Delta analysis
    if "A_vector" in metrics and metrics["A_vector"].get("n_queries", 0) > 0:
        base = metrics["A_vector"]["recall_at_5"]
        print("Delta vs pure vector baseline (A):")
        for exp in order[1:]:
            if exp not in metrics or exp == "A_vector":
                continue
            m = metrics[exp]
            if base > 0:
                gain = (m["recall_at_5"] - base) / base * 100
                bar = "#" * max(1, int(abs(gain) / 2))
                print(f"  {exp_labels.get(exp, exp):<18} R@5={m['recall_at_5']:.4f}  {bar} {gain:+.1f}%")
    print()

    # MRR analysis
    print("Mean Reciprocal Rank:")
    for exp in order:
        if exp not in metrics:
            continue
        m = metrics[exp]
        print(f"  {exp_labels.get(exp, exp):<22} MRR={m.get('mrr', 0):.4f}  (中位排名={m.get('median_rank', '-')})")


def main():
    logger.info("=" * 60)
    logger.info("GraphRAG 检索质量消融评估 启动")
    logger.info("=" * 60)

    # ── 加载 checkpoint ─────────────────────────────────────
    checkpoint = {}
    if CHECKPOINT_FILE.exists():
        try:
            checkpoint = json.loads(CHECKPOINT_FILE.read_text(encoding="utf-8"))
            logger.info(f"📂 加载 checkpoint: {len(checkpoint.get('test_set', {}))} 篇论文已处理")
        except Exception:
            logger.warning("Checkpoint 损坏，从头开始")

    # ── 初始化客户端 ────────────────────────────────────────
    nc = Neo4jConnection()
    emb_client = QwenEmbeddingClient()
    qwen_cfg = get_qwen_max_config()
    llm_client = QwenMaxClient(
        api_key=qwen_cfg["api_key"],
        base_url=qwen_cfg["base_url"],
        model=qwen_cfg["model"],
    )

    # ── 阶段 1: 生成测试集 ─────────────────────────────────
    if "test_set" not in checkpoint or not checkpoint["test_set"]:
        logger.info("\n📝 阶段 1: 自动构造测试集")
        generator = TestQueryGenerator(llm_client)
        test_set = generator.run(nc)
        checkpoint["test_set"] = test_set
        checkpoint["generated_at"] = datetime.now().isoformat()
        CHECKPOINT_FILE.write_text(json.dumps(checkpoint, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        test_set = checkpoint["test_set"]
        total_q = sum(len(v.get("questions", [])) for v in test_set.values())
        logger.info(f"📂 复用已有测试集: {len(test_set)} 篇论文, {total_q} 个问题")

    # ── 阶段 2: 消融实验 ────────────────────────────────────
    if "ablation_done" not in checkpoint:
        logger.info("\n🔬 阶段 2: 消融实验")
        runner = AblationRunner(emb_client, llm_client)
        test_set = runner.run_all(nc, test_set)
        checkpoint["test_set"] = test_set
        checkpoint["ablation_done"] = True
        checkpoint["ablation_at"] = datetime.now().isoformat()
        CHECKPOINT_FILE.write_text(json.dumps(checkpoint, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        total_q = sum(len(v.get("results", {}).get("query_texts", [])) for v in test_set.values())
        logger.info(f"📂 复用已有消融结果: {total_q} 个查询已评估")

    # ── 阶段 3: 计算指标 ────────────────────────────────────
    logger.info("\n📊 阶段 3: 指标计算")
    computer = MetricsComputer()
    metrics = computer.compute(test_set)

    # ── 阶段 4: 报告 ────────────────────────────────────────
    print_report(metrics)

    # ── 保存完整结果 ────────────────────────────────────────
    full_report = {
        "timestamp": datetime.now().isoformat(),
        "config": {
            "papers": len(test_set),
            "questions_per_paper": QUESTIONS_PER_PAPER,
            "top_k": TOP_K_VALUES,
            "hyde_enabled": HYDE_ENABLED,
        },
        "metrics": metrics,
        "test_set_summary": {
            paper: {
                "n_questions": len(v.get("questions", [])),
                "n_ground_truth": len(v.get("ground_truth_entities", [])),
            }
            for paper, v in test_set.items()
        },
    }
    RESULT_FILE.write_text(json.dumps(full_report, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"\n📄 完整报告已保存: {RESULT_FILE}")

    nc.close()
    logger.info("✅ 评估完成")


if __name__ == "__main__":
    main()

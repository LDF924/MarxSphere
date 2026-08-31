#!/usr/bin/env python3
"""verify_claim.py — 引文三维核验 (V399: Rimagination/citation-lab 移植)
三维核验:
  ① 元数据真伪: Crossref + OpenAlex 多源查证标题/年份/作者
  ② 语境相关性: 引用上下文 vs 官方摘要 语义相似度 + 意图分类
  ③ 断言支持度: 断言 vs 摘要 关键词覆盖率 + 方向性/否定冲突检测
设计对齐 citation-lab: 状态 green/yellow/white/red, 得分 0-1, 证据句提取。

用法:
  python verify_claim.py "<断言句>" [--doi DOI] [--title TITLE] [--text 官方摘要] [--context 上下文]
输出: JSON
"""
import json
import math
import re
import sys
from collections import Counter
from difflib import SequenceMatcher

import requests

CROSSREF_API = "https://api.crossref.org/works"
OPENALEX_API = "https://api.openalex.org/works"
EMAIL = "sag-marx@outlook.com"

STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
    "by", "is", "are", "was", "were", "that", "this", "it", "we", "our",
    "their", "can", "could", "be", "from", "using", "use", "based", "study",
    "paper", "research", "和", "与", "以及", "进行", "研究", "表明", "可以",
    "能够", "一种", "通过", "对", "在", "中", "的", "了", "是", "我们", "认为",
    "本文", "指出", "发现", "结果", "显示", "说明", "具有", "作用", "影响",
}

INTENT_KEYWORDS = {
    "background": {"background", "review", "overview", "现状", "背景", "综述", "概述", "基础"},
    "result": {"found", "showed", "result", "发现", "结果显示", "显著", "结果表明"},
    "method": {"method", "approach", "technique", "方法", "模型", "算法", "框架"},
}

NEGATION_WORDS = {"not", "no", "never", "without", "lack", "unable", "failed",
                  "并非", "不是", "没有", "未", "缺乏", "无法", "否认"}

DIRECTION_INCREASE = {"increase", "improve", "enhance", "raise", "promote", "more",
                      "增长", "提高", "促进", "增强", "提升", "上升", "增加"}
DIRECTION_DECREASE = {"decrease", "reduce", "decline", "lower", "less", "weaken",
                      "下降", "减少", "降低", "减弱", "下滑", "抑制"}

NULL_EFFECT = {"no significant", "not significant", "no effect", "insignificant",
               "不显著", "无显著", "没有显著", "无影响"}

TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z\-]{1,}|[0-9]+(?:\.[0-9]+)?|[一-鿿]{2,}")
SENTENCE_RE = re.compile(r"(?<=[。！？!?\.])\s+")
DOI_RE = re.compile(r"(10\.\d{4,9}/[-._;()/:A-Z0-9]+)", re.IGNORECASE)


# ─── 工具函数 ───
def _tokens(text: str) -> list[str]:
    return [t.lower() for t in TOKEN_RE.findall(text or "") if t.lower() not in STOPWORDS]


def _cosine_similarity(left: str, right: str) -> float:
    lt, rt = Counter(_tokens(left)), Counter(_tokens(right))
    if not lt or not rt:
        return 0.0
    inter = sum((lt & rt).values())
    denom = math.sqrt(sum(v * v for v in lt.values())) * math.sqrt(sum(v * v for v in rt.values()))
    return inter / denom if denom > 0 else 0.0


def _best_evidence_sentence(query: str, document: str) -> tuple[str | None, float]:
    """在摘要/全文中找与断言最相关的证据句 (citation-lab 同思路)"""
    sentences = [s.strip() for s in SENTENCE_RE.split(document or "") if len(s.strip()) >= 15]
    best, best_score = None, 0.0
    for s in sentences:
        sc = _cosine_similarity(query, s)
        if sc > best_score:
            best, best_score = s, sc
    return best, best_score


def _classify_intent(text: str) -> str:
    t = (text or "").lower()
    scores = {k: sum(1 for w in v if w in t) for k, v in INTENT_KEYWORDS.items()}
    return max(scores, key=scores.get) if max(scores.values()) > 0 else "unknown"


def _is_cross_lingual(left: str, right: str) -> bool:
    lc = len(re.findall(r"[一-鿿]", left or ""))
    rc = len(re.findall(r"[一-鿿]", right or ""))
    return (lc > 0 and rc == 0) or (lc == 0 and rc > 0)


def _fuzzy_coverage(claim_tokens: set[str], abstract_tokens: set[str]) -> float:
    if not claim_tokens:
        return 0.0
    covered = sum(1 for t in claim_tokens if any(SequenceMatcher(None, t, at).ratio() >= 0.8 for at in abstract_tokens))
    return covered / len(claim_tokens)


def _has_negation(text: str) -> bool:
    t = (text or "").lower()
    return any(w in t for w in NEGATION_WORDS)


def _directionality(text: str) -> set[str]:
    directions: set[str] = set()
    t = (text or "").lower()
    if any(p in t for p in NULL_EFFECT):
        directions.add("null")
    if any(w in t for w in DIRECTION_INCREASE):
        directions.add("increase")
    if any(w in t for w in DIRECTION_DECREASE):
        directions.add("decrease")
    return directions


def _has_directional_conflict(claim: str, evidence: str | None) -> bool:
    cd, ed = _directionality(claim), _directionality(evidence or "")
    if not cd or not ed:
        return False
    if "increase" in cd and ("decrease" in ed or "null" in ed):
        return True
    if "decrease" in cd and ("increase" in ed or "null" in ed):
        return True
    return False


def _detect_domain(text: str) -> str:
    t = (text or "").lower()
    domains = {
        "economics": ["经济", "market", "capital", "labor", "gdp", "growth", "投资", "金融", "产业"],
        "agriculture": ["农", "土地", "rural", "agricult", "farm", "耕地", "农村", "粮食"],
        "political": ["政治", "政", "party", "government", "治理", "policy", "政策", "制度"],
        "environment": ["环境", "climate", "ecolog", "carbon", "污染", "生态", "排放"],
        "medical": ["clinical", "patient", "disease", "治疗", "临床", "患者", "疾病"],
        "ai_ml": ["neural", "deep learning", "transformer", "模型", "算法", "dataset", "训练"],
    }
    best, best_score = "unknown", 0
    for name, kws in domains.items():
        sc = sum(1 for k in kws if k in t)
        if sc > best_score:
            best, best_score = name, sc
    return best if best_score >= 2 else "unknown"


# ─── 元数据查证 (Crossref + OpenAlex) ───
def _query_crossref(doi: str) -> dict | None:
    try:
        r = requests.get(f"{CROSSREF_API}/{doi}", timeout=15, headers={"User-Agent": f"MarxSphere/1.0 mailto:{EMAIL}"})
        if r.status_code != 200:
            return None
        m = r.json().get("message", {})
        return {
            "title": (m.get("title") or [""])[0],
            "year": (m.get("issued", {}).get("date-parts", [[None]])[0][0]),
            "authors": [a.get("family", "") for a in (m.get("author") or [])][:6],
            "journal": (m.get("container-title") or [""])[0],
            "source": "crossref",
        }
    except Exception:
        return None


def _query_openalex(doi: str) -> dict | None:
    try:
        r = requests.get(f"{OPENALEX_API}/doi:{doi}", timeout=15, params={"mailto": EMAIL})
        if r.status_code != 200:
            return None
        d = r.json()
        return {
            "title": d.get("title") or "",
            "year": d.get("publication_year"),
            "authors": [a.get("author", {}).get("display_name", "") for a in (d.get("authorships") or [])[:6]],
            "journal": (d.get("primary_location") or {}).get("source", {}).get("display_name", "") if (d.get("primary_location") or {}).get("source") else "",
            "abstract": d.get("abstract_inverted_index"),
            "source": "openalex",
        }
    except Exception:
        return None


def _decode_inverted_abstract(inverted: dict | None) -> str | None:
    """OpenAlex abstract_inverted_index → 摘要文本"""
    if not inverted:
        return None
    pos = {}
    for word, idxs in inverted.items():
        for i in idxs:
            pos[i] = word
    return " ".join(pos[i] for i in sorted(pos)) if pos else None


# ─── 三维核验 ───
def verify_metadata(doi: str | None, title: str | None) -> dict:
    """① 元数据真伪: 多源查证"""
    if not doi and not title:
        return {"status": "white", "label": "无法核验", "score": 0.35,
                "reason": "引用未提供 DOI/标题, 无法查证文献真实性。"}

    crossref = _query_crossref(doi) if doi else None
    openalex = _query_openalex(doi) if doi else None
    found = [s for s in (crossref, openalex) if s]
    if not found:
        return {"status": "red", "label": "疑似捏造", "score": 0.05,
                "reason": f"Crossref/OpenAlex 均未命中 (doi={doi or '无'}), 疑似捏造或信息缺失。"}

    official = found[0]
    source_names = " + ".join(s["source"] for s in found)
    # 标题比对
    title_ok = True
    if title and official.get("title"):
        title_ok = SequenceMatcher(None, title.lower()[:40], official["title"].lower()[:40]).ratio() >= 0.6
    if not title_ok:
        return {"status": "yellow", "label": "标题偏差", "score": 0.6,
                "reason": f"多源命中({source_names}) 但标题与官方记录偏差较大。"}
    return {"status": "green", "label": "真实", "score": 0.95,
            "reason": f"多源命中({source_names})，标题匹配。官方: {official.get('title', '')[:60]} ({official.get('year', '?')})"}


def evaluate_relevance(context: str, abstract: str | None) -> dict:
    """② 语境相关性: 引用上下文 vs 官方摘要"""
    if not abstract:
        return {"status": "white", "label": "无摘要", "score": 0.35,
                "reason": "未获取到官方摘要, 无法做语义相关性判断。"}
    if not context:
        return {"status": "white", "label": "无上下文", "score": 0.45,
                "reason": "未提供引用上下文, 相关性无法判定 (提供 context 可提升核验质量)。"}

    similarity = _cosine_similarity(context, abstract)
    ev_sentence, ev_score = _best_evidence_sentence(context, abstract)
    context_intent = _classify_intent(context)
    is_background = context_intent == "background"
    cross_lingual = _is_cross_lingual(context, abstract)

    if cross_lingual and similarity < 0.08 and ev_score < 0.08:
        status, score = "white", 0.45
    elif is_background:
        status = "yellow" if similarity < 0.10 else "green"
        score = 0.55 if status == "yellow" else 0.85
    else:
        status = "yellow" if similarity < 0.12 else "green"
        score = 0.55 if status == "yellow" else 0.85

    reason = (f"语义相似度={similarity:.3f}, 证据句匹配={ev_score:.3f}, "
              f"上下文意图={context_intent}{', 跨语言' if cross_lingual else ''}。"
              f"证据句: {(ev_sentence or '未提取到')[:100]}")
    return {"status": status, "label": "相关" if status == "green" else "弱相关", "score": round(score, 3), "reason": reason}


def evaluate_support(claim: str, abstract: str | None, context: str | None) -> dict:
    """③ 断言支持度: 断言 vs 摘要 覆盖率 + 冲突检测"""
    if not abstract:
        return {"status": "white", "label": "无摘要", "score": 0.35,
                "reason": "仅凭当前信息无法判断断言支持度。"}

    similarity = _cosine_similarity(claim, abstract)
    ev_sentence, ev_score = _best_evidence_sentence(claim, abstract)
    claim_tokens = set(_tokens(claim))
    if not claim_tokens:
        return {"status": "white", "label": "无断言词", "score": 0.35, "reason": "未能从断言句抽取有效关键词。"}

    coverage = _fuzzy_coverage(claim_tokens, set(_tokens(abstract)))
    ev_text = ev_sentence or abstract
    negation_conflict = _has_negation(claim) != _has_negation(ev_text)
    directional_conflict = _has_directional_conflict(claim, ev_text)

    claim_domain = _detect_domain(f"{context or ''} {claim}")
    ref_domain = _detect_domain(abstract)
    if claim_domain != "unknown" and ref_domain != "unknown" and claim_domain != ref_domain:
        return {"status": "red", "label": "领域冲突", "score": 0.18,
                "reason": f"检测到领域冲突(断言={claim_domain}, 文献={ref_domain}), 覆盖率={coverage:.3f}。"}

    if directional_conflict and (coverage >= 0.18 or similarity >= 0.10):
        return {"status": "red", "label": "方向冲突", "score": 0.15,
                "reason": f"检测到方向性结论冲突(覆盖率={coverage:.3f}, 相似度={similarity:.3f})。"}
    if negation_conflict and (similarity >= 0.12 or ev_score >= 0.12):
        return {"status": "red", "label": "否定冲突", "score": 0.15,
                "reason": f"检测到潜在否定语义冲突(相似度={similarity:.3f}, 覆盖率={coverage:.3f})。"}

    if coverage >= 0.62 or (coverage >= 0.45 and similarity >= 0.20):
        status, score = "green", 0.9
    elif coverage >= 0.18 or similarity >= 0.10:
        status, score = "yellow", 0.62
    else:
        status, score = "yellow", 0.4

    reason = (f"摘要对断言关键词覆盖率={coverage:.3f}, 相似度={similarity:.3f}, "
              f"证据句匹配={ev_score:.3f}。证据句: {(ev_sentence or '未提取到')[:100]}")
    return {"status": status, "label": "支持" if status == "green" else "支持不足", "score": round(score, 3), "reason": reason}


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "用法: verify_claim.py <断言句> [--doi DOI] [--title TITLE] [--text 摘要] [--context 上下文]"}))
        return 1
    claim = sys.argv[1]
    doi = title = text = context = None
    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--doi" and i + 1 < len(sys.argv): doi = sys.argv[i + 1]; i += 2
        elif sys.argv[i] == "--title" and i + 1 < len(sys.argv): title = sys.argv[i + 1]; i += 2
        elif sys.argv[i] == "--text" and i + 1 < len(sys.argv): text = sys.argv[i + 1]; i += 2
        elif sys.argv[i] == "--context" and i + 1 < len(sys.argv): context = sys.argv[i + 1]; i += 2
        else: i += 1

    # 摘要缺省时从 OpenAlex 拉取
    abstract = text
    meta = None
    if doi:
        meta = _query_openalex(doi) or _query_crossref(doi)
        if meta and not abstract:
            abstract = _decode_inverted_abstract(meta.get("abstract")) if meta.get("abstract") and isinstance(meta.get("abstract"), dict) else None
            if not abstract and meta.get("abstract") and isinstance(meta.get("abstract"), str):
                abstract = meta["abstract"]
    if not abstract and title and not doi:
        try:
            r = requests.get(OPENALEX_API, params={"search": title, "per-page": 1, "mailto": EMAIL}, timeout=15)
            if r.status_code == 200:
                results = r.json().get("results") or []
                if results:
                    abstract = _decode_inverted_abstract(results[0].get("abstract_inverted_index"))
        except Exception:
            pass

    dim_metadata = verify_metadata(doi, title)
    dim_relevance = evaluate_relevance(context or "", abstract)
    dim_support = evaluate_support(claim, abstract, context)

    order = ["red", "yellow", "green", "white"]
    statuses = [dim_metadata["status"], dim_relevance["status"], dim_support["status"]]
    overall_status = next((s for s in order if s in statuses), "white")
    overall_score = round(sum(d["score"] for d in (dim_metadata, dim_relevance, dim_support)) / 3, 3)

    print(json.dumps({
        "ok": True,
        "dimensions": {
            "metadata": dim_metadata,
            "relevance": dim_relevance,
            "support": dim_support,
        },
        "overall": {"status": overall_status, "score": overall_score},
        "abstract_available": bool(abstract),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

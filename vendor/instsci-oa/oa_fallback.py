#!/usr/bin/env python3
"""oa_fallback.py — 英文文献 OA 回退 (提炼自 Rimagination/instsci)
仅依赖 requests; unpaywall DOI 查 OA + arXiv 检索/元数据。

用法:
  python oa_fallback.py oa <DOI>            # Unpaywall 查 OA
  python oa_fallback.py search <query> [max]# arXiv 检索
  python oa_fallback.py meta <arxiv_id>     # arXiv 元数据
输出: JSON 到 stdout (供 TS 端 execFileSync 解析)
"""
import json
import os
import re
import sys
import time

import requests

UNPAYWALL_API = "https://api.unpaywall.org/v2"
ARXIV_API = "https://export.arxiv.org/api/query"  # 注意: http 被墙, 必须 https
ARXIV_PDF_BASE = "https://arxiv.org/pdf"
ARXIV_ABS_BASE = "https://arxiv.org/abs"
OPENALEX_API = "https://api.openalex.org/works"
EMAIL = os.environ.get("UNPAYWALL_EMAIL") or "sag-marx@outlook.com"  # Unpaywall ToS 要求提供 email; 可用 .env 覆盖


def request_with_retry(method, url, params=None, timeout=15, tries=3):
    last = None
    for i in range(tries):
        try:
            r = requests.request(method, url, params=params, timeout=timeout)
            if r.status_code in (429, 502, 503, 504) and i < tries - 1:
                time.sleep(2 * (i + 1))
                continue
            return r
        except requests.RequestException as e:
            last = e
            time.sleep(1 + i)
    raise last if last else RuntimeError("request failed")


def check_oa(doi):
    """Unpaywall: DOI → OA 信息 (提炼自 instsci/sources/unpaywall.py)"""
    url = f"{UNPAYWALL_API}/{doi}?email={EMAIL}"
    try:
        resp = request_with_retry("GET", url, timeout=10)
        if resp.status_code == 404:
            return {"is_oa": False}
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return {"is_oa": False}

    result = {
        "is_oa": data.get("is_oa", False),
        "title": data.get("title", ""),
        "journal": data.get("journal_name", ""),
        "year": data.get("year"),
        "doi": doi,
    }
    authors = []
    for a in (data.get("z_authors") or []):
        name = " ".join(x for x in [a.get("given"), a.get("family")] if x)
        if name:
            authors.append(name)
    result["authors"] = authors

    if not result["is_oa"]:
        return result

    best = data.get("best_oa_location") or {}
    result["pdf_url"] = best.get("url_for_pdf", "") or ""
    result["html_url"] = best.get("url_for_landing_page", "") or ""
    repo = best.get("repository_institution", "") or ""
    host_type = best.get("host_type", "")
    joined = (result["pdf_url"] + result["html_url"] + repo).lower()
    if "arxiv" in joined:
        result["source"] = "arxiv"
    elif host_type == "publisher":
        result["source"] = "publisher"
    else:
        result["source"] = "repository"

    if not result["pdf_url"]:
        for loc in (data.get("oa_locations") or []):
            pdf = loc.get("url_for_pdf", "") or ""
            if pdf:
                result["pdf_url"] = pdf
                break
    return result


def arxiv_search(query, max_results=5):
    """arXiv API 检索 (提炼自 instsci/sources/arxiv.py)"""
    try:
        resp = request_with_retry("GET", ARXIV_API, params={"search_query": f'all:"{query}"', "max_results": max_results}, timeout=15)
        resp.raise_for_status()
    except Exception:
        return {"ok": False, "error": "arXiv API 请求失败"}
    text = resp.text
    entries = re.findall(r"<entry>(.*?)</entry>", text, re.S)
    out = []
    for e in entries:
        title = re.search(r"<title>(.*?)</title>", e, re.S)
        link = re.search(r'<id>http://arxiv\.org/abs/([^<]+)</id>', e)
        summary = re.search(r"<summary>(.*?)</summary>", e, re.S)
        published = re.search(r"<published>(\d{4})", e)
        authors = re.findall(r"<name>([^<]+)</name>", e)
        out.append({
            "title": (title.group(1).strip() if title else "").replace("\n", " "),
            "arxiv_id": link.group(1) if link else "",
            "abstract": (summary.group(1).strip() if summary else "").replace("\n", " ")[:400],
            "year": int(published.group(1)) if published else None,
            "authors": authors[:8],
            "pdf_url": f"{ARXIV_PDF_BASE}/{link.group(1)}.pdf" if link else "",
            "abs_url": f"{ARXIV_ABS_BASE}/{link.group(1)}" if link else "",
        })
    return {"ok": True, "total": len(out), "items": out}


def arxiv_metadata(arxiv_id):
    """arXiv ID → 元数据 (提炼自 instsci/sources/arxiv.py)"""
    clean_id = re.sub(r"v\d+$", "", arxiv_id)
    try:
        resp = request_with_retry("GET", ARXIV_API, params={"id_list": clean_id, "max_results": 1}, timeout=15)
        resp.raise_for_status()
    except Exception:
        return {"ok": False, "error": "arXiv API 请求失败"}
    e = re.search(r"<entry>(.*?)</entry>", resp.text, re.S)
    if not e:
        return {"ok": False, "error": f"arXiv ID {arxiv_id} 未找到"}
    e = e.group(1)
    title = re.search(r"<title>(.*?)</title>", e, re.S)
    summary = re.search(r"<summary>(.*?)</summary>", e, re.S)
    published = re.search(r"<published>(\d{4}-\d{2}-\d{2})", e)
    authors = re.findall(r"<name>([^<]+)</name>", e)
    return {
        "ok": True,
        "arxiv_id": clean_id,
        "title": (title.group(1).strip() if title else "").replace("\n", " "),
        "abstract": (summary.group(1).strip() if summary else "").replace("\n", " ")[:600],
        "published": published.group(1) if published else "",
        "authors": authors[:8],
        "pdf_url": f"{ARXIV_PDF_BASE}/{clean_id}.pdf",
        "abs_url": f"{ARXIV_ABS_BASE}/{clean_id}",
    }


def openalex_search(query, max_results=5):
    """OpenAlex 检索 (国内可达的英文文献源; 含 OA 标记/DOI)"""
    try:
        resp = request_with_retry("GET", OPENALEX_API, params={"search": query, "per-page": max_results, "mailto": EMAIL}, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return {"ok": False, "error": "OpenAlex 请求失败"}
    out = []
    for w in (data.get("results") or []):
        oa_url = ""
        oa_loc = w.get("best_oa_location") or {}
        if oa_loc:
            oa_url = oa_loc.get("pdf_url") or oa_loc.get("landing_page_url") or ""
        authors = [a.get("author", {}).get("display_name", "") for a in (w.get("authorships") or [])[:8]]
        out.append({
            "title": w.get("title") or "",
            "doi": w.get("doi") or "",
            "year": w.get("publication_year"),
            "journal": (w.get("primary_location") or {}).get("source", {}).get("display_name") if (w.get("primary_location") or {}).get("source") else "",
            "authors": authors,
            "is_oa": bool(w.get("open_access", {}).get("is_oa")),
            "oa_url": oa_url,
            "cited_by": w.get("cited_by_count"),
        })
    return {"ok": True, "total": len(out), "items": out}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "用法: oa <DOI> | search <query> [max] | openalex <query> [max] | meta <id>"}))
        return 1
    cmd = sys.argv[1]
    if cmd == "oa" and len(sys.argv) >= 3:
        print(json.dumps(check_oa(sys.argv[2]), ensure_ascii=False))
    elif cmd == "search" and len(sys.argv) >= 3:
        maxr = int(sys.argv[3]) if len(sys.argv) >= 4 else 5
        print(json.dumps(arxiv_search(sys.argv[2], maxr), ensure_ascii=False))
    elif cmd == "openalex" and len(sys.argv) >= 3:
        maxr = int(sys.argv[3]) if len(sys.argv) >= 4 else 5
        print(json.dumps(openalex_search(sys.argv[2], maxr), ensure_ascii=False))
    elif cmd == "meta" and len(sys.argv) >= 3:
        print(json.dumps(arxiv_metadata(sys.argv[2]), ensure_ascii=False))
    else:
        print(json.dumps({"ok": False, "error": "参数错误"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

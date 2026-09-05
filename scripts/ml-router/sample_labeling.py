#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""sample_labeling.py — V405-ML: 人工标注抽样(方案 1)

从 query_tasks 去重/去噪后, 按"规则建议档位"分层 + 多样性(查询文本互异)抽 ~180 条,
写 data/ml-router/labeling.tsv (utf-8, tab 分隔):
  id<TAB>query<TAB>rule_suggest<TAB>human_label<TAB>note
- rule_suggest 列已预填轻量规则建议(lite/standard/deep) — 标注人仅需改不同意者
- human_label 留空, 标注人填 lite|standard|deep
- 抽完打印待标数与已覆盖的规则建议分布
用法: python scripts/ml-router/sample_labeling.py [n=180]
"""
import json
import re
import sys
from collections import Counter, OrderedDict
from pathlib import Path

import pg8000

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "ml-router"))
from router_features import rule_suggest  # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 180
OUT = ROOT / "data" / "ml-router" / "labeling.tsv"

# 噪声过滤: 纯符号/过短/明显非问题
_NOISE_RE = re.compile(
    r"^(?:测试|test|hello|hi|你好|demo|示例|example|请$|帮我$|谢谢|好的|ok|OK|\d+)$"
)
_STOP = {"", " ", "test", "测试", "demo", "示例", "你好", "hello", "hi"}


def main():
    conn = pg8000.connect(
        host="127.0.0.1", port=5540, user="sag_lite",
        password="sag_lite_pass", database="sag_lite",
    )
    cur = conn.cursor()
    cur.execute("""
        select t.id::text, t.query
        from query_tasks t
        where t.query is not null and t.query <> ''
          and t.query ~ '[一-鿿]'
        order by t.created_at desc
    """)
    rows = cur.fetchall()

    seen = set()
    uniq = []
    for tid, q in rows:
        q = (q or "").strip()
        if len(q) < 4 or len(q) > 400:
            continue
        if q in _STOP or _NOISE_RE.match(q):
            continue
        norm = re.sub(r"[\s，。！？、,;:：()（）【】\"'“”‘’《》]+", "", q)
        if norm in seen or len(norm) < 4:
            continue
        seen.add(norm)
        uniq.append((tid, q))

    print(f"去重后唯一查询: {len(uniq)}")

    # 按规则建议分层抽样(保三类都有; 突出 standard 与 deep 便于覆盖模型盲区)
    buckets: dict[str, list[tuple[str, str]]] = {"lite": [], "standard": [], "deep": []}
    for tid, q in uniq:
        buckets[rule_suggest(q)].append((tid, q))

    for k, v in buckets.items():
        print(f"  规则建议 {k}: {len(v)} 条")

    quota = {"lite": max(10, int(N * 0.30)),
             "standard": max(10, int(N * 0.35)),
             "deep": max(10, int(N * 0.35))}
    picked: list[tuple[str, str, str]] = []  # (tid, q, rule)
    for k in ("lite", "standard", "deep"):
        pool = buckets[k]
        # 优先挑与该桶内其它文本差异大的(多样性: 贪心按归一长度/字符集散列粗分)
        pool_sorted = sorted(pool, key=lambda x: (len(x[1]) % 7, x[1][:2]))
        n_need = min(quota[k], len(pool))
        picked.extend((tid, q, k) for tid, q in pool_sorted[:n_need])

    # 若某桶不足, 从其它桶补充到总量 N
    if len(picked) < N:
        have = {p[2] for p in picked}
        for tid, q in uniq:
            if len(picked) >= N:
                break
            r = rule_suggest(q)
            if r not in have or picked.count(r) < 1:
                picked.append((tid, q, r))

    picked = picked[:N]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("id\tquery\trule_suggest\thuman_label\tnote\n")
        for tid, q, r in picked:
            q_clean = q.replace("\t", " ").replace("\n", " ")
            f.write(f"{tid}\t{q_clean}\t{r}\t\t\n")

    dist = Counter(p[2] for p in picked)
    print(f"已生成标注文件: {OUT}")
    print(f"待标 {len(picked)} 条 | 规则建议分布: {dict(dist)}")
    print("标注口径: lite=短概念/事实直接快答可满足; standard=常规需三库检索; "
          "deep=政策评估/引证核验/综述比较等深链")
    print("提示: 重点复核与直觉不符的建议(建议值≠您判断处), 全部填完保存后运行 "
          "python scripts/ml-router/train_router_human.py")


if __name__ == "__main__":
    main()

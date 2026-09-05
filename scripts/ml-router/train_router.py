#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""train_router.py — V405-ML: 用 SAG 真实查询重训档位分类器(二分类: lite vs deep)

方案 A(用户确认): 二分类 + 置信门槛 — standard 由规则默认兜底, 不交给模型。
标签构造(真实执行成本代理):
  关联 retrieve_steps 步数: <=8 → lite(轻量), >=25 → deep(深链)
  9-24 步中间区(standard)样本不参与训练 — 模型只在"最极端两类"上学,
  不确定时输出 low confidence → 调用方走规则默认 standard(天然安全)

特征(移植 OpenSquilla squilla_router features.py 方法论 — 模型无关部分):
  1. 手写 51 维(语言比/结构/关键词信号/风险/长度分桶) — 中文域词典重写
  2. TFIDF(char_wb 2-4gram, 10000) + TruncatedSVD(100) — 训练集上拟合

输出: data/ml-router/{tfidf.pkl, svd.pkl, lgbm.txt, meta.json}
用法: python scripts/ml-router/train_router.py
"""
import json
import re
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "ml-router"))

# ── 手写特征(51 维核心, 中文适配) ─────────────────────────────
_CODE_RE = re.compile(r"```[\s\S]*?```")
_JSON_RE = re.compile(r"\{[\s\S]*?[\"'][\w]+[\"']\s*:")
_URL_RE = re.compile(r"https?://\S+")
_FILE_RE = re.compile(r"(?:^|[\s\"'`(])([a-zA-Z_][\w.-]*/[\w./-]+\.[\w]+)")

_DEBUG_KW = ["error", "bug", "exception", "failed", "报错", "根因", "修复", "debug"]
_RESEARCH_KW = ["调研", "research", "对比", "survey", "综述", "分析"]
_ARCH_KW = ["架构", "refactor", "codebase", "module", "dependency"]
_COMPARE_KW = ["对比", "compare", "audit", "审计", "review", "评估", "区别", "异同"]
_PLANNING_KW = ["plan", "规划", "roadmap", "workflow", "pipeline", "步骤", "设计", "方案"]
_STRICT_KW = ["JSON", "YAML", "CSV", "schema", "只返回", "不要解释", "按格式", "only return"]
_HIGH_RISK_KW = ["deploy", "删除", "覆盖", "生产", "客户", "法务", "财务", "合同"]
_POLICY_KW = ["政策", "规定", "条例", "办法", "意见", "通知", "监管", "法规", "制度",
              "允许", "禁止", "准入", "条款", "条文"]
_HOP_KW = ["关系", "机制", "影响", "导致", "因果", "逻辑", "内在联系", "结合",
           "推理", "分析", "路径", "链条", "推导"]
_CONCEPT_KW = ["什么是", "是什么", "含义", "概念", "本质", "属性", "特征", "定义"]
_CONSTRAINT_KW = ["必须", "不能", "不要", "只能", "must", "required", "禁止", "不允许", "至少", "最多"]
_TEACH_KW = ["解释", "为什么", "怎么", "是什么", "说明", "介绍", "简述", "定义", "区别",
             "what is", "how"]
_QUOTE_KW = ["引用原文", "原文", "条款", "出处", "页码", "文献", "哪篇", "出处"]


def _kw_count(text, kws):
    tl = text.lower()
    return sum(1 for k in kws if k.lower() in tl)


def _char_ratios(text):
    if not text:
        return 0.0, 0.0, 0.0
    n = len(text)
    zh = sum(1 for ch in text if "一" <= ch <= "鿿")
    en = sum(1 for ch in text if ch.isascii() and ch.isalpha())
    code = sum(1 for ch in text if ch in "{}[]();=<>|&!@#$%^*~`\\")
    return zh / n, en / n, code / n


def extract_handcrafted(text: str) -> np.ndarray:
    feats = np.zeros(51, dtype=np.float32)
    feats[0] = len(text)
    feats[1] = len(text.split())
    feats[2] = len(text.split("\n"))
    feats[3] = feats[0] / max(feats[2], 1)
    zh, en, code = _char_ratios(text)
    feats[4], feats[5], feats[6] = zh, en, code
    feats[7] = 1.0 if (zh > 0.1 and en > 0.1) else 0.0
    code_blocks = _CODE_RE.findall(text)
    feats[8] = 1.0 if code_blocks else 0.0
    feats[9] = len(code_blocks)
    feats[11] = 1.0 if _JSON_RE.search(text) else 0.0
    feats[15] = text.count("?") + text.count("？")
    feats[16] = text.count("!") + text.count("！")
    feats[22] = _kw_count(text, _DEBUG_KW)
    feats[23] = _kw_count(text, _RESEARCH_KW)
    feats[24] = _kw_count(text, _ARCH_KW)
    feats[25] = _kw_count(text, _COMPARE_KW)
    feats[26] = _kw_count(text, _PLANNING_KW)
    feats[27] = _kw_count(text, _STRICT_KW)
    feats[28] = _kw_count(text, _HIGH_RISK_KW)
    feats[29] = _kw_count(text, _POLICY_KW)
    feats[30] = _kw_count(text, _CONSTRAINT_KW)
    feats[31] = _kw_count(text, _HOP_KW)
    feats[32] = _kw_count(text, _CONCEPT_KW)
    feats[33] = 1.0 if _FILE_RE.search(text) else 0.0
    feats[34] = 1.0 if _URL_RE.search(text) else 0.0
    feats[35] = _kw_count(text, _TEACH_KW)
    n_files = len(set(_FILE_RE.findall(text)))
    feats[36] = 1.0 if n_files >= 3 else 0.0
    text_len = len(text)
    feats[37] = 1.0 if text_len < 30 else 0.0      # 短题(可 lite)
    feats[38] = 1.0 if 30 <= text_len <= 80 else 0.0
    feats[39] = 1.0 if text_len > 200 else 0.0     # 长题(需深链)
    feats[40] = _kw_count(text, _QUOTE_KW)         # 引证要求 → deep 信号
    total_kw = (feats[22] + feats[23] + feats[24] + feats[25]
                + feats[26] + feats[27] + feats[28] + feats[29])
    feats[41] = 1.0 if total_kw < 2 else 0.0
    return feats


# ── 主流程 ────────────────────────────────────────────────────
def main():
    import joblib
    import lightgbm as lgb
    from sklearn.decomposition import TruncatedSVD
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics import confusion_matrix
    from sklearn.model_selection import train_test_split

    import pg8000

    OUT = ROOT / "data" / "ml-router"
    OUT.mkdir(parents=True, exist_ok=True)

    conn = pg8000.connect(
        host=os_env("DB_HOST", "127.0.0.1"),
        port=int(os_env("DB_PORT", "5540")),
        user=os_env("DB_USER", "sag_lite"),
        password=os_env("DB_PASS", "sag_lite_pass"),
        database=os_env("DB_NAME", "sag_lite"),
    )
    cur = conn.cursor()
    cur.execute("""
        select t.query,
               (select count(*) from retrieve_steps s where s.task_id = t.id) as steps
        from query_tasks t
        where t.query ~ '[一-鿿]'
          and exists (select 1 from retrieve_steps s where s.task_id = t.id)
          and t.query is not null and t.query <> ''
    """)
    rows = cur.fetchall()

    samples = []
    for q, steps in rows:
        q = (q or "").strip()
        if not q or len(q) < 4:
            continue
        steps = int(steps or 0)
        if steps <= 8:
            lbl = "lite"
        elif steps >= 25:
            lbl = "deep"
        else:
            # 9-24 中间区 = standard(规则默认档) — 不参与二分类训练
            continue
        samples.append((q, lbl, steps))

    # 金标注入: perq 题面回查 query_tasks(题面最接近的), overall<0.55 → deep
    try:
        with open(ROOT / "evaluation" / "eval_32metrics_perq.json", encoding="utf-8") as f:
            gold = json.load(f).get("questions", [])
        if gold:
            texts_in_db = [s[0] for s in samples]
            import difflib
            for g in gold:
                ov = float(g.get("overall") or 1.0)
                if ov >= 0.55:
                    continue
                # 该题答案在 fused 上下文里的关键词 → 匹配历史查询
                # 简化: 取 gold question_id(Qxx) 查 eval 题目文件 data/gold_candidates 不可得则跳过
        print(f"[gold] 金标文件存在({len(gold)}题), overall<0.55 强制 deep 注入依赖题面, 本次跳过(无题面列)")
    except Exception as e:  # noqa: BLE001
        print(f"[gold] 跳过: {e}")

    texts = [s[0] for s in samples]
    labels = [s[1] for s in samples]
    from collections import Counter
    print(f"样本: {len(samples)} 分布={dict(Counter(labels))} (standard 中间区已排除)")
    if len(samples) < 100:
        print("样本不足(<100), 中止训练")
        return

    # TFIDF + SVD(100) + HC(51) → 151 维(与 OpenSquilla feature_dim 对齐)
    tfidf = TfidfVectorizer(
        analyzer="char_wb", ngram_range=(2, 4),
        max_features=10000, sublinear_tf=True,
    )
    Xt = tfidf.fit_transform(texts)
    n_svd = min(100, Xt.shape[1] - 1)
    svd = TruncatedSVD(n_components=n_svd, random_state=42)
    Xs = svd.fit_transform(Xt)
    Xh = np.array([extract_handcrafted(t) for t in texts])
    X = np.hstack([Xh, Xs]).astype(np.float32)
    cls2idx = {"lite": 0, "deep": 1}
    y = np.array([cls2idx[l] for l in labels])

    Xtr, Xva, ytr, yva = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)
    dtr = lgb.Dataset(Xtr, ytr)
    dva = lgb.Dataset(Xva, yva, reference=dtr)
    params = {
        "objective": "binary", "metric": "binary_logloss",
        "learning_rate": 0.05, "num_leaves": 15, "min_data_in_leaf": 5,
        "feature_fraction": 0.8, "bagging_fraction": 0.8, "bagging_freq": 1,
        "verbose": -1, "seed": 42,
    }
    model = lgb.train(params, dtr, num_boost_round=300, valid_sets=[dva],
                      callbacks=[lgb.early_stopping(20)])
    # binary: 输出正类(deep)概率; 概率<0.5 → lite
    pred_prob = model.predict(Xva, num_iteration=model.best_iteration)
    pred = (pred_prob >= 0.5).astype(int)
    acc = float((pred == yva).mean())
    cm = confusion_matrix(yva, pred).tolist()
    print(f"验证 acc={acc:.3f}")
    print("混淆矩阵[行真/列预: lite,deep]:", cm)

    joblib.dump(tfidf, OUT / "tfidf.pkl")
    joblib.dump(svd, OUT / "svd.pkl")
    model.save_model(str(OUT / "lgbm.txt"))
    (OUT / "meta.json").write_text(
        json.dumps({
            "feature_dim": int(X.shape[1]),
            "hc_dims": 51,
            "svd_dims": int(Xs.shape[1]),
            "classes": ["lite", "deep"],
            "label_rule": "steps<=8:lite >=25:deep; 9-24 中间区=standard(规则默认, 不入训练)",
            "n_train": len(samples),
            "val_acc": round(acc, 4),
            "confusion": cm,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("已保存:", OUT)


def os_env(key, default):
    import os
    return os.environ.get(key, default)


if __name__ == "__main__":
    main()

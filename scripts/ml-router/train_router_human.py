#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""train_router_human.py — V405-ML: 人工标签训练(方案 1)

读取 data/ml-router/labeling.tsv 的 human_label 列(跳过 note 非空行),
训练两类模型并对照:
  A. 二分类(lite vs deep) — 推荐上线: standard 由规则默认兜底
  B. 三分类(lite/standard/deep) — 对照(评估中间档可学性, 数据少则仅供参考)
输出: data/ml-router/{lgbm_bin.txt, lgbm_tri.txt, meta_human.json}
"""
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "ml-router"))
from router_features import extract_handcrafted  # noqa: E402

TSV = ROOT / "data" / "ml-router" / "labeling.tsv"
OUT = ROOT / "data" / "ml-router"


def main():
    import joblib
    import lightgbm as lgb
    from sklearn.decomposition import TruncatedSVD
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics import confusion_matrix
    from sklearn.model_selection import train_test_split

    samples = []
    with open(TSV, encoding="utf-8") as f:
        for line in f.read().splitlines()[1:]:
            parts = line.split("\t")
            if len(parts) < 5:
                continue
            _id, query, _rule, label, note = (parts + ["", "", "", ""])[:5]
            label = (label or "").strip().lower()
            if note and note.strip():
                continue  # 噪声行排除
            if label not in ("lite", "standard", "deep"):
                continue
            if not query or len(query) < 4:
                continue
            samples.append((query, label))

    if len(samples) < 60:
        print(f"有效样本不足: {len(samples)}"); return
    print(f"有效样本: {len(samples)} 分布={dict(Counter(s[1] for s in samples))}")

    texts = [s[0] for s in samples]
    # 特征复用: 训练集全体拟合 TFIDF/SVD(与 predict_router 的加载路径一致: 直接用已存资产拟合一致性存疑 →
    # 这里独立拟合并覆写 tfidf/svd, 训练与预测共用同一份资产)
    tfidf = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4),
                            max_features=10000, sublinear_tf=True)
    Xt = tfidf.fit_transform(texts)
    n_svd = min(100, Xt.shape[1] - 1)
    svd = TruncatedSVD(n_components=n_svd, random_state=42)
    Xs = svd.fit_transform(Xt)
    Xh = np.array([extract_handcrafted(t) for t in texts])
    X = np.hstack([Xh, Xs]).astype(np.float32)

    meta: dict = {"n": len(samples), "dist": dict(Counter(s[1] for s in samples))}

    # ── A. 二分类 lite vs deep ──
    bi_idx = [i for i, s in enumerate(samples) if s[1] in ("lite", "deep")]
    bi = [samples[i] for i in bi_idx]
    if len(bi) >= 80:
        print(f"\n── A. 二分类 lite/deep: {len(bi)} 样本 ──")
        Xb = X[bi_idx]
        yb = np.array([1 if l == "deep" else 0 for _, l in bi])
        Xtr, Xva, ytr, yva = train_test_split(Xb, yb, test_size=0.2, random_state=42, stratify=yb)
        db = lgb.Dataset(Xtr, ytr)
        vb = lgb.Dataset(Xva, yva, reference=db)
        params = {"objective": "binary", "metric": "binary_logloss", "learning_rate": 0.05,
                  "num_leaves": 15, "min_data_in_leaf": 5, "feature_fraction": 0.8,
                  "bagging_fraction": 0.8, "bagging_freq": 1, "verbose": -1, "seed": 42}
        mb = lgb.train(params, db, 300, valid_sets=[vb], callbacks=[lgb.early_stopping(20)])
        pb = (mb.predict(Xva, num_iteration=mb.best_iteration) >= 0.5).astype(int)
        acc = float((pb == yva).mean())
        cm = confusion_matrix(yva, pb).tolist()
        print(f"acc={acc:.3f} 混淆[行真:lite,deep / 列预:lite,deep]={cm}")
        mb.save_model(str(OUT / "lgbm_bin.txt"))
        meta["bin"] = {"n": len(bi), "val_acc": round(acc, 4), "confusion": cm,
                       "classes": ["lite", "deep"], "source": "human_label"}
    else:
        print("二分类样本不足, 跳过")

    # ── B. 三分类对照 ──
    if len(samples) >= 120 and all(Counter(s[1] for s in samples)[k] >= 15 for k in ("lite", "standard", "deep")):
        print(f"\n── B. 三分类对照: {len(samples)} 样本 ──")
        cls2i = {"lite": 0, "standard": 1, "deep": 2}
        yt = np.array([cls2i[l] for _, l in samples])
        Xtr, Xva, ytr, yva = train_test_split(X, yt, test_size=0.2, random_state=42, stratify=yt)
        dt = lgb.Dataset(Xtr, ytr)
        vt = lgb.Dataset(Xva, yva, reference=dt)
        pt = {"objective": "multiclass", "num_class": 3, "metric": "multi_logloss",
              "learning_rate": 0.05, "num_leaves": 15, "min_data_in_leaf": 3,
              "feature_fraction": 0.8, "bagging_fraction": 0.8, "bagging_freq": 1,
              "verbose": -1, "seed": 42}
        mt = lgb.train(pt, dt, 300, valid_sets=[vt], callbacks=[lgb.early_stopping(20)])
        pt_ = mt.predict(Xva, num_iteration=mt.best_iteration).argmax(axis=1)
        acc_t = float((pt_ == yva).mean())
        cm_t = confusion_matrix(yva, pt_).tolist()
        print(f"acc={acc_t:.3f} 混淆[行真:lite,std,deep / 列预:lite,std,deep]={cm_t}")
        mt.save_model(str(OUT / "lgbm_tri.txt"))
        meta["tri"] = {"n": len(samples), "val_acc": round(acc_t, 4), "confusion": cm_t,
                       "classes": ["lite", "standard", "deep"]}
    else:
        print("三分类样本分布不足(需各类≥15), 跳过对照")

    # 资产(与 predict 共用) + meta
    joblib.dump(tfidf, OUT / "tfidf.pkl")
    joblib.dump(svd, OUT / "svd.pkl")
    meta["feature_dim"] = int(X.shape[1])
    meta["trained_at"] = np.datetime64("now").astype(str)
    (OUT / "meta_human.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n已保存:", OUT)


if __name__ == "__main__":
    main()

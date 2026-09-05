#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""predict_router.py — V405-ML: 档位分类器推理 sidecar(二分类 lite vs deep)

用法(被 Node 侧 spawn 调用, 单次预测):
  python predict_router.py "<查询文本>"           → 输出一行 JSON
输出: {"label": "lite"|"deep", "prob_deep": 0.xx, "confident": true|false, "err": null}
语义(与 tier-router-service 对接):
  - label=deep 且 confident → 走 deep 档(全链路+完整自愈)
  - label=lite 且 confident → 走 lite 档(快答); 但规则层的高风险/政策类始终优先于模型
  - confident=false(概率接近 0.5)或任何异常 → 调用方走规则默认(standard), 不冒险

模型资产: data/ml-router/{tfidf.pkl, svd.pkl, lgbm.txt, meta.json}(由 train_router.py 产出)
特征: 手写 51 维(HC) + TFIDF(char_wb 2-4gram)→SVD 100 维, 与训练一致
"""
import json
import re
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT / "data" / "ml-router"

# 与 train_router.py 完全一致的手写特征(51 维) ─────────────────
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
    feats[37] = 1.0 if text_len < 30 else 0.0
    feats[38] = 1.0 if 30 <= text_len <= 80 else 0.0
    feats[39] = 1.0 if text_len > 200 else 0.0
    feats[40] = _kw_count(text, _QUOTE_KW)
    total_kw = (feats[22] + feats[23] + feats[24] + feats[25]
                + feats[26] + feats[27] + feats[28] + feats[29])
    feats[41] = 1.0 if total_kw < 2 else 0.0
    return feats


# ── 推理入口 ───────────────────────────────────────────────────
def predict(text: str) -> dict:
    """加载模型资产 → 提取特征 → LightGBM binary 预测(正类=deep)。"""
    import joblib
    import lightgbm as lgb

    if not text or len(text.strip()) < 4:
        return {"label": "standard", "prob_deep": None, "confident": False,
                "err": "query too short"}

    tfidf = joblib.load(MODEL_DIR / "tfidf.pkl")
    svd = joblib.load(MODEL_DIR / "svd.pkl")
    # V405-ML: 优先人工标签二分类模型(lgbm_bin.txt, 方案 A); 无则回退早期弱监督版
    model_file = MODEL_DIR / "lgbm_bin.txt"
    if not model_file.exists():
        model_file = MODEL_DIR / "lgbm.txt"
    model = lgb.Booster(model_file=str(model_file))

    hc = extract_handcrafted(text).reshape(1, -1)
    sv = svd.transform(tfidf.transform([text]))
    X = np.hstack([hc, sv]).astype(np.float32)

    prob_deep = float(model.predict(X)[0])  # binary 正类(deep)概率
    # 置信门槛: 概率远离 0.5 才 confident(0.45~0.55 中间带 → 交给规则默认)
    confident = prob_deep <= 0.35 or prob_deep >= 0.65
    label = "deep" if prob_deep >= 0.5 else "lite"
    return {"label": label, "prob_deep": round(prob_deep, 4),
            "confident": confident, "err": None}


def main():
    q = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        print(json.dumps(predict(q), ensure_ascii=False))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"label": "standard", "prob_deep": None,
                          "confident": False, "err": str(e)[:200]},
                         ensure_ascii=False))


if __name__ == "__main__":
    main()

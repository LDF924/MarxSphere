#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""router_features.py — V405-ML: 档位分类器共享特征模块(51 维手写 HC)

train_router.py / predict_router.py / sample_labeling.py 共用 — 保持单一实现防漂移。
移植 OpenSquilla squilla_router features.py 的手写特征方法论, 中文域词典重写。
"""
import re

import numpy as np

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

# 规则建议档位(与 TS 侧 tier-router-service.decideTier 对齐的轻量版, 供抽样预填/复核)
# V405-ML 口径定稿(2026-09-05 用户确认):
#   deep = 政策法条定位 / 引证核验 / 跨理论体系比较 / 系统性综述 / 理论对接 / 选题设计 / 复杂多跳论证
#   lite = 单点事实/概念, 一次检索即答; standard = 跨库检索综合(其余默认)
_POLICY_HINT = ["政策", "条例", "办法", "意见", "通知", "监管", "法规", "制度",
                "准入", "条款", "条文", "规定", "允许", "禁止", "审批", "备案"]
_QUOTE_HINT = ["引用原文", "原文", "出处", "页码", "文献", "哪篇", "条款"]
_DEEP_SYNTH_HINT = ["比较", "对比", "综述", "梳理", "系统", "理论对接", "对接",
                    "选题", "研究设计", "研究空白", "内在逻辑", "框架", "范式",
                    "比较分析", "异同", "关系", "机制", "影响", "逻辑结构", "谱系",
                    "演进", "发展脉络", "脉络", "述评", "批判", "争论", "论战",
                    "流派", "学派", "新质", "辨析", "评价", "评估", "分析"]


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
    """51 维手写特征(与 OpenSquilla HC 通道对应, 中文适配)。"""
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


def rule_suggest(query: str) -> str:
    """规则建议(口径定稿): 政策/引证/比较/综述/对接/选题/机制分析 → deep;
    短概念单点(<=50 字且无深链信号) → lite; 其余 standard。宁深勿浅。"""
    q = (query or "").strip()
    if not q:
        return "standard"
    n = len(q)
    # deep 信号(任一命中即 deep — 保守口径)
    if _kw_count(q, _POLICY_HINT) > 0:
        return "deep"
    if _kw_count(q, _QUOTE_HINT) > 0:
        return "deep"
    if _kw_count(q, _DEEP_SYNTH_HINT) > 0:
        return "deep"
    # lite: 真单点(无深链词)且短
    if n <= 50:
        return "lite"
    return "standard"

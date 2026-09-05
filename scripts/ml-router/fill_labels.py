#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""fill_labels.py — V405-ML: 人工标注填充(Claude 按定稿口径执行, 用户可复核)

对 labeling.tsv:
  1. 默认 human_label = rule_suggest(规则建议)
  2. 按 OVERRIDES(行号→标签)覆盖 — Claude 逐条判定的与规则分歧处
  3. 噪声行(测试/坏数据/答案残片)打 note, 标签中性(standard/lite), 训练脚本跳过 note 行

口径(用户 2026-09-05 确认):
  lite = 单点事实/概念/定义/数据/史实, 一次检索即可答(出处即使是政策文件, 单点数值仍 lite)
  standard = 单文档内多步概括/推理/列举(如"三阶段""三方面""多跳但单文档")
  deep = 政策法条定位展开 / 原文引证核验 / 跨理论体系比较 / 系统性综述 / 理论对接 /
         机制-影响-关系分析 / 实证研究设计 / 选题设计 / 学术史梳理
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TSV = ROOT / "data" / "ml-router" / "labeling.tsv"

# 覆盖判定(行号 → 标签)。行号 = tsv 行号 - 1(1-based 数据行)
OVERRIDES = {
    1: "deep",      # 术语生成与德文版演变 + 误用类型根源 → 学术史+综述
    5: "deep",      # 误用类型、根源与理论后果 → 分析综述
    16: "deep", 17: "deep", 18: "deep", 19: "deep", 20: "deep",  # 劳动过程理论×AI 理论对接族
    21: "deep",     # 同 1 族
    23: "standard", # 三阶段梳理(单文档内列举概括)
    26: "deep",     # 同 16 族
    27: "deep", 28: "deep", 29: "deep", 30: "deep",  # 实证/机制研究
    31: "deep",     # 方法论"理论接口"构建逻辑深析
    36: "deep",     # 命题体系×AI 适用性 → 理论对接
    44: "deep", 45: "deep", 50: "deep",  # 关键词堆叠研究问题(理论对接)
    48: "standard", # 双重效应概括(两点, 综述可给)
    51: "deep", 52: "deep", 53: "deep",  # 实证研究/理论生长点
    57: "lite",     # 单文档(郑文)定位 → 一次检索
    60: "lite",     # 讲解模板(坏参数) — 教学单点
    64: "lite",     # 讲解「剩余价值率」基础
    102: "standard",# 单文档三维度概括
    103: "standard",# 单文档特征概括
    112: "standard",# 概念教学(定义+来源+关联, 非穷尽综述)
    132: "standard",# "简述"影响机制 — 中等深度(简述信号)
    134: "deep",    # 同 16 族(规则误判 lite)
    163: "standard",# 实践启示推导(单文档应用)
    165: "lite",    # 单文档内两术语解释
}

# 噪声行(不入训练): note 标记
NOISE_NOTES = {
    13: "坏数据: 讲解「y」占位符, 排除",
    34: "测试查询(偏好源去重), 排除",
    56: "答案残片非问题(2.5倍…建议…), 排除",
    60: "坏数据: 讲解「undefined」占位符, 排除",
}


def main():
    with open(TSV, encoding="utf-8") as f:
        lines = f.read().splitlines()
    header = lines[0]
    out = [header]
    changed = []
    for i, line in enumerate(lines[1:], start=1):
        parts = line.split("\t")
        if len(parts) < 5:
            parts = (parts + ["", "", "", ""])[:5]
        _id, query, rule, label, note = parts
        # 已有手工标签(用户可能已填)则不覆盖
        if not (label or "").strip():
            label = OVERRIDES.get(i, rule)
            if OVERRIDES.get(i) and OVERRIDES[i] != rule:
                changed.append(f"L{i} {rule}→{label}: {query[:36]}")
        if i in NOISE_NOTES:
            note = (note + " " if note else "") + NOISE_NOTES[i]
        out.append("\t".join([_id, query, rule, label, note]))
    with open(TSV, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    print(f"覆盖 {len(changed)} 条:")
    for c in changed:
        print("  ", c)


if __name__ == "__main__":
    main()

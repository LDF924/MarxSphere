# -*- coding: utf-8 -*-
"""empirical_simulate.py — 问卷仿真数据生成器（V413+）
基于已识别问卷结构(Question[])生成 N 份"带内在结构"的模拟作答。

核心设计 —— 用 latent 潜质驱动题间相关, 让后续回归能挖出真信号:
  design: {
    "latent": "moral",                    // 潜质名
    "groups": [                            // 同属一个潜质的题组(共享 latent 分量)
      { "latent": "moral", "cols": ["moral_cognition_1", ...], "reverse": true/false, "effect": 1.0, "kind": "ordinal" },
      { "latent": "watch", "cols": ["watch_days_per_week", ...], "reverse": false, "effect": 1.0, "kind": "cat" },
    ],
    "relations": [                         // 潜质间因果: watch 越大 → moral 越小
      { "from": "watch", "to": "moral", "direction": -1, "strength": 1.2 }
    ]
  }
若不传 design: 全随机(结构正确但无题间相关)。

结构规则(自动):
- 多选 → 拆 变量名_rN 哑变量列(0/1)
- 筛选跳题(问卷 structure 里的 skipLogic 或 params.skip 指定的 第5题"否"跳转)
  → 命中跳转者后续题置 -99(结构缺失, 描述统计/回归前需 filter)
- 挖缺(可选): missing.cols 按 missing.rate 随机置 None(供 LLM 插补演示)

input.json: { script:"simulate", questionnaire: Question[], params: { n, seed, design?, skip?, missing? } }
result.json: { ok, meta, data: { columnOrder, rows } }
"""
import json, random, sys
from pathlib import Path

task_dir = Path(sys.argv[1])
inp = json.load(open(task_dir / "input.json", encoding="utf-8"))
qs = inp.get("questionnaire") or []
params = inp.get("params") or {}
N = int(params.get("n", 100))
seed = int(params.get("seed", 42))
random.seed(seed)
design = params.get("design") or {}

def opt_codes(q):
    opts = q.get("options") or []
    return [o.get("code") for o in opts] if opts else None

def all_cols_for(q):
    vn = q.get("varName")
    if q.get("type") == "multi":
        return [f"{vn}_r{c}" for c in (opt_codes(q) or [1, 2])]
    return [vn]

# ── 潜质 → 列映射(design 题组展开) ──
# latent_of_col[col] = latentName; rev_of_col[col] = reverse; eff_of_col[col] = effect
latent_of_col = {}
rev_of_col = {}
eff_of_col = {}
latent_specs = {}
for g in design.get("groups", []):
    ln = g.get("latent", "base")
    kind = g.get("kind", "ordinal")
    eff = float(g.get("effect", 1.0))
    rev = bool(g.get("reverse", False))
    # 题干名直接匹配(design.cols 是题干 varName) — 先把匹配规则放宽: cols 既可以是题干也可以给题号
    for q in qs:
        for want in (g.get("cols") or []):
            if str(q.get("qid")) == str(want) or q.get("varName") == str(want):
                for c in all_cols_for(q):
                    latent_of_col[c] = ln
                    rev_of_col[c] = rev
                    eff_of_col[c] = eff
                break
    latent_specs.setdefault(ln, {"kind": kind})
for rel in design.get("relations", []):
    key = f"rel:{rel.get('from')}->{rel.get('to')}"
    latent_specs.setdefault(key, {"kind": "relation", "direction": float(rel.get("direction", -1)),
                                  "strength": float(rel.get("strength", 1.0)),
                                  "from": rel.get("from"), "to": rel.get("to")})

# 潜质分量: 每行独立
def draw_latents():
    lv = {}
    # 先抽基础潜质
    for ln, spec in latent_specs.items():
        if spec["kind"] == "relation":
            continue
        lv[ln] = random.gauss(0.0, 1.0)
    # 再按关系推
    for ln, spec in latent_specs.items():
        if spec["kind"] != "relation":
            continue
        frm, to = spec["from"], spec["to"]
        base = lv.get(to, random.gauss(0.0, 1.0))
        lv[to] = base + spec["direction"] * spec["strength"] * (lv.get(frm, 0.0) or 0.0)
        lv.setdefault(frm, random.gauss(0.0, 1.0))
    return lv

# ── 作答函数 ──
def answer_ordinal(q, latent):
    """1-5 程度题: latent 高 → 高分(除非 reverse)"""
    codes = opt_codes(q) or [1, 2, 3, 4, 5]
    lo, hi = min(codes), max(codes)
    if latent is None:
        return random.randint(lo, hi)
    center = (lo + hi) / 2
    spread = (hi - lo) / 2
    v = center + latent * spread * 0.42 + random.gauss(0, spread * 0.42)
    return max(lo, min(hi, round(v)))

def answer_cat(q, latent):
    codes = opt_codes(q) or [1, 2]
    if latent is None or len(codes) <= 1:
        return random.choice(codes)
    # 有序单选(如时长档): latent 越大越靠后
    lo, hi = min(codes), max(codes)
    span = hi - lo
    v = (lo + hi) / 2 + latent * span * 0.30 + random.gauss(0, span * 0.3)
    return max(lo, min(hi, round(v)))

def answer_cont(q, latent):
    return round(50 + (latent or 0) * 15 + random.gauss(0, 18), 1)

# ── 跳转范围 ──
# 找出问卷结构中带 skipLogic 的题
# V414: ifOption 支持多值 —— "选 A 或 B 时显示"(如单身两种状态都要答)原来只能存一个数字,
#   识别到的多值条件被压成单个, 仿真时漏掉另一半人。现在优先读 ifOptions 数组, 兼容旧 ifOption。
def _as_option_list(v):
    """单值/数组/None → list[int]（None 表示"任意选项都触发"）"""
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        out = []
        for x in v:
            try:
                out.append(int(x))
            except (TypeError, ValueError):
                pass
        return out
    try:
        return [int(v)]
    except (TypeError, ValueError):
        return []


skip_cfg = params.get("skip")
skip_entries = []
for q in qs:
    sl = q.get("skipLogic") or {}
    if sl and sl.get("ifQid"):
        opts = _as_option_list(sl.get("ifOptions"))
        if not opts:
            opts = _as_option_list(sl.get("ifOption"))
        skip_entries.append({"ifQid": str(sl.get("ifQid")), "ifOptions": opts,
                             "goto": str(sl.get("goto")), "basedOn": str(q.get("qid"))})
# 人工指定(兼容老问卷: 没 skipLogic 字段但文本里有)
if skip_cfg:
    opts = _as_option_list(skip_cfg.get("ifOptions")) or _as_option_list(skip_cfg.get("ifOption"))
    skip_entries.append({"ifQid": str(skip_cfg.get("ifQid")), "ifOptions": opts,
                         "goto": str(skip_cfg.get("goto")), "basedOn": skip_cfg.get("basedOn", "")})

# 筛选题(触发跳转的题)不参与 latent 驱动, 独立小概率命中跳转选项(不看者 ~12-20%)
FILTER_PROB = float((skip_cfg or {}).get("prob", 0.15))

def skip_ranges():
    """返回 [(触发题index, 触发选项list, 跳过index集合), ...]；选项 list 为空 = 任意选项都触发"""
    idx = {str(q.get("qid")): i for i, q in enumerate(qs)}
    out = []
    for e in skip_entries:
        if e["ifQid"] not in idx:
            continue
        gi = idx.get(e["goto"])
        si = idx[e["ifQid"]]
        if gi is None or gi <= si:
            # goto 指向未识别题(可能"结束") → 跳到最后
            rng = set(range(si + 1, len(qs)))
        else:
            rng = set(range(si + 1, gi))  # 跳到 goto 本身(再答 goto)
        out.append((si, e["ifOptions"], rng))
    return out

SKIP_RANGES = skip_ranges()
FILTER_IDX = {si for si, _, _ in SKIP_RANGES}

rows = []
for _ in range(N):
    lv = draw_latents()
    row = {}
    hit_skip = {}
    for i, q in enumerate(qs):
        vn = q.get("varName")
        # 是否被某跳转覆盖
        skipped = False
        for si, so, rng in SKIP_RANGES:
            if hit_skip.get(si) and i in rng:
                skipped = True
                break
        if skipped:
            # 多选列也置 -99
            if q.get("type") == "multi":
                for c in (opt_codes(q) or [1, 2]):
                    row[f"{vn}_r{c}"] = -99
            else:
                row[vn] = -99
            continue
        # 触发题: 概率命中"跳转选项"(筛选题不走 latent)
        is_filter = i in FILTER_IDX
        if is_filter:
            for si, sopts, rng in SKIP_RANGES:
                # V414: sopts 是选项列表 —— 命中其中一个就算触发跳转。
                # 原来只比单个 so, 多值条件("选 A 或 B")永远只命中第一个。
                if si == i and sopts:
                    if random.random() < FILTER_PROB:
                        row[vn] = random.choice(sopts)
                        hit_skip[si] = True
                    else:
                        # 未命中跳转 → 正常作答(筛选题取任一非跳转选项=继续)
                        codes = opt_codes(q) or [1, 2]
                        others = [c for c in codes if c not in sopts]
                        row[vn] = random.choice(others) if others else random.choice(codes)
                    break
        if vn in row:
            continue
        ln = latent_of_col.get(vn)
        latent = lv.get(ln) if ln else None
        rev = rev_of_col.get(vn, False)
        t = q.get("type")
        if t == "ordinal":
            row[vn] = answer_ordinal(q, latent if not rev else -latent)
        elif t == "cat":
            row[vn] = answer_cat(q, latent)
        elif t == "multi":
            codes = opt_codes(q) or [1, 2]
            k = random.randint(1, min(3, len(codes)))
            picks = set(random.sample(codes, k))
            for c in codes:
                row[f"{vn}_r{c}"] = 1 if c in picks else 0
        elif t == "cont":
            row[vn] = answer_cont(q, latent)
        else:
            row[vn] = "示例作答文本"
    rows.append(row)

# 列序(按问卷顺序; 多选展开在题干位置)
column_order = []
for q in qs:
    column_order.extend(all_cols_for(q))

# 挖缺
missing_cfg = params.get("missing")
if missing_cfg and missing_cfg.get("cols"):
    rate = float(missing_cfg.get("rate", 0.1))
    for r in rows:
        for c in missing_cfg["cols"]:
            if c in r and r[c] not in (-99, None) and random.random() < rate:
                r[c] = None

out_rows = [[r.get(c, None) for c in column_order] for r in rows]
result = {"ok": True,
          "meta": {"n": len(rows), "cols": len(column_order), "seed": seed,
                   "skipEntries": len(skip_entries),
                   "note": "结构缺失=-99(跳答); 挖缺失=None(插补演示)"},
          "data": {"columnOrder": column_order, "rows": out_rows}}
json.dump(result, open(task_dir / "result.json", "w", encoding="utf-8"), ensure_ascii=False)

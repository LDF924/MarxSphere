# -*- coding: utf-8 -*-
"""问卷结构数据验证: 生成50份模拟问卷 → 通过 4173 实证 API 跑通 genvars/logit/crosstab/ologit
产出: scripts/问卷演示数据.csv (可直接粘贴到实证工作台前端复现)"""
import json, csv, random, time, urllib.request

random.seed(42)
API = "http://localhost:4173/api/empirical"

# ── 1) 生成 50 份假问卷(含内在结构: 转出概率 ∝ 非农就业+承包面积) ──
COLS = ["identity", "gender", "birth_ym", "edu", "hh_size", "employment", "politics",
        "village_duty", "hukou", "nonfarm_income", "own_area", "transfer_in_area",
        "transfer_out_area", "reclaim_area", "cult_area", "n_parcels",
        "adj_willing", "continue_will", "abandon_right_will", "cadre", "off_farm"]

rows = []
for i in range(50):
    # 身份: 种植小户为主, 少量新型主体
    identity = random.choices([1, 2, 3, 4, 5, 6], weights=[30, 6, 7, 2, 2, 3])[0]
    gender = random.choices([1, 2], weights=[7, 3])[0]
    birth_ym = random.randint(1958, 2003) * 100 + random.randint(1, 12)
    age = 2023 - birth_ym // 100
    # 教育: 年龄越轻学历越高
    edu = max(1, min(9, round(11 - age / 6.5 + random.gauss(0, 1.2))))
    hh_size = random.choices([1, 2, 3, 4, 5, 6], weights=[2, 8, 20, 30, 25, 15])[0]
    employment = random.choices([1, 2, 3, 4, 5, 6, 7], weights=[30, 12, 22, 4, 10, 8, 14])[0]
    off_farm = 1 if employment in (2, 3) else 0
    politics = random.choices([1, 2, 3, 4], weights=[70, 18, 10, 2])[0]
    village_duty = random.choices([1, 2, 3, 4, 5], weights=[85, 3, 4, 5, 3])[0]
    cadre = 1 if village_duty in (2, 3) else 0
    hukou = random.choices([1, 2, 3, 4, 5], weights=[80, 8, 6, 4, 2])[0]
    nonfarm_income = round(random.gauss(18000, 9000) * (1.6 if off_farm else 0.35)) if off_farm or random.random() < 0.3 else 0
    nonfarm_income = max(0, int(nonfarm_income))
    # 承包面积 0-30 亩
    own_area = round(max(0, random.gauss(10, 7)), 1)
    # 转出: 概率受 非农就业 + 面积 + 年龄(老) 驱动
    p_out = 0.15 + 0.35 * off_farm + 0.02 * (own_area - 5) + 0.004 * (age - 45)
    p_out = min(0.9, max(0.02, p_out))
    transfer_out_area = round(own_area * random.uniform(0.4, 1.0), 1) if random.random() < p_out else 0
    transfer_in_area = round(random.uniform(2, 20), 1) if random.random() < 0.22 else 0
    reclaim_area = round(random.uniform(1, 5), 1) if random.random() < 0.1 else 0
    cult_area = round(own_area - transfer_out_area + transfer_in_area + reclaim_area, 1)
    n_parcels = random.randint(1, 9)
    # 调地意愿(1 非常愿意 … 5 非常不愿意): 年轻/高学历/新型主体更愿调
    adj_w = 5 - round(0.03 * edu + 0.02 * (50 - max(age, 18)) + (0.8 if identity in (2, 3, 6) else 0))
    adj_w = max(1, min(5, adj_w + random.choice([-1, 0, 0, 0, 1])))
    cont_w = max(1, min(5, round(random.gauss(2.4, 1.1))))
    aband_w = max(1, min(5, round(5 - 0.05 * edu - 0.02 * (45 - max(age, 18)) + random.gauss(0, 1.2))))
    aband_w = max(1, min(5, aband_w))
    rows.append([identity, gender, birth_ym, edu, hh_size, employment, politics,
                 village_duty, hukou, nonfarm_income, own_area, transfer_in_area,
                 transfer_out_area, reclaim_area, cult_area, n_parcels,
                 adj_w, cont_w, aband_w, cadre, off_farm])

with open("scripts/问卷演示数据.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f)
    w.writerow(COLS)
    w.writerows(rows)
print(f"已生成 50 份模拟问卷 → scripts/问卷演示数据.csv ({len(COLS)} 列)")

# ── 2) API 提交工具 ──
def run(method, params, data_cols=None, data_rows=None):
    body = json.dumps({
        "method": method,
        "params": params,
        "data": {"columnOrder": data_cols or COLS, "rows": data_rows or rows},
    }, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(f"{API}/run", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        resp = json.loads(r.read().decode("utf-8"))
    if not resp.get("ok"):
        return {"error": resp.get("error")}
    task_id = resp["taskId"]
    for _ in range(40):  # 轮询最多 20s
        with urllib.request.urlopen(f"{API}/result/{task_id}", timeout=15) as r2:
            res = json.loads(r2.read().decode("utf-8"))
        if res.get("status") in ("done", "error"):
            return res
        time.sleep(0.5)
    return {"error": "轮询超时"}

# ── 3) 验证 1: genvars 构造衍生变量 ──
r = run("genvars", {"formulas": [
    {"name": "has_out", "expr": "transfer_out_area > 0"},
    {"name": "transfer_rate", "expr": "transfer_out_area / own_area"},
    {"name": "age", "expr": "2023 - (birth_ym // 100)"},
    {"name": "mu_income", "expr": "nonfarm_income / cult_area"},
]})
if r.get("error"):
    print("[GENVARS] 失败:", r)
else:
    print("[GENVARS] OK:", r["result"]["tables"][0]["rows"])
    # 将 has_out 列并入数据, 供 logit 使用
    has_out_vals = [1 if row[COLS.index("transfer_out_area")] > 0 else 0 for row in rows]
    cols2 = COLS + ["has_out", "age"]
    rows2 = [row + [has_out_vals[i], 2023 - row[COLS.index("birth_ym")] // 100] for i, row in enumerate(rows)]

# ── 4) 验证 2: logit 是否转出土地 ~ 家庭特征 ──
r = run("logit", {"y": "has_out", "xs": ["age", "edu", "hh_size", "gender", "own_area",
                                          "n_parcels", "off_farm", "nonfarm_income"],
                   "link": "logit"}, cols2, rows2)
if r.get("error"):
    print("[LOGIT] 失败:", r)
else:
    tab = r["result"]["tables"][0]
    print(f"[LOGIT] OK  N={r['result']['meta']['n']}  表: {tab['title']}")
    for row_ in tab["rows"]:
        print("   ", row_)

# ── 5) 验证 3: crosstab 身份 × 调地意愿 ──
r = run("crosstab", {"row": "identity", "col": "adj_willing"})
if r.get("error"):
    print("[CROSSTAB] 失败:", r)
else:
    tab = r["result"]["tables"][0]
    print(f"[CROSSTAB] OK  {tab['title']}  N={r['result']['meta']['n']}")
    for row_ in tab["rows"]:
        print("   ", row_)
    for d in r["result"]["diagnostics"]:
        print("   诊断:", d)

# ── 6) 验证 4: ologit 调地意愿 ~ 教育/面积/身份 ──
r = run("ologit", {"y": "adj_willing", "xs": ["edu", "cult_area", "identity", "hh_size",
                                               "gender", "age", "n_parcels"]}, cols2, rows2)
if r.get("error"):
    print("[OLOGIT] 失败:", r)
else:
    tab = r["result"]["tables"][0]
    print(f"[OLOGIT] OK  N={r['result']['meta']['n']}  表: {tab['title']}")
    for row_ in tab["rows"]:
        print("   ", row_)
    print("  备注:", tab["notes"])
print("\n验证完成")

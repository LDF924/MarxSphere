# -*- coding: utf-8 -*-
"""empirical_demo_gen.py — 基于《农村经营形态调查问卷(最终打印版).pdf》的真实演示数据生成器（V380+）
读 问卷变量模板.csv(167题) → 按 PDF 跳转逻辑生成 50 份模拟作答
- 单选/有序: 填编码值; 连续: 填合理数值; 多选(可多选): 拆成 变量名_rN 哑变量列
- 跳转逻辑: 2-1无地→跳2-13; 有转出才答2a; 有转入才答2b; 3a-19有灾害才答3a-20~25; 3b-1买保险才答3b-2~8; 3f-1享补贴才答3f-2~9
- 文本题: 填示例文本
输出: scripts/问卷演示数据_全量.csv(真实问卷结构, 约150列)
"""
import csv, random, re, os, sys

random.seed(20260812)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TPL = os.path.join(ROOT, "问卷变量模板.csv")
OUT = os.path.join(ROOT, "scripts", "问卷演示数据_全量.csv")

rows = list(csv.reader(open(TPL, encoding="utf-8-sig")))
qs = rows[1:]  # [题号, 变量名, 题干, 选项编码, 变量类型]

# 变量名去重(模板有 3d-9/3d-9b 两个 cont 题)
seen = {}
for q in qs:
    vn = q[1]
    if vn in seen:
        seen[vn] += 1
        vn = f"{vn}_{seen[vn]}"
        q[1] = vn
    else:
        seen[vn] = 1

# 解析选项编码 → [(code, label)]; 返回 None 表示连续/文本
def parse_options(opt_str: str):
    if not opt_str or "=" not in opt_str:
        return None
    opts = []
    for part in opt_str.split(";"):
        m = re.match(r"^\s*(\d+)\s*=\s*(.+?)\s*$", part)
        if m:
            opts.append((int(m.group(1)), m.group(2)))
    return opts or None

N = 50
data = {}  # varName -> [values]

# 预生成每份问卷的核心结构(跳转依赖)
profiles = []
for i in range(N):
    identity = random.choices([1, 2, 3, 4, 5, 6], weights=[30, 6, 8, 2, 2, 3])[0]
    gender = random.choices([1, 2], weights=[7, 3])[0]
    age = random.randint(28, 72)
    birth_ym = (2023 - age) * 100 + random.randint(1, 12)
    edu = max(1, min(9, round(11 - age / 6.5 + random.gauss(0, 1.2))))
    hh_size = random.choices([1, 2, 3, 4, 5, 6], weights=[2, 8, 20, 30, 25, 15])[0]
    employment = random.choices([1, 2, 3, 4, 5, 6, 7], weights=[30, 12, 22, 4, 10, 8, 14])[0]
    politics = random.choices([1, 2, 3, 4], weights=[70, 18, 10, 2])[0]
    village_duty = random.choices([1, 2, 3, 4, 5], weights=[85, 3, 4, 5, 3])[0]
    hukou = random.choices([1, 2, 3, 4, 5], weights=[80, 8, 6, 4, 2])[0]
    own_area = round(max(0, random.gauss(10, 7)), 1)
    has_land = own_area > 0.5
    # 转出决策
    off_farm = 1 if employment in (2, 3) else 0
    p_out = min(0.9, max(0.02, 0.12 + 0.35 * off_farm + 0.02 * (own_area - 5) + 0.004 * (age - 45)))
    has_out = has_land and random.random() < p_out
    has_in = random.random() < 0.22
    transfer_out_area = round(own_area * random.uniform(0.4, 1.0), 1) if has_out else 0
    transfer_in_area = round(random.uniform(2, 20), 1) if has_in else 0
    reclaim_area = round(random.uniform(1, 5), 1) if random.random() < 0.1 else 0
    cult_area = round(own_area - transfer_out_area + transfer_in_area + reclaim_area, 1)
    n_parcels = random.randint(1, 9)
    # 调地意愿
    adj_w = max(1, min(5, 5 - round(0.03 * edu + 0.02 * (50 - age) + (0.8 if identity in (2, 3, 6) else 0)) + random.choice([-1, 0, 0, 0, 1])))
    disaster_5y = random.choices([1, 2], weights=[35, 65])[0]
    ins_buy = random.choices([1, 2], weights=[40, 60])[0]
    subsidy_get = random.choices([1, 2, 3], weights=[65, 25, 10])[0]
    tech_need = random.choices([1, 2], weights=[45, 55])[0]
    tech_train = random.choices([1, 2], weights=[30, 70])[0]
    process_do = random.choices([1, 2, 3], weights=[40, 35, 25])[0]
    brand_exist = random.choices([1, 2, 3], weights=[25, 55, 20])[0]
    ecom_sell = random.choices([1, 2], weights=[25, 75])[0]
    own_abandon = random.choices([1, 2], weights=[20, 80])[0]
    village_abandon = random.choices([1, 2], weights=[45, 55])[0]
    profiles.append(dict(i=i, identity=identity, gender=gender, birth_ym=birth_ym, edu=edu,
        hh_size=hh_size, employment=employment, politics=politics, village_duty=village_duty,
        hukou=hukou, own_area=own_area, has_land=has_land, has_out=has_out, has_in=has_in,
        transfer_out_area=transfer_out_area, transfer_in_area=transfer_in_area,
        reclaim_area=reclaim_area, cult_area=cult_area, n_parcels=n_parcels, adj_w=adj_w,
        disaster_5y=disaster_5y, ins_buy=ins_buy, subsidy_get=subsidy_get, tech_need=tech_need,
        tech_train=tech_train, process_do=process_do, brand_exist=brand_exist,
        ecom_sell=ecom_sell, own_abandon=own_abandon, village_abandon=village_abandon,
        off_farm=off_farm, age=age))

# 模板题分类
cat_qs = [q for q in qs if q[4] == "cat"]
ord_qs = [q for q in qs if q[4] == "ord"]
cont_qs = [q for q in qs if q[4] == "cont"]
text_qs = [q for q in qs if q[4] == "text"]
multi_qs = [q for q in qs if "可多选" in q[2] or "可多选" in q[3]]

# 变量名 → 题号映射(跳转判断用)
qid_map = {q[1]: q[0] for q in qs}

# 可多选题选项数(用于拆哑变量)
multi_opts = {}
for q in multi_qs:
    opts = parse_options(q[3])
    if opts:
        multi_opts[q[1]] = [c for c, _ in opts]

# 每份问卷作答
all_rows = []
for p in profiles:
    row = {}
    for q in qs:
        qid, vn, stem, opt_str, vtype = q[0], q[1], q[2], q[3], q[4]
        opts = parse_options(opt_str)
        n_opts = len(opts) if opts else 0

        # ── 跳转逻辑: 未适用 → -99 ──
        def skip(v):
            row[vn] = -99

        if vn == "adj_direction":  # 2-16 仅愿意调地者
            if p["adj_w"] <= 2: row[vn] = random.choices([1, 2], weights=[65, 35])[0]
            else: skip(vn)
            continue
        if qid in ("2a-1", "2a-2", "2a-3", "2a-4", "2a-5", "2a-6", "2a-7", "2a-8", "2a-9", "2a-10", "2a-11", "2a-12", "2a-13", "2a-14", "2a-15", "2a-16", "2a-17"):
            if not p["has_out"]: skip(vn); continue
        if qid in ("2b-1", "2b-2", "2b-3", "2b-4", "2b-5", "2b-6", "2b-7", "2b-8", "2b-9", "2b-10", "2b-11", "2b-12", "2b-13", "2b-14", "2b-15", "2b-16", "2b-17", "2b-18", "2b-19"):
            if not p["has_in"]: skip(vn); continue
        if qid in ("3a-9",):  # 机械服务支出: 仅用机械服务者(简化为 50%)
            if random.random() < 0.5: skip(vn); continue
        if qid in ("3a-16",):  # 技术需求内容: 仅 3a-15=有
            if p["tech_need"] != 1: skip(vn); continue
        if qid in ("3a-18",):  # 培训来源: 仅 3a-17=有
            if p["tech_train"] != 1: skip(vn); continue
        if qid in ("3a-20", "3a-21", "3a-22", "3a-23", "3a-24", "3a-25"):
            if p["disaster_5y"] != 1: skip(vn); continue
        if qid in ("3b-2", "3b-3", "3b-4", "3b-5", "3b-6", "3b-7", "3b-8"):
            if p["ins_buy"] != 1: skip(vn); continue
        if qid in ("3b-9", "3b-10"):
            if p["ins_buy"] != 2: skip(vn); continue
        if qid in ("3d-2", "3d-3", "3d-4", "3d-5", "3d-6", "3d-7", "3d-8", "3d-9", "3d-9b", "3d-10"):
            if p["process_do"] == 3 or (vn == "process_subsidy_amt" and random.random() < 0.6): skip(vn); continue
        if qid in ("3d-12", "3d-13"):
            if p["brand_exist"] != 1: skip(vn); continue
        if qid in ("3d-15", "3d-16"):
            if p["brand_exist"] == 1: skip(vn); continue
        if qid in ("3f-2", "3f-3", "3f-4", "3f-5", "3f-6", "3f-7", "3f-8", "3f-9"):
            if p["subsidy_get"] != 1: skip(vn); continue
        if qid in ("3f-10",):
            if p["subsidy_get"] == 1: skip(vn); continue
        if qid in ("4-3",):
            if p["own_abandon"] != 1: skip(vn); continue
        if qid in ("4-5",):
            if p["village_abandon"] != 1: skip(vn); continue

        # ── 多选: 拆哑变量 ──
        if vn in multi_opts:
            codes = multi_opts[vn]
            chosen = random.sample(codes, random.randint(1, min(3, len(codes))))
            for c in codes:
                row[f"{vn}_r{c}"] = 1 if c in chosen else 0
            continue

        # ── 按类型填值 ──
        if vtype == "cat":
            row[vn] = random.randint(1, n_opts) if n_opts else 99
        elif vtype == "ord":
            row[vn] = random.randint(1, n_opts) if n_opts else 3
        elif vtype == "cont":
            row[vn] = round(random.uniform(1, 50), 1)
        else:  # text
            row[vn] = random.choice(["自家食用为主, 剩余出售", "外出务工, 家中老人耕种", "流转给合作社统一经营", "种粮补贴较稳定", "担心政策变化"])

    # ── 核心列覆盖(用预生成值, 保证结构合理) ──
    core_vals = dict(
        identity=p["identity"], gender=p["gender"], birth_ym=p["birth_ym"], edu=p["edu"],
        hh_size=p["hh_size"], employment=p["employment"], politics=p["politics"],
        village_duty=p["village_duty"], hukou=p["hukou"],
        own_area=p["own_area"], transfer_out_area=p["transfer_out_area"],
        transfer_in_area=p["transfer_in_area"], reclaim_area=p["reclaim_area"],
        cult_area=p["cult_area"], n_parcels=p["n_parcels"], adj_willing=p["adj_w"],
        disaster_5y=p["disaster_5y"], ins_buy=p["ins_buy"], subsidy_get=p["subsidy_get"],
        tech_need=p["tech_need"], tech_train=p["tech_train"], process_do=p["process_do"],
        brand_exist=p["brand_exist"], ecom_sell=p["ecom_sell"],
        own_abandon=p["own_abandon"], village_abandon=p["village_abandon"],
        nonfarm_income=round(random.gauss(18000, 9000) * (1.6 if p["off_farm"] else 0.35)),
    )
    for k, v in core_vals.items():
        if k in row:
            row[k] = v
    all_rows.append(row)

# ── 输出: 列序 = 模板变量名 + 多选哑变量列 ──
columns = []
for q in qs:
    vn = q[1]
    if vn not in columns:
        columns.append(vn)
    if vn in multi_opts:
        for c in multi_opts[vn]:
            col = f"{vn}_r{c}"
            if col not in columns:
                columns.append(col)

with open(OUT, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f)
    w.writerow(columns)
    for row in all_rows:
        w.writerow([row.get(c, "") for c in columns])

# ── 挖缺版: 在全量基础上挖缺(LLM 插补演示用) ──
# nonfarm_income 15% 空, politics 10% -88, adj_willing 8% 空 + 3% 乱答 99
import random as _r
_r.seed(20260813)
MISS_OUT = os.path.join(ROOT, "scripts", "问卷演示数据_挖缺全量.csv")
miss_rows = []
for row in all_rows:
    r2 = dict(row)
    if "nonfarm_income" in r2 and _r.random() < 0.15:
        r2["nonfarm_income"] = ""
    if "politics" in r2 and _r.random() < 0.10:
        r2["politics"] = -88
    if "adj_willing" in r2:
        roll = _r.random()
        if roll < 0.08:
            r2["adj_willing"] = ""
        elif roll < 0.11:
            r2["adj_willing"] = 99  # 乱答(越界编码)
    miss_rows.append(r2)
with open(MISS_OUT, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f)
    w.writerow(columns)
    for row in miss_rows:
        w.writerow([row.get(c, "") for c in columns])
n_miss = sum(1 for r in miss_rows if r.get("nonfarm_income") == "")
print(f"✅ 已生成挖缺全量版 {MISS_OUT}: nonfarm_income 空={n_miss}/50")

print(f"✅ 已生成 {OUT}")
print(f"   行数: {len(all_rows)}, 列数: {len(columns)}")
print(f"   跳转逻辑已应用: 2a(仅转出者)/2b(仅转入者)/灾害链/保险链/补贴链")
print(f"   多选列: {sum(1 for q in qs if q[1] in multi_opts)} 题拆为 {sum(len(v) for v in multi_opts.values())} 个哑变量列")

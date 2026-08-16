#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""离线可视化 v2：零 CDN 依赖，vis.js 内联，直接双击打开"""

import sys, json
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))
from pipeline import Neo4jConnection

import requests

OUTPUT = Path(r"D:\Desktop\graphrag_marx_viz.html")
MAX_ENTITIES = 1200   # increase from 600 — file will be ~1.5MB
MAX_EDGES = 2500

# 下载 vis-network JS/CSS（优先 jsdelivr，超时回退 unpkg）
print("下载 vis-network (内联嵌入)...")
VIS_JS = None
VIS_CSS = None
CDN_JS = [
    "https://cdn.jsdelivr.net/npm/vis-network@9.1.2/dist/vis-network.min.js",
    "https://unpkg.com/vis-network@9.1.2/dist/vis-network.min.js",
]
CDN_CSS = [
    "https://cdn.jsdelivr.net/npm/vis-network@9.1.2/dist/dist/vis-network.min.css",
    "https://unpkg.com/vis-network@9.1.2/dist/dist/vis-network.min.css",
]
for url in CDN_JS:
    try:
        r = requests.get(url, timeout=10)
        if r.status_code == 200:
            VIS_JS = r.text
            break
        print(f"  {url[:55]}: HTTP {r.status_code}")
    except Exception as e:
        print(f"  {url[:55]}: {e}")
for url in CDN_CSS:
    try:
        r = requests.get(url, timeout=10)
        if r.status_code == 200:
            VIS_CSS = r.text
            break
        print(f"  {url[:55]}: HTTP {r.status_code}")
    except Exception as e:
        print(f"  {url[:55]}: {e}")

if not VIS_JS:
    print("ERROR 下载 vis.js 失败，请检查网络连接")
    sys.exit(1)
print(f"  JS: {len(VIS_JS):,} chars, CSS: {len(VIS_CSS or ''):,} chars")

CATEGORY_COLORS = {
    "理论概念": "#E74C3C", "理论概念类": "#E74C3C",
    "人物主体类": "#3498DB",
    "文本与著作类": "#2ECC71",
    "组织/机构/空间": "#E67E22", "组织/机构/空间实体": "#E67E22",
    "时代/历史/时序": "#9B59B6",
    "价值/意识形态/文化": "#F1C40F",
    "研究要素/学术工具": "#1ABC9C",
    "行为/实践/社会行动": "#E91E63",
    "权利/规范/法律": "#00BCD4",
    "关系载体": "#795548",
}

EDGE_COLORS = {
    "PROPOSED_BY": ("#2196F3", "提出"), "PUBLISHED_IN": ("#4CAF50", "发表于"),
    "INHERITS_FROM": ("#9C27B0", "继承自"), "CRITIQUES": ("#F44336", "批判"),
    "DEVELOPS_INTO": ("#FF9800", "发展为"), "LEAD_TO": ("#FF5722", "导致"),
    "BELONG_TO": ("#607D8B", "属于"), "CONTRAST_WITH": ("#795548", "对立于"),
    "对应实体": ("#E91E63", "对应实体"),
    "聚合领域": ("#00BCD4", "聚合领域"),
    "所属社区": ("#8BC34A", "所属社区"),
    "EXTRACTED_FROM": ("#FFC107", "来源"),
}

NODE_SHAPES = {
    "领域知识": "star",
    "时间线": "triangle",
    "社区": "diamond",
}

nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")

# ── 拉数据 ──
print("拉取实体...")
total_ent = nc.execute_query("MATCH (e:Entity) RETURN count(e) AS c")[0]["c"]
print(f"  Total: {total_ent}")

entities = nc.execute_query(
    "MATCH (e:Entity) OPTIONAL MATCH (e)-[r]-() WHERE type(r) <> 'EXTRACTED_FROM' "
    "RETURN elementId(e) AS eid, e.name AS name, e.category AS category, "
    "e.level AS level, e.description AS description, count(r) AS deg "
    "ORDER BY deg DESC LIMIT $l",
    {"l": MAX_ENTITIES}
)
print(f"  Selected entities: {len(entities)}")

# ── 拉 DomainKnowledge ──
domains = nc.execute_query(
    "MATCH (dk:DomainKnowledge) RETURN elementId(dk) AS eid, dk.domain AS name, '领域知识' AS cat, "
    "dk.domain AS level, '' AS description, 50 AS deg"
)
print(f"  DomainKnowledge: {len(domains)}")

# ── 拉 TimelineNode ──
timelines = nc.execute_query(
    "MATCH (tn:TimelineNode) RETURN elementId(tn) AS eid, tn.stage_name AS name, '时间线' AS cat, "
    "toString(tn.start_year) AS level, tn.core_theory AS description, 30 AS deg"
)
# fix nulls
for t in timelines:
    if not t['name']: t['name'] = '(未命名时间线)'
print(f"  TimelineNode: {len(timelines)}")

# ── 拉 Community ──
communities = nc.execute_query(
    "MATCH (c:Community) OPTIONAL MATCH (e:Entity)-[:BELONGS_TO_COMMUNITY]->(c) "
    "RETURN elementId(c) AS eid, c.name AS name, '社区' AS cat, "
    "c.level AS level, '' AS description, count(e) AS deg"
)
print(f"  Community: {len(communities)}")

# ── 合并 ──
all_nodes = list(entities) + list(domains) + list(timelines) + list(communities)
eids = {r["eid"] for r in all_nodes}
print(f"  Total nodes: {len(all_nodes)} (entities {len(entities)} + DK {len(domains)} + TN {len(timelines)} + Comm {len(communities)})")

# ── 拉关系（含聚合关系） ──
print("拉取关系...")

# Entity-to-Entity
e2e_rels = nc.execute_query(
    "MATCH (e1:Entity)-[r]->(e2:Entity) WHERE type(r) IN "
    "['LEAD_TO','BELONG_TO','PROPOSED_BY','CONTRAST_WITH','INHERITS_FROM','PUBLISHED_IN','DEVELOPS_INTO','CRITIQUES'] "
    "RETURN elementId(e1) AS eid1, elementId(e2) AS eid2, type(r) AS t LIMIT $l",
    {"l": MAX_EDGES}
)
print(f"  Entity edges: {len(e2e_rels)}")

# Distill → Entity (CORRESPONDS_TO)
d2e_rels = nc.execute_query(
    "MATCH (ld:LiteratureDistill)-[r:CORRESPONDS_TO]->(e:Entity) "
    "RETURN elementId(ld) AS eid1, elementId(e) AS eid2, '对应实体' AS t LIMIT 500"
)
print(f"  Distill→Entity edges: {len(d2e_rels)}")

# Distill → DomainKnowledge (AGGREGATED_INTO)
d2dk_rels = nc.execute_query(
    "MATCH (ld:LiteratureDistill)-[r:AGGREGATED_INTO]->(dk:DomainKnowledge) "
    "RETURN elementId(ld) AS eid1, elementId(dk) AS eid2, '聚合领域' AS t LIMIT 300"
)
print(f"  Distill→DK edges: {len(d2dk_rels)}")

# Entity → Community
e2c_rels = nc.execute_query(
    "MATCH (e:Entity)-[r:BELONGS_TO_COMMUNITY]->(c:Community) "
    "RETURN elementId(e) AS eid1, elementId(c) AS eid2, '所属社区' AS t LIMIT 500"
)
print(f"  Entity→Community edges: {len(e2c_rels)}")

all_rels = list(e2e_rels) + list(d2e_rels) + list(d2dk_rels) + list(e2c_rels)
print(f"  Total edges: {len(all_rels)}")

nc.close()

# ── 构建 vis.js 数据 ──
nodes = []
node_map = {}
categories_seen = set()

for ent in all_nodes:
    eid = ent["eid"]
    name = (ent.get("name") or "").strip()
    if not name:
        name = "…"
    cat = ent.get("category", "其它")
    lvl = ent.get("level", "") or ""
    desc = (ent.get("description", "") or "")[:100].replace('"', "'")
    deg = ent.get("deg", 0)

    color = CATEGORY_COLORS.get(cat, "#95A5A6")
    shape = NODE_SHAPES.get(cat, "dot")
    categories_seen.add(cat)

    nodes.append({
        "id": eid,
        "label": name[:24],
        "title": f"<b>{name}</b><br>{cat} | {lvl}<br>{desc}",
        "color": {"background": color, "border": "#222"},
        "shape": shape,
        "size": min(8 + deg * 1.5, 40),
        "font": {"size": 9, "face": "Microsoft YaHei, sans-serif", "color": "#ddd"},
    })
    node_map[eid] = name

edges = []
for rel in all_rels:
    if rel["eid1"] in node_map and rel["eid2"] in node_map and rel["eid1"] != rel["eid2"]:
        cinfo = EDGE_COLORS.get(rel["t"], ("#999", rel["t"]))
        edges.append({
            "from": rel["eid1"],
            "to": rel["eid2"],
            "title": cinfo[1],
            "label": cinfo[1],
            "color": {"color": cinfo[0], "opacity": 0.6},
            "arrows": "to",
            "smooth": {"type": "continuous", "roundness": 0.3},
            "width": 1.5 if rel["t"] in ("聚合领域", "所属社区", "对应实体") else 0.8,
            "dashes": True if rel["t"] in ("聚合领域", "所属社区", "对应实体") else False,
        })

print(f"Nodes: {len(nodes)}, Edges: {len(edges)}, Categories: {len(categories_seen)}")

# ── 图例 ──
legend_items = "".join(
    f'<span style="color:{CATEGORY_COLORS.get(c, "#95A5A6")}">●</span> {c}<br>'
    for c in sorted(categories_seen)
)
edge_legend = "".join(
    f'<span style="color:{v[0]}">━━</span> {v[1]} ({k})<br>'
    for k, v in EDGE_COLORS.items()
)

# ── HTML 模板 ──
html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GraphRAG-Marx 知识图谱</title>
<style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ font-family: "Microsoft YaHei", sans-serif; overflow: hidden; background: #1a1a2e; }}
#graph {{ width: 100vw; height: 100vh; }}
#panel {{
  position: fixed; top: 10px; right: 10px;
  background: rgba(0,0,0,0.80); color: #eee; padding: 12px 16px;
  border-radius: 8px; font-size: 12px; z-index: 999; max-height: 80vh; overflow-y: auto;
  line-height: 1.7; min-width: 180px;
}}
#panel b {{ color: #fff; }}
#info {{
  position: fixed; top: 10px; left: 10px;
  background: rgba(0,0,0,0.80); color: #ccc; padding: 10px 14px;
  border-radius: 8px; font-size: 12px; z-index: 999; line-height: 1.6;
}}
input#search {{
  position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
  width: 320px; padding: 10px 16px; border-radius: 20px; border: 1px solid #555;
  background: rgba(0,0,0,0.75); color: #fff; font-size: 14px; z-index: 999;
  outline: none;
}}
input#search:focus {{ border-color: #3498DB; }}
</style>
</head>
<body>
<div id="info">
  <b>GraphRAG-Marx</b><br>
  实体 {len(nodes)} | 关系 {len(edges)} | {len(categories_seen)} 类<br>
  {datetime.now().strftime('%Y-%m-%d %H:%M')}<br>
  <span style="color:#888">拖拽/滚轮/搜索</span>
</div>
<div id="panel">
  <b>节点类型</b><br>{legend_items}<br>
  <b>关系类型</b><br>{edge_legend}<br>
  <b>提示</b><br>
  <span style="color:#ccc">拖拽 / 滚轮缩放</span><br>
  <span style="color:#ccc">搜索框 底部</span><br>
  <span style="color:#ccc">Esc 重置</span><br>
  <span style="color:#ccc">★领域知识 △时间线</span><br>
  <span style="color:#ccc">◆社区 ·实体</span><br>
  <span style="color:#ccc">--- 虚线=聚合/社区</span>
</div>
<input id="search" placeholder="搜索实体..." autocomplete="off">

<div id="graph"></div>

<script>
{VIS_JS}
</script>

<script>
var nodes = new vis.DataSet({json.dumps(nodes, ensure_ascii=False)});
var edges = new vis.DataSet({json.dumps(edges, ensure_ascii=False)});

var container = document.getElementById('graph');
var data = {{ nodes: nodes, edges: edges }};
var options = {{
  interaction: {{
    hover: true, tooltipDelay: 100,
    zoomView: true, dragView: true,
    navigationButtons: true,
    keyboard: {{ enabled: true, bindToWindow: false }}
  }},
  nodes: {{
    borderWidth: 1, borderWidthSelected: 3,
    chosen: {{ node: function(vals) {{ vals.borderWidth = 3; }} }}
  }},
  edges: {{
    font: {{ size: 9, color: '#aaa', face: 'Microsoft YaHei' }},
    chosen: {{ edge: function(vals) {{ vals.width = 3; }} }}
  }},
  physics: {{
    solver: 'barnesHut',
    barnesHut: {{ gravitationalConstant: -2000, centralGravity: 0.3, springLength: 150, springConstant: 0.02, damping: 0.4 }},
    stabilization: {{ iterations: 150, fit: true }}
  }}
}};

var network = new vis.Network(container, data, options);

// 搜索框
document.getElementById('search').addEventListener('input', function(e) {{
  var q = e.target.value.trim().toLowerCase();
  if (!q) {{
    nodes.forEach(function(n) {{ nodes.update({{id: n.id, opacity: 1}}); }});
    edges.forEach(function(ed) {{ edges.update({{id: ed.id, opacity: 1}}); }});
    return;
  }}
  var matched = new Set();
  nodes.forEach(function(n) {{
    if (n.label.toLowerCase().includes(q) || (n.title && n.title.toLowerCase().includes(q))) {{
      matched.add(n.id);
      nodes.update({{id: n.id, opacity: 1, size: n.size * 1.8}});
    }} else {{
      nodes.update({{id: n.id, opacity: 0.15, size: n.size}});
    }}
  }});
  edges.forEach(function(ed) {{
    if (matched.has(ed.from) || matched.has(ed.to)) {{
      edges.update({{id: ed.id, opacity: 1}});
    }} else {{
      edges.update({{id: ed.id, opacity: 0.05}});
    }}
  }});
}});

// 点击节点高亮其邻居
network.on('click', function(params) {{
  if (params.nodes.length === 0) return;
  var clicked = params.nodes[0];
  var neighbors = new Set([clicked]);
  edges.forEach(function(ed) {{
    if (ed.from === clicked) neighbors.add(ed.to);
    if (ed.to === clicked) neighbors.add(ed.from);
  }});
  // 重置所有
  nodes.forEach(function(n) {{
    nodes.update({{id: n.id, opacity: 0.2}});
  }});
  edges.forEach(function(ed) {{
    edges.update({{id: ed.id, opacity: 0.05}});
  }});
  // 高亮邻居
  neighbors.forEach(function(nid) {{
    nodes.update({{id: nid, opacity: 1}});
  }});
  edges.forEach(function(ed) {{
    if (neighbors.has(ed.from) || neighbors.has(ed.to)) {{
      edges.update({{id: ed.id, opacity: 1, width: 2}});
    }}
  }});
}});

// Esc 重置
document.addEventListener('keydown', function(e) {{
  if (e.key === 'Escape') {{
    nodes.forEach(function(n) {{ nodes.update({{id: n.id, opacity: 1, size: n.size}}); }});
    edges.forEach(function(ed) {{ edges.update({{id: ed.id, opacity: 1, width: 0.8}}); }});
    document.getElementById('search').value = '';
  }}
}});
</script>
</body>
</html>"""

OUTPUT.write_text(html, encoding="utf-8")
print(f"\n保存: {OUTPUT}  ({OUTPUT.stat().st_size / 1024:.0f} KB)")
print("双击文件即可在浏览器中打开。")
print(f"实体 {len(nodes)} 个, 关系 {len(edges)} 条, {len(categories_seen)} 个类别")

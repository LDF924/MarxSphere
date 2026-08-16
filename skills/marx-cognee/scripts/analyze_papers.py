import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from pathlib import Path

p = Path(r"D:\Desktop\ov_import")
papers = sorted([d for d in p.iterdir() if d.is_dir()])

print(f"Total papers: {len(papers)}")
print()

# Collect sizes
data = []
for i, paper in enumerate(papers):
    orig = paper / f"{paper.name}.original.md"
    if orig.exists():
        size = orig.stat().st_size
        lines = len(orig.read_text('utf-8').splitlines())
        data.append((i+1, size, lines, paper.name))

# Sort by size desc
data.sort(key=lambda x: -x[1])

print("=== 最大的20篇论文 ===")
for idx, size, lines, name in data[:20]:
    print(f"  [{idx}] {size:>6}B {lines:>4}行  {name[:50]}")

print()
print("=== 最小的20篇论文 ===")
for idx, size, lines, name in data[-20:]:
    print(f"  [{idx}] {size:>6}B {lines:>4}行  {name[:50]}")

# Size buckets
buckets = {"<1KB":0, "1-10KB":0, "10-30KB":0, "30-50KB":0, ">50KB":0}
for _, size, _, _ in data:
    if size < 1000: buckets["<1KB"] += 1
    elif size < 10000: buckets["1-10KB"] += 1
    elif size < 30000: buckets["10-30KB"] += 1
    elif size < 50000: buckets["30-50KB"] += 1
    else: buckets[">50KB"] += 1

print()
print("=== 大小分布 ===")
for k, v in buckets.items():
    pct = v / len(papers) * 100
    print(f"  {k}: {v} ({pct:.1f}%)")

# Check which papers already succeeded vs hung
succeeded_names = [
    "ȵů÷ Ǯ   ",  # paper 1
]

print()
print("=== 已成功的论文大小 ===")
# From Neo4j
from neo4j import GraphDatabase
d = GraphDatabase.driver('bolt://localhost:7687', auth=('neo4j', 'password'))
s = d.session()
completed = [r[0] for r in s.run('MATCH (e:Episodic) RETURN e.name').values()]
d.close()

completed_sizes = []
for name in completed:
    for idx, size, lines, pname in data:
        if pname == name:
            completed_sizes.append((idx, size, lines))
            break

for idx, size, lines in sorted(completed_sizes):
    print(f"  [{idx}] {size}B {lines}行")

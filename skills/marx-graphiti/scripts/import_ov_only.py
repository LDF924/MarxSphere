"""
只导入论文到 OpenViking（跳过 Graphiti — 等结构化输出解决后再跑）
"""
import sys
import requests
from pathlib import Path

PAPERS_DIR = Path(r"D:\Desktop\ov_import")
OV_URL = "http://127.0.0.1:8000"


def add_one(paper_dir: Path) -> tuple[int, str]:
    dname = paper_dir.name
    # MKCOL
    requests.request("MKCOL", f"{OV_URL}/webdav/resources/{dname}/")
    ok = 0
    for f in sorted(paper_dir.glob("*.md")):
        body = f.read_text("utf-8")
        r = requests.put(
            f"{OV_URL}/webdav/resources/{dname}/{f.name}",
            data=body.encode("utf-8"),
            headers={"Content-Type": "text/markdown; charset=utf-8"},
        )
        if r.status_code in (200, 201, 204):
            ok += 1
        else:
            print(f"  [ERR] {f.name}: {r.status_code}")
    return ok, dname


start = int(sys.argv[1]) if len(sys.argv) > 1 else 0
limit = int(sys.argv[2]) if len(sys.argv) > 2 else None

papers = sorted([d for d in PAPERS_DIR.iterdir() if d.is_dir()])
batch = papers[start:] if limit is None else papers[start:start + limit]

total = 0
for i, p in enumerate(batch):
    n, name = add_one(p)
    total += n
    if (i + 1) % 20 == 0:
        print(f"[{start+i+1}] {name[:50]}... ({n}/4)  |  累计: {total} files")

print(f"\n完成: {len(batch)} 篇论文, {total} 个文件 -> OpenViking")

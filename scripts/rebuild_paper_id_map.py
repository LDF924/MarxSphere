import os
"""V96: 重建 paper_id_map.json — 保留 gold_dataset 依赖的稳定 id, 补齐 ov_import 全部论文
策略:
  1. 保留现有 map 中 title 匹配到当前 ov_import 论文的条目 (复用原 paper_id)
  2. 对 ov_import 中未匹配的论文生成确定性 hash id (md5(folder_name)[:12])
  3. gold_dataset 引用的 50 个 paper_id 全部保留 (title 匹配则复用, 否则保留原条目)
"""
import hashlib, json
from pathlib import Path

OV_IMPORT = Path(r"D:\Desktop\ov_import")
MAP_PATH = Path(Path(os.environ.get('SAG_ROOT', '.')) / 'paper_id_map.json')
GOLD_PATH = Path(Path(os.environ.get('SAG_ROOT', '.')) / 'gold_dataset.json')

def gen_id(folder_name: str) -> str:
    return hashlib.md5(folder_name.encode("utf-8")).hexdigest()[:12]

def scan_papers(base: Path) -> list[Path]:
    papers = []
    if not base.exists(): return papers
    for entry in sorted(base.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."): continue
        if list(entry.glob("*.original.md")):
            papers.append(entry)
        else:
            for sub in sorted(entry.iterdir()):
                if sub.is_dir() and not sub.name.startswith("."):
                    if list(sub.glob("*.original.md")):
                        papers.append(sub)
    return papers

def main():
    # 1. 加载现状 — 优先用 .v96-before-rebuild 备份作为 id 稳定源
    #    (重建脚本自身生成的新 map 可能因 title 覆盖丢条目, 备份保留真实历史)
    old_src = MAP_PATH.parent / "paper_id_map.json.v96-before-rebuild"
    src_map = json.loads(old_src.read_text(encoding="utf-8")) if old_src.exists() else json.loads(MAP_PATH.read_text(encoding="utf-8"))
    cur_map = src_map
    gold = json.loads(GOLD_PATH.read_text(encoding="utf-8"))
    gold_pids = {q["paper_id"] for q in gold if q.get("paper_id")}
    gold_titles = {q.get("paper_title", "") for q in gold if q.get("paper_title")}

    # 2. 扫描当前论文
    papers = scan_papers(OV_IMPORT)
    paper_names = {p.name for p in papers}
    print(f"ov_import 论文: {len(papers)}")

    # 3. 建立 folder_name -> 现有 title -> paper_id 索引
    title_to_pid = {}   # title -> paper_id (当前 map)
    for pid, info in cur_map.items():
        t = (info.get("title") or "").strip()
        if t: title_to_pid[t] = pid

    # 4. 为每篇论文确定 paper_id — 精确 title==folder 才复用, 不做包含吸收
    new_map = {}
    reused = 0; new_ids = 0; gold_kept = 0
    for p in papers:
        folder = p.name
        # 仅精确 title == folder 才复用现有 id (避免短标题吸收长标题)
        matched_pid = title_to_pid.get(folder)
        if matched_pid:
            new_map[matched_pid] = {
                "paper_id": matched_pid,
                "title": folder,
                "graphiti_folder": folder,
            }
            reused += 1
        else:
            pid = gen_id(folder)
            new_map[pid] = {
                "paper_id": pid,
                "title": folder,
                "graphiti_folder": folder,
            }
            new_ids += 1

    # 5. 确保 gold_dataset 依赖的 50 个 paper_id 全部存在
    new_keys = set(new_map.keys())
    missing_gold = gold_pids - new_keys
    if missing_gold:
        print(f"  WARN: gold 引用但未覆盖: {len(missing_gold)}")
        for gpid in missing_gold:
            info = cur_map.get(gpid, {})
            new_map[gpid] = {
                "paper_id": gpid,
                "title": info.get("title", ""),
                "graphiti_folder": info.get("graphiti_folder", ""),
            }
            gold_kept += 1

    # 6. 排序 + 写入
    sorted_map = dict(sorted(new_map.items()))
    MAP_PATH.write_text(
        json.dumps(sorted_map, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"重建完成:")
    print(f"  总数: {len(sorted_map)}")
    print(f"  复用现有 id: {reused}")
    print(f"  新生成 id: {new_ids}")
    print(f"  gold 补充保留: {gold_kept}")
    print(f"  gold 引用全部存在: {gold_pids <= set(sorted_map.keys())}")
    # 验证 gold title
    final_titles = {v.get("title", "") for v in sorted_map.values()}
    gold_ok = all(any(gt == t or gt in t or t in gt for t in final_titles) for gt in gold_titles if gt)
    print(f"  gold title 全部可匹配: {gold_ok}")

if __name__ == "__main__":
    main()

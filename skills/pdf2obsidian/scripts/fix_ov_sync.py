"""
从源数据重新同步 208 篇论文到 OV 数据目录，确保文件夹名和文件内容一致
"""
import sys, io, os, shutil
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

SOURCE = Path(r"D:\Desktop\ov_import")
TARGET = Path(r"%USERPROFILE%\openviking_data\viking\default\resources")

# 清理旧的论文目录（保留 .obsidian、demo_paper、test_paper）
for item in sorted(TARGET.iterdir()):
    if item.is_dir() and not item.name.startswith('.') and item.name not in ('demo_paper', 'test_paper'):
        shutil.rmtree(item, ignore_errors=True)
        print(f'删除: {item.name[:60]}')
print()

# 然后从 ov_import 重新生成
PAPERS = sorted([d for d in SOURCE.iterdir() if d.is_dir() and not d.name.startswith('.')])

for src in PAPERS:
    folder_name = src.name
    tgt_dir = TARGET / folder_name
    tgt_dir.mkdir(parents=True, exist_ok=True)

    for md in sorted(src.glob("*.md")):
        tgt_file = tgt_dir / md.name
        content = md.read_text("utf-8")

        # 统一修正：frontmatter 中 title 和 paperTitle 匹配文件夹名 (不含作者)
        import re
        paper_name = folder_name.rsplit("_", 1)[0]  # e.g. "城乡中国时代的资本下乡"

        # 修正 title 和 paperTitle frontmatter
        content = re.sub(
            r'^title:\s*.+$',
            f'title: {paper_name}',
            content, flags=re.MULTILINE
        )
        content = re.sub(
            r'^paperTitle:\s*.+$',
            f'paperTitle: {paper_name}',
            content, flags=re.MULTILINE
        )

        tgt_file.write_text(content, "utf-8")

    print(f"✅ {folder_name[:60]}")

print(f"\n总计: {len(PAPERS)} 篇论文，文件名和内容已同步")

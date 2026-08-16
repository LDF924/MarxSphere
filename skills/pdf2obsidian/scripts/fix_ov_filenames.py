"""
修复 OV 数据目录中的乱码文件名（URL 编码 → 正常中文）
"""
import os
from pathlib import Path
from urllib.parse import unquote

RESOURCES_DIR = Path(r"%USERPROFILE%\openviking_data\viking\default\resources")

def fix_encoding(path: Path):
    """递归修复目录和文件名中的 URL 编码"""
    for item in sorted(path.iterdir()):
        old_name = item.name
        try:
            new_name = unquote(old_name, encoding='utf-8')
        except Exception:
            new_name = old_name

        if new_name != old_name:
            new_path = item.parent / new_name
            counter = 1
            while new_path.exists():
                stem = item.stem
                suffix = item.suffix
                new_path = item.parent / f"{unquote(stem, encoding='utf-8')}_{counter}{suffix}"
                counter += 1
            print(f"  {old_name[:60]}")
            print(f"  → {new_name[:60]}")
            print()
            os.rename(str(item), str(new_path))
            item = new_path

        if item.is_dir():
            fix_encoding(item)

print("修复 URL 编码乱码...")
print(f"目标目录: {RESOURCES_DIR}")
print()
fix_encoding(RESOURCES_DIR)
print("完成！")

import os
import re
import shutil
from pathlib import Path

# ====== 配置 ======
SOURCE_DIR = Path(r"E:\1.Obsidian Vault\课题文献库（CSSCI、北大核心、CSCD、AMI、WJCI）\学术期刊\资本下乡（2012—2026年6月）\Markdown")
OUTPUT_DIR = Path(r"D:\Desktop\ov_import")

# 需要导入的 4 个文件（用关键词匹配，因为 original 文件名和目录名一致）
KEEP_FILES = ["摘要.md", "术语表.md", "问答.md"]  # original 单独处理


def clean_content(text: str) -> str:
    """清洗单个 Markdown 文件内容"""
    # 1. 删除整个 wiki 链接（不保留文本），因为提取出的 index 引用没有意义
    text = re.sub(r'\[\[.*?\]\]', '', text)

    # 2. 删除 HTML <details> 整块
    text = re.sub(r'<details[^>]*>.*?</details>', '', text, flags=re.DOTALL)

    # 3. 删除 Obsidian 图片引用 ![](...) 或 ![[...]]
    text = re.sub(r'!\[.*?\]\(.*?\)', '', text)
    text = re.sub(r'!\[\[.*?\]\]', '', text)

    # 4. 删除 "← 返回：..." 导航行
    text = re.sub(r'\*\*← 返回：.*?\*\*\s*', '', text)

    # 5. 删除孤立的 "**← 返回：**"
    text = re.sub(r'\*\*← 返回：\*\*', '', text)

    # 6. 删除孤立的 Obsidian index 引用行（wiki 链接去掉后的残留）
    text = re.sub(r'^.*\.index\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^.*\.index\s*\n', '\n', text, flags=re.MULTILINE)

    # 7. 删除残余的 <summary> / </details> 孤标簽
    text = re.sub(r'<summary[^>]*>.*?</summary>\s*', '', text, flags=re.DOTALL)
    text = re.sub(r'</details>', '', text)
    text = re.sub(r'<details[^>]*>', '', text)

    # 8. 删除多余的 `text_image` 残留
    text = re.sub(r'text_image\s*', '', text)

    # 9. 压缩多余空行：连续3+空行→2空行
    text = re.sub(r'\n{4,}', '\n\n\n', text)
    # 删除开头空行
    text = text.lstrip('\n')

    return text


def clean_frontmatter(text: str) -> str:
    """简化 YAML frontmatter，只保留 title 和 paperTitle"""
    if not text.startswith('---'):
        return text

    # 找到 frontmatter 范围
    end = text.find('---', 3)
    if end == -1:
        return text

    fm = text[3:end].strip()
    body = text[end + 3:]

    # 提取需要的字段
    title_match = re.search(r'^title:\s*(.+)$', fm, re.MULTILINE)
    paper_title_match = re.search(r'^paperTitle:\s*(.+)$', fm, re.MULTILINE)

    new_fm_lines = ['---']
    if title_match:
        new_fm_lines.append(f'title: {title_match.group(1).strip()}')
    if paper_title_match:
        new_fm_lines.append(f'paperTitle: {paper_title_match.group(1).strip()}')
    new_fm_lines.append('---')

    return '\n'.join(new_fm_lines) + '\n' + body


def process_paper(paper_dir: Path) -> bool:
    """处理一篇论文，返回是否成功"""
    dir_name = paper_dir.name

    # 跳过非论文目录（json、log、check_report、数据库.base）
    if dir_name.endswith('.json') or dir_name.endswith('.log') or dir_name.endswith('.base') or dir_name == 'check_report.json':
        return False

    # 创建输出目录
    out_dir = OUTPUT_DIR / dir_name
    out_dir.mkdir(parents=True, exist_ok=True)

    processed = 0

    # --- 处理 original.md ---
    # 文件名和目录名一致
    original_name = f"{dir_name}.original.md"
    original_path = paper_dir / original_name
    if original_path.exists():
        content = original_path.read_text(encoding='utf-8')
        content = clean_content(content)
        content = clean_frontmatter(content)
        (out_dir / original_name).write_text(content, encoding='utf-8')
        processed += 1

    # --- 处理 摘要.md、术语表.md、问答.md ---
    for fname in KEEP_FILES:
        fpath = paper_dir / fname
        if fpath.exists():
            content = fpath.read_text(encoding='utf-8')
            content = clean_content(content)
            content = clean_frontmatter(content)
            (out_dir / fname).write_text(content, encoding='utf-8')
            processed += 1

    return processed >= 1


def main():
    # 确保输出目录存在
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # 统计
    total = 0
    success = 0
    skipped = []

    for item in sorted(SOURCE_DIR.iterdir()):
        if not item.is_dir():
            continue
        if item.name.startswith('.'):
            continue

        total += 1
        ok = process_paper(item)
        if ok:
            success += 1
        else:
            skipped.append(item.name)

    print(f"总计论文目录: {total}")
    print(f"成功清洗: {success}")
    print(f"跳过/失败: {len(skipped)}")
    if skipped:
        for s in skipped:
            print(f"  - {s}")

    # 验证输出
    out_dirs = [d for d in OUTPUT_DIR.iterdir() if d.is_dir()]
    total_files = sum(1 for d in out_dirs for f in d.iterdir() if f.is_file())
    print(f"\n输出目录: {OUTPUT_DIR}")
    print(f"输出论文数: {len(out_dirs)}")
    print(f"输出文件数: {total_files}")
    print(f"平均每篇: {total_files / len(out_dirs):.1f} 个文件" if out_dirs else "")


if __name__ == "__main__":
    main()

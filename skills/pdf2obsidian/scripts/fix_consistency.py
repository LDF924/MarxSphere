# fix_consistency.py
# pdf2obsidian 输出一致性修复脚本
# 修复所有已知问题：目录名统一、wiki-link 修正、重复去重、元数据补全、state 重建
# 用法: cd Markdown目录 && python3 "${CLAUDE_SKILL_DIR}/scripts/fix_consistency.py"
import os, re, json, shutil, sys
from collections import defaultdict


def safe_rename(old_path, new_path):
    """Windows 安全重命名，目标存在则跳过。"""
    if os.path.exists(new_path):
        return False
    os.rename(old_path, new_path)
    return True


def fix_dir_names(md_dir, pdf_dir):
    """修复目录名：以 PDF 文件名为准重命名所有目录和内部文件。"""
    renamed = 0
    # 读取 sourcePdf → 当前目录映射
    source_to_dir = {}
    for d in os.listdir(md_dir):
        dpath = os.path.join(md_dir, d)
        if not os.path.isdir(dpath):
            continue
        for f in os.listdir(dpath):
            if "original" in f and f.endswith(".md"):
                with open(os.path.join(dpath, f), "rb") as fh:
                    for line in fh:
                        if line.startswith(b"sourcePdf:"):
                            sp = line.split(b":", 1)[1].strip()
                            if sp.startswith(b'"'):
                                sp = sp[1:-1]
                            source_to_dir[sp.decode("utf-8")] = d
                            break
                break

    for sp, cur_dir in source_to_dir.items():
        target = sp[:-4] if sp.lower().endswith(".pdf") else sp
        if target == cur_dir:
            continue
        old_path = os.path.join(md_dir, cur_dir)
        new_path = os.path.join(md_dir, target)
        if safe_rename(old_path, new_path):
            for f in os.listdir(new_path):
                if f.endswith(".md") and f.startswith(cur_dir):
                    suffix = f[len(cur_dir) :]
                    os.rename(
                        os.path.join(new_path, f),
                        os.path.join(new_path, target + suffix),
                    )
            renamed += 1
    return renamed


def fix_wiki_links(md_dir):
    """修复所有 .md 文件中指向旧 slug 的 wiki-link。"""
    fixed = 0
    for d in os.listdir(md_dir):
        dpath = os.path.join(md_dir, d)
        if not os.path.isdir(dpath):
            continue
        for f in os.listdir(dpath):
            if not f.endswith(".md"):
                continue
            fpath = os.path.join(dpath, f)
            with open(fpath, "r", encoding="utf-8", errors="replace") as fh:
                content = fh.read()

            def fix_link(m):
                inner = m.group(1)
                parts = inner.split("|")
                target = parts[0].split("#")[0]
                if target in ("摘要", "术语表", "问答"):
                    return m.group(0)
                if target.startswith(d):
                    return m.group(0)
                for sfx in ["_信息", ".original", ".index"]:
                    if target.endswith(sfx):
                        new_target = d + sfx
                        new_inner = new_target + (
                            "|" + parts[1] if len(parts) > 1 else ""
                        )
                        return "[[" + new_inner + "]]"
                return m.group(0)

            new_content = re.sub(r"\[\[([^\]]+)\]\]", fix_link, content)
            if new_content != content:
                with open(fpath, "w", encoding="utf-8") as fh:
                    fh.write(new_content)
                fixed += 1
    return fixed


def remove_duplicates(md_dir):
    """删除同一 sourcePdf 的重复目录，保留与 PDF 文件名完全匹配的。"""
    import shutil

    source_dirs = defaultdict(list)
    for d in os.listdir(md_dir):
        dpath = os.path.join(md_dir, d)
        if not os.path.isdir(dpath):
            continue
        for f in os.listdir(dpath):
            if "original" in f.lower():
                with open(os.path.join(dpath, f), "rb") as fh:
                    for line in fh:
                        if line.startswith(b"sourcePdf:"):
                            sp = line.split(b":", 1)[1].strip()
                            if sp.startswith(b'"'):
                                sp = sp[1:-1]
                            source_dirs[sp.decode("utf-8")].append(d)
                            break
                break

    deleted = 0
    for sp, dirs in source_dirs.items():
        if len(dirs) <= 1:
            continue
        target = sp[:-4] if sp.lower().endswith(".pdf") else sp
        keep = target if target in dirs else max(
            dirs,
            key=lambda x: sum(
                os.path.getsize(os.path.join(md_dir, x, f))
                for f in os.listdir(os.path.join(md_dir, x))
                if os.path.isfile(os.path.join(md_dir, x, f))
            ),
        )
        for d in dirs:
            if d != keep:
                shutil.rmtree(os.path.join(md_dir, d))
                deleted += 1
    return deleted


def rebuild_state(md_dir):
    """基于当前目录的 sourcePdf 重建 state 文件。"""
    state = {}
    for d in os.listdir(md_dir):
        dpath = os.path.join(md_dir, d)
        if not os.path.isdir(dpath):
            continue
        for f in os.listdir(dpath):
            if "original" in f.lower() and f.endswith(".md"):
                with open(os.path.join(dpath, f), "rb") as fh:
                    for line in fh:
                        if line.startswith(b"sourcePdf:"):
                            sp = line.split(b":", 1)[1].strip()
                            if sp.startswith(b'"'):
                                sp = sp[1:-1]
                            state[sp.decode("utf-8")] = "finished"
                            break
                break

    state_path = os.path.join(md_dir, ".pdf2obsidian_state.json")
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent="\t")
    return len(state)


def verify(md_dir, pdf_dir):
    """最终验证: PDF数 = 目录数 = sourcePdf数。"""
    sources = set()
    for d in os.listdir(md_dir):
        dpath = os.path.join(md_dir, d)
        if not os.path.isdir(dpath):
            continue
        for f in os.listdir(dpath):
            if "original" in f.lower() and f.endswith(".md"):
                with open(os.path.join(dpath, f), "rb") as fh:
                    for line in fh:
                        if line.startswith(b"sourcePdf:"):
                            sp = line.split(b":", 1)[1].strip()
                            if sp.startswith(b'"'):
                                sp = sp[1:-1]
                            sources.add(sp.decode("utf-8"))
                            break
                break

    pdfs = set(f for f in os.listdir(pdf_dir) if f.lower().endswith(".pdf"))
    dirs = set(d for d in os.listdir(md_dir) if os.path.isdir(os.path.join(md_dir, d)))
    print(
        f"PDF={len(pdfs)} Dir={len(dirs)} SourcePdf={len(sources)} "
        f"Extra={len(dirs-pdfs)} Missing={len(pdfs-dirs)}"
    )
    return len(pdfs) == len(dirs) == len(sources)


def main():
    import argparse

    parser = argparse.ArgumentParser(description="pdf2obsidian 输出一致性修复")
    parser.add_argument("--md-dir", required=True, help="Markdown 输出目录")
    parser.add_argument("--pdf-dir", required=True, help="PDF 源文件目录")
    parser.add_argument("--skip-extract", action="store_true", help="跳过元数据提取")
    args = parser.parse_args()

    md_dir = args.md_dir
    pdf_dir = args.pdf_dir

    print("=== 1/6 修复目录名 ===")
    n = fix_dir_names(md_dir, pdf_dir)
    print(f"  重命名: {n} 个目录")

    print("\n=== 2/6 修复 wiki-link ===")
    n = fix_wiki_links(md_dir)
    print(f"  修复: {n} 个文件")

    print("\n=== 3/6 删除重复目录 ===")
    n = remove_duplicates(md_dir)
    print(f"  删除: {n} 个重复目录")

    print("\n=== 4/6 提取元数据（年/作者）===")
    if not args.skip_extract:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from extract_metadata import extract_year, extract_authors

        fixed_yr = fixed_au = 0
        for d in sorted(os.listdir(md_dir)):
            dpath = os.path.join(md_dir, d)
            if not os.path.isdir(dpath):
                continue
            for f in sorted(os.listdir(dpath)):
                if not f.endswith(".original.md"):
                    continue
                fpath = os.path.join(dpath, f)
                with open(fpath, "r", encoding="utf-8", errors="replace") as fh:
                    content = fh.read()
                if not content.startswith("---"):
                    break
                parts = content.split("---", 2)
                if len(parts) < 3:
                    break
                fm, body = parts[1], parts[2]
                modified = False

                if "year:" not in fm:
                    y = extract_year(body)
                    if y:
                        fm = re.sub(
                            r"(translatedTitle:.*\n)",
                            r"\1year: " + y + "\n",
                            fm,
                            count=1,
                        )
                        if "year:" not in fm:
                            fm = re.sub(
                                r"(paperTitle:.*\n)",
                                r"\1year: " + y + "\n",
                                fm,
                                count=1,
                            )
                        if "year:" in fm:
                            fixed_yr += 1
                            modified = True

                if "authors:" not in fm:
                    au = extract_authors(body)
                    if not au:
                        # 从文件名提取
                        parts_name = d.rsplit("_", 1)
                        if len(parts_name) == 2 and re.match(
                            r"^[一-鿿]{2,4}$", parts_name[1]
                        ):
                            au = [parts_name[1]]
                    if au:
                        block = "authors:\n"
                        for a in au:
                            block += "  - " + a + "\n"
                        if "sourceHash:" in fm:
                            fm = fm.replace("sourceHash:", block + "sourceHash:")
                        elif "lang:" in fm:
                            fm = fm.replace("lang:", block + "lang:")
                        else:
                            fm = fm.rstrip() + "\n" + block
                        fixed_au += 1
                        modified = True

                if modified:
                    new_content = "---\n" + fm + "\n---" + parts[2]
                    with open(fpath, "w", encoding="utf-8") as fh:
                        fh.write(new_content)
                break
        print(f"  补充年份: {fixed_yr}, 补充作者: {fixed_au}")
    else:
        print("  跳过")

    print("\n=== 5/6 重建 state 文件 ===")
    n = rebuild_state(md_dir)
    print(f"  state 条目: {n}")

    print("\n=== 6/6 最终验证 ===")
    ok = verify(md_dir, pdf_dir)
    print(f"  全部一致: {ok}")


if __name__ == "__main__":
    main()

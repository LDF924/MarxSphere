#!/usr/bin/env python3
"""pdf2obsidian 修复工具：一站式修复目录名、wiki-link、state 文件、sourcePdf 字段等。

用法:
  python3 fix_md_dirs.py                            # 完整修复（在 Markdown 目录下运行）
  python3 fix_md_dirs.py --audit-only               # 仅审计，不修改
  python3 fix_md_dirs.py --fix-names                # 仅修复目录名
  python3 fix_md_dirs.py --fix-wikilinks            # 仅修复 wiki-link
  python3 fix_md_dirs.py --fix-state                # 仅重建 state
  python3 fix_md_dirs.py --fix-sourcepdf            # 仅补全缺失的 sourcePdf 字段
  python3 fix_md_dirs.py --pdf-dir PATH             # 指定 PDF 目录（默认 ../PDF）
"""
import os, re, json, hashlib, argparse

EMPTY_HASH = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def audit(md_dir, pdf_dir):
    """打印完整的审计报告。"""
    pdfs = {re.sub(r'\.pdf$', '', f, flags=re.IGNORECASE) for f in os.listdir(pdf_dir) if f.lower().endswith('.pdf')}
    md_dirs = {d for d in os.listdir(md_dir) if os.path.isdir(d)}
    matched = pdfs & md_dirs

    print(f"=== 数量对齐 ===")
    print(f"PDF: {len(pdfs)}  MD: {len(md_dirs)}  匹配: {len(matched)}")
    missing = sorted(pdfs - md_dirs)
    extra = sorted(md_dirs - pdfs)
    if missing:
        print(f"缺MD目录({len(missing)}):")
        for m in missing[:10]:
            print(f"  {m}.pdf")
    if extra:
        print(f"多余MD目录({len(extra)}):")
        for e in extra[:10]:
            print(f"  {e}")

    # 正文为空
    print(f"\n=== 正文为空 ===")
    empty = []
    for d in sorted(md_dirs):
        for f in os.listdir(os.path.join(md_dir, d)):
            if '.original.md' in f:
                with open(os.path.join(md_dir, d, f), 'r', encoding='utf-8', errors='replace') as fh:
                    c = fh.read()
                parts = c.split('---', 2)
                text = parts[2] if len(parts) >= 3 else c
                clean = re.sub(r'#.*?\n', '', text).strip()
                if len(clean) < 50 or EMPTY_HASH in c:
                    empty.append((d, len(clean)))
                break
    print(f"正文为空: {len(empty)}")
    for d, l in empty:
        print(f"  {d[:70]} ({l}字)")

    # AI 文件
    print(f"\n=== AI 文件 ===")
    no_s, no_g, no_q = [], [], []
    for d in sorted(md_dirs):
        files = set(os.listdir(os.path.join(md_dir, d)))
        if '摘要.md' not in files: no_s.append(d)
        if '术语表.md' not in files: no_g.append(d)
        if '问答.md' not in files: no_q.append(d)
    print(f"缺摘要: {len(no_s)}  缺术语表: {len(no_g)}  缺问答: {len(no_q)}")
    if no_s: print(f"  缺摘要: {[d[:50] for d in no_s[:5]]}")
    if no_g: print(f"  缺术语表: {[d[:50] for d in no_g[:5]]}")
    if no_q: print(f"  缺问答: {[d[:50] for d in no_q[:5]]}")

    # sourcePdf 字段
    print(f"\n=== sourcePdf 字段 ===")
    no_src = []
    for d in sorted(md_dirs):
        for f in os.listdir(os.path.join(md_dir, d)):
            if '.original.md' in f:
                with open(os.path.join(md_dir, d, f), 'r', encoding='utf-8', errors='replace') as fh:
                    if 'sourcePdf:' not in fh.read():
                        no_src.append(d)
                break
    print(f"缺 sourcePdf: {len(no_src)}")
    for d in no_src:
        print(f"  {d[:70]}")

    # 正文长度
    print(f"\n=== 正文长度 ===")
    sizes = []
    for d in sorted(md_dirs):
        for f in os.listdir(os.path.join(md_dir, d)):
            if '.original.md' in f:
                with open(os.path.join(md_dir, d, f), 'r', encoding='utf-8', errors='replace') as fh:
                    c = fh.read()
                parts = c.split('---', 2)
                text = parts[2] if len(parts) >= 3 else c
                sizes.append(len(text.strip()))
                break
    if sizes:
        print(f"min={min(sizes)}  max={max(sizes)}  median={sorted(sizes)[len(sizes)//2]}  avg={sum(sizes)//len(sizes)}")
        short = [(d, l) for d, l in zip(sorted(md_dirs), sizes) if l < 2000]
        if short:
            print(f"短文(<2000字): {len(short)} 篇")

    # sourcePdf → 目录名 映射检查
    print(f"\n=== sourcePdf → 目录名 ===")
    mismatches = []
    for d in sorted(md_dirs):
        for f in os.listdir(os.path.join(md_dir, d)):
            if '.original.md' in f:
                with open(os.path.join(md_dir, d, f), 'rb') as fh:
                    for line in fh:
                        if line.startswith(b'sourcePdf:'):
                            sp = line.split(b':', 1)[1].strip()
                            if sp.startswith(b'"'): sp = sp[1:-1]
                            sp = sp.decode('utf-8')
                            expected = sp[:-4] if sp.lower().endswith('.pdf') else sp
                            if d != expected:
                                mismatches.append((d, expected))
                        break
                break
    print(f"目录名与 sourcePdf 不一致: {len(mismatches)}")
    for d, exp in mismatches[:10]:
        print(f"  当前: {d[:60]}")
        print(f"  期望: {exp[:60]}")

    all_ok = (len(empty) == 0 and len(no_s) == 0 and len(no_g) == 0 and len(no_q) == 0
              and len(no_src) == 0 and len(missing) == 0 and len(mismatches) == 0)
    print(f"\n=== 总结: {'全部OK' if all_ok else '有问题需修复'} ===")
    return {
        "missing": missing, "extra": extra, "empty": empty,
        "no_summary": no_s, "no_glossary": no_g, "no_qa": no_q,
        "no_sourcepdf": no_src, "mismatches": mismatches, "all_ok": all_ok,
    }


def fix_names(md_dir):
    """以 sourcePdf 为准重命名目录和内部 .md 文件。"""
    source_to_dir = {}
    for d in sorted(os.listdir(md_dir)):
        dpath = os.path.join(md_dir, d)
        if not os.path.isdir(dpath): continue
        for f in os.listdir(dpath):
            if '.original.md' in f:
                with open(os.path.join(dpath, f), 'rb') as fh:
                    for line in fh:
                        if line.startswith(b'sourcePdf:'):
                            sp = line.split(b':', 1)[1].strip()
                            if sp.startswith(b'"'): sp = sp[1:-1]
                            sp = sp.decode('utf-8')
                            source_to_dir[sp] = d
                break
    print(f"sourcePdf 映射: {len(source_to_dir)} 条目")

    renamed = 0
    for sp, cur_dir in source_to_dir.items():
        target = sp[:-4] if sp.lower().endswith('.pdf') else sp
        if cur_dir == target:
            continue
        old_path = os.path.join(md_dir, cur_dir)
        new_path = os.path.join(md_dir, target)
        if os.path.exists(new_path):
            print(f"  冲突跳过: {cur_dir[:60]}")
            continue
        os.rename(old_path, new_path)
        renamed += 1
        for f in os.listdir(new_path):
            if f.endswith('.md') and f.startswith(cur_dir):
                suffix = f[len(cur_dir):]
                new_f = target + suffix
                new_f = new_f.replace('# ', '')
                os.rename(os.path.join(new_path, f), os.path.join(new_path, new_f))
    print(f"重命名完成: {renamed} 目录")


def fix_wikilinks(md_dir):
    """修复 wiki-link 使其指向当前目录名。"""
    fixed = 0
    for d in sorted(os.listdir(md_dir)):
        dpath = os.path.join(md_dir, d)
        if not os.path.isdir(dpath): continue
        for f in os.listdir(dpath):
            if not f.endswith('.md'): continue
            fpath = os.path.join(dpath, f)
            with open(fpath, 'r', encoding='utf-8', errors='replace') as fh:
                content = fh.read()

            def fix_link(m):
                inner = m.group(1)
                parts = inner.split('|')
                target_name = parts[0].split('#')[0]
                if target_name in ('摘要', '术语表', '问答'):
                    return m.group(0)
                if target_name.startswith(d):
                    return m.group(0)
                for sfx in ['_信息', '.original', '.index']:
                    if target_name.endswith(sfx):
                        new_target = d + sfx
                        new_inner = new_target + ('|' + parts[1] if len(parts) > 1 else '')
                        return '[[' + new_inner + ']]'
                return m.group(0)

            new_content = re.sub(r'\[\[([^\]]+)\]\]', fix_link, content)
            if new_content != content:
                with open(fpath, 'w', encoding='utf-8') as fh:
                    fh.write(new_content)
                fixed += 1
    print(f"wiki-link 修复: {fixed} 个文件")


def fix_state(md_dir):
    """以当前 sourcePdf 映射为准，重建 .pdf2obsidian_state.json。"""
    state_path = os.path.join(md_dir, '.pdf2obsidian_state.json')
    old_state = {}
    if os.path.exists(state_path):
        with open(state_path, 'r', encoding='utf-8') as fh:
            old_state = json.load(fh)

    state = {}
    for d in sorted(os.listdir(md_dir)):
        dpath = os.path.join(md_dir, d)
        if not os.path.isdir(dpath): continue
        for f in os.listdir(dpath):
            if '.original.md' in f:
                with open(os.path.join(dpath, f), 'rb') as fh:
                    for line in fh:
                        if line.startswith(b'sourcePdf:'):
                            sp = line.split(b':', 1)[1].strip().decode('utf-8').strip('"')
                            state[sp] = 'finished'
                break

    for k, v in old_state.items():
        if k not in state:
            state[k] = v

    with open(state_path, 'w', encoding='utf-8') as fh:
        json.dump(state, fh, ensure_ascii=False, indent='\t')
    print(f"重建 state: {len(state)} 条目 (保留 {len(old_state)} → {len(state)})")


def fix_sourcepdf(md_dir):
    """为缺少 sourcePdf 字段的 original.md 补全。通过目录名推断 PDF 名。"""
    fixed = 0
    for d in sorted(os.listdir(md_dir)):
        dpath = os.path.join(md_dir, d)
        if not os.path.isdir(dpath): continue
        for f in os.listdir(dpath):
            if '.original.md' in f:
                fpath = os.path.join(dpath, f)
                with open(fpath, 'r', encoding='utf-8', errors='replace') as fh:
                    content = fh.read()
                if 'sourcePdf:' in content:
                    break
                # 补全：目录名 + .pdf
                pdf_name = d + '.pdf'
                lines = content.split('\n')
                new_lines = []
                inserted = False
                for line in lines:
                    new_lines.append(line)
                    if not inserted and line.startswith('sourceHash:'):
                        new_lines.append(f'sourcePdf: {pdf_name}')
                        inserted = True
                if not inserted:
                    fm_end = None
                    for i, line in enumerate(new_lines):
                        if i > 0 and line.strip() == '---':
                            fm_end = i
                            break
                    if fm_end:
                        new_lines.insert(fm_end, f'sourcePdf: {pdf_name}')
                with open(fpath, 'w', encoding='utf-8', errors='replace') as fh:
                    fh.write('\n'.join(new_lines))
                fixed += 1
                break
    print(f"补全 sourcePdf: {fixed} 个文件")


def main():
    parser = argparse.ArgumentParser(description="pdf2obsidian 修复工具")
    parser.add_argument("--dir", default=".", help="Markdown 目录（默认当前目录）")
    parser.add_argument("--pdf-dir", default="../PDF", help="PDF 源目录（默认 ../PDF）")
    parser.add_argument("--audit-only", action="store_true")
    parser.add_argument("--fix-names", action="store_true")
    parser.add_argument("--fix-wikilinks", action="store_true")
    parser.add_argument("--fix-state", action="store_true")
    parser.add_argument("--fix-sourcepdf", action="store_true")
    parser.add_argument("--all", action="store_true", help="执行全部修复")
    args = parser.parse_args()

    md_dir = os.path.abspath(args.dir)
    pdf_dir = os.path.abspath(args.pdf_dir)

    if args.audit_only:
        audit(md_dir, pdf_dir)
        return

    run_all = args.all or (not args.fix_names and not args.fix_wikilinks
                           and not args.fix_state and not args.fix_sourcepdf)

    print(f"MD目录: {md_dir}")
    print(f"PDF目录: {pdf_dir}")
    print()

    # 先审计
    result = audit(md_dir, pdf_dir)
    print()

    if run_all or args.fix_names:
        if result["mismatches"] or result["extra"]:
            print(">>> 修复目录名...")
            fix_names(md_dir)
        else:
            print("目录名已一致，跳过")

    if run_all or args.fix_wikilinks:
        print(">>> 修复 wiki-link...")
        fix_wikilinks(md_dir)

    if run_all or args.fix_sourcepdf:
        if result["no_sourcepdf"]:
            print(">>> 补全 sourcePdf 字段...")
            fix_sourcepdf(md_dir)
        else:
            print("sourcePdf 字段已齐全，跳过")

    if run_all or args.fix_state:
        print(">>> 重建 state 文件...")
        fix_state(md_dir)

    print("\n=== 修复后验证 ===")
    result2 = audit(md_dir, pdf_dir)
    if result2["all_ok"]:
        print("\n全部通过!")


if __name__ == '__main__':
    main()

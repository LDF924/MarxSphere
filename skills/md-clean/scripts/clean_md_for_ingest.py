"""Clean Obsidian Markdown files for ingestion into marx-graphiti / marx-cognee.

Strips all YAML frontmatter fields except `title` and `paperTitle`.
Keeps only .original.md / 摘要.md / 术语表.md / 问答.md per paper dir.

Usage:
    python clean_md_for_ingest.py <source_dir> <target_dir>
"""
import re
import sys
import os as _os
from pathlib import Path
from datetime import datetime

KEEP_FILES = {".original.md", "摘要.md", "术语表.md", "问答.md"}
FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)

# ══════════════════════════════════════════════════════════════════
# LAYER 0: md-clean 专属自愈 — 只修 md-clean 遇到的坑
# ══════════════════════════════════════════════════════════════════

def _log(action, detail=""):
    msg = f"  [PREFLIGHT] {action}"
    if detail:
        msg += f" — {detail}"
    print(msg, flush=True)

def preflight_md_clean(source_dir, target_dir):
    """md-clean 特有故障检测+自愈。

    踩坑记录:
      1. 源目录路径含中文空格 → Path 构造失败
      2. 目标磁盘空间不足 → 写一半中断
      3. frontmatter 不是标准 YAML 分隔符 → 正则 miss
      4. 文件编码非 UTF-8 → UnicodeDecodeError
      5. 进程被 Ctrl+C → 目标残留半成品文件
    """
    src = Path(source_dir)
    tgt = Path(target_dir)
    fixes = 0

    # ── 1. 源目录存在性 ──
    if not src.exists():
        # 尝试常见路径变体
        alt = str(src).replace("\\", "/").replace("//", "/")
        alt_src = Path(alt)
        if alt_src.exists():
            _log("FIX: source path needed slash-normalization", alt[:80])
            fixes += 1
            source_dir = alt
        else:
            _log("FATAL: source directory does not exist", str(src)[:120])
            sys.exit(1)

    # ── 2. 目标磁盘空间检查 ──
    try:
        import shutil
        free = shutil.disk_usage(str(tgt) if tgt.exists() else str(tgt.parent))
        free_gb = free.free / (1024 ** 3)
        # md-clean 输出很小（~50KB/篇 × 300篇 ≈ 15MB），但检查一下
        if free_gb < 0.1:
            _log(f"WARN: target disk has only {free_gb:.2f} GB free — may fail mid-write")
    except Exception:
        pass  # 网络盘/虚拟盘可能不支持 disk_usage

    # ── 3. 源目录中是否有非 UTF-8 文件 ──
    bad_encoding = 0
    for entry in sorted(src.iterdir()):
        if not entry.is_dir():
            continue
        for sub in entry.iterdir():
            if sub.is_dir():
                continue
            name_lower = sub.name.lower()
            if not any(name_lower.endswith(s) for s in KEEP_FILES):
                continue
            try:
                sub.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                bad_encoding += 1
                if bad_encoding <= 3:
                    _log(f"WARN: non-UTF-8 encoding detected", sub.name[:60])
    if bad_encoding:
        _log(f"WARN: {bad_encoding} files have encoding issues (will print READ ERROR but continue)")

    # ── 4. 目标目录残留清理（上次 Ctrl+C 中断） ──
    if tgt.exists():
        existing = [d for d in tgt.iterdir() if d.is_dir()]
        if existing:
            _log(f"INFO: target has {len(existing)} existing dirs — will overwrite if re-processed")

    # ── 5. 统计源目录结构 ──
    paper_dirs = [d for d in src.iterdir() if d.is_dir()]
    incomplete = 0
    for d in paper_dirs:
        names = {f.name for f in d.iterdir() if f.is_file()}
        expected = 4  # original + 摘要 + 术语 + 问答
        if len(names) < expected:
            incomplete += 1
    if incomplete:
        _log(f"WARN: {incomplete}/{len(paper_dirs)} source dirs have < {expected} files (may be partial)")
    _log(f"INFO: {len(paper_dirs)} paper dirs found, {incomplete} incomplete")

    if fixes:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Preflight: {fixes} fixes applied", flush=True)
    return source_dir  # may have been normalized


def clean_frontmatter(text: str) -> str:
    """Strip frontmatter down to only title + paperTitle fields."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return text

    raw = m.group(1)
    kept = []
    for line in raw.split("\n"):
        key = line.split(":", 1)[0].strip()
        if key in ("title", "paperTitle"):
            kept.append(line)

    if not kept:
        return text[m.end():]

    return "---\n" + "\n".join(kept) + "\n---\n" + text[m.end():]


def process_paper(src_dir: Path, dst_dir: Path) -> bool:
    """Process one paper directory. Returns True on success."""
    dst_dir.mkdir(parents=True, exist_ok=True)
    ok = True

    for entry in src_dir.iterdir():
        if entry.is_dir():
            continue
        name = entry.name.lower()

        if not any(name.endswith(suffix) for suffix in KEEP_FILES):
            continue

        try:
            content = entry.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            # Try with BOM or gbk fallback (pdf2obsidian sometimes emits non-UTF8)
            try:
                content = entry.read_text(encoding="gbk")
                print(f"  RECOVERED (gbk): [{entry.name}]")
            except Exception as e:
                print(f"  READ ERROR [{entry.name}]: {e}")
                ok = False
                continue
        except Exception as e:
            print(f"  READ ERROR [{entry.name}]: {e}")
            ok = False
            continue

        cleaned = clean_frontmatter(content)
        out_path = dst_dir / entry.name
        try:
            out_path.write_text(cleaned, encoding="utf-8")
        except Exception as e:
            print(f"  WRITE ERROR [{entry.name}]: {e}")
            ok = False

    return ok


def main():
    if len(sys.argv) < 3:
        print("Usage: python clean_md_for_ingest.py <source_dir> <target_dir>")
        print("Example:")
        print('  python clean_md_for_ingest.py "E:\\Obsidian Vault\\Markdown" "D:\\Desktop\\ov_import\\output"')
        sys.exit(1)

    src_root_raw = sys.argv[1]
    tgt_root_raw = sys.argv[2]

    # ══════════════════════════════════════════════════════════════
    # 前置条件检查：跑之前必须满足，不满足直接退出
    # ══════════════════════════════════════════════════════════════

    src_root = Path(src_root_raw)
    tgt_root = Path(tgt_root_raw)

    # 1. 源目录必须存在
    if not src_root.exists():
        print(f"FATAL: 源目录不存在: {src_root}")
        sys.exit(1)

    # 2. 源目录必须包含子文件夹
    paper_dirs = [d for d in src_root.iterdir() if d.is_dir()]
    if not paper_dirs:
        print(f"FATAL: 源目录下没有子文件夹: {src_root}")
        sys.exit(1)
    print(f"前置检查: 源目录 OK ({len(paper_dirs)} 个论文文件夹)")

    # 3. 目标父目录必须可写
    try:
        tgt_root.mkdir(parents=True, exist_ok=True)
        test = tgt_root / ".write_test"
        test.write_text("ok")
        test.unlink()
    except (PermissionError, OSError) as e:
        print(f"FATAL: 目标目录不可写: {tgt_root} — {e}")
        sys.exit(1)
    print(f"前置检查: 目标目录 OK (可写)")

    tgt_root.mkdir(parents=True, exist_ok=True)

    total = 0
    success = 0
    errors = 0

    for entry in sorted(src_root.iterdir()):
        if not entry.is_dir():
            if entry.suffix == ".log":
                continue
            print(f"SKIP (not a dir): {entry.name}")
            continue

        total += 1
        dst = tgt_root / entry.name
        print(f"[{total}] {entry.name}")

        if process_paper(entry, dst):
            success += 1
        else:
            errors += 1

    print(f"\nDone. Total dirs: {total}, success: {success}, errors: {errors}")


if __name__ == "__main__":
    main()

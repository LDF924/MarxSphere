# extract_metadata.py
# 从 original.md 正文中提取年份和作者信息，补全 frontmatter 元数据
# 用法: cd Markdown目录 && python3 extract_metadata.py
import os, re, sys
sys.stdout.reconfigure(encoding='utf-8')


def extract_year(body: str) -> str:
    """从正文前 1000 字符中提取年份。"""
    # 优先级: (C)2021 > 2021 年 > 收稿日期2021 > DOI中的年份 > 正文中的20xx

    # 1. 版权标记
    m = re.search(r'(?:[©©]|\(c\))\s*(19|20)\d{2}', body[:500], re.I)
    if m: return m.group(0)[-4:]

    # 2. "2021 年" 模式
    m = re.search(r'(19|20)\d{2}\s*[年]', body[:500])
    if m: return m.group(0)[:4]

    # 3. 期刊卷期: 《期刊名》，2021 年第
    m = re.search(r'[，,]\s*(19|20)\d{2}\s*[年第]', body[:800])
    if m: return m.group(0)[-6:-2] if len(m.group(0)) > 5 else m.group(0)[-4:]

    # 4. 收稿日期
    m = re.search(r'(?:收稿日期|投稿日期)[：:]\s*(19|20)\d{2}', body[:1000])
    if m: return m.group(0)[-4:]

    # 5. 中图分类号行附近
    m = re.search(r'中图分类号.*?(19|20)\d{2}', body[:1000])
    if m: return m.group(0)[-4:]

    # 6. DOI 中的年份 (10.xxxx/xxx.2021.xxx)
    m = re.search(r'/(19|20)(?:0[89]|1\d|2[0-6])\.\d', body[:1000])
    if m: return m.group(0)[1:5]

    return ""


def extract_authors(body: str) -> list[str]:
    """从正文前 8 个非标题行中提取作者姓名。"""
    lines = [l.strip() for l in body.split("\n") if l.strip() and not l.strip().startswith("#")]
    results = []

    for line in lines[:8]:
        # A. 纯中文姓名（2-4 字，无空格无标点）
        if re.match(r"^[一-鿿]{2,4}$", line):
            return [line]

        # B. 空格分隔的中文姓名
        m = re.match(r"^[一-鿿](?:\s+[一-鿿]){1,3}$", line)
        if m:
            return [re.sub(r"\s+", "", line)]

        # C. 带符号的作者行：◇解 安 余婧兰
        m = re.match(r"^[◇◆■□○●△▲▽▼☆★*]?\s*([一-鿿]{2,4}(?:\s+[一-鿿]{2,4})*)", line)
        if m and len(m.group(1).replace(" ", "")) >= 4:
            name_groups = m.group(1).strip().split()
            return [ng for ng in name_groups if re.match(r"^[一-鿿]{2,4}$", ng)]

        # D. "文 / 作者1 作者2"
        m = re.search(r"文\s*/\s*([一-鿿]{2,4}(?:\s+[一-鿿]{2,4})*)", line)
        if m:
            name_groups = m.group(1).strip().split()
            return [ng for ng in name_groups if re.match(r"^[一-鿿]{2,4}$", ng)]

        # E. "作者名（单位）" 模式
        m = re.search(r"[一-鿿]{2,4}[\s（(]", line)
        if m:
            name = re.sub(r"[\s（(].*", "", line)
            name = re.sub(r"^[◇◆■□*]?\s*", "", name)
            name = re.sub(r"\s+", "", name)
            if re.match(r"^[一-鿿]{2,4}$", name):
                return [name]

    return []


def main():
    md_dir = os.getcwd()
    files = sorted(os.listdir(md_dir))

    fixed_year = 0
    fixed_author = 0
    total = 0

    for dirname in files:
        dpath = os.path.join(md_dir, dirname)
        if not os.path.isdir(dpath):
            continue

        # 找到 original.md
        orig_path = None
        for f in os.listdir(dpath):
            if f.endswith(".original.md"):
                orig_path = os.path.join(dpath, f)
                break
        if not orig_path:
            continue

        total += 1

        with open(orig_path, "r", encoding="utf-8") as f:
            content = f.read()

        if not content.startswith("---"):
            continue

        parts = content.split("---", 2)
        if len(parts) < 3:
            continue

        fm = parts[1]
        body = parts[2]
        modified = False

        # 提取年份
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
                    fm = re.sub(r"(paperTitle:.*\n)", r"\1year: " + y + "\n", fm, count=1)
                if "year:" in fm:
                    fixed_year += 1
                    modified = True

        # 提取作者
        if "authors:" not in fm:
            authors = extract_authors(body)
            if authors:
                block = "authors:\n"
                for a in authors:
                    block += "  - " + a + "\n"
                # 插入到 lang: 或 sourceHash: 之前
                if "sourceHash:" in fm:
                    fm = fm.replace("sourceHash:", block + "sourceHash:")
                elif "lang:" in fm:
                    fm = fm.replace("lang:", block + "lang:")
                else:
                    fm = fm.rstrip() + "\n" + block
                fixed_author += 1
                modified = True

        if modified:
            new_content = "---\n" + fm + "\n---" + parts[2]
            with open(orig_path, "w", encoding="utf-8") as f:
                f.write(new_content)

    print(f"处理目录数: {total}")
    print(f"补充年份: {fixed_year}")
    print(f"补充作者: {fixed_author}")


if __name__ == "__main__":
    main()

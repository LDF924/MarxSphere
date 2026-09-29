#!/usr/bin/env python3
"""
brand-rename.py — SocioSeek → 群学求真 SocioSeek 的全量重命名。

为什么是脚本而不是一串 sed:
  1. **行尾是混的** —— README/*.md 是 CRLF, src/ 是 LF。文本模式替换会把 CRLF 文件
     整体改写, git 里显示成"整个文件重写"。所以必须**字节级替换**。
  2. **小写变体不止一种** —— `socioseek` / `socioseek-soc` / `socioseek-app` /
     `socioseek-workbench` / `socioseek-architecture`, 各自的正确译法不同,
     一刀切会改坏 iframe 的 postMessage 协议。
  3. **有"改了就静默炸"的地方** —— `socioseek-soc` / `socioseek-app` 是外壳与
     Vue 子应用之间的握手标识, 两边必须同时改; 漏一边则跨应用通信断且**不报错**。

═══ 一个必须知道的事 ═══
`appId` 默认**不改**。改它会让已装用户的桌面端变成另一个应用(数据目录/单实例锁/
自动更新全断), 不是无损升级。真要改, 加 `--app-id` 显式声明, 并自备迁移方案。

用法:
    python scripts/brand-rename.py              # 预演, 不写文件
    python scripts/brand-rename.py --apply      # 真正执行
    python scripts/brand-rename.py --apply --app-id   # 连 appId 一起改(有迁移代价)
"""
import os, re, sys, argparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {"node_modules", ".git", "dist", "release", ".claude", ".safe",
             "eval-archive", "recovery", "coverage", ".vite", "temp", "tmp"}
# 这些文件里的名字是**历史记录**(提交标题、事故报告), 改了就是篡改史实
SKIP_FILES = {"sag_runtime.log"}

CN, EN = "群学求真", "SocioSeek"

# ── 替换规则: 顺序**重要**, 长的先替 ──
#
# ⚠ 源串用 `OLD + b"..."` 拼出来, **不能直接写字面量**。
#   2026-09-29 实测: 第一版把旧名直接写成字面量放在规则表里, 脚本一跑就
#   **把自己文件里的规则也替换了** —— 全部变成 `(b"SocioSeek", b"SocioSeek")`,
#   即"把 A 替换成 A"。之后这条规则永远匹配不到任何东西, 而**脚本照常报成功**。
#   这是个自指的坑: 工具遍历目录时把**工具自己**算作了被改对象。
#   拼字符串后, 源文件里就不存在完整的旧名, 规则表得以保留。
OLD = "Marx" + "Sphere"          # 旧名拆开写, 见上
old_l, old_u = OLD.encode(), OLD.upper().encode()

BASE = [
    # 例外标记: 商标法里的 exception 条款, 这个标识是法律文本的一部分
    (old_u + b"-Exception", b"SocioSeek-Exception"),
    # iframe 握手协议 —— 外壳与子应用两边必须同改, 否则静默失联
    (old_l + b"-soc", b"socioseek-soc"),
    (old_l + b"-app", b"socioseek-app"),
    (old_l + b"-workbench", b"socioseek-workbench"),
    (old_l + b"-architecture", b"socioseek-architecture"),
    (old_l + b"-painpoint-solution", b"socioseek-painpoint-solution"),
    # 品牌名
    (OLD.encode() + b"Research", (EN + "Research").encode()),
    (old_u, EN.upper().encode()),
    (OLD.encode(), EN.encode()),
    (old_l, EN.lower().encode()),
]

# ⚠ `appId` 必须**在通用规则之前**被保护掉。
#   2026-09-29 实测: 通用规则 `old_l → socioseek` 本身就会命中 `com.marxsphere.desktop`
#   （它是 `marxsphere` 的子串），于是 `--app-id` 这个开关**形同虚设** —— 加不加都会改。
#   所以这里用占位符先把 appId 挖出来，收尾时按开关决定放回哪个值。
APPID_OLD = ("com." + "marx" + "sphere").encode() + b".desktop"
APPID_NEW = b"com.socioseek.desktop"
APPID_PLACEHOLDER = b"__APPID_PLACEHOLDER__"


def walk():
    for dp, dns, fns in os.walk(ROOT):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for fn in fns:
            if fn in SKIP_FILES:
                continue
            yield os.path.join(dp, fn)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真正写盘(默认只预演)")
    ap.add_argument("--app-id", action="store_true", help="连 electron appId 一起改(有迁移代价)")
    args = ap.parse_args()

    rules = BASE

    hits, changed, skipped = {}, 0, []
    for path in walk():
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            continue
        # appId 先挖成占位符, 免得被通用规则顺手改掉(见 APPID_OLD 的说明)
        data = data.replace(APPID_OLD, APPID_PLACEHOLDER)
        if not any(pat in data for pat, _ in rules):
            continue
        new = data
        for pat, rep in rules:
            if pat in new:
                hits[pat] = hits.get(pat, 0) + new.count(pat)
                new = new.replace(pat, rep)
        # 收尾: 按开关放回
        final_appid = APPID_NEW if args.app_id else APPID_OLD
        if APPID_PLACEHOLDER in new:
            hits[b"(appId)"] = hits.get(b"(appId)", 0) + new.count(APPID_PLACEHOLDER)
            new = new.replace(APPID_PLACEHOLDER, final_appid)
        if new == data:
            continue
        rel = os.path.relpath(path, ROOT).replace("\\", "/")
        if b"\n" not in data[:4096] and len(data) > 4096:
            skipped.append(rel)          # 极可能是二进制(图片/压缩包), 不动
            continue
        changed += 1
        if args.apply:
            with open(path, "wb") as f:
                f.write(new)

    print(f"{'[预演] ' if not args.apply else ''}命中统计:")
    for pat, rep in rules:
        n = hits.get(pat, 0)
        if n:
            print(f"  {pat.decode(errors='replace'):<32} → {rep.decode(errors='replace'):<28} {n:>6} 处")
    print(f"\n{'已改' if args.apply else '将改'} {changed} 个文件")
    if skipped:
        print(f"跳过(疑似二进制) {len(skipped)} 个: {', '.join(skipped[:5])}")
    if not args.app_id:
        print(f"\n· appId 未改({('com.' + 'marx' + 'sphere.desktop')})。要改加 --app-id —— 注意已装用户会变成新应用。")
    if not args.apply:
        print("· 这是预演。确认无误后加 --apply。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

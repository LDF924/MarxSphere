#!/bin/bash
# ============================================================
# 知网文献批量下载 — 自动化脚本 v4.0
# 基于6轮实战总结，最终稳定版本
# ============================================================
#
# 前置条件:
#   1. Edge浏览器已登录知网（CARSI → 南宁师范大学）
#   2. CDP Proxy 已启动（端口3456）
#   3. 用户已在知网勾选好筛选条件（主题/学科/年度/研究层次/来源类别）
#   4. 每页显示50条
#
# 用法:
#   chmod +x cnki_batch_download.sh
#   ./cnki_batch_download.sh <SEARCH_TAB_ID> <TARGET_DIR>
#
# 示例:
#   ./cnki_batch_download.sh 1DC42212D9ABA84AEBE2D8995CAA7FA7 "C:/课题文献库/三农（2012—2026年6月）"
#
# 核心流程（每篇文章）:
#   ① 对比当前页与文件夹，找出缺失
#   ② 真实鼠标点击(clickAt)文章标题 → 新开详情tab
#   ③ 真实鼠标点击(clickAt) a#pdfDown → 触发Edge下载
#   ④ eval穿透Shadow DOM → 点击downloads-hub的.save按钮
#   ⑤ 等待.crdownload消失 → 下载完成
#   ⑥ 复制到目标文件夹 + 关闭详情tab
# ============================================================

set -o pipefail

SEARCH_TAB="${1:?Usage: $0 <search_tab_id> <target_dir>}"
DIR="${2:?Usage: $0 <search_tab_id> <target_dir>}"
PROXY="http://localhost:3456"
PER_PAGE=50

mkdir -p "$DIR" 2>/dev/null

echo "===== 知网批量下载 v4.0 ====="
echo "Tab: $SEARCH_TAB"
echo "目标: $DIR"
echo "已有: $(ls "$DIR"/*.pdf 2>/dev/null | wc -l) 篇"
echo ""

# ==================== 第一步：对比 ====================
echo "===== 第一步：对比当前页 vs 文件夹 ====="

MISSING_IDX=()
MISSING=0
TOTAL=0

for ((idx=0; idx<$PER_PAGE; idx++)); do
  RAW=$(curl -s "$PROXY/eval?target=$SEARCH_TAB" \
    -d "var a=document.querySelectorAll('td.name a')[$idx]; a?a.textContent.trim().replace(/\\s+/g,' '):''" 2>/dev/null)
  TITLE=$(echo "$RAW" | sed "s/^{'value':'//;s/'}$//")
  [ -z "$TITLE" ] && continue

  TOTAL=$((TOTAL+1))
  SAFE=$(echo "$TITLE" | sed 's/[\\/:*?"<>|]/_/g' | cut -c1-100)

  if [ -f "$DIR/$SAFE.pdf" ] && [ "$(stat -c%s "$DIR/$SAFE.pdf" 2>/dev/null)" -gt 50000 ] 2>/dev/null; then
    continue
  fi

  echo "  MISSING [$idx]: ${TITLE:0:60}"
  MISSING=$((MISSING+1))
  MISSING_IDX+=($idx)
done

echo "  共${TOTAL}篇 | 缺${MISSING}篇"

if [ ${#MISSING_IDX[@]} -eq 0 ]; then
  echo "  当前页全部完整！"
  echo "总计: $(ls "$DIR"/*.pdf 2>/dev/null | wc -l) 篇"
  exit 0
fi

# ==================== 第二步：下载 ====================
echo ""
echo "===== 第二步：真实鼠标点击下载${MISSING}篇 ====="

OK=0
FAIL=0

for idx in "${MISSING_IDX[@]}"; do
  # 获取标题
  RAW=$(curl -s "$PROXY/eval?target=$SEARCH_TAB" \
    -d "var a=document.querySelectorAll('td.name a')[$idx]; a?a.textContent.trim().replace(/\\s+/g,' '):''" 2>/dev/null)
  TITLE=$(echo "$RAW" | sed "s/^{'value':'//;s/'}$//")
  SAFE=$(echo "$TITLE" | sed 's/[\\/:*?"<>|]/_/g' | cut -c1-100)

  echo -n "  [$idx] ${TITLE:0:40}..."

  # ① 真实鼠标点击文章标题
  curl -s -X POST "$PROXY/clickAt?target=$SEARCH_TAB" -d 'td.name a' >/dev/null 2>&1
  sleep 4

  # ② 找到新打开的详情tab
  DTAB=$(curl -s "$PROXY/targets" \
    | python3 -c "import sys,json;[print(t['targetId']) for t in json.loads(sys.stdin.read()) if '/kcms2/article/abstract' in t.get('url','')]" 2>/dev/null \
    | head -1)

  if [ -z "$DTAB" ]; then
    echo "NO_TAB"
    FAIL=$((FAIL+1))
    continue
  fi

  # ③ 真实鼠标点击PDF下载按钮（多次点击确保触发）
  for c in 1 2 3; do
    curl -s -X POST "$PROXY/clickAt?target=$DTAB" -d 'a#pdfDown' >/dev/null 2>&1
    sleep 1.5
  done

  # ④ Edge下载Hub中点击"保存"按钮（穿透Shadow DOM）
  HTAB=$(curl -s "$PROXY/targets" \
    | python3 -c "import sys,json;[print(t['targetId']) for t in json.loads(sys.stdin.read()) if 'downloads-hub' in t.get('url','')]" 2>/dev/null \
    | head -1)

  if [ -n "$HTAB" ]; then
    curl -s -X POST "$PROXY/eval?target=$HTAB" \
      -d "var hub=document.querySelector('downloads-hub-app');if(hub){var lst=hub.shadowRoot.querySelector('downloads-list');var it=lst.shadowRoot.querySelectorAll('download-item');if(it.length){var f=it[0];if(f.getAttribute('state')==='pending_open_save_as'){var b=f.shadowRoot.querySelector('.save');if(b)b.click()}}}" >/dev/null
  fi

  # ⑤ 等待下载完成（.crdownload消失）
  for try in $(seq 1 12); do
    [ -z "$(ls /e/*.crdownload 2>/dev/null)" ] && break
    sleep 2
  done
  sleep 2

  # ⑥ 复制到目标文件夹
  LATEST=$(ls -t /e/*.pdf /e/*.crdownload 2>/dev/null | head -1)
  if [ -n "$LATEST" ]; then
    cp "$LATEST" "$DIR/$SAFE.pdf" 2>/dev/null
    sz=$(stat -c%s "$LATEST" 2>/dev/null)
    echo "OK($sz)"
    rm -f /e/*.crdownload /e/*.pdf 2>/dev/null
    OK=$((OK+1))
  else
    echo "NO_E"
    FAIL=$((FAIL+1))
  fi

  # ⑦ 关闭详情tab
  curl -s "$PROXY/close?target=$DTAB" >/dev/null 2>&1
  sleep 1
done

echo ""
echo "  补下载完成: OK=$OK FAIL=$FAIL"
echo "总计: $(ls "$DIR"/*.pdf 2>/dev/null | wc -l) 篇"

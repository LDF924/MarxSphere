#!/bin/bash
# =============================================================
# 知网文献批量下载自动化脚本 v3.0 (基于两轮实战总结)
# =============================================================
#
# 用法:
#   1. 用户在Edge中手动勾选筛选条件
#   2. 用户在Edge中手动翻页(每页50篇)
#   3. 每翻一页，运行本脚本下载当前页
#
#   ./cnki_download.sh <SEARCH_TAB_ID> <TARGET_DIR>
#   例: ./cnki_download.sh F73AE823C9D1B1B65F135367F4391B8E "C:/课题文献库/乡村振兴"
#
# 前置条件:
#   - Edge浏览器 + CDP Proxy (localhost:3456) 已连接
#   - 知网已登录 (CARSI → 南宁师范大学)
#   - 知网搜索结果页筛选条件已勾选
#   - 每页显示50条
#
# 核心流程 (每篇文章):
#   ① eval点击文章标题 → 新开详情tab
#   ② clickAt真实点击 a#pdfDown → 触发Edge下载
#   ③ eval穿透Shadow DOM → 点击downloads-hub的.save按钮
#   ④ 等待crdownload消失 + extra wait → 下载完成
#   ⑤ 复制到目标文件夹 + 关闭详情tab
#
# 避坑要点:
#   - 不刷新页面(丢失筛选条件)
#   - 不使用scroll(破坏筛选状态)
#   - 等待crdownload消失后再复制(避免文件截断)
#   - 逐篇下载 + 每篇间隔3-5秒(减少验证码)
#   - 失败的文章需要逐篇重试(核对+补下载)
# =============================================================

set -o pipefail

SEARCH_TAB="${1:?Usage: $0 <search_tab_id> <target_dir>}"
DIR="${2:?Usage: $0 <search_tab_id> <target_dir>}"
PROXY="http://localhost:3456"
PER_PAGE=50

mkdir -p "$DIR" 2>/dev/null

echo "===== 知网批量下载 v3.0 ====="
echo "Tab: $SEARCH_TAB  |  Target: $DIR"
echo "已有: $(ls "$DIR"/*.pdf 2>/dev/null | wc -l) 篇"
echo ""

OK=0 FAIL=0

for ((i=0; i<$PER_PAGE; i++)); do

  # STEP 1: 获取第i篇文章标题
  TITLE=$(curl -s "$PROXY/eval?target=$SEARCH_TAB" \
    -d "(function(){var r=document.querySelectorAll('tr');var cnt=0;for(var j=1;j<r.length;j++){var c=r[j].cells;if(!c||c.length<8)continue;if(cnt==$i)return(c[1].textContent||'').trim().replace(/\\s+/g,' ');cnt++}return''})()" \
    | sed 's/^{"value":"//;s/"}$//')

  [ -z "$TITLE" ] && { FAIL=$((FAIL+1)); continue; }

  # STEP 2: 安全文件名 (用下划线替换非法字符)
  SAFE=$(echo "$TITLE" | sed 's/[\\/:*?"<>|]/_/g' | cut -c1-100)

  # STEP 3: 跳过已下载 (文件大小 > 50KB)
  if [ -f "$DIR/$SAFE.pdf" ]; then
    sz=$(stat -c%s "$DIR/$SAFE.pdf" 2>/dev/null)
    [ "$sz" -gt 50000 ] 2>/dev/null && continue
    rm -f "$DIR/$SAFE.pdf" 2>/dev/null
  fi

  echo -n "[$((i+1))/$PER_PAGE] ${TITLE:0:40}..."

  # STEP 4: 点击文章标题 → 打开详情页
  curl -s -X POST "$PROXY/eval?target=$SEARCH_TAB" \
    -d "(function(){var r=document.querySelectorAll('tr');var cnt=0;for(var j=1;j<r.length;j++){var c=r[j].cells;if(!c||c.length<8)continue;if(cnt==$i){var a=c[1].querySelector('a');if(a){a.click();return'ok'}}cnt++}return'nf'})()" >/dev/null
  sleep 3

  # STEP 5: 找到新打开的详情页Tab
  DTAB=$(curl -s "$PROXY/targets" \
    | python3 -c "import sys,json;[print(t['targetId']) for t in json.loads(sys.stdin.read()) if '/kcms2/article/abstract' in t.get('url','')]" 2>/dev/null \
    | head -1)
  [ -z "$DTAB" ] && { echo "NO_TAB"; FAIL=$((FAIL+1)); continue; }

  # STEP 6: 真实鼠标点击PDF下载按钮 (clickAt = CDP Input.dispatchMouseEvent)
  curl -s -X POST "$PROXY/clickAt?target=$DTAB" -d 'a#pdfDown' >/dev/null 2>&1
  sleep 2

  # STEP 7: Edge下载Hub中点击"保存"按钮 (穿透Shadow DOM)
  HTAB=$(curl -s "$PROXY/targets" \
    | python3 -c "import sys,json;[print(t['targetId']) for t in json.loads(sys.stdin.read()) if 'downloads-hub' in t.get('url','')]" 2>/dev/null \
    | head -1)
  if [ -n "$HTAB" ]; then
    curl -s -X POST "$PROXY/eval?target=$HTAB" \
      -d "var hub=document.querySelector('downloads-hub-app');if(hub){var lst=hub.shadowRoot.querySelector('downloads-list');var it=lst.shadowRoot.querySelectorAll('download-item');if(it.length){var f=it[0];if(f.getAttribute('state')==='pending_open_save_as'){var b=f.shadowRoot.querySelector('.save');if(b)b.click()}}}" >/dev/null
  fi

  # STEP 8: 等待下载完成 (crdownload消失 + extra wait)
  for try in $(seq 1 12); do
    [ -z "$(ls /e/*.crdownload 2>/dev/null)" ] && break
    sleep 2
  done
  sleep 2  # Extra safety wait

  # STEP 9: 复制到目标文件夹
  LATEST=$(ls -t /e/*.pdf /e/*.crdownload 2>/dev/null | head -1)
  if [ -n "$LATEST" ] && [ -f "$LATEST" ]; then
    cp "$LATEST" "$DIR/$SAFE.pdf" 2>/dev/null
    rm -f /e/*.crdownload /e/*.pdf 2>/dev/null
    OK=$((OK+1))
  else
    echo -n "NO_E"
    FAIL=$((FAIL+1))
  fi

  # STEP 10: 关闭详情页Tab
  curl -s "$PROXY/close?target=$DTAB" >/dev/null 2>&1
  sleep 3  # 间隔3秒避免触发验证码
done

echo ""
echo "===== 本页完成: OK=$OK FAIL=$FAIL ====="
echo "总计: $(ls "$DIR"/*.pdf 2>/dev/null | wc -l) 篇"

# 提示查漏补缺
if [ $FAIL -gt 0 ]; then
  echo "⚠ 有 $FAIL 篇失败，需要逐篇核对重试。"
  echo "  运行: cnki_retry.sh $SEARCH_TAB \"$DIR\""
fi

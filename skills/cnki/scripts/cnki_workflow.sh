#!/bin/bash
# ============================================================
# 知网批量下载 v5.4
# ============================================================
# 前置条件:
#   1. Edge/Chrome 已登录知网（CARSI 或机构登录）
#   2. 搜索页面已完成筛选，每页50条
#   3. 浏览器下载路径已设置好
#
# 用法: /cnki
#
# 流程:
#   ① CDP Proxy → 列出Tab → 选择搜索页+下载文件夹
#   ② 全量下载：逐篇点击，记录成功/失败序号
#   ③ 等待下载完成 → 比对缺失（标题前6字+第一作者匹配）→ 补下载
#   ④ 汇报汇总：成功序号、失败序号
# ============================================================

set -o pipefail

PROXY="http://localhost:3456"
DIR=""
TAB_ID=""

# 保存下载状态，支持 Ctrl+C 中断
SUCCESS=()
FAILED=()
CLEANUP_DONE=false

cleanup() {
  if [ "$CLEANUP_DONE" = true ]; then return; fi
  CLEANUP_DONE=true
  echo ""
  echo "===== 收到中断信号 ====="
  echo "  已成功下载: ${#SUCCESS[@]} 篇"
  if [ ${#SUCCESS[@]} -gt 0 ]; then
    echo "  成功序号: [${SUCCESS[*]}]"
  fi
  if [ ${#FAILED[@]} -gt 0 ]; then
    echo "  未成功序号: [${FAILED[*]}]"
  fi
  echo "========================="
  exit 130
}
trap cleanup SIGINT SIGTERM

echo "=============================================="
echo "  知网批量下载 v5.4"
echo "=============================================="
echo ""

# ============ 步骤1：启动 CDP Proxy ============
echo "===== 步骤1：启动 CDP Proxy ====="
pkill -f cdp-proxy.mjs 2>/dev/null
sleep 2

CHECK_RESULT=$(node "${CLAUDE_SKILL_DIR}/../web-access/scripts/check-deps.mjs" --browser edge 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "  CDP Proxy 已就绪"
elif [ $EXIT_CODE -eq 2 ]; then
  echo "  需要选择浏览器: node check-deps.mjs --browser edge"
  exit 2
else
  echo "  CDP Proxy 启动失败: $CHECK_RESULT"
  exit 1
fi
echo ""

# ============ 步骤2：列出Tab ============
echo "===== 步骤2：当前浏览器Tab ====="
curl -s http://localhost:3456/targets | python3 -c "
import sys,json
tabs=json.loads(sys.stdin.read())
for i,t in enumerate(tabs):
    print(f'  [{i}] {t[\"targetId\"][:32]}')
    print(f'      {t[\"title\"][:70]}')
    print(f'      {t[\"url\"][:100]}')
    print()
"
echo ""

# ============ 步骤3：输入 ============
echo "===== 步骤3：输入参数 ====="
read -r -p "  搜索Tab ID: " TAB_ID
read -r -p "  下载文件夹路径: " DIR
echo ""

mkdir -p "$DIR" 2>/dev/null
if [ ! -d "$DIR" ]; then
  echo "  文件夹不存在: $DIR"
  exit 1
fi

# ============ 步骤4：验证 ============
echo "===== 步骤4：验证Tab连接 ====="
TITLE=$(curl -s "$PROXY/eval?target=$TAB_ID" -d "document.title" 2>/dev/null | sed 's/^{"value"://;s/}$//')
if [ -z "$TITLE" ]; then
  echo "  无法连接 Tab $TAB_ID"
  exit 1
fi
echo "  已连接: $TITLE"

TOTAL=$(curl -s "$PROXY/eval?target=$TAB_ID" -d "document.querySelectorAll('td.name a').length" 2>/dev/null | sed 's/^{"value"://;s/}$//')
if [ "$TOTAL" = "0" ] || [ -z "$TOTAL" ]; then
  echo "  无搜索结果"
  exit 1
fi

# 打印当前页所有标题（序号+标题）
echo "  本页共: $TOTAL 篇"
echo ""
echo "===== 当前页文献列表 ====="
for ((i=0; i<TOTAL; i++)); do
  T=$(curl -s "$PROXY/eval?target=$TAB_ID" \
    -d "var a=document.querySelectorAll('td.name a')[$i]; a?a.textContent.trim().replace(/\\\\s+/g,' ').substring(0,60):''" 2>/dev/null \
    | sed 's/^{"value"://;s/}$//')
  printf "  [%02d] %s\n" "$i" "${T:0:70}"
done
echo "========================="
echo ""

# ============ 工具函数 ============

get_titles_str() {
  curl -s "$PROXY/eval?target=$TAB_ID" -d "
var a=document.querySelectorAll('td.name a');
var s='';
for(var i=0;i<a.length;i++){s+=a[i].textContent.trim().replace(/\\\\s+/g,' ')+'|||';}
s
" 2>/dev/null | sed 's/^{"value"://;s/}$//' | sed 's/^"//;s/"$//'
}

safe_name() {
  echo "$1" | sed 's/[\\/:*?"<>|]/_/g' | cut -c1-100
}

# 下载单篇：eval点标题 → 找详情tab → clickAt点PDF → 关tab
download_one() {
  local idx="$1"
  curl -s "$PROXY/eval?target=$TAB_ID" \
    -d "document.querySelectorAll('td.name a')[$idx].click()" >/dev/null 2>&1
  sleep 1.5
  local dtab
  dtab=$(curl -s "$PROXY/targets" | python3 -c "
import sys,json
for t in json.loads(sys.stdin.read()):
    if '/kcms2/article/abstract' in t.get('url',''):
        print(t['targetId']);break
" 2>/dev/null)
  [ -z "$dtab" ] && return 1
  curl -s -X POST "$PROXY/clickAt?target=$dtab" -d 'a#pdfDown' >/dev/null 2>&1
  sleep 0.3
  curl -s "$PROXY/close?target=$dtab" >/dev/null 2>&1
  return 0
}

# ============ 步骤5：全量下载 ============
echo "===== 步骤5：全量下载 ${TOTAL} 篇 ====="
echo "  (按 Ctrl+C 可随时中断并查看已下载成果)"
echo ""

for ((i=0; i<TOTAL; i++)); do
  T=$(curl -s "$PROXY/eval?target=$TAB_ID" \
    -d "var a=document.querySelectorAll('td.name a')[$i]; a?a.textContent.trim().replace(/\\\\s+/g,' ').substring(0,50):''" 2>/dev/null \
    | sed 's/^{"value"://;s/}$//')
  printf "  [%02d/%02d] %s ... " "$i" "$TOTAL" "${T:0:40}"

  if download_one "$i"; then
    echo "OK"
    SUCCESS+=($i)
  else
    echo "FAIL"
    FAILED+=($i)
  fi
done

echo ""
echo "  第一轮完成: 成功 ${#SUCCESS[@]}/${TOTAL}"

# ============ 步骤6：比对 + 补下载 ============
echo ""
echo "===== 步骤6：等待下载完成，开始比对 ====="
echo -n "  等待下载完成"
for try in $(seq 1 30); do
  ls "$DIR"/*.crdownload 2>/dev/null | head -1 | grep -q . || { echo " OK"; break; }
  echo -n "."
  sleep 2
done
echo ""

# 比对：取页面标题(前6字) + 第一作者  vs  文件夹文件名(前6字) + 作者
echo "  比对中..."
RAW=$(get_titles_str)
MISSING=$(echo "$RAW" | python3 -c "
import sys,os,re,json,subprocess
data=sys.stdin.read().strip()
titles=[t for t in data.split('|||') if t]
td=r'''$DIR'''
files=[f[:-4] for f in os.listdir(td) if f.endswith('.pdf')]
def clean(s):
    return ''.join(ch for ch in s if ch.isalnum() or ch.isspace()).strip()
# Also get authors from page
try:
    raw=subprocess.run(['curl','-s','-X','POST','http://localhost:3456/eval?target=$TAB_ID','-d',
        'JSON.stringify(Array.from(document.querySelectorAll(\"td.author\")).map(el=>el.textContent.trim()||\"\"))'],
        capture_output=True,text=True,timeout=10).stdout
    authors=json.loads(json.loads(raw)['value'])
except:
    authors=[]
missing=[]
for i,t in enumerate(titles):
    t6=clean(t)[:6]
    if not t6: continue
    a=''
    if i < len(authors):
        parts=authors[i].split(';')
        a=parts[0].strip() if parts else ''
    found=False
    for f in files:
        if a and a not in f: continue
        if clean(f)[:6]==t6:
            found=True
            break
    if not found:
        missing.append(i)
print(','.join(str(m) for m in missing) if missing else '')
" 2>/dev/null)

if [ -n "$MISSING" ]; then
  IFS=',' read -ra MISSING_ARR <<< "$MISSING"
  echo "  实际缺 ${#MISSING_ARR[@]} 篇，补下载中..."
  echo ""

  RETRY_OK=()
  RETRY_FAIL=()

  for idx in "${MISSING_ARR[@]}"; do
    T=$(curl -s "$PROXY/eval?target=$TAB_ID" \
      -d "var a=document.querySelectorAll('td.name a')[$idx]; a?a.textContent.trim().replace(/\\\\s+/g,' ').substring(0,50):''" 2>/dev/null \
      | sed 's/^{"value"://;s/}$//')
    printf "  [%02d] %s ... " "$idx" "${T:0:40}"

    if download_one "$idx"; then
      echo "OK"
      RETRY_OK+=($idx)
    else
      echo "FAIL"
      RETRY_FAIL+=($idx)
    fi
  done

  # 更新成功/失败列表
  for idx in "${RETRY_OK[@]}"; do
    SUCCESS+=($idx)
    FAILED=($(printf '%d\n' "${FAILED[@]}" | grep -v "^${idx}$" | sort -n))
  done
  for idx in "${RETRY_FAIL[@]}"; do
    FAILED+=($idx)
  done

  echo ""
  echo "  补下载完成: 成功 ${#RETRY_OK[@]}, 失败 ${#RETRY_FAIL[@]}"
else
  echo "  比对结果：已全部在文件夹中！"
fi

# ============ 步骤7：汇报 ============
echo ""
echo "=============================================="
echo "  下载汇报"
echo "=============================================="
echo "  本页总数: $TOTAL 篇"
echo "  下载成功: ${#SUCCESS[@]} 篇"
if [ ${#SUCCESS[@]} -gt 0 ]; then
  echo "  成功序号: [$(echo "${SUCCESS[@]}" | tr ' ' ',' | sed 's/,/, /g')]"
fi
echo "  下载失败: ${#FAILED[@]} 篇"
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "  失败序号: [$(echo "${FAILED[@]}" | tr ' ' ',' | sed 's/,/, /g')]"
  echo ""
  echo "  失败文献:"
  for idx in "${FAILED[@]}"; do
    T=$(curl -s "$PROXY/eval?target=$TAB_ID" \
      -d "var a=document.querySelectorAll('td.name a')[$idx]; a?a.textContent.trim().replace(/\\\\s+/g,' ').substring(0,80):''" 2>/dev/null \
      | sed 's/^{"value"://;s/}$//')
    echo "    [$idx] ${T}"
  done
fi
echo "  文件夹: ${DIR}"
echo "  文件夹现有: $(ls "$DIR"/*.pdf 2>/dev/null | wc -l) 篇"
echo ""
echo "===== 完成 ====="
echo "  翻到下一页后重新输入 /cnki"
echo "=============================================="

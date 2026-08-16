#!/bin/bash
# ============================================================
# 知网引文网络抓取 v2.0（全自动）
# ============================================================
# 输入: 论文标题（参数或交互输入）
# 输出: data/citations-{论文}.json（参考文献/引证文献/共引文献/同被引文献/二级参考文献/二级引证文献）
#
# 全自动流程:
#   ① 检查 CDP Proxy（web-access skill 基础设施）
#   ② 查找或自动创建知网搜索页 tab
#   ③ 导航搜索页 + 搜索关键词
#   ④ 轮询等待论文链接出现（最多 30 秒）
#   ⑤ JS 点击论文链接打开详情页（知网需 el.click() 触发）
#   ⑥ 等待详情页加载（10 秒）
#   ⑦ 滚动到引文区域触发懒加载
#   ⑧ 逐个点击 6 种引文 tab + 等待加载 + 提取
#   ⑨ 输出 JSON 汇总
#
# 依赖: web-access skill 的 cdp-proxy（Edge 已登录知网）
# 用法: bash cnki_citations.sh "论文标题"
# ============================================================

set -o pipefail

PROXY="http://localhost:3456"
OUTDIR="${HOME}/.claude/skills/cnki/data"
mkdir -p "$OUTDIR"

# ─── 工具函数：eval（临时文件方式，避免转义问题）───
eval_js() {
  local target="$1" expr="$2" tmpfile
  tmpfile="$(mktemp /tmp/cnki-eval-XXXXXX.js)"
  printf '%s' "$expr" > "$tmpfile"
  curl -s -m 25 -X POST "$PROXY/eval?target=$target" --data-binary @"$tmpfile" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    v = d.get('value', '')
    print(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
except Exception:
    print('')
"
  rm -f "$tmpfile"
}

# ─── 工具函数：JS 点击 ───
js_click() {
  local target="$1" selector="$2"
  eval_js "$target" "(() => { const el = document.querySelector('$selector'); if (!el) return 'nf'; el.click(); return 'ok'; })()"
}

# ─── 工具函数：真实鼠标点击 ───
real_click() {
  local target="$1" selector="$2"
  # 先标记元素再点击
  eval_js "$target" "(() => { const el = document.querySelector('$selector'); if (!el) return 'nf'; el.id = 'cnki-click-target'; return 'ok'; })()" > /dev/null
  curl -s -m 20 -X POST "$PROXY/clickAt?target=$target" -d '#cnki-click-target' 2>/dev/null | grep -q '"clicked":true'
}

# ─── 工具函数：检测知网登录状态 ───
# 返回: "logged_in" | "not_logged_in" | "needs_verify"
cnki_login_status() {
  local tab="$1"
  local body
  body=$(eval_js "$tab" 'document.body ? document.body.innerText.slice(0, 1000) : ""')
  # 已登录：右上角显示机构名「南宁师范大学 个人登录」
  if echo "$body" | grep -q "个人登录"; then
    echo "logged_in"
  elif echo "$body" | grep -qE "机构登录|登录"; then
    echo "not_logged_in"
  else
    echo "unknown"
  fi
}

# ─── 工具函数：自动 CARSI 登录（从零开始）───
# 流程: 打开 IdP → 点知网链接 → 登录表单(自动填充) → 点登录 → 信息释放同意 → 机构选择 → 进入知网
auto_cnki_login() {
  echo "  [登录] 未检测到知网登录态，自动执行 CARSI 登录…"

  # 1. 打开南宁师范大学 IdP 页
  echo "  [登录] ① 打开 IdP 登录页"
  local idp_tab
  idp_tab=$(curl -s -m 25 -X POST "$PROXY/new" --data-raw 'https://idp.nnnu.edu.cn/idp/' 2>/dev/null | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('targetId',''))")
  if [ -z "$idp_tab" ]; then
    echo "  [登录] 错误: 无法打开 IdP 页"
    return 1
  fi
  sleep 6

  # 2. 点击「知网（CNKI）」链接（真实鼠标点击）
  echo "  [登录] ② 点击知网链接"
  eval_js "$idp_tab" "(() => { const a = document.querySelector(\"a[href*='fsso.cnki.net']\"); if (!a) return 'nf'; a.id = 'cnki-link'; return 'ok'; })()" > /dev/null
  sleep 2
  curl -s -m 20 -X POST "$PROXY/clickAt?target=$idp_tab" -d '#cnki-link' > /dev/null 2>&1
  sleep 6

  # 3. 找到登录表单 tab（Web Login Service）
  echo "  [登录] ③ 填写登录表单"
  local login_tab=""
  for i in $(seq 1 5); do
    login_tab=$(curl -s -m 5 "$PROXY/targets" 2>/dev/null | python3 -c "
import sys, json
try:
    tabs = json.loads(sys.stdin.read())
    found = ''
    for t in tabs:
        if 'Web Login' in t.get('title', '') or 'idp/profile' in t.get('url', ''):
            found = t['targetId']
            break
    print(found)
except Exception:
    pass
")
    if [ -n "$login_tab" ]; then break; fi
    sleep 2
  done
  if [ -z "$login_tab" ]; then
    echo "  [登录] 错误: 未找到登录表单页"
    return 1
  fi
  sleep 3

  # 4. 检查用户名/密码是否已自动填充，未填充则提示用户
  local filled
  filled=$(eval_js "$login_tab" "(() => { const u = document.getElementById('username'); const p = document.getElementById('password'); return (u && u.value) ? 'yes' : 'no'; })()")
  if [ "$filled" != "yes" ]; then
    echo "  [登录] 账号密码未自动填充，请在 Edge 的登录页手动输入后按回车继续…"
    read -r -p "  输入完成后回车: " _
  fi

  # 5. 真实鼠标点击登录按钮
  echo "  [登录] ④ 点击登录"
  curl -s -m 20 -X POST "$PROXY/clickAt?target=$login_tab" -d 'button[type="submit"]' > /dev/null 2>&1
  sleep 6

  # 6. 信息释放页 → 点「同意」
  echo "  [登录] ⑤ 信息释放确认"
  curl -s -m 20 -X POST "$PROXY/clickAt?target=$login_tab" -d 'input[type="submit"][value="同意"]' > /dev/null 2>&1
  sleep 8

  # 7. 机构选择页 → 填入南宁师范大学 → 点击机构链接
  echo "  [登录] ⑥ 机构选择"
  local inst_tab="$login_tab"
  eval_js "$inst_tab" "(() => { const i = document.getElementById('o'); if (!i) return 'nf'; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(i, '南宁师范大学'); i.dispatchEvent(new Event('input', {bubbles: true})); return 'ok'; })()" > /dev/null
  sleep 3
  # 点击机构列表里的「南宁师范大学」链接（含完整 href）
  eval_js "$inst_tab" "(() => { const links = Array.from(document.querySelectorAll('a')); const t = links.find(a => (a.innerText || '').trim() === '南宁师范大学' && (a.href || '').includes('idp.nnnu.edu.cn')); if (!t) return 'nf'; t.id = 'inst-link'; return 'ok'; })()" > /dev/null
  sleep 2
  curl -s -m 20 -X POST "$PROXY/clickAt?target=$inst_tab" -d '#inst-link' > /dev/null 2>&1
  sleep 10

  # 8. 登录完成 → 应跳转到知网
  echo "  [登录] ⑦ 完成，进入知网"
  return 0
}

# ═══════════════════════════════════════════════
echo "=============================================="
echo "  知网引文网络抓取 v2.0（全自动）"
echo "=============================================="

# 输入论文标题
QUERY="${1:-}"
if [ -z "$QUERY" ]; then
  read -r -p "输入论文标题: " QUERY
fi
if [ -z "$QUERY" ]; then
  echo "错误: 未提供论文标题"
  exit 1
fi
echo "论文: $QUERY"
echo ""

# ─── ① 检查 CDP Proxy ───
echo "===== ① 检查 CDP Proxy ====="
CHECK=$(node "${CLAUDE_SKILL_DIR}/../web-access/scripts/check-deps.mjs" --browser edge 2>&1)
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  echo "CDP Proxy 不可用: $CHECK"
  echo "  提示: 可能需要在 Edge 中重新授权 CDP 连接"
  exit 1
fi
echo "  CDP Proxy 就绪"
echo ""

# ─── ② 查找或创建知网搜索页 tab ───
echo "===== ② 定位知网搜索页 ====="
SEARCH_TAB=""
TABS=$(curl -s -m 5 "$PROXY/targets" 2>/dev/null)
SEARCH_TAB=$(echo "$TABS" | python3 -c "
import sys, json
try:
    tabs = json.loads(sys.stdin.read())
    for t in tabs:
        if 'kns.cnki.net' in t.get('url', '') and 'defaultresult' in t.get('url', ''):
            print(t['targetId']); break
except Exception:
    pass
")
if [ -z "$SEARCH_TAB" ]; then
  echo "  未找到搜索页 tab，自动创建…"
  NEW=$(curl -s -m 25 -X POST "$PROXY/new" --data-raw 'https://kns.cnki.net/kns8s/defaultresult/index?korder=SU' 2>/dev/null)
  SEARCH_TAB=$(echo "$NEW" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('targetId',''))")
  if [ -z "$SEARCH_TAB" ]; then
    echo "错误: 无法创建知网搜索页"
    exit 1
  fi
  sleep 8
fi
echo "  搜索页 tab: ${SEARCH_TAB:0:12}…"

# ─── ②.5 检测登录状态，未登录自动 CARSI 登录（从零开始）───
echo "===== ②.5 检查知网登录状态 ====="
STATUS=$(cnki_login_status "$SEARCH_TAB")
echo "  登录状态: $STATUS"
if [ "$STATUS" = "not_logged_in" ] || [ "$STATUS" = "unknown" ]; then
  auto_cnki_login
  # 登录后搜索页可能被覆盖，重新找搜索页
  sleep 5
  SEARCH_TAB=$(curl -s -m 5 "$PROXY/targets" 2>/dev/null | python3 -c "
import sys, json
try:
    tabs = json.loads(sys.stdin.read())
    found = ''
    for t in tabs:
        if 'kns.cnki.net' in t.get('url', '') and 'defaultresult' in t.get('url', ''):
            found = t['targetId']
            break
    print(found)
except Exception:
    pass
")
fi
echo ""
echo ""

# ─── ③ 导航搜索页 + 搜索关键词 ───
echo "===== ③ 搜索: $QUERY ====="
SEARCH_URL="https://kns.cnki.net/kns8s/defaultresult/index?korder=SU&kw=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$QUERY")"
curl -s -m 20 -X POST "$PROXY/navigate?target=$SEARCH_TAB" --data-binary "$SEARCH_URL" > /dev/null 2>&1
echo "  已导航到搜索页，等待结果…"
echo ""

# ─── ④ 轮询等待论文链接 ───
echo "===== ④ 等待论文链接 ====="
PAPER_URL=""
for i in $(seq 1 10); do
  sleep 3
  PAPER_URL=$(eval_js "$SEARCH_TAB" "(() => { const links = Array.from(document.querySelectorAll(\"a[href*='kcms2/article/abstract']\")); const t = links.find(a => (a.innerText || '').trim().length > 8 && (a.innerText || '').trim().length < 60); return t ? t.href : ''; })()")
  if [ -n "$PAPER_URL" ]; then
    echo "  找到论文链接（第 ${i} 次轮询）"
    break
  fi
done
if [ -z "$PAPER_URL" ]; then
  echo "错误: 搜索结果中未找到论文（可能被安全验证拦截，请手动在 Edge 完成滑块验证后重试）"
  exit 1
fi
echo ""

# ─── ⑤ JS 点击打开详情页 ───
echo "===== ⑤ 打开论文详情页 ====="
# 先关闭所有旧详情页 tab（避免干扰选择）
OLD_DETAILS=$(curl -s -m 5 "$PROXY/targets" 2>/dev/null | python3 -c "
import sys, json
try:
    tabs = json.loads(sys.stdin.read())
    for t in tabs:
        if 'kcms2' in t.get('url', ''):
            print(t['targetId'])
except Exception:
    pass
")
for old in $OLD_DETAILS; do
  curl -s -m 5 "$PROXY/close?target=$old" > /dev/null 2>&1
done
sleep 2
# 标记论文链接
eval_js "$SEARCH_TAB" "(() => { const links = Array.from(document.querySelectorAll(\"a[href*='kcms2/article/abstract']\")); const t = links.find(a => (a.innerText || '').trim().length > 8 && (a.innerText || '').trim().length < 60); if (!t) return 'nf'; t.id = 'cnki-paper-link'; return 'ok'; })()" > /dev/null
# JS 点击（知网需 el.click() 触发新 tab）
eval_js "$SEARCH_TAB" "(() => { const el = document.getElementById('cnki-paper-link'); if (!el) return 'nf'; el.click(); return 'ok'; })()" > /dev/null
echo "  已点击论文链接，等待详情页…"
sleep 10

# 找到详情页 tab（按标题匹配搜索关键词，避免选中旧论文）
DETAIL_TAB=""
KEYWORD_HINT=$(echo "$QUERY" | cut -c1-8)
for i in $(seq 1 5); do
  DETAIL_TAB=$(curl -s -m 5 "$PROXY/targets" 2>/dev/null | python3 -c "
import sys, json
try:
    tabs = json.loads(sys.stdin.read())
    found = ''
    for t in tabs:
        url = t.get('url', '')
        title = t.get('title', '')
        if 'kcms2' in url and '$KEYWORD_HINT' in title:
            found = t['targetId']
            break
    print(found)
except Exception:
    pass
")
  if [ -n "$DETAIL_TAB" ]; then
    break
  fi
  sleep 2
done
if [ -z "$DETAIL_TAB" ]; then
  # 兜底：任意 kcms2 详情页
  DETAIL_TAB=$(curl -s -m 5 "$PROXY/targets" 2>/dev/null | python3 -c "
import sys, json
try:
    tabs = json.loads(sys.stdin.read())
    found = ''
    for t in tabs:
        if 'kcms2' in t.get('url', ''):
            found = t['targetId']
            break
    print(found)
except Exception:
    pass
")
fi
if [ -z "$DETAIL_TAB" ]; then
  echo "错误: 未找到详情页 tab"
  exit 1
fi
echo "  详情页 tab: ${DETAIL_TAB:0:12}…"
PAPER_TITLE=$(eval_js "$DETAIL_TAB" 'document.title.replace(/ - 中国知网$/, "")')
echo "  论文: $PAPER_TITLE"
echo ""

# ─── ⑥ 滚动到引文区域触发懒加载 ───
echo "===== ⑥ 触发引文区域加载 ====="
eval_js "$DETAIL_TAB" "(() => { const el = document.querySelector('#refpartdiv'); if (el) { el.scrollIntoView({block: 'center'}); return 'ok'; } return 'no el'; })()" > /dev/null
sleep 3
echo "  已滚动到引文区域"
echo ""

# ─── ⑦ 逐个提取 6 种引文 ───
echo "===== ⑦ 提取引文数据 ====="
declare -A TABS=(
  [references]="参考文献"
  [citations]="引证文献"
  [coreferences]="共引文献"
  [cocitations]="同被引文献"
  [secondreferences]="二级参考文献"
  [secondcitations]="二级引证文献"
)

TMPDIR_FOR_JSON="$(mktemp -d /tmp/cnki-json-XXXXXX)"

for type in references citations coreferences cocitations secondreferences secondcitations; do
  LABEL="${TABS[$type]}"
  echo "  ─ $LABEL …"

  # 点击对应 tab（先滚动到引文区域触发懒加载）
  eval_js "$DETAIL_TAB" "(() => { const el = document.querySelector('#refpartdiv'); if (el) el.scrollIntoView({block: 'center'}); return 'ok'; })()" > /dev/null
  sleep 2
  eval_js "$DETAIL_TAB" "(() => { const tabs = Array.from(document.querySelectorAll('#refpartdiv li')); const t = tabs.find(x => (x.className || '').includes('$type')); if (!t) return 'nf'; t.click(); return 'ok'; })()" > /dev/null

  # 等待加载（重试 5 次 × 4 秒）
  ITEMS_JSON="[]"
  for attempt in $(seq 1 5); do
    sleep 4
    RAW=$(eval_js "$DETAIL_TAB" "(() => {
      const el = document.querySelector('#refpartdiv');
      if (!el) return JSON.stringify({items: [], counts: []});
      const NL = String.fromCharCode(10);
      const lines = el.innerText.split(NL).map(s => s.trim()).filter(Boolean);
      const TAB_NAMES = ['引文网络', '参考文献', '引证文献', '共引文献', '同被引文献', '二级参考文献', '二级引证文献', '节点文献'];
      const items = lines.filter(l => !TAB_NAMES.includes(l)).filter(l => /^[\[［][0-9]+[\]］]/.test(l)).map(l => { const m = l.match(/[0-9]+/); return {raw: l, seq: m ? parseInt(m[0], 10) : 9999}; });
      items.sort((a, b) => a.seq - b.seq);
      return JSON.stringify({items: items.slice(0, 200), counts: lines.filter(l => /共[\\s]*[0-9]+[\\s]*条/.test(l)).slice(0, 2)});
    })()")

    ITEMS_JSON=$(echo "$RAW" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    items = d.get('items', [])
    print(json.dumps(items, ensure_ascii=False))
except Exception:
    print('[]')
")
    COUNT=$(echo "$ITEMS_JSON" | python3 -c "import sys,json; print(len(json.loads(sys.stdin.read())))")
    if [ "$COUNT" -gt 0 ]; then
      echo "    ✓ $COUNT 条"
      break
    fi
  done

  # 保存该类型的 JSON 到临时文件（供最后组装）
  echo "$ITEMS_JSON" > "$TMPDIR_FOR_JSON/$type.json"
done

# ─── ⑧ 保存输出（用 python 组装 JSON，避免转义问题）───
SAFE_NAME=$(echo "$QUERY" | md5sum | cut -c1-12)
OUTFILE="$OUTDIR/citations-${SAFE_NAME}.json"

python3 - "$OUTFILE" "$PAPER_TITLE" "$TMPDIR_FOR_JSON" << 'PYEOF'
import json, sys, os
outfile, title, tmpdir = sys.argv[1], sys.argv[2], sys.argv[3]
tabs = {}
for t in ["references", "citations", "coreferences", "cocitations", "secondreferences", "secondcitations"]:
    f = os.path.join(tmpdir, f"{t}.json")
    try:
        with open(f, encoding="utf-8") as fh:
            tabs[t] = json.load(fh)
    except Exception:
        tabs[t] = []
result = {"paperTitle": title.strip(), "tabs": tabs}
with open(outfile, "w", encoding="utf-8") as fh:
    json.dump(result, fh, ensure_ascii=False, indent=1)
print(f"论文: {title[:40]}")
for k, v in tabs.items():
    print(f"  {k}: {len(v)} 条")
PYEOF
rm -rf "$TMPDIR_FOR_JSON"
echo ""
echo "=============================================="
echo "  完成！结果已保存: $OUTFILE"
echo "=============================================="

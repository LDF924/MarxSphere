# 知网文献批量下载 — 完整自动化操作说明 v4.0

> 基于 6 轮实战总结（三农 1189 篇 + 乡村振兴 1065 篇 + 田野调查 401 篇），最终稳定版本。

---

## 一、整体架构

```
用户(Edge浏览器) ←→ CDP Proxy (localhost:3456) ←→ Bash脚本(curl调用)
                                      ↑
                           知网网站 (kns.cnki.net)
                                      ↓
                           Edge下载Hub → E:\ → 目标文件夹
```

---

## 二、前置准备

### 步骤1：启动 CDP Proxy

```bash
node "%USERPROFILE%/.claude/skills/web-access/scripts/check-deps.mjs" --browser edge
```

**预期输出：**
```
node: ok (v24.16.0)
browser: ok (Microsoft Edge, port 9222) [--browser 指定]
proxy: ready (Microsoft Edge)
```

**故障排查：**
```bash
# 如果连接失败，杀死旧进程后重试
pkill -f cdp-proxy.mjs
sleep 2
node "%USERPROFILE%/.claude/skills/web-access/scripts/check-deps.mjs" --browser edge
```

### 步骤2：登录知网

在 Edge 中手动操作：
1. 打开 `https://idp.nnnu.edu.cn/idp/`
2. 点击「知网（CNKI）」链接 → CARSI 统一认证 → 进入知网
3. 确认知网首页右上角显示「南宁师范大学 个人登录」

**验证登录状态：**
```bash
# 检查IDP页面
curl -s "http://localhost:3456/eval?target=<IDP_TAB_ID>" -d "document.body.innerText.substring(0,300)"
# 应包含: 欢迎来自南宁师范大学的您
```

### 步骤3：搜索并筛选

1. 在知网搜索框输入关键词（如「三农」「乡村振兴」「田野调查」）
2. 在左侧边栏勾选筛选条件：
   - **年度**: 根据需要勾选
   - **来源类别**: 北大核心 / CSSCI / CSCD
   - **研究层次**: 应用研究类 + 开发研究类
   - **主题/学科**: 根据需要勾选
3. 设置每页显示 **50条**

---

## 三、获取搜索Tab ID

```bash
# 列出所有tab
curl -s http://localhost:3456/targets | python3 -c "
import sys,json
for t in json.loads(sys.stdin.read()):
    print(f'{t[\"targetId\"]} {t[\"title\"][:80]}')
"
```

找到标题为「高级检索-中国知网」或「检索-中国知网」的 tab ID。

---

## 四、一键下载

```bash
bash "%USERPROFILE%/.claude/skills/web-access/scripts/cnki_batch_download.sh" \
  <SEARCH_TAB_ID> \
  "C:/课题文献库/目标文件夹"
```

**示例：**
```bash
bash "%USERPROFILE%/.claude/skills/web-access/scripts/cnki_batch_download.sh" \
  1DC42212D9ABA84AEBE2D8995CAA7FA7 \
  "C:/课题文献库/三农（2012—2026年6月）"
```

---

## 五、逐页操作循环

每下载完一页，脚本会提示「请翻到第X页」。用户在 Edge 中手动翻页后，再次运行同一个命令即可。

```
第1页: 运行脚本 → 下载完成
  ↓ 用户在Edge翻页
第2页: 运行脚本 → 下载完成
  ↓ 用户在Edge翻页
第3页: 运行脚本 → 下载完成
  ...
```

---

## 六、脚本内部流程详解

### 第1步：对比

```bash
# 获取当前页第idx篇文章的标题
curl -s "$PROXY/eval?target=$SEARCH_TAB" -d \
  "var a=document.querySelectorAll('td.name a')[$idx]; a?a.textContent.trim().replace(/\\s+/g,' '):''"

# 检查本地是否已有该文件（>50KB视为有效）
if [ -f "$DIR/$SAFE.pdf" ] && [ "$(stat -c%s "$DIR/$SAFE.pdf")" -gt 50000 ]; then
  continue  # 跳过
fi
```

### 第2步：真实鼠标点击文章标题

```bash
# clickAt = CDP Input.dispatchMouseEvent（真实用户手势）
curl -s -X POST "$PROXY/clickAt?target=$SEARCH_TAB" -d 'td.name a' >/dev/null 2>&1
sleep 4  # 等待新tab加载
```

### 第3步：找到新打开的详情tab

```bash
DTAB=$(curl -s "$PROXY/targets" \
  | python3 -c "import sys,json;[print(t['targetId']) for t in json.loads(sys.stdin.read()) if '/kcms2/article/abstract' in t.get('url','')]" \
  | head -1)
```

### 第4步：真实鼠标点击PDF下载

```bash
# 多次点击确保触发
for c in 1 2 3; do
  curl -s -X POST "$PROXY/clickAt?target=$DTAB" -d 'a#pdfDown' >/dev/null 2>&1
  sleep 1.5
done
```

### 第5步：Edge下载Hub保存（穿透Shadow DOM）

```bash
# 先找到downloads-hub tab
HTAB=$(curl -s "$PROXY/targets" \
  | python3 -c "import sys,json;[print(t['targetId']) for t in json.loads(sys.stdin.read()) if 'downloads-hub' in t.get('url','')]" \
  | head -1)

# 穿透三层Shadow DOM点击.save按钮
curl -s -X POST "$PROXY/eval?target=$HTAB" -d '
var hub = document.querySelector("downloads-hub-app");
if (hub) {
  var lst = hub.shadowRoot.querySelector("downloads-list");
  var it = lst.shadowRoot.querySelectorAll("download-item");
  if (it.length) {
    var f = it[0];
    if (f.getAttribute("state") === "pending_open_save_as") {
      var b = f.shadowRoot.querySelector(".save");
      if (b) b.click();
    }
  }
}
' >/dev/null
```

### 第6步：等待下载完成

```bash
# Edge下载PDF时先产生 .crdownload 临时文件
# 必须等它消失（变为 .pdf）才能复制
for try in $(seq 1 12); do
  [ -z "$(ls /e/*.crdownload 2>/dev/null)" ] && break
  sleep 2
done
sleep 2  # 额外安全等待
```

### 第7步：复制到目标文件夹

```bash
LATEST=$(ls -t /e/*.pdf /e/*.crdownload 2>/dev/null | head -1)
if [ -n "$LATEST" ]; then
  cp "$LATEST" "$DIR/$SAFE.pdf" 2>/dev/null
  rm -f /e/*.crdownload /e/*.pdf 2>/dev/null  # 清理E盘
fi
```

### 第8步：关闭详情tab

```bash
curl -s "$PROXY/close?target=$DTAB" >/dev/null 2>&1
sleep 1
```

---

## 七、关键API速查

| 操作 | API |
|------|-----|
| 列出所有tab | `curl -s http://localhost:3456/targets` |
| 新建tab | `curl -s -X POST --data-raw 'URL' http://localhost:3456/new` |
| 执行JS | `curl -s -X POST "http://localhost:3456/eval?target=ID" -d 'code'` |
| JS点击 | `curl -s -X POST "http://localhost:3456/click?target=ID" -d 'selector'` |
| 真实鼠标点击 | `curl -s -X POST "http://localhost:3456/clickAt?target=ID" -d 'selector'` |
| 页面导航 | `curl -s -X POST --data-raw 'URL' "http://localhost:3456/navigate?target=ID"` |
| 后退 | `curl -s "http://localhost:3456/back?target=ID"` |
| 关闭tab | `curl -s "http://localhost:3456/close?target=ID"` |
| 页面信息 | `curl -s "http://localhost:3456/info?target=ID"` |

---

## 八、避坑清单

| 问题 | 原因 | 解决 |
|------|------|------|
| 文件打不开(缺EOF) | `.crdownload` 未完成就复制 | 循环等待最多24秒 |
| 点击无效 | 知网需要真实鼠标事件 | 用 `clickAt` 不用 `click` |
| 下载保存失败 | Edge Shadow DOM不可见 | 检查 downloads-hub tab |
| 页面空白 | CDP连接导致渲染异常 | `pkill -f cdp-proxy.mjs` 后重连 |
| 搜索结果丢失 | 点击标题后tab被替换 | 检查是否有新tab，或使用 `back` |
| 验证码触发 | 高频访问 | 间隔3-5秒，失败后逐篇重试 |
| 筛选条件丢失 | 页面被刷新 | **绝对不要刷新页面** |
| getAttribute报错 | 结果超过50条(.name element) | 用 `td.name a` 精确选择 |

---

## 九、Edge下载Hub DOM结构

```
<downloads-hub-app>                          ← Shadow DOM #1
  └── <downloads-list>                       ← Shadow DOM #2
        └── <download-item state="pending_open_save_as">  ← Shadow DOM #3
              ├── <mai-button class="save">保存</mai-button>
              └── <mai-button class="saveAs">另存为</mai-button>
```

穿透方式：
```javascript
document.querySelector('downloads-hub-app')
  .shadowRoot.querySelector('downloads-list')
  .shadowRoot.querySelectorAll('download-item')[0]
  .shadowRoot.querySelector('.save')
  .click();
```

---

## 十、完整工作流脚本

将以下代码保存为 `cnki_workflow.sh` 并执行：

```bash
#!/bin/bash
# 知网批量下载完整工作流

echo "===== 步骤1：启动CDP Proxy ====="
pkill -f cdp-proxy.mjs 2>/dev/null
sleep 2
node "%USERPROFILE%/.claude/skills/web-access/scripts/check-deps.mjs" --browser edge
echo ""

echo "===== 步骤2：列出当前tab ====="
curl -s http://localhost:3456/targets | python3 -c "
import sys,json
for t in json.loads(sys.stdin.read()):
    print(f'{t[\"targetId\"]} {t[\"title\"][:80]}')
"
echo ""

echo "===== 步骤3：输入搜索Tab ID和文件夹路径 ====="
read -p "搜索Tab ID: " TAB_ID
read -p "目标文件夹: " TARGET_DIR

echo ""
echo "===== 步骤4：开始批量下载 ====="
bash "%USERPROFILE%/.claude/skills/web-access/scripts/cnki_batch_download.sh" "$TAB_ID" "$TARGET_DIR"

echo ""
echo "===== 完成！请翻到下一页后重新运行本脚本 ====="
```

---

## 十一、文件命名规则

文章标题 → 安全文件名：
- 非法字符 `\ / : * ? " < > |` → `_`
- 截取前100字符
- 扩展名 `.pdf`

示例：
```
习近平《论"三农"工作》 免费
→ 习近平_论三农工作_ 免费.pdf
```

# Computer Use（桌面控制）

MarxSphere Computer Use（2026-08-27，ScienceX 对照）：Agent 控制桌面——截屏、鼠标、键盘、窗口列表。

## 能力

| 能力 | 说明 | 实现 |
|---|---|---|
| **截屏** | 主屏全屏 PNG（base64 返回，Agent 可"看"屏幕） | PowerShell System.Drawing |
| **鼠标** | move / click / dblclick（坐标） | user32.dll |
| **键盘** | 文本输入（SendKeys，特殊字符转义） | System.Windows.Forms |
| **窗口列表** | 有标题的窗口（标题+PID） | Get-Process |

## 启用

```bash
# .env
COMPUTER_USE_ENABLED=true
```

**默认关闭**（安全）：未启用时 API 返回 403。

## API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/computer-use/status` | GET | 启用状态 + 平台 |
| `/api/computer-use/screenshot` | POST | 截屏 → `{ok, image(base64 PNG)}` |
| `/api/computer-use/mouse` | POST | `{action: move\|click\|dblclick, x, y}` |
| `/api/computer-use/type` | POST | `{text}`（SendKeys） |
| `/api/computer-use/windows` | GET | 窗口列表 |

## Agent 工具接入

```bash
# 工具: computer_use（agent-tool-router 注册）
# 参数: action(screenshot/mouse/type/windows) + x/y/text
# Agent 流程: 截屏看屏幕 → 判断 → 鼠标点击 → 键盘输入 → 再截屏验证
```

## 平台

- **Windows**：完整支持（PowerShell 无依赖）
- **macOS/Linux**：当前返回"仅支持 Windows"（后续可加 osascript/xdotool）

## 安全

- `COMPUTER_USE_ENABLED=true` 才启用（默认关）
- 截屏/窗口列表为只读操作；鼠标/键盘为控制操作（同开关控制）
- 权限分级：analyst 可用只读（screenshot/windows），控制操作需 manager

## 实现

- `src/services/computer-use-service.ts` — PowerShell 免依赖实现
- 参考：email-service 的降级风格（不可用 → 明确错误，不静默）

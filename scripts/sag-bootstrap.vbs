' sag-bootstrap.vbs — 开机自启（启动文件夹方案，无需管理员权限）
' 放入 Shell:startup（%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup）
' 登录时静默执行 sag-bootstrap.sh（隐藏窗口）
Set ws = CreateObject("Wscript.Shell")
' 延迟 30 秒（等 Docker/网络就绪）
WScript.Sleep 30000
ws.Run "bash SAG_ROOT/scripts\sag-bootstrap.sh", 0, False

' ov-start.vbs — OpenViking 静默启动（无窗口）
' 用法: cscript //nologo ov-start.vbs <SAG_ROOT> <OPENVIKING_DIR>
' 示例: cscript //nologo ov-start.vbs C:\MarxSphere C:\Users\me\openviking
' 路径由 sag-bootstrap.sh 传入, 避免硬编码个人目录
Set ws = CreateObject("Wscript.Shell")
root = WScript.Arguments(0)
ovDir = WScript.Arguments(1)
ws.CurrentDirectory = ovDir
ws.Run "cognee\.venv312\Scripts\openviking-server.exe --config " & ovDir & "\.openviking\ov.conf", 0, False

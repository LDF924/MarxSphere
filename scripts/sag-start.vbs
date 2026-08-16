' sag-start.vbs — SAG 静默启动（无窗口）— V348: 尊重 mode.json, 不硬编码 preview
' 之前: set MARXSPHERE_PREVIEW=1 硬编码 → 即使 mode.json=full 也强制预览(推理/检索不可用)
' 现在: 读 mode.json 的 mode 字段, preview → 设 MARXSPHERE_PREVIEW=1, full/其他 → 不设(完整模式)
' ws.Run 的第二个参数 0 = 隐藏窗口
Set ws = CreateObject("Wscript.Shell")
ws.CurrentDirectory = "SAG_ROOT"

' 读 mode.json 决定启动模式
Set fso = CreateObject("Scripting.FileSystemObject")
modeFile = "SAG_ROOT\mode.json"
mode = "full"  ' 默认 full（完整推理/检索）
If fso.FileExists(modeFile) Then
  Set f = fso.OpenTextFile(modeFile, 1)
  content = f.ReadAll
  f.Close
  If InStr(content, """mode"": ""preview""") > 0 Then
    mode = "preview"
  End If
End If

If mode = "preview" Then
  ws.Run "cmd /c set MARXSPHERE_PREVIEW=1&& npx tsx src\index.ts", 0, False
Else
  ws.Run "cmd /c npx tsx src\index.ts", 0, False
End If

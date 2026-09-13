' sag-start.vbs — SAG 静默启动（无窗口）— V348: 尊重 mode.json, 不硬编码 preview
' 之前: set MARXSPHERE_PREVIEW=1 硬编码 → 即使 mode.json=full 也强制预览(推理/检索不可用)
' 现在: 读 mode.json 的 mode 字段, preview → 设 MARXSPHERE_PREVIEW=1, full/其他 → 不设(完整模式)
' ws.Run 的第二个参数 0 = 隐藏窗口
'
' V415(2026-09-13): 原来写死 C:\Users\HUAWEI\SAG-main —— 改为从本脚本位置回推仓库根,
'   并显式传 --env-file。否则换机器/从别处唤起时读不到 .env(JWT_SECRET 随机 → 全站 401)。
Set ws = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)

' 本脚本所在目录的上级 = 仓库根
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(scriptDir)
ws.CurrentDirectory = root

' 读 mode.json 决定启动模式
modeFile = root & "\mode.json"
mode = "full"  ' 默认 full（完整推理/检索）
If fso.FileExists(modeFile) Then
  Set f = fso.OpenTextFile(modeFile, 1)
  content = f.ReadAll
  f.Close
  If InStr(content, """mode"": ""preview""") > 0 Then
    mode = "preview"
  End If
End If

tsx = root & "\node_modules\tsx\dist\cli.mjs"
envFile = root & "\.env"
entry = root & "\src\index.ts"
If fso.FileExists(tsx) Then
  cmd = "cmd /c " & IIf(mode = "preview", "set MARXSPHERE_PREVIEW=1&& ", "") & "node " & q & tsx & q & " --env-file=" & q & envFile & q & " " & q & entry & q
Else
  ' 未装依赖 → 回退 npx(cwd 已设为仓库根, 相对路径可用)
  cmd = "cmd /c " & IIf(mode = "preview", "set MARXSPHERE_PREVIEW=1&& ", "") & "npx tsx --env-file=./.env src\index.ts"
End If
ws.Run cmd, 0, False

' VBScript 无三元运算符 → 小工具函数
Function IIf(cond, a, b)
  If cond Then IIf = a Else IIf = b
End Function

' run-ps-hidden.vbs — 通用静默执行 PowerShell 脚本（无窗口）
' 用法: wscript.exe run-ps-hidden.vbs "C:\path\script.ps1" [arg1] [arg2] ...
' - 与 run-script-hidden.vbs 对称：那个跑 bash，这个跑 PowerShell
' - ws.Run 参数 0 = 隐藏窗口，False = 不等待
' - -ExecutionPolicy Bypass 保证在受限策略下也能跑
Set ws = CreateObject("Wscript.Shell")
q = Chr(34)
script = WScript.Arguments(0)
args = ""
For i = 1 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next
cmd = q & "powershell.exe" & q & " -NoProfile -ExecutionPolicy Bypass -File " & q & script & q & args
ws.Run cmd, 0, False

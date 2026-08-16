' run-script-hidden.vbs — 通用静默执行 bash 脚本（无窗口）
' 用法: wscript.exe run-script-hidden.vbs "C:\path\script.sh" [arg1] [arg2] ...
' - bash 用 -lc (login shell) 加载完整 PATH（计划任务环境 PATH 不完整）
' - ws.Run 参数 0 = 隐藏窗口
Set ws = CreateObject("Wscript.Shell")
q = Chr(34)
' 把 Windows 反斜杠路径转成 bash 正斜杠
script = Replace(WScript.Arguments(0), "\", "/")
args = ""
For i = 1 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next
cmd = q & "D:\Git\bin\bash.exe" & q & " -lc " & q & script & args & q
ws.Run cmd, 0, False

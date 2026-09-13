' run-script-hidden.vbs — 通用静默执行 bash 脚本（无窗口）
' 用法: wscript.exe run-script-hidden.vbs "C:\path\script.sh" [arg1] [arg2] ...
' - bash 用 -lc (login shell) 加载完整 PATH（计划任务环境 PATH 不完整）
' - ws.Run 参数 0 = 隐藏窗口
'
' V415(2026-09-13): bash 原来写死 D:\Git\bin\bash.exe —— 换机器必挂。
'   改为依次探测: SAG_BASH 环境变量 → PATH 上的 bash → 常见 Git for Windows 安装位置。
'   都找不到时弹一个可见的错误框(静默脚本最怕的就是"什么都没发生")。
Set ws = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)
' 把 Windows 反斜杠路径转成 bash 正斜杠
script = Replace(WScript.Arguments(0), "\", "/")
args = ""
For i = 1 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next

' ── 找 bash ──
bash = ""
If Len(ws.ExpandEnvironmentStrings("%SAG_BASH%")) > 0 And ws.ExpandEnvironmentStrings("%SAG_BASH%") <> "%SAG_BASH%" Then
  If fso.FileExists(ws.ExpandEnvironmentStrings("%SAG_BASH%")) Then bash = ws.ExpandEnvironmentStrings("%SAG_BASH%")
End If
If bash = "" Then
  ' PATH 上的 bash: `where` 会返回**多行**(本机实测 3 条), 必须只取第一条 ——
  ' 早先把 \r\n 全删掉拼成了一条路径, FileExists 恒为 False, 于是总走"找不到 bash"分支。
  On Error Resume Next
  p = ws.Exec("cmd /c where bash 2>nul").StdOut.ReadAll
  On Error GoTo 0
  lines = Split(Replace(p, vbCrLf, vbLf), vbLf)
  For Each ln In lines
    ln = Trim(ln)
    If Len(ln) > 0 And fso.FileExists(ln) Then
      bash = ln
      Exit For
    End If
  Next
End If
If bash = "" Then
  ' 常见 Git for Windows 安装位置(含 PATH 里只有 git 没有 bash 的情况;
  ' 本机实测 bash 在 D:\Git\usr\bin, 而 D:\Git\bin\bash.exe 并不存在)
  For Each c In Array( _
      ws.ExpandEnvironmentStrings("%ProgramFiles%\Git\bin\bash.exe"), _
      ws.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Git\bin\bash.exe"), _
      ws.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\Git\bin\bash.exe"), _
      "C:\Program Files\Git\usr\bin\bash.exe", _
      "C:\Program Files (x86)\Git\usr\bin\bash.exe", _
      "D:\Git\usr\bin\bash.exe", "D:\Git\bin\bash.exe")
    If fso.FileExists(c) Then
      bash = c
      Exit For
    End If
  Next
End If

If bash = "" Then
  MsgBox "找不到 bash.exe，无法执行 " & script & vbCrLf & vbCrLf & _
         "请设置环境变量 SAG_BASH 指向 bash.exe（Git for Windows 通常在 C:\Program Files\Git\bin\bash.exe）。", 16, "SAG 启动失败"
  WScript.Quit 1
End If

cmd = q & Replace(bash, "\", "/") & q & " -lc " & q & script & args & q
ws.Run cmd, 0, False

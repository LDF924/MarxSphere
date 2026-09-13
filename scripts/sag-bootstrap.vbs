' sag-bootstrap.vbs — 开机自启（启动文件夹方案，无需管理员权限）
' 放入 Shell:startup（%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup）
' 登录时静默执行 sag-bootstrap.sh（隐藏窗口）
'
' V415(2026-09-13): bash 与脚本路径原来都写死 D:\Git\bin\bash.exe / C:/Users/HUAWEI/...
'   改为: bash 走 SAG_BASH → PATH → 常见 Git 安装位置; 脚本路径可用 SAG_ROOT 覆盖,
'   否则用本脚本同级目录下的 sag-bootstrap.sh(sag-bootstrap.vbs 与 .sh 同在 scripts/)。
Set ws = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)

' 延迟 30 秒（等 Docker/网络就绪）
WScript.Sleep 30000

' ── 目标脚本 ──
root = ws.ExpandEnvironmentStrings("%SAG_ROOT%")
If root = "%SAG_ROOT%" Then root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
target = root & "\scripts\sag-bootstrap.sh"
If Not fso.FileExists(target) Then
  MsgBox "找不到 " & target & vbCrLf & "请设置 SAG_ROOT 指向仓库根。", 16, "SAG 引导失败"
  WScript.Quit 1
End If
target = Replace(target, "\", "/")

' ── 找 bash(与 run-script-hidden.vbs 同一套探测) ──
bash = ""
If Len(ws.ExpandEnvironmentStrings("%SAG_BASH%")) > 0 And ws.ExpandEnvironmentStrings("%SAG_BASH%") <> "%SAG_BASH%" Then
  If fso.FileExists(ws.ExpandEnvironmentStrings("%SAG_BASH%")) Then bash = ws.ExpandEnvironmentStrings("%SAG_BASH%")
End If
If bash = "" Then
  ' PATH 上的 bash: `where` 会返回多行, 只取第一条(拼在一起会变成无效路径 —— 见 run-script-hidden.vbs 同处注释)
  On Error Resume Next
  p = ws.Exec("cmd /c where bash 2>nul").StdOut.ReadAll
  On Error GoTo 0
  For Each ln In Split(Replace(p, vbCrLf, vbLf), vbLf)
    ln = Trim(ln)
    If Len(ln) > 0 And fso.FileExists(ln) Then
      bash = ln
      Exit For
    End If
  Next
End If
If bash = "" Then
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
  MsgBox "找不到 bash.exe，无法执行 sag-bootstrap.sh。" & vbCrLf & vbCrLf & _
         "请设置环境变量 SAG_BASH 指向 bash.exe。", 16, "SAG 引导失败"
  WScript.Quit 1
End If

ws.Run q & Replace(bash, "\", "/") & q & " -lc " & q & target & q, 0, False

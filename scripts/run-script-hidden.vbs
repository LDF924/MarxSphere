' run-script-hidden.vbs -- run a bash script silently (no window).
' Usage: wscript.exe run-script-hidden.vbs "C:\path\script.sh" [arg1] [arg2] ...
' - bash is invoked with -lc (login shell) so the full PATH is loaded
'   (the PATH in a scheduled-task environment is incomplete).
' - ws.Run arg 0 = hidden window.
'
' V415(2026-09-13): bash used to be hardcoded to D:\Git\bin\bash.exe -- that
'   breaks on any other machine. Now it probes, in order: the SAG_BASH env var,
'   bash on PATH, then the usual Git for Windows install locations.
'   If none is found it shows a VISIBLE error box (the worst failure mode for a
'   silent script is "nothing happened and nothing said why").
'
' NOTE: keep this file ASCII-only. VBScript reads the file in the ANSI codepage,
'   so UTF-8 Chinese here decodes to mojibake -- the MsgBox text below used to be
'   Chinese and popped up garbled.
Set ws = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)
' Convert a Windows backslash path to bash forward slashes
script = Replace(WScript.Arguments(0), "\", "/")
args = ""
For i = 1 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next

' --- locate bash ---
bash = ""
If Len(ws.ExpandEnvironmentStrings("%SAG_BASH%")) > 0 And ws.ExpandEnvironmentStrings("%SAG_BASH%") <> "%SAG_BASH%" Then
  If fso.FileExists(ws.ExpandEnvironmentStrings("%SAG_BASH%")) Then bash = ws.ExpandEnvironmentStrings("%SAG_BASH%")
End If
If bash = "" Then
  ' bash on PATH: do NOT use ws.Exec("cmd /c where bash") -- WshShell.Exec pops a
  ' console window. This script is launched by a scheduled task every 5-30 min
  ' (process watchdog / ingest watchdog / WAL sync), so it would flash a console
  ' every cycle and the user would just see "why do command windows keep flashing".
  ' Walking the PATH dirs with FileExists starts no process at all, so no window.
  ' (2026-09-13: that flashing was introduced by me when I added this probe --
  '  before it, the script only ever used the hidden ws.Run.)
  For Each d In Split(ws.ExpandEnvironmentStrings("%PATH%"), ";")
    d = Trim(d)
    If Len(d) > 0 Then
      For Each exe In Array("bash.exe", "bash")
        If fso.FileExists(d & "\" & exe) Then
          bash = d & "\" & exe
          Exit For
        End If
      Next
      If bash <> "" Then Exit For
    End If
  Next
End If
If bash = "" Then
  ' Usual Git for Windows install locations (covers the case where PATH has git
  ' but not bash; measured on this machine, bash lives in D:\Git\usr\bin while
  ' D:\Git\bin\bash.exe does not exist).
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
  MsgBox "bash.exe not found, cannot run " & script & vbCrLf & vbCrLf & _
         "Set the SAG_BASH environment variable to point at bash.exe " & _
         "(Git for Windows usually installs it at C:\Program Files\Git\bin\bash.exe).", 16, "SAG failed to start"
  WScript.Quit 1
End If

cmd = q & Replace(bash, "\", "/") & q & " -lc " & q & script & args & q
ws.Run cmd, 0, False

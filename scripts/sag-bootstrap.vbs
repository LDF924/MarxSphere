' sag-bootstrap.vbs -- run at logon (Startup-folder approach; no admin needed).
' Put it in Shell:startup
'   (%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup).
' At logon it runs scripts/sag-bootstrap.sh silently (hidden window).
'
' V415(2026-09-13): bash and the script path used to be hardcoded to
'   D:\Git\bin\bash.exe / C:/Users/HUAWEI/... Now: bash is probed via
'   SAG_BASH -> PATH -> common Git install locations; the script path can be
'   overridden with SAG_ROOT, otherwise it is sag-bootstrap.sh in the same
'   directory as this script (both live in scripts/).
'
' NOTE: keep this file ASCII-only. VBScript reads the file in the ANSI codepage,
'   so UTF-8 Chinese here decodes to mojibake -- the MsgBox text below used to be
'   Chinese and popped up garbled.
Set ws = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)

' Delay 30s, to let Docker/network come up.
WScript.Sleep 30000

' --- target script ---
root = ws.ExpandEnvironmentStrings("%SAG_ROOT%")
If root = "%SAG_ROOT%" Then root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
target = root & "\scripts\sag-bootstrap.sh"
If Not fso.FileExists(target) Then
  MsgBox "Cannot find " & target & vbCrLf & "Set SAG_ROOT to the repository root.", 16, "SAG bootstrap failed"
  WScript.Quit 1
End If
target = Replace(target, "\", "/")

' --- locate bash (same probe as run-script-hidden.vbs) ---
bash = ""
If Len(ws.ExpandEnvironmentStrings("%SAG_BASH%")) > 0 And ws.ExpandEnvironmentStrings("%SAG_BASH%") <> "%SAG_BASH%" Then
  If fso.FileExists(ws.ExpandEnvironmentStrings("%SAG_BASH%")) Then bash = ws.ExpandEnvironmentStrings("%SAG_BASH%")
End If
If bash = "" Then
  ' bash on PATH: walk the dirs with FileExists -- do NOT use ws.Exec, that pops a
  ' console window (2026-09-13: measured as periodic window flashing from the
  ' scheduled task; see the same note in run-script-hidden.vbs).
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
  MsgBox "bash.exe not found, cannot run sag-bootstrap.sh." & vbCrLf & vbCrLf & _
         "Set the SAG_BASH environment variable to point at bash.exe.", 16, "SAG bootstrap failed"
  WScript.Quit 1
End If

ws.Run q & Replace(bash, "\", "/") & q & " -lc " & q & target & q, 0, False

' run-ps-hidden.vbs -- run a PowerShell script silently (no window).
' Usage: wscript.exe run-ps-hidden.vbs "C:\path\script.ps1" [arg1] [arg2] ...
' - The counterpart of run-script-hidden.vbs: that one runs bash, this one runs
'   PowerShell.
' - ws.Run arg 0 = hidden window, False = do not wait.
' - -ExecutionPolicy Bypass so it still runs under a restricted policy.
'
' NOTE: keep this file ASCII-only. VBScript reads the file in the ANSI codepage,
'   so UTF-8 Chinese here decodes to mojibake.
Set ws = CreateObject("Wscript.Shell")
q = Chr(34)
script = WScript.Arguments(0)
args = ""
For i = 1 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next
cmd = q & "powershell.exe" & q & " -NoProfile -ExecutionPolicy Bypass -File " & q & script & q & args
ws.Run cmd, 0, False

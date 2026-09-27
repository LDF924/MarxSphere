' sag-start.vbs -- start SAG silently (no window).
' V348: honour mode.json instead of hardcoding preview.
'   Before: MARXSPHERE_PREVIEW=1 was hardcoded, so even with mode.json=full the
'   preview mode was forced (inference/retrieval unavailable).
'   Now: read the "mode" field of mode.json -- preview sets MARXSPHERE_PREVIEW=1,
'   full (or anything else) leaves it unset, i.e. full mode.
' ws.Run arg 0 = hidden window.
'
' V415(2026-09-13): used to hardcode C:\Users\HUAWEI\SAG-main -- now the repo root
'   is derived from this script's own location, and --env-file is passed
'   explicitly. Otherwise, on another machine (or when launched from elsewhere),
'   .env is not found, JWT_SECRET ends up random, and the whole site 401s.
'
' NOTE: keep this file ASCII-only. VBScript reads the file in the ANSI codepage,
'   so UTF-8 Chinese here decodes to mojibake.
Set ws = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)

' The parent of this script's directory is the repo root.
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(scriptDir)
ws.CurrentDirectory = root

' Read mode.json to decide the startup mode.
modeFile = root & "\mode.json"
mode = "full"  ' default full (complete inference/retrieval)
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
  ' Dependencies not installed -> fall back to npx (cwd is the repo root, so the
  ' relative path works).
  cmd = "cmd /c " & IIf(mode = "preview", "set MARXSPHERE_PREVIEW=1&& ", "") & "npx tsx --env-file=./.env src\index.ts"
End If
ws.Run cmd, 0, False

' VBScript has no ternary operator -> tiny helper.
Function IIf(cond, a, b)
  If cond Then IIf = a Else IIf = b
End Function

' ov-start.vbs -- start OpenViking silently (no window).
' Usage: cscript //nologo ov-start.vbs <SAG_ROOT> <OPENVIKING_DIR>
' Example: cscript //nologo ov-start.vbs C:\SocioSeek C:\Users\me\openviking
' Paths are passed in by sag-bootstrap.sh, so no personal directory is hardcoded.
'
' NOTE: keep this file ASCII-only. VBScript reads the file in the ANSI codepage,
'   so UTF-8 Chinese here decodes to mojibake.
Set ws = CreateObject("Wscript.Shell")
root = WScript.Arguments(0)
ovDir = WScript.Arguments(1)
ws.CurrentDirectory = ovDir
ws.Run "cognee\.venv312\Scripts\openviking-server.exe --config " & ovDir & "\.openviking\ov.conf", 0, False

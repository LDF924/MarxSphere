@echo off
rem start-api-4173.cmd - 4173 backend launcher (called by scheduled task SAG-Dev4173-Temp)
rem Log goes outside the repo to avoid git noise; --max-old-space-size guards against OOM.
rem
rem V415 (2026-09-13): previously hardcoded C:\Users\HUAWEI\SAG-main (x3) and D:\node.exe.
rem   Any other machine or username fails immediately, and this is the script the scheduled
rem   task calls, so it is also the authoritative answer to "how does the service start".
rem   Now: repo root is derived from this script's own location; node comes from PATH
rem   (override with SAG_NODE).
rem
rem NOTE: keep comments ASCII-only. cmd.exe parses .cmd files in the OEM codepage (GBK on
rem   zh-CN Windows); UTF-8 Chinese in a rem line mis-decodes and can swallow later commands.
rem
rem 2026-09-22: cd to the repo root FIRST, for BOTH branches.
rem   The launcher passes absolute paths for node/tsx/app, so src/ is always this repo's.
rem   But the server resolves its static root (resolveWebDist) and data root from the
rem   CURRENT DIRECTORY. Started from a directory that happens to contain web/dist
rem   (a worktree, say), it serves THAT copy of the frontend while running THIS repo's src/.
rem   Observed: launched from the worktree -> served the worktree's web/dist
rem   (log line "[sag] 前端产物: ...worktrees\<name>\web\dist"), and the gate comparing
rem   "served assets vs this tree's dist" failed even though both trees were in sync.
rem   Same service, different UI depending on who started it -- deterministic cwd ends it.
setlocal
set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
cd /d "%ROOT%"
if not defined SAG_NODE set "SAG_NODE=node"
if not defined SAG_API_LOG set "SAG_API_LOG=%TEMP%\sag-api-4173.log"

set "TSX=%ROOT%\node_modules\tsx\dist\cli.mjs"
if exist "%TSX%" (
  "%SAG_NODE%" --max-old-space-size=1200 "%TSX%" --env-file="%ROOT%\.env" "%ROOT%\src\index.ts" >> "%SAG_API_LOG%" 2>&1
) else (
  call npx tsx --env-file=./.env src/index.ts >> "%SAG_API_LOG%" 2>&1
)
endlocal

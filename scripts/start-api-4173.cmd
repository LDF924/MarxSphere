@echo off
rem start-api-4173.cmd - 4173 backend launcher (called by scheduled task SAG-Dev4173-Temp)
rem NOTE 2026-09-27: line 2 used to be Chinese ("4173 backend launcher" written in Chinese),
rem   which VIOLATED this file's own rule a few lines below ("keep comments ASCII-only").
rem   Consequence, measured: cmd parses .cmd in the OEM codepage (GBK on zh-CN Windows),
rem   mis-decodes the UTF-8 Chinese, and the rem line then SWALLOWS the following command --
rem   the symptom is stray fragments at startup such as
rem   "'t-api-4173.cmd' is not recognized as an internal or external command".
rem   It had always "worked" only because what got swallowed was a comment, not a command.
rem   So: purge Chinese from comments in these .cmd files, not just from newly added ones.
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
rem   (log line "[sag] frontend artifacts: ...worktrees\<name>\web\dist"), and the gate comparing
rem   "served assets vs this tree's dist" failed even though both trees were in sync.
rem   Same service, different UI depending on who started it -- deterministic cwd ends it.
setlocal
set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
cd /d "%ROOT%"
if not defined SAG_NODE set "SAG_NODE=node"
rem Log file. Precedence: already-set SAG_LOG_FILE > .env's SAG_LOG_FILE > SAG_API_LOG
rem   > the %TEMP% default.
rem NOTE 2026-09-27: SAG_LOG_FILE used to be a DEAD variable -- .env sets it but
rem   nothing in the repo ever read it, so changing it did nothing. Wiring it up
rem   needed one non-obvious step: **.env does NOT reach the cmd environment**.
rem   The launcher passes `tsx --env-file=<.env>`, which is *tsx* loading the file
rem   into node -- a completely separate mechanism. So cmd can only see it by
rem   reading the file itself.
rem
rem   Do NOT route this through `for /f ... node <script> SAG_LOG_FILE "<path with = in it>"`:
rem   **cmd's for/f treats an `=` inside an argument as an option separator** and
rem   swallows it ("filename, directory name, or volume label syntax is incorrect",
rem   the command never runs). Verified -- that is exactly how the first attempt failed.
rem   The `--env-file=<path>` form is fine (it goes to node, not to for/f).
rem   So: plain findstr, no `=`, no inner quotes.
rem   (ASCII-only on purpose -- see the same note in start-api-worktree-4173.cmd.)
if not defined SAG_LOG_FILE if exist "%ROOT%\.env" for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b /c:"SAG_LOG_FILE=" "%ROOT%\.env"`) do set "SAG_LOG_FILE=%%B"
if not defined SAG_LOG_FILE if defined SAG_API_LOG set "SAG_LOG_FILE=%SAG_API_LOG%"
if not defined SAG_LOG_FILE set "SAG_LOG_FILE=%TEMP%\sag-api-4173.log"
set "SAG_API_LOG=%SAG_LOG_FILE%"
echo [sag] log file: %SAG_LOG_FILE%

set "TSX=%ROOT%\node_modules\tsx\dist\cli.mjs"
if exist "%TSX%" (
  "%SAG_NODE%" --max-old-space-size=1200 "%TSX%" --env-file="%ROOT%\.env" "%ROOT%\src\index.ts" >> "%SAG_API_LOG%" 2>&1
) else (
  call npx tsx --env-file=./.env src/index.ts >> "%SAG_API_LOG%" 2>&1
)
endlocal

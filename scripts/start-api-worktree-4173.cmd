@echo off
rem ============================================================================
rem start-api-worktree-4173.cmd - run the 4173 backend FROM A WORKTREE
rem   while keeping the MAIN repo's data.
rem
rem Why this exists (2026-09-26):
rem   Developing in a worktree while running the service from the main repo means
rem   frontend build artifacts must be hand-copied main-ward before they are
rem   visible -- a step that is easy to forget, and forgetting it looks exactly
rem   like "my fix did nothing". Verified from both directions in this repo's
rem   history (see the 2026-09-22 note in start-api-4173.cmd about serve-vs-build
rem   divergence).
rem
rem   Running the backend from the worktree removes that step: resolveWebDist()
rem   checks <SAG_ROOT>/web/dist first and, when running from source, the
rem   module-relative candidate resolves to the WORKTREE's web/dist. So whatever
rem   you build in the worktree is what gets served. No copying.
rem
rem What is intentionally SHARED with the main repo (not per-worktree):
rem   DATA_DIR  - the 63M data/ tree (uploads, empirical figures, skill state).
rem               A worktree's own data/ is a stale partial copy; pointing here
rem               avoids writing into a directory nobody reads.
rem   .env      - secrets live only in the main repo and are never committed.
rem   All three knowledge-base roots (VAULT_ROOT / LITERATURE_DIR / POLICY_DIR)
rem   are absolute paths already declared in that .env, so they resolve correctly
rem   from any working directory.
rem
rem Deliberately NOT done here: schema changes run against the SAME database as
rem   the main checkout, so check out a matching branch before starting. Going
rem   backward across a migration is the one real hazard of this setup.
rem
rem NOTE: keep comments ASCII-only. cmd.exe parses .cmd files in the OEM codepage
rem   (GBK on zh-CN Windows); UTF-8 Chinese inside a rem line mis-decodes and can
rem   swallow later commands.
rem ============================================================================
setlocal

rem Worktree root = parent of this script's directory (scripts\ -> worktree).
set "WT=%~dp0.."
for %%I in ("%WT%") do set "WT=%%~fI"
cd /d "%WT%"

rem Main repo root -- DERIVED, not hardcoded.
rem   A linked worktree's .git is a FILE pointing at <main>/.git, so
rem   `git rev-parse --git-common-dir` yields the MAIN repo's .git even when
rem   run from inside the worktree; its parent is the main repo root.
rem   Hardcoding C:\Users\<name>\SAG-main would break on any other machine or
rem   username, and this file sits in scripts/ -- which IS synced to the public
rem   repo -- so a hardcoded local path would get published too.
rem   (Same lesson as start-api-4173.cmd, which once hardcoded the path x3.)
rem   Override with SAG_MAIN_ROOT only when the layout is genuinely unusual.
rem
rem   NOTE 1: do NOT use `git rev-parse --path-format=absolute ...` here.
rem   cmd.exe strips the `=absolute` part when the command sits inside a
rem   for /f backquote, so git receives a bare `--path-format` and dies with
rem   "--path-format requires an argument" -- silently yielding an empty
rem   variable. Verified: the same command works from bash but not from cmd.
rem
rem   NOTE 2: `git rev-parse --git-common-dir` returns an ALREADY ABSOLUTE
rem   path (C:/.../.git), not a relative one. So do NOT prefix it with %WT% --
rem   doing so produced the nonsense path
rem   "<worktree>\C:\Users\...\SAG-main" and the check failed with no hint why.
rem   Appending `\..` and letting %%~fI resolve it handles the absolute case
rem   correctly: the `..` is resolved from the path ROOT, giving the main repo.
rem   NOTE 3: keep these `for` loops OUT of an `if ... ( ... )` block.
rem   cmd.exe expands %VAR% when it PARSES a parenthesized block, not when it
rem   runs each line inside it. Inside a block, %GITCOMMON% is therefore still
rem   empty at parse time, `"%GITCOMMON%\.."` collapses to `"\.."`, and that
rem   resolves to the DRIVE ROOT -- the script then failed with the baffling
rem   "main repo .env not found: C:\.env". Isolated tests passed only because
rem   they had no enclosing block, i.e. they were not testing this shape.
set "GITCOMMON="
for /f "delims=" %%I in ('git -C "%WT%" rev-parse --git-common-dir 2^>nul') do set "GITCOMMON=%%I"
if defined GITCOMMON for %%I in ("%GITCOMMON%\..") do set "SAG_MAIN_ROOT_DERIVED=%%~fI"
if not defined SAG_MAIN_ROOT set "SAG_MAIN_ROOT=%SAG_MAIN_ROOT_DERIVED%"

if not defined SAG_MAIN_ROOT (
  echo [FAIL] could not derive the main repo root from git.
  echo        run this from inside a linked worktree, or set SAG_MAIN_ROOT.
  exit /b 1
)

rem Shared state -- see the header notes above.
set "SAG_ROOT=%WT%"
set "DATA_DIR=%SAG_MAIN_ROOT%\data"
set "SAG_ENV=%SAG_MAIN_ROOT%\.env"

rem Port: override to run a worktree instance alongside the main one.
if not defined HTTP_PORT set "HTTP_PORT=4173"

if not defined SAG_NODE set "SAG_NODE=node"
if not defined SAG_API_LOG set "SAG_API_LOG=%TEMP%\sag-api-4173.log"

if not exist "%SAG_ENV%" (
  echo [FAIL] main repo .env not found: %SAG_ENV%
  echo        set SAG_MAIN_ROOT to the main checkout.
  exit /b 1
)

echo [worktree] root   : %WT%
echo [worktree] SAG_ROOT: %SAG_ROOT%
echo [worktree] DATA_DIR: %DATA_DIR%
echo [worktree] env     : %SAG_ENV%
echo [worktree] port    : %HTTP_PORT%

set "TSX=%WT%\node_modules\tsx\dist\cli.mjs"
if exist "%TSX%" (
  "%SAG_NODE%" --max-old-space-size=1200 "%TSX%" --env-file="%SAG_ENV%" "%WT%\src\index.ts" >> "%SAG_API_LOG%" 2>&1
) else (
  call npx tsx --env-file="%SAG_ENV%" src/index.ts >> "%SAG_API_LOG%" 2>&1
)
endlocal

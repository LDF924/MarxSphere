# edge-orphan-guard.ps1 -- reclaim orphaned / long-idle headless Edge processes.
#
# Why this exists (a hard-learned lesson, the second time):
#   2026-09-08  a socialsci deep-scrape left a headless Edge behind; it burned
#     20 hours of CPU. A cleanup script was written afterwards -- but it only
#     matched `edge-probe-profile`, and it depended on someone remembering to
#     run it by hand, so it did not stop the next occurrence.
#   2026-09-10 11:19  another headless Edge appeared with
#     --user-data-dir=...\Temp\edge-smoke-cdp; it survived 32 hours after its
#     parent (pid 33532) died, and its GPU children burned 178 minutes of CPU.
#     -> That is why this is now an unattended scheduled guard.
#
# Decision rules (conservative -- never touches a browser you are actually using):
#   A. broker whose parent process no longer exists  -> orphan; kill the whole tree
#   B. headless and alive > 3 hours                  -> no probe session lasts that
#                                                       long; treat as abandoned,
#                                                       kill the whole tree
# Only msedge.exe brokers are considered (the command line without --type=).
# An instance whose parent is alive, or that is not headless, is left alone.
#
# Invoked silently every 30 minutes by the scheduled task SAG-EdgeOrphanGuard
#   (via run-script-hidden.vbs).
#
# NOTE: keep this file ASCII-only (and BOM-free). Windows PowerShell 5.1 reads a
#   BOM-less .ps1 as ANSI, so the Chinese that used to be in these comments was
#   decoded as mojibake. Keep Chinese out, or save as UTF-8 WITH BOM.

$ErrorActionPreference = 'Continue'

# This script lives in <repo>/scripts/; derive the repo root from its location
# (it used to hardcode one machine's path).
$SagRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $SagRoot 'logs'
$Log    = Join-Path $LogDir 'edge-orphan-guard.log'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-Log($msg) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $msg
  Add-Content -Path $Log -Value $line -Encoding OEM
}

$STALE_HOURS = 3

$all = Get-CimInstance Win32_Process

# Only msedge.exe brokers (the main process, whose command line has no --type=).
$brokers = @()
foreach ($p in $all) {
  if ($p.Name -ne 'msedge.exe') { continue }
  if ($p.CommandLine -and $p.CommandLine -match '--type=') { continue }
  $brokers += $p
}

if ($brokers.Count -eq 0) {
  # No broker: exit silently (no log line, so we do not write noise every 30 min).
  exit 0
}

$killed = @()

foreach ($b in $brokers) {
  $parentAlive = ($all | Where-Object { $_.ProcessId -eq $b.ParentProcessId } | Measure-Object).Count -gt 0
  $isHeadless  = ($b.CommandLine -and $b.CommandLine -match '--headless')

  $ageH = 0
  try { $ageH = [math]::Round(((Get-Date) - $b.CreationDate).TotalHours, 1) } catch { }

  $reason = $null
  if (-not $parentAlive) {
    $reason = 'ORPHAN(parent dead)'
  } elseif ($isHeadless -and $ageH -gt $STALE_HOURS) {
    $reason = "STALE_HEADLESS($ageH h)"
  }

  if (-not $reason) { continue }

  $cmd = if ($b.CommandLine) { $b.CommandLine.Substring(0, [Math]::Min(160, $b.CommandLine.Length)) } else { '(no cmdline)' }

  # Kill the whole process tree.
  $out = & taskkill /PID $b.ProcessId /T /F 2>&1 | Out-String
  $ok = ($LASTEXITCODE -eq 0)

  Write-Log ("KILLED pid={0} reason={1} age={2}h headless={3} result={4}" -f $b.ProcessId, $reason, $ageH, $isHeadless, $(if ($ok) { 'ok' } else { 'fail' }))
  Write-Log ("       cmd={0}" -f $cmd)
  if (-not $ok) { Write-Log ("       taskkill out: {0}" -f ($out -replace "`r?`n", ' ')) }

  $killed += $b.ProcessId
}

# Also clean up stale Edge temp profile dirs that no process is using (>12 h).
$tmp = Join-Path $env:LOCALAPPDATA 'Temp'
$cleaned = 0
foreach ($d in (Get-ChildItem $tmp -Directory -Force -ErrorAction SilentlyContinue)) {
  if ($d.Name -notmatch '^edge[-_]') { continue }
  if (((Get-Date) - $d.LastWriteTime).TotalHours -lt 12) { continue }
  # Skip if some process is currently using this profile.
  $inUse = ($all | Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($d.Name) } | Measure-Object).Count -gt 0
  if ($inUse) { continue }
  try {
    Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction Stop
    $cleaned++
  } catch { }
}
if ($cleaned -gt 0) { Write-Log ("CLEANED {0} stale edge temp profile dir(s)" -f $cleaned) }

if ($killed.Count -gt 0) {
  Write-Log ("SUMMARY killed {0} orphan/stale headless Edge tree(s)" -f $killed.Count)
}

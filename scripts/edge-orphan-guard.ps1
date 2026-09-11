# edge-orphan-guard.ps1 — 回收孤儿 / 长期挂起的 headless Edge
#
# 为什么要有它(血泪教训, 第二次):
#   2026-09-08 socialsci 深采遗留 headless Edge, 白烧 20 小时 CPU。
#     事后写了 .claude/socialsci-probe/cleanup-probe.sh —— 但它只认
#     edge-probe-profile, 且靠人记得手动跑, 所以没拦住下一次。
#   2026-09-10 11:19 又冒出 --user-data-dir=...\Temp\edge-smoke-cdp 的
#     headless Edge, 父进程(33532)死后仍存活 32 小时,
#     GPU 子进程累计烧 178 分钟 CPU。→ 本次改为无人值守定时守卫。
#
# 判定规则(保守, 绝不碰日常浏览器):
#   A. broker 的父进程已不存在   → 孤儿, 杀整棵进程树
#   B. headless 且存活 > 3 小时  → 探针会话不可能这么久, 视为遗弃, 杀整棵进程树
# 只处理 msedge.exe 的 broker(命令行不含 --type=)。
# 父进程健在、且非 headless 的实例一律不动(那是用户正在用的浏览器)。
#
# 由 schtasks 任务 SAG-EdgeOrphanGuard 每 30 分钟静默调用(经 run-script-hidden.vbs)。

$ErrorActionPreference = 'Continue'

$LogDir = 'C:\Users\HUAWEI\SAG-main\logs'
$Log    = Join-Path $LogDir 'edge-orphan-guard.log'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-Log($msg) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $msg
  Add-Content -Path $Log -Value $line -Encoding OEM
}

$STALE_HOURS = 3

$all = Get-CimInstance Win32_Process

# 只看 msedge.exe 的 broker（不带 --type= 的那个主进程）
$brokers = @()
foreach ($p in $all) {
  if ($p.Name -ne 'msedge.exe') { continue }
  if ($p.CommandLine -and $p.CommandLine -match '--type=') { continue }
  $brokers += $p
}

if ($brokers.Count -eq 0) {
  # 无 broker，静默退出（不写日志，避免每 30 分钟刷一行噪音）
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

  # 杀掉整棵进程树
  $out = & taskkill /PID $b.ProcessId /T /F 2>&1 | Out-String
  $ok = ($LASTEXITCODE -eq 0)

  Write-Log ("KILLED pid={0} reason={1} age={2}h headless={3} result={4}" -f $b.ProcessId, $reason, $ageH, $isHeadless, $(if ($ok) { 'ok' } else { 'fail' }))
  Write-Log ("       cmd={0}" -f $cmd)
  if (-not $ok) { Write-Log ("       taskkill out: {0}" -f ($out -replace "`r?`n", ' ')) }

  $killed += $b.ProcessId
}

# 顺带清理：无进程占用的陈旧 Edge 临时 profile（>12 小时）
$tmp = Join-Path $env:LOCALAPPDATA 'Temp'
$cleaned = 0
foreach ($d in (Get-ChildItem $tmp -Directory -Force -ErrorAction SilentlyContinue)) {
  if ($d.Name -notmatch '^edge[-_]') { continue }
  if (((Get-Date) - $d.LastWriteTime).TotalHours -lt 12) { continue }
  # 有进程正在用这个 profile 就跳过
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

# run-eval-one-by-one.ps1 — 逐题评测（每题独立进程，跑完等服务器恢复再跑下一题）
# 用法: powershell -File run-eval-one-by-one.ps1 Q03 Q04 Q07 Q08 Q11 Q12 Q15 Q17 Q19 Q20 Q27 Q32 Q35 Q36 Q38 Q42 Q43 Q46 Q49 Q50
$questions = @($args)
if ($questions.Count -eq 0) {
  $questions = @("Q03","Q04","Q07","Q08","Q11","Q12","Q15","Q17","Q19","Q20","Q27","Q32","Q35","Q36","Q38","Q42","Q43","Q46","Q49","Q50")
}
$log = "%SAG_ROOT%\eval_onebyone.log"
$dir = "%SAG_ROOT%"

foreach ($q in $questions) {
  $ts = Get-Date -Format "HH:mm:ss"
  Add-Content -Path $log -Value "=== [$ts] 开始 $q ==="
  Write-Output "=== [$ts] 开始 $q ==="
  $env:EVAL_QUESTIONS = $q
  $env:FETCH_TIMEOUT_MS = "18000000"
  $p = Start-Process -FilePath "node.exe" -ArgumentList "%SAG_ROOT%\node_modules\tsx\dist\cli.mjs","scripts/eval-32-metrics.ts" -WorkingDirectory $dir -WindowStyle Hidden -RedirectStandardOutput "$dir\eval_onebyone_$q.log" -RedirectStandardError "$dir\eval_onebyone_$q.err" -PassThru
  # 等评测进程结束（超时保护 40 分钟）
  $waited = $false
  for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Seconds 30
    if ($p.HasExited) { $waited = $true; break }
  }
  if (-not $waited) {
    Add-Content -Path $log -Value "=== $q 超时40分钟，强制停止 ==="
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  }
  $ts2 = Get-Date -Format "HH:mm:ss"
  Add-Content -Path $log -Value "=== [$ts2] $q 完成，等待60秒让服务器恢复 ==="
  Start-Sleep -Seconds 60
}
Add-Content -Path $log -Value "=== 全部完成 ==="
Write-Output "全部完成"

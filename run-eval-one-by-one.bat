@echo off
rem 逐题评测脚本 — 每题单独运行评测脚本，跑完再跑下一题
rem 用法: run-eval-one-by-one.bat Q03 Q04 Q07 ...

setlocal
cd /d %SAG_ROOT%

for %%q in (%*) do (
  echo ========================================
  echo [%date% %time%] 开始评测 %%q
  echo ========================================
  set EVAL_QUESTIONS=%%q
  npx tsx scripts/eval-32-metrics.ts >> eval_onebyone.log 2>&1
  echo [%date% %time%] %%q 完成
  rem 每题之间等60秒，让服务器恢复连接
  timeout /t 60 /nobreak > nul
)

echo 全部完成

@echo off
rem start-api-4173.cmd — 4173 后端启动脚本(计划任务 SAG-Dev4173-Temp 调用, 2026-09-03)
rem 日志重定向到主仓外, 避免 git 污染; --max-old-space-size 防 OOM
cd /d C:\Users\HUAWEI\SAG-main
D:\node.exe --max-old-space-size=1200 C:\Users\HUAWEI\SAG-main\node_modules\tsx\dist\cli.mjs C:\Users\HUAWEI\SAG-main\src\index.ts >> C:\Users\HUAWEI\AppData\Local\Temp\sag-api-4173.log 2>&1

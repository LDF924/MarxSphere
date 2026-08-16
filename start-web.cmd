@echo off
rem SAG Web dev server 启动脚本（供 preview_start 使用）
cd /d %SAG_ROOT%
call npx vite --host 0.0.0.0

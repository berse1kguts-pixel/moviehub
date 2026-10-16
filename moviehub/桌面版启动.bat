@echo off
chcp 65001 >nul
cd /d %~dp0
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules\electron\dist\electron.exe (
  echo [桌面版] 首次运行，正在安装 Electron 运行环境（约 100MB）…
  call npm i electron --no-audit --no-fund
)
echo [桌面版] 正在启动观影中心…
call npx electron .
pause

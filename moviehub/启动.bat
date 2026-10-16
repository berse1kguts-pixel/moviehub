@echo off
chcp 65001 >nul
cd /d %~dp0
title 观影中心

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [错误] 未检测到 Node.js 运行环境
    echo   请先安装 Node.js（一直点下一步即可）: https://nodejs.org/
    echo   安装完成后重新双击本文件
    echo.
    pause
    exit /b 1
)

echo.
echo   ════════════════════════════════════════
echo    🎬 观影中心正在启动 ...
echo    本机观看：   http://localhost:7000
echo    电视/手机： http://本机局域网IP:7000
echo    停止服务：  直接关闭本窗口
echo   ════════════════════════════════════════
echo.

start "" http://localhost:7000
node server.js
pause

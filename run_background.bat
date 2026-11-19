@echo off
setlocal
cd /d "%~dp0"
title Antigravity Remote - Rust Background Runner
if not exist "%~dp0logs" mkdir "%~dp0logs"
if /i "%~1"=="/background" goto run
wscript.exe "%~dp0start_background_bridge.vbs"
echo Starting Antigravity Remote. Open http://127.0.0.1:8000/#connect
exit /b 0

:run
if not defined BRIDGE_PORT set "BRIDGE_PORT=8000"
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $env:BRIDGE_PORT + '/healthz') -TimeoutSec 2; if ($r.engine -eq 'rust-axum') { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 exit /b 0
set "BRIDGE_BINARY=%~dp0antigravity-bridge.exe"
if not exist "%BRIDGE_BINARY%" set "BRIDGE_BINARY=%~dp0target\release\antigravity-bridge.exe"
if not exist "%BRIDGE_BINARY%" (
    echo Rust binary missing. Run build.bat first. >> "%~dp0logs\bridge_stdout.log"
    exit /b 1
)
:server_loop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_background_log.ps1" -Binary "%BRIDGE_BINARY%" -LogPath "%~dp0logs\bridge_stdout.log"
if not errorlevel 1 exit /b 0
rem Exit instead of restarting forever when another service owns the port.
powershell -NoProfile -Command "if (Get-NetTCPConnection -State Listen -LocalPort $env:BRIDGE_PORT -ErrorAction SilentlyContinue) { exit 0 }; exit 1" >nul 2>&1
if not errorlevel 1 exit /b 1
timeout /t 3 /nobreak >nul
goto server_loop

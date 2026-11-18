@echo off
:: Antigravity Remote - Native Rust Server Launcher
setlocal
cd /d "%~dp0"
title Antigravity Remote [Rust Native Engine]

if not defined BRIDGE_PORT set "BRIDGE_PORT=8000"
set "BRIDGE_URL=http://127.0.0.1:%BRIDGE_PORT%/"
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri ($env:BRIDGE_URL + 'healthz') -TimeoutSec 2; if ($r.ok -eq $true -and $r.engine -eq 'rust-axum') { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto :already_running

echo Local website: %BRIDGE_URL%
echo Keep this window open while using the website.
echo.

set "BRIDGE_BINARY="
if exist "antigravity-bridge.exe" set "BRIDGE_BINARY=antigravity-bridge.exe"
if not defined BRIDGE_BINARY if exist "target\release\antigravity-bridge.exe" set "BRIDGE_BINARY=target\release\antigravity-bridge.exe"
if defined BRIDGE_BINARY (
    echo Starting Antigravity Remote [%BRIDGE_BINARY%]...
    echo The phone pairing page will open with a QR code when the server is ready.
    echo.
    start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open_connect.ps1"
    "%BRIDGE_BINARY%"
    goto :server_stopped
)

echo [ERROR] The Rust bridge binary was not found.
echo Run build.bat in this folder, then run Start_Antigravity_Remote.bat again.
pause
exit /b 1

:server_stopped
set "BRIDGE_EXIT_CODE=%errorlevel%"
echo.
if "%BRIDGE_EXIT_CODE%"=="0" (
    echo Server stopped.
) else (
    echo [ERROR] Server exited with code %BRIDGE_EXIT_CODE%. See the error above.
)
pause
exit /b %BRIDGE_EXIT_CODE%

:already_running
echo Antigravity Remote is already running.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open_connect.ps1"
if errorlevel 1 (
    echo Open %BRIDGE_URL%#connect in your browser to pair your phone.
    pause
    exit /b 1
)
echo.
echo The existing server will keep running after you close this window.
pause
exit /b 0


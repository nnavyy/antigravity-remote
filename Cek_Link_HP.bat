@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title Antigravity Remote - Status and Phone Link
color 0b
cls

set "PROJ_DIR=%~dp0"
if not defined BRIDGE_PORT set "BRIDGE_PORT=8000"
set "LOCAL_BASE=http://127.0.0.1:%BRIDGE_PORT%"

echo ================================================================
echo            ANTIGRAVITY REMOTE - STATUS AND PHONE LINK
echo ================================================================
echo.

rem 1. Check whether the Rust bridge is already listening on BRIDGE_PORT
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri ($env:LOCAL_BASE + '/healthz') -TimeoutSec 2; if ($r.ok -eq $true) { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>&1
if !errorlevel! neq 0 (
    echo [STATUS] Bridge server is not running in the background.
    echo [INFO] Starting Antigravity Remote in the background...
    wscript.exe "%PROJ_DIR%start_background_bridge.vbs"
    echo [WAIT] Waiting for the bridge server to respond on port %BRIDGE_PORT%...
    for /L %%i in (1,1,10) do (
        powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri ($env:LOCAL_BASE + '/healthz') -TimeoutSec 2; if ($r.ok -eq $true) { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>&1
        if !errorlevel! equ 0 goto server_ready
        timeout /t 1 /nobreak >nul
    )
    echo.
    echo [ERROR] Bridge server did not respond on port %BRIDGE_PORT%.
    echo         If antigravity-bridge.exe has not been built yet, run build.bat first.
    echo         Otherwise check logs\bridge_stdout.log for details.
    echo.
    pause
    exit /b 1
) else (
    echo [STATUS] Bridge server is running on port %BRIDGE_PORT%.
)

:server_ready
echo.
set "REMOTE_MODE="
set "PRIMARY_URL="
set "LAN_URL="

for /f "usebackq tokens=1,* delims==" %%A in (`powershell -NoProfile -Command "try { $c = Invoke-RestMethod -Uri ($env:LOCAL_BASE + '/api/connection') -TimeoutSec 3; Write-Output ('REMOTE_MODE=' + $c.settings.remote_mode); Write-Output ('PRIMARY_URL=' + $c.primary_url); Write-Output ('LAN_URL=' + $c.lan_url) } catch {}"`) do set "%%A=%%B"

set "SHARE_URL=!PRIMARY_URL!"

echo ----------------------------------------------------------------
if defined REMOTE_MODE (
    echo [ACCESS MODE]: !REMOTE_MODE!
)
if defined SHARE_URL (
    echo [PRIMARY PHONE LINK]:
    echo   !SHARE_URL!
    powershell -NoProfile -Command "Set-Clipboard -Value $env:SHARE_URL" >nul 2>&1
    if !errorlevel! equ 0 echo   ^(Copied to clipboard^)
) else (
    echo [PHONE ADDRESS UNAVAILABLE] Open Connect to configure the selected mode.
)
echo.
if defined LAN_URL (
    echo [LOCAL WI-FI ^(LAN^) LINK]:
    echo   !LAN_URL!
    echo.
)
echo [LAPTOP CONNECT ^& QR PAGE]:
echo   %LOCAL_BASE%/#connect
echo.
echo ----------------------------------------------------------------
echo.

echo Choose an option:
echo [1] Open Connect ^& QR Code page in laptop browser
if defined SHARE_URL echo [2] Open WhatsApp Web to send the active link to yourself
if defined SHARE_URL echo [3] Copy primary phone link to clipboard again
echo [4] Exit
echo.
set /p CHOICE="Enter choice (1/2/3/4) [default: 1]: "
if "!CHOICE!"=="" set "CHOICE=1"
if "!CHOICE!"=="1" (
    start "" "%LOCAL_BASE%/#connect"
)
if defined SHARE_URL if "!CHOICE!"=="2" (
    start "" "https://api.whatsapp.com/send?text=Antigravity%%20Remote%%20Link:%%20!SHARE_URL!"
)
if defined SHARE_URL if "!CHOICE!"=="3" (
    powershell -NoProfile -Command "Set-Clipboard -Value $env:SHARE_URL" >nul 2>&1
    echo [OK] Link copied to clipboard: !SHARE_URL!
    timeout /t 2 >nul
)

@echo off
setlocal
cd /d "%~dp0"
title Build Antigravity Remote [Rust Native Engine]

set "PATH=C:\w64devkit\bin;%USERPROFILE%\.cargo\bin;%PATH%"

echo [1/3] Using the configured Rust toolchain...
where cargo >nul 2>&1 || goto :fail

echo [2/3] Compiling optimized release binary (LTO + stripped)...
cargo build --release --locked || goto :fail

echo [3/3] Publishing standalone executable to project root...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish_build.ps1" || exit /b 1

echo.
echo Build complete. You can now launch Antigravity Remote using Start_Antigravity_Remote.bat
exit /b 0

:fail
echo.
echo Compilation failed.
exit /b 1

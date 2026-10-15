@echo off
rem ===================================================================
rem  Who is that white window?  (double-click me)
rem
rem  Step 1: this window tells you to click the white window.
rem  Step 2: within 8 seconds, CLICK the white window with your mouse.
rem  Step 3: it prints the process name, PID, exe path, class and title.
rem
rem  Send those lines to DaFeiYu. Nothing is closed or modified.
rem  ASCII-only + CRLF on purpose.
rem ===================================================================
setlocal
cd /d "%~dp0"
chcp 65001 >nul 2>nul

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\who-is-this-window.ps1"

echo.
pause
endlocal

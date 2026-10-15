@echo off
rem ===================================================================
rem  Watch for the blank white window (double-click me)
rem
rem  Keep this window open while you use the computer. The moment that
rem  white window shows up, it writes the time AND which processes were
rem  started in the previous minute -- that is how we find who creates it.
rem
rem  Log: data\logs\blank-window-watch.log
rem  Runs 30 minutes, then stops by itself. Close the window to stop early.
rem  ASCII-only + CRLF on purpose.
rem ===================================================================
setlocal
cd /d "%~dp0"
chcp 65001 >nul 2>nul

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\watch-blank-window.ps1"

echo.
pause
endlocal

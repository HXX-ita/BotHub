@echo off
rem ===================================================================
rem  Close the "blank white window" (double-click me)
rem
rem  What that white window is: an ApplicationFrameWindow (a UWP app
rem  frame) owned by explorer.exe with NO title -- i.e. it belongs to
rem  Windows, NOT to BotHub. BotHub only has the Edge app window
rem  ("BotHub . <name>") and a tray icon; its helpers run with no window.
rem
rem  This script closes ONLY untitled blank UWP frames. Nothing else.
rem  ASCII-only + CRLF on purpose (cmd.exe reads the OEM codepage).
rem ===================================================================
setlocal
cd /d "%~dp0"
chcp 65001 >nul 2>nul

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\close-blank-window.ps1"

echo.
pause
endlocal

@echo off
rem ===================================================================
rem  Start BotHub - double-click this file.
rem
rem    1. enable the keep-alive tasks (in case "full exit" disabled them)
rem    2. make sure the app is running
rem    3. wait until the panel answers (no "can't connect" white window)
rem    4. put the tray icon in the notification area
rem    5. open the panel as a plain window (Edge/Chrome app mode)
rem
rem  ASCII-only + CRLF: cmd.exe reads scripts in the OEM codepage.
rem ===================================================================
chcp 65001 >nul 2>nul
setlocal
cd /d "%~dp0"
if not exist "data\logs" mkdir "data\logs"
set "LOG=data\logs\launcher.log"

set "NODE="
if exist "runtime\node\node.exe" set "NODE=%CD%\runtime\node\node.exe"
if not defined NODE (
  for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
)
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (
  echo Node.js not found. Please run install.cmd first.
  pause
  exit /b 1
)

echo [%DATE% %TIME%] ===== start BotHub ===== >> "%LOG%"

schtasks /Change /TN "BotHub-Supervisor" /ENABLE >nul 2>&1
schtasks /Change /TN "BotHub-Ensure" /ENABLE >nul 2>&1

rem ensure goes to the CONSOLE too: on a cold start this step is the slow one,
rem and the boss must see *something* happening while it waits.
echo   - starting the app (first time can take ~10s)...
"%NODE%" "tools\start-bothub-supervisor.mjs" --ensure
rem wait for the panel -- goes to the CONSOLE so the user sees the spinning
rem "starting up" animation (the script logs one line itself).
echo   - waiting for the panel (first run can take a few seconds)...
"%NODE%" "tools\wait-panel.mjs"
wscript.exe //nologo "tools\start-tray.vbs"
"%NODE%" "tools\open-window.mjs" >> "%LOG%" 2>&1

exit /b 0

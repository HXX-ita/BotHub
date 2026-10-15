@echo off
rem ===================================================================
rem  Start BotHub - double-click this file.
rem
rem  What it does (2026-10-16, changed at the boss's request):
rem    1. enable the keep-alive tasks (in case "full exit" disabled them)
rem    2. make sure the app is running -- started in the BACKGROUND
rem    3. put the tray icon in the notification area
rem
rem  It does NOT open the panel any more: nothing pops up on start.
rem  Open the panel yourself from the tray icon -> "open panel".
rem  This file itself exits immediately and shows no console window.
rem
rem  ASCII-only + CRLF: cmd.exe reads scripts in the OEM codepage.
rem ===================================================================
chcp 65001 >nul 2>nul
setlocal
cd /d "%~dp0"
if not exist "data\logs" mkdir "data\logs"
set "LOG=data\logs\launcher.log"

rem make sure Node is around at all: if it is missing, nothing can start.
rem (run-hidden.vbs resolves the exact path by itself afterwards.)
set "HAVENODE="
if exist "runtime\node\node.exe" set "HAVENODE=1"
if not defined HAVENODE (
  for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "HAVENODE=1"
)
if not defined HAVENODE if exist "%ProgramFiles%\nodejs\node.exe" set "HAVENODE=1"
if not defined HAVENODE (
  echo Node.js not found. Please run install.cmd first.
  pause
  exit /b 1
)

echo [%DATE% %TIME%] ===== start BotHub (background, no panel) ===== >> "%LOG%"

schtasks /Change /TN "BotHub-Supervisor" /ENABLE >nul 2>&1
schtasks /Change /TN "BotHub-Ensure" /ENABLE >nul 2>&1

rem app + supervisor, started HIDDEN (no console, no panel window)
wscript.exe //nologo "tools\run-hidden.vbs" "start-bothub-supervisor.mjs" --ensure

rem tray icon (hidden; it holds a single-instance lock so no double icons)
wscript.exe //nologo "tools\start-tray.vbs"

rem NOTE: the panel is NOT opened here on purpose -- use the tray menu.

exit /b 0

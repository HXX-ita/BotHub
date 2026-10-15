@echo off
rem ===================================================================
rem  Diagnose BotHub - double-click when the bot does not answer.
rem  Prints a one-screen Chinese report with a "what to do" line per item.
rem
rem  ASCII-only + CRLF: cmd.exe reads scripts in the OEM codepage.
rem ===================================================================
setlocal
cd /d "%~dp0"
chcp 65001 >nul

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

"%NODE%" "tools\doctor.mjs"
echo.
pause

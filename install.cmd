@echo off
rem ===================================================================
rem  BotHub installer - double-click this file.
rem
rem  What it does:
rem    1. find Node.js (bundled runtime\node, then PATH, then Program Files)
rem    2. if none: download the official portable Node into runtime\node
rem    3. install the one dependency (npm install)
rem    4. run the setup wizard: paste your QQ appId + appSecret
rem
rem  ASCII-only + CRLF on purpose: cmd.exe reads scripts in the OEM
rem  codepage, so UTF-8 Chinese here would turn into garbage commands.
rem ===================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
title BotHub setup

echo.
echo   BotHub - one-click setup
echo   ========================
echo.

set "NODE="
if exist "runtime\node\node.exe" set "NODE=%CD%\runtime\node\node.exe"
if not defined NODE (
  for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
)
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE (
  echo   [1/4] Node.js not found - downloading the official portable build...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "tools\get-node.ps1"
  if exist "runtime\node\node.exe" set "NODE=%CD%\runtime\node\node.exe"
)
if not defined NODE (
  echo.
  echo   [X] Could not get Node.js automatically.
  echo       Please install it from https://nodejs.org/ ^(LTS^) and run this file again.
  echo.
  pause
  exit /b 1
)
echo   [1/4] Node.js: %NODE%
"%NODE%" --version

echo   [2/4] Installing dependencies...
if not exist "node_modules\@tencent-connect" (
  "%NODE%" "%~dp0node_modules\npm\bin\npm-cli.js" --version >nul 2>&1
  where npm >nul 2>&1
  if !errorlevel! equ 0 (
    call npm install --omit=dev --no-audit --no-fund
  ) else (
    echo       npm not found - skipping ^(BotHub works without the QQ SDK only in mock mode^)
  )
) else (
  echo       already installed
)

echo   [3/4] Configuration...
echo.
"%NODE%" "tools\setup.mjs"
set "RC=%errorlevel%"

if not "%RC%"=="0" (
  echo.
  echo   Setup did not finish ^(exit code %RC%^). Run install.cmd again after fixing that.
  echo.
  pause
  exit /b %RC%
)

echo.
echo   [4/4] Starting BotHub...
call "start.cmd"
echo.
pause
exit /b 0

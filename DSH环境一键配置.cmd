@echo off
rem ============================================================
rem   DSH environment one-click setup  (bundled with BotHub)
rem   ------------------------------------------------------
rem   This .cmd is ASCII-only on purpose: cmd.exe is picky about
rem   encodings, so all user-facing Chinese text is printed by the
rem   Node script below (which handles UTF-8 fine).
rem   Double-click it: it checks DSH, the model channel and the
rem   optional plugins, then writes the DSH path into the config.
rem ============================================================
chcp 65001 >nul 2>nul
setlocal
cd /d "%~dp0"

set NODE=
where node >nul 2>nul && set NODE=node
if not defined NODE if exist "%~dp0tools\node\node.exe" set NODE=%~dp0tools\node\node.exe
if not defined NODE if exist "%~dp0runtime\node.exe" set NODE=%~dp0runtime\node.exe
if not defined NODE (
  echo.
  echo   [!] Node.js not found. Please run install.cmd first, then try again.
  echo.
  pause
  exit /b 1
)

"%NODE%" "%~dp0tools\dsh-env-setup.mjs" --apply
echo.
pause
endlocal

@echo off
setlocal enableextensions
cd /d "%~dp0"
title zhibo-auto - Console

rem =====================================================================
rem  Double-click this file to start the console on 127.0.0.1:18090.
rem
rem  server.mjs serves the page itself and opens the browser (--open).
rem  If the port is already taken it opens the console that is already
rem  running and exits quietly -- so double-clicking twice is harmless.
rem
rem  Want a different port?  set AUTO_PORT=18091
rem
rem  NOTE: keep this file ASCII-only. cmd.exe mis-parses UTF-8 Chinese
rem  inside rem/echo lines and tries to run them as commands.
rem =====================================================================

set "NODE_EXE="
if exist "D:\Apps\node22\node.exe" set "NODE_EXE=D:\Apps\node22\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if exist "%%D\node.exe" set "NODE_EXE=%%D\node.exe"

if not defined NODE_EXE (
  echo.
  echo  [ERROR] Node.js not found on this machine.
  echo.
  echo    Install it once:   winget install OpenJS.NodeJS.LTS
  echo    Then close this window and run start-backend.bat again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo  First run: installing dependencies, this takes a minute...
  call npm install
  if errorlevel 1 (
    echo  [ERROR] npm install failed. See the output above.
    pause
    exit /b 1
  )
)

echo.
echo   node : %NODE_EXE%
echo   dir  : %CD%
echo.
echo   Console : http://127.0.0.1:18090/   (opens automatically)
echo   Keep this window open - closing it stops the console.
echo  ---------------------------------------------------------------
echo.

"%NODE_EXE%" server.mjs --open

echo.
echo  ---------------------------------------------------------------
echo   Console stopped. If it died on startup, the reason is above.
echo  ---------------------------------------------------------------
pause >nul

@echo off
setlocal
rem StudyHub for ZCode installer. Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).
rem ASCII only, CRLF line endings. This file only checks Node; studyhub\install\install.mjs does the rest, in Node,
rem so no folder name is ever read back or parsed by cmd.exe.
rem Usage: install.bat                           (finds ZCode by itself)
rem        install.bat "E:\Program Files\ZCode"   (the folder ZCode is installed in)

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js was not found. Install Node.js 22.19 or newer from https://nodejs.org and run this script again.
  goto fail
)
set "NODE_OK="
for /f "tokens=1,2 delims=v." %%a in ('node -v') do (
  if %%a GTR 22 set "NODE_OK=1"
  if %%a EQU 22 if %%b GEQ 19 set "NODE_OK=1"
)
if not defined NODE_OK (
  echo [X] Node.js 22.19 or newer is needed. Install the LTS from https://nodejs.org and run this script again.
  goto fail
)

node "%~dp0studyhub\install\install.mjs" %*
if errorlevel 1 goto fail
if not defined STUDYHUB_NO_PAUSE pause
exit /b 0

:fail
if not defined STUDYHUB_NO_PAUSE pause
exit /b 1

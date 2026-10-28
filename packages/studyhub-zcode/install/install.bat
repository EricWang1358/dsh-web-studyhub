@echo off
setlocal
rem StudyHub for ZCode installer. Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).
rem ASCII only, CRLF line endings: cmd.exe mis-reads UTF-8 and LF scripts.
rem Usage: install.bat                      (finds ZCode by itself)
rem        install.bat "E:\Program Files\ZCode"   (the folder ZCode is installed in)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js was not found. Install Node.js 22 or newer from https://nodejs.org and run this script again.
  goto fail
)
set "NODE_MAJOR=0"
for /f "tokens=1 delims=v." %%a in ('node -v') do set "NODE_MAJOR=%%a"
if %NODE_MAJOR% LSS 22 (
  echo [X] Node.js %NODE_MAJOR% is too old. Install Node.js 22 or newer from https://nodejs.org and run this script again.
  goto fail
)

rem Where ZCode is: the folder given above, the running ZCode, the registry, then the usual folders on every drive.
set "ZCODE="
for /f "usebackq delims=" %%p in (`node "%~dp0studyhub\install\find-zcode.mjs" "%~1"`) do set "ZCODE=%%p"
if not defined ZCODE (
  echo [X] ZCode was not found. Start ZCode once and run this script again, or give its folder:
  echo     install.bat "E:\Program Files\ZCode"
  goto fail
)
echo [1/3] Found ZCode: %ZCODE%

echo [2/3] Registering this folder as a local marketplace and installing StudyHub ...
node "%ZCODE%" plugins marketplace add "%~dp0."
if errorlevel 1 (
  echo     The marketplace may already point at another folder; registering this one again ...
  node "%ZCODE%" plugins marketplace remove studyhub-bundle
  node "%ZCODE%" plugins marketplace add "%~dp0."
  if errorlevel 1 (
    echo [X] Registering the marketplace failed.
    goto fail
  )
)
node "%ZCODE%" plugins install studyhub@studyhub-bundle
if errorlevel 1 (
  echo [X] Installing StudyHub failed.
  goto fail
)

echo [3/3] Done. Quit ZCode completely, including its tray icon, and open it again.
echo       Then type /studyhub in a new chat. Model setup and privacy: see the guide next to this script.
echo       Background tasks run while ZCode is open; quitting ZCode ends them, and finished parts are kept.
echo.
echo To uninstall later, run these two lines in a command prompt:
echo   node "%ZCODE%" plugins uninstall studyhub --force
echo   node "%ZCODE%" plugins marketplace remove studyhub-bundle
pause
exit /b 0

:fail
pause
exit /b 1

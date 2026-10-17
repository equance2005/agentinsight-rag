@echo off
setlocal

rem Double-click this file to start both services.
rem Arguments are forwarded to start-all.ps1, for example: start-all.cmd -SkipInstall

set "SCRIPT=%~dp0start-all.ps1"
if not exist "%SCRIPT%" (
  echo Startup script not found: %SCRIPT%
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Startup script failed with exit code: %EXIT_CODE%
  pause
)

exit /b %EXIT_CODE%

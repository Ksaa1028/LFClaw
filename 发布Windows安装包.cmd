@echo off
setlocal EnableExtensions

cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release-win.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Windows package build failed. Review the error above.
) else (
  echo.
  echo Windows package build completed. The release folder is open.
)

echo.
pause
exit /b %EXIT_CODE%

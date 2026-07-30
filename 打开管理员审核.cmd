@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".env.admin.local" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-admin.ps1"
  if errorlevel 1 (
    echo Failed to create the local administrator configuration.
    pause
    exit /b 1
  )
  echo.
  echo Fill in the Render URL and copy the generated token to the Render environment.
  echo Save the file, then double-click this launcher again to open administrator mode.
  pause
  exit /b 1
)

call npm run admin
if errorlevel 1 (
  echo.
  echo Failed to start the local administrator companion. Check the message above.
  pause
)

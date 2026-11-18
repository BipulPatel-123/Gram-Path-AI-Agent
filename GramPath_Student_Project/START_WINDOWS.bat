@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 or newer, then open this file again.
  pause
  exit /b 1
)
if not exist "node_modules\express\package.json" (
  call npm ci
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm start
pause

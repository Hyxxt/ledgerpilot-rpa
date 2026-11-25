@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 20 or later, then open this launcher again.
  pause
  exit /b 1
)
if not exist "node_modules\playwright-core\package.json" (
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node.exe launch.mjs
if errorlevel 1 pause

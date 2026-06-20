@echo off
REM One-time / background setup — no server start, no pause
cd /d "%~dp0"
setlocal enabledelayedexpansion

node -v >nul 2>&1
if errorlevel 1 exit /b 1

if not exist "db\accounting.db" (
    python3 scripts\setup-production.py >nul 2>&1
)

if not exist "node_modules" (
    call npm install >nul 2>&1
)
if not exist "frontend\node_modules" (
    cd frontend
    call npm install >nul 2>&1
    cd ..
)

if not exist "frontend\dist\index.html" (
    cd frontend
    call npm run build >nul 2>&1
    cd ..
)

exit /b 0

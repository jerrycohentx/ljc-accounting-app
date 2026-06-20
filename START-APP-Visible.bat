@echo off
REM LJC Accounting App — visible startup (for troubleshooting)
cd /d "%~dp0"
setlocal enabledelayedexpansion

echo.
echo ======================================================
echo  LJC Accounting App - Visible Startup
echo ======================================================
echo.

node -v >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed
    echo Please download from: https://nodejs.org
    pause
    exit /b 1
)

echo [1/6] Checking Node.js...
node -v
echo OK
echo.

echo [2/6] Setting up database...
if not exist "db\accounting.db" (
    echo Creating new database...
    python3 scripts\setup-production.py
) else (
    echo Database already exists
)
echo OK
echo.

echo [3/6] Installing dependencies...
if not exist "node_modules" call npm install
if not exist "frontend\node_modules" (
    cd frontend
    call npm install
    cd ..
)
echo OK
echo.

echo [4/6] Building frontend...
cd frontend
call npm run build
cd ..
echo OK
echo.

echo [5/6] Checking port 3000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo Stopping previous server (PID %%a)...
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul
echo OK
echo.

echo [6/6] Starting application...
echo Visit: http://localhost:3000
echo Press Ctrl+C to stop
echo.

node server.js
pause

@echo off
REM LJC Accounting App - One-Click Launcher
REM This script sets everything up and starts the app

cd /d "%~dp0"
setlocal enabledelayedexpansion

echo.
echo ======================================================
echo  LJC Accounting App - Automatic Startup
echo ======================================================
echo.

REM Check if Node.js is installed
node -v >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed
    echo.
    echo Please download and install Node.js from: https://nodejs.org
    echo Then run this script again
    echo.
    pause
    exit /b 1
)

echo [1/5] Checking Node.js...
node -v
echo OK
echo.

REM Check database
echo [2/5] Setting up database...
if not exist "db\accounting.db" (
    echo Creating new database...
    python3 scripts\setup-production.py
    if errorlevel 1 (
        echo Warning: Database setup had an issue, but continuing...
    )
) else (
    echo Database already exists
)
echo OK
echo.

REM Install backend dependencies if needed
echo [3/5] Installing dependencies...
if not exist "node_modules" (
    echo Installing backend packages...
    call npm install
)
if not exist "frontend\node_modules" (
    echo Installing frontend packages...
    cd frontend
    call npm install
    cd ..
)
echo OK
echo.

REM Build frontend
echo [4/5] Building frontend...
cd frontend
call npm run build
cd ..
echo OK
echo.

REM Start the app
echo [5/5] Starting application...
echo.
echo ======================================================
echo  App is starting...
echo.
echo  Visit: http://localhost:3000
echo.
echo  Email: jerry@ljcfinancial.com
echo  Password: (check your email or ask admin)
echo.
echo  Press Ctrl+C to stop the app
echo ======================================================
echo.

REM Start server
node server.js

pause

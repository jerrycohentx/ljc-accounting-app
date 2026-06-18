@echo off
REM =====================================================
REM LJC Accounting App - Complete Setup and Deployment
REM =====================================================

echo.
echo ===== STEP 1: Backing Up Existing Database =====
echo.
if exist db\accounting.db (
    echo Backing up old database...
    move db\accounting.db db\accounting.db.backup
    echo Backup saved as accounting.db.backup
)

echo.
echo ===== STEP 2: Initializing Fresh Database =====
echo.
call node init-db.js
if %errorlevel% neq 0 (
    echo ERROR: Database initialization failed
    pause
    exit /b 1
)

echo.
echo ===== STEP 3: Setting Up App Data =====
echo.
call node migrate-data.js
if %errorlevel% neq 0 (
    echo ERROR: Data setup failed
    pause
    exit /b 1
)

echo.
echo ===== STEP 4: Building Frontend =====
echo.
cd frontend
call npm run build
if %errorlevel% neq 0 (
    echo ERROR: Frontend build failed
    cd ..
    pause
    exit /b 1
)
cd ..

echo.
echo ===== SETUP COMPLETE =====
echo.
echo Your app is ready!
echo.
echo Next: Deploy to cloud
echo.
pause

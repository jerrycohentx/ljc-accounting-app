@echo off
REM Pull latest code, rebuild UI, then launch (double-click after updates)
cd /d "%~dp0"
echo.
echo ======================================================
echo  LJC Accounting — Update and Start
echo ======================================================
echo.

git pull origin master
if errorlevel 1 (
    echo.
    echo git pull failed — check your internet / git install.
    pause
    exit /b 1
)

echo.
echo Building frontend...
call npm run build:frontend
if errorlevel 1 (
    echo.
    echo Build failed — try START-APP-Visible.bat to see errors.
    pause
    exit /b 1
)

echo.
echo Starting app...
wscript //nologo "%~dp0Launch_LJC_AI_Accounting.vbs"
exit /b 0

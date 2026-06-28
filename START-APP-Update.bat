@echo off
REM Same as UPDATE-AND-START.bat — pull, rebuild UI, launch (sits next to START-APP.bat)
cd /d "%~dp0"
echo.
echo ======================================================
echo  LJC Accounting — Update and Start
echo ======================================================
echo.

git pull origin master
if errorlevel 1 (
    echo.
    echo git pull failed. If git is not installed, download the latest zip from GitHub
    echo or use START-APP-Visible.bat after copying new files.
    pause
    exit /b 1
)

echo.
echo Building frontend...
call npm run build:frontend
if errorlevel 1 (
    echo Build failed — run START-APP-Visible.bat to see errors.
    pause
    exit /b 1
)

echo.
echo Starting app...
wscript //nologo "%~dp0Launch_LJC_AI_Accounting.vbs"
exit /b 0

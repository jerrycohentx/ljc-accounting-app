@echo off
echo.
echo Installing Git for Windows...
echo.

REM Download Git installer
echo Downloading Git installer...
bitsadmin /transfer gitdownload /download /priority foreground https://github.com/git-for-windows/git/releases/download/v2.42.0.windows.1/Git-2.42.0-64-bit.exe "%TEMP%\GitInstaller.exe"

if %errorlevel% neq 0 (
    echo Download failed. Please visit https://git-scm.com/download/win and install manually.
    pause
    exit /b 1
)

REM Run installer
echo.
echo Running Git installer...
"%TEMP%\GitInstaller.exe"

REM Clean up
del "%TEMP%\GitInstaller.exe"

echo.
echo ===== GIT INSTALLED =====
echo.
echo Now run: DEPLOY_TO_CLOUD.bat
echo.
pause

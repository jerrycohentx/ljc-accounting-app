@echo off
REM Install Node.js - Simplest Version
setlocal enabledelayedexpansion

echo.
echo ======================================================
echo  Node.js Installation
echo ======================================================
echo.

REM Check if already installed
where node >nul 2>&1
if %errorlevel% equ 0 (
    echo Node.js is already installed:
    node -v
    pause
    exit /b 0
)

REM Download using bitsadmin (built-in Windows tool)
echo Downloading Node.js LTS...
bitsadmin /transfer NodeDownload /download /resume "https://nodejs.org/dist/v24.16.0/node-v24.16.0-x64.msi" "%TEMP%\node-installer.msi"

if not exist "%TEMP%\node-installer.msi" (
    echo.
    echo ERROR: Could not download Node.js
    echo Please download manually and run the installer:
    echo https://nodejs.org
    echo.
    pause
    exit /b 1
)

echo.
echo Installing Node.js...
msiexec /i "%TEMP%\node-installer.msi" /quiet /norestart

echo Waiting for installation...
timeout /t 15

echo.
echo Installation complete!
echo.
node -v
npm -v
echo.
echo Ready to start your app. Run: START-APP.bat
echo.
pause

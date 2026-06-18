@echo off
REM Install Node.js - Fixed Version
setlocal enabledelayedexpansion

echo.
echo ======================================================
echo  Node.js Installation
echo ======================================================
echo.

REM Check if Node.js is already installed
where node >nul 2>&1
if %errorlevel% equ 0 (
    echo Node.js is already installed:
    node -v
    echo.
    echo Ready to start your app. Run: START-APP.bat
    pause
    exit /b 0
)

REM Node.js not found - download and install
echo Node.js not found. Installing now...
echo.
echo Downloading Node.js LTS (this takes 1-2 minutes)...

REM Download using PowerShell
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference = 'SilentlyContinue'; ^
  Invoke-WebRequest -Uri 'https://nodejs.org/dist/v24.16.0/node-v24.16.0-x64.msi' ^
  -OutFile '%TEMP%\node-installer.msi' -UseBasicParsing" 2>nul

if not exist "%TEMP%\node-installer.msi" (
    echo.
    echo ERROR: Download failed
    echo.
    echo Try downloading manually from: https://nodejs.org
    echo Choose: Windows Installer (LTS)
    echo.
    pause
    exit /b 1
)

echo Download complete. Installing...
echo.

REM Run installer
msiexec /i "%TEMP%\node-installer.msi" /quiet /norestart

echo Waiting for installation to complete...
timeout /t 20 /nobreak

REM Verify
where node >nul 2>&1
if %errorlevel% equ 0 (
    echo.
    echo ======================================================
    echo  SUCCESS! Node.js installed
    echo ======================================================
    echo.
    node -v
    npm -v
    echo.
    echo You can now run: START-APP.bat
    echo.
) else (
    echo.
    echo Installation may have failed. Please verify manually.
    echo.
)

pause

@echo off
REM Install Node.js - One Click
REM This script downloads and installs Node.js automatically

echo.
echo ======================================================
echo  Node.js Installation Script
echo ======================================================
echo.

REM Check if Node.js is already installed
node -v >nul 2>&1
if errorlevel 0 (
    echo Node.js is already installed:
    node -v
    echo.
    echo Ready to start your app. Run: START-APP.bat
    pause
    exit /b 0
)

REM Create temp directory if needed
if not exist "%TEMP%\nodejs-install" mkdir "%TEMP%\nodejs-install"

REM Download Node.js using PowerShell
echo Downloading Node.js (this may take 1-2 minutes)...
powershell -Command "(New-Object System.Net.ServicePointManager).SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12; [Net.ServicePointManager]::SecurityProtocol = 'Tls12'; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v24.16.0/node-v24.16.0-x64.msi' -OutFile '%TEMP%\nodejs-install\node-installer.msi' -UseBasicParsing" 2>nul

REM Check if download succeeded
if not exist "%TEMP%\nodejs-install\node-installer.msi" (
    echo.
    echo ERROR: Could not download Node.js
    echo.
    echo Please download manually from: https://nodejs.org
    echo Choose: Windows Installer (LTS version)
    echo Then run this script again
    echo.
    pause
    exit /b 1
)

echo Download complete. Installing Node.js...
echo.

REM Run the installer silently
msiexec /i "%TEMP%\nodejs-install\node-installer.msi" /quiet /norestart

REM Wait for installer to complete
timeout /t 30 /nobreak

REM Verify installation
node -v >nul 2>&1
if errorlevel 1 (
    echo.
    echo ERROR: Node.js installation may have failed
    echo Please check the installation manually
    echo.
    pause
    exit /b 1
)

echo.
echo ======================================================
echo  Node.js Installation Complete!
echo ======================================================
echo.
echo Installed version:
node -v
echo.
echo npm version:
npm -v
echo.
echo You can now run your app:
echo   Double-click: START-APP.bat
echo.
pause

@echo off
REM Double-click this — creates desktop shortcut to the website (shows this window)
setlocal
cd /d "%~dp0"

set "APP_URL=https://ljc-accounting-app.onrender.com"
set "DESKTOP=%USERPROFILE%\Desktop"
set "NAME=Cohen Entities AI Accounting"

echo.
echo ======================================================
echo   Creating web shortcut on your desktop
echo ======================================================
echo.
echo   %APP_URL%
echo.

if not exist "%DESKTOP%" (
    echo ERROR: Desktop folder not found: %DESKTOP%
    pause
    exit /b 1
)

del /f /q "%DESKTOP%\LJC AI Accounting.lnk" 2>nul
del /f /q "%DESKTOP%\LJC Accounting.lnk" 2>nul
del /f /q "%DESKTOP%\Cohen Entities AI Accounting.lnk" 2>nul
del /f /q "%DESKTOP%\LJC AI Accounting.url" 2>nul
del /f /q "%DESKTOP%\LJC Accounting.url" 2>nul
del /f /q "%DESKTOP%\Cohen Entities AI Accounting.url" 2>nul

(
echo [InternetShortcut]
echo URL=%APP_URL%
echo IconIndex=0
) > "%DESKTOP%\%NAME%.url"

if not exist "%DESKTOP%\%NAME%.url" (
    echo ERROR: Could not create shortcut file.
    pause
    exit /b 1
)

echo   DONE — new icon on your desktop:
echo   "%NAME%"
echo.
echo   Next: unpin the OLD taskbar icon, then right-click the
echo   NEW desktop icon ^-^> Pin to taskbar
echo.
echo   Opening the website now...
echo.

start "" "%APP_URL%"

pause
exit /b 0

@echo off
REM One-time / background setup — no server start, no pause
cd /d "%~dp0"
setlocal enabledelayedexpansion

node -v >nul 2>&1
if errorlevel 1 exit /b 1

if not exist "db\accounting.db" (
    python3 scripts\setup-production.py >nul 2>&1
)

if not exist "node_modules" (
    call npm install >nul 2>&1
)
if not exist "frontend\node_modules" (
    cd frontend
    call npm install >nul 2>&1
    cd ..
)

if not exist "frontend\dist\index.html" (
    goto :buildfrontend
)

REM Rebuild when React source is newer than the last build (after git pull)
powershell -NoProfile -Command "$d=Get-Item 'frontend\dist\index.html'; $src=Get-ChildItem -Recurse 'frontend\src' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if ($null -eq $src -or $src.LastWriteTime -gt $d.LastWriteTime) { exit 1 } else { exit 0 }" >nul 2>&1
if errorlevel 1 goto :buildfrontend
goto :skipbuild

:buildfrontend
cd frontend
call npm run build >nul 2>&1
cd ..

:skipbuild

exit /b 0

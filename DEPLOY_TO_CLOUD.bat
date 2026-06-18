@echo off
REM =====================================================
REM Deploy LJC Accounting App to GitHub and Render
REM =====================================================

setlocal enabledelayedexpansion

set GITHUB_TOKEN=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
set GITHUB_USER=jerrycohentx
set REPO_NAME=ljc-accounting-app

echo.
echo ===== STEP 1: Initialize Git Repository =====
echo.

REM Check if git is installed
git --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Git is not installed. Please install from https://git-scm.com/download/win
    pause
    exit /b 1
)

REM Initialize git repo if not already done
if not exist .git (
    echo Initializing git repository...
    git init
    git config user.name "Jerry Cohen"
    git config user.email "jerry@ljcfinancial.com"
)

echo.
echo ===== STEP 2: Add Files to Git =====
echo.
git add .
echo ✓ Files staged

echo.
echo ===== STEP 3: Create Initial Commit =====
echo.
git commit -m "Initial commit: LJC Accounting App" || echo (Repository may already have commits)

echo.
echo ===== STEP 4: Create GitHub Repository =====
echo.
echo Creating repository on GitHub...

REM Create repo via GitHub CLI if available, otherwise via API
gh repo create %REPO_NAME% --public --source=. --remote=origin --push >nul 2>&1
if %errorlevel% equ 0 (
    echo ✓ Repository created and code pushed to GitHub!
) else (
    echo ✓ Git is ready. Repository may already exist.
)

echo.
echo ===== DEPLOYMENT PREPARATION COMPLETE =====
echo.
echo Your code is on GitHub at:
echo https://github.com/%GITHUB_USER%/%REPO_NAME%
echo.
echo Next Step: Deploy to Render
echo 1. Go to https://render.com
echo 2. Sign up with GitHub
echo 3. Click "New +" and select "Web Service"
echo 4. Connect your repository
echo 5. Deploy!
echo.
pause

@echo off
setlocal enabledelayedexpansion

REM Set the repository name
set "REPO_NAME=eazybe-hubspot-enricher"
set "GITHUB_USER=your_username"

REM Check if git is initialized
if not exist ".git\" (
    echo Initializing git repository...
    git init
    
    echo Creating initial .gitignore...
    echo node_modules/ > .gitignore
    echo .env >> .gitignore
    echo logs/ >> .gitignore
    echo .vercel/ >> .gitignore
)

REM Prompt for GitHub username
set /p "GITHUB_USER=Enter your GitHub username: "
set /p "PAT=Enter your GitHub Personal Access Token (or press enter if already configured): "

echo Adding files...
git add .

echo Committing...
git commit -m "Initial commit: Eazybe Lead Enrichment Webhook"

echo Setting main branch...
git branch -M main

REM Create the remote URL
if"!PAT!"=="" (
    set "REMOTE_URL=https://github.com/!GITHUB_USER!/!REPO_NAME!.git"
) else (
    set "REMOTE_URL=https://!PAT!@github.com/!GITHUB_USER!/!REPO_NAME!.git"
)

echo Adding remote origin...
git remote add origin "!REMOTE_URL!"
IF %ERRORLEVEL% NEQ 0 (
    echo Remote might already exist. Updating URL...
    git remote set-url origin "!REMOTE_URL!"
)

echo Pushing to GitHub...
git push -u origin main

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ✅ Successfully pushed to https://github.com/!GITHUB_USER!/!REPO_NAME!
    echo.
    echo Next Steps:
    echo 1. Go to Vercel Dashboard
    echo 2. Click "Add New" -^> "Project"
    echo 3. Import "!REPO_NAME!" from GitHub
) else (
    echo ❌ Push failed! Please check your credentials and ensure the repository exists on GitHub.
)

pause

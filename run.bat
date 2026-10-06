@echo off
setlocal
cd /d "%~dp0"

where node.exe >nul 2>&1
if errorlevel 1 (
    echo Node.js is required. Install it from https://nodejs.org/ and try again.
    pause
    exit /b 1
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo npm was not found. Reinstall Node.js and try again.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo Installing dependencies...
    call npm.cmd ci
    if errorlevel 1 (
        echo Dependency installation failed.
        pause
        exit /b 1
    )
)

echo Starting Citysignal NYC...
echo Open http://localhost:5173 in your browser.
echo Press Ctrl+C to stop the app.
call npm.cmd run dev
if errorlevel 1 (
    echo The app stopped with an error.
    pause
    exit /b 1
)

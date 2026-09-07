@echo off
REM Double-click this file to run threads-bot-filter. No terminal knowledge
REM needed - it checks for Node.js, installs dependencies on first run, starts
REM the local tool, and opens it in your browser automatically.
cd /d "%~dp0"

echo threads-bot-filter
echo ===================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Node.js isn't installed yet - this tool needs it to run.
    echo Opening the Node.js download page for you...
    echo After installing it, come back and double-click this file again.
    start "" "https://nodejs.org/"
    echo.
    pause
    exit /b 1
)

if not exist node_modules (
    echo First run - installing what this tool needs ^(this can take a minute^)...
    call npm install
    if errorlevel 1 (
        echo.
        echo Something went wrong installing dependencies - see the error above.
        pause
        exit /b 1
    )
    echo.
)

echo Starting threads-bot-filter in a new window...
start "threads-bot-filter (keep this open)" cmd /k node bin\cli.js

timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4173"

echo.
echo It's running! Your browser should have opened to it automatically -
echo if not, go to: http://127.0.0.1:4173
echo.
echo A new window titled "threads-bot-filter" is now running the tool -
echo leave THAT window open while you use it, and close it when you're done.
echo.
pause

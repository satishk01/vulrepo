@echo off
REM ============================================================================
REM UEM Frontend - One-time setup for Windows
REM Installs node dependencies. Run this once, then use run-frontend.bat.
REM ============================================================================

setlocal

echo.
echo [1/2] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not found on PATH.
    echo Install Node 18+ LTS from https://nodejs.org/en/download
    exit /b 1
)
node --version
npm --version

echo.
echo [2/2] Installing npm packages...
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed.
    exit /b 1
)

echo.
echo ============================================================
echo  Setup complete. Run: run-frontend.bat
echo ============================================================
endlocal

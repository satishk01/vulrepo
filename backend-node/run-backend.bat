@echo off
REM ============================================================================
REM UEM Node.js Backend - Start the Express server on Windows
REM ============================================================================

setlocal

if not exist node_modules (
    echo ERROR: node_modules not found. Run setup-windows.bat first.
    exit /b 1
)

if not exist .env (
    echo ERROR: .env not found. Copy .env.example to .env and fill in your AWS keys.
    exit /b 1
)

echo.
echo Starting UEM (Node.js) backend on http://localhost:8000
echo Health endpoint  http://localhost:8000/health
echo.
echo Press Ctrl+C to stop.
echo.

call npm start

endlocal

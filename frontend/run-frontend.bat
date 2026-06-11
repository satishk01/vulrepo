@echo off
REM ============================================================================
REM UEM Frontend - Start the Vite dev server on Windows
REM Serves at http://localhost:3000 and proxies /api/* to localhost:8000.
REM ============================================================================

setlocal

if not exist node_modules (
    echo ERROR: node_modules not found. Run setup-windows.bat first.
    exit /b 1
)

echo.
echo Starting UEM frontend on http://localhost:3000
echo (the backend must already be running on http://localhost:8000)
echo.
echo Press Ctrl+C to stop.
echo.

call npm run dev

endlocal

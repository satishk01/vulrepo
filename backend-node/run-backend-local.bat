@echo off
REM ============================================================================
REM run-backend-local.bat - serve dashboard data from local CLI output (Windows)
REM ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

if not exist node_modules ( call npm install --no-audit --no-fund )

if exist .env (
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        set "line=%%A"
        if not "!line:~0,1!"=="#" if not "%%A"=="" set "%%A=%%B"
    )
)

set "STORAGE_BACKEND=local"
if "%LOCAL_STORAGE_DIR%"=="" set "LOCAL_STORAGE_DIR=.\uem-data"
if "%HOST%"=="" set "HOST=127.0.0.1"
if "%PORT%"=="" set "PORT=8000"

echo Serving local scans from: %LOCAL_STORAGE_DIR%
echo Backend: http://%HOST%:%PORT%
call npm start
endlocal

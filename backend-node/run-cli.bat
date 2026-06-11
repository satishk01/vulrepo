@echo off
REM ============================================================================
REM run-cli.bat - analyse a folder of scanner/pentest files offline (Windows)
REM
REM Usage:
REM   run-cli.bat <input-folder-or-file> [extra args...]
REM
REM Examples:
REM   run-cli.bat .\reports
REM   run-cli.bat .\reports --model anthropic.claude-opus-4-5 --batch-size 6
REM
REM Loads .env automatically for AWS keys + LOCAL_STORAGE_DIR.
REM ============================================================================
setlocal enabledelayedexpansion

cd /d "%~dp0"

if not exist node_modules (
    echo Installing dependencies ^(first run^)...
    call npm install --no-audit --no-fund
)

REM --- Load .env (KEY=VALUE lines, ignore comments/blanks) ---
if exist .env (
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        set "line=%%A"
        if not "!line:~0,1!"=="#" if not "%%A"=="" set "%%A=%%B"
    )
)

if "%~1"=="" (
    echo Usage: run-cli.bat ^<input-folder-or-file^> [extra args...]
    exit /b 2
)

set "INPUT=%~1"
shift

if "%LOCAL_STORAGE_DIR%"=="" set "LOCAL_STORAGE_DIR=.\uem-data"

REM Re-collect remaining args
set "REST="
:collect
if "%~1"=="" goto run
set "REST=!REST! %1"
shift
goto collect

:run
node src/cli/analyze-cli.js --input "%INPUT%" --storage-dir "%LOCAL_STORAGE_DIR%" %REST%

endlocal

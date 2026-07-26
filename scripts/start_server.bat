@echo off
cd /d "%~dp0"
set MOCK_PAYMENTS_ENABLED=true
set PYTHON=%~dp0venv\Scripts\python.exe

echo [%date% %time%] Starting... >> "%~dp0startup.log"

if not exist "%PYTHON%" (
    echo [%date% %time%] Python not found: %PYTHON% >> "%~dp0startup.log"
    exit /b 1
)

"%PYTHON%" -m uvicorn main:app --host 127.0.0.1 --port 8000 >> "%~dp0backend-dev.log" 2>> "%~dp0backend-dev.err.log"

echo [%date% %time%] Stopped >> "%~dp0startup.log"
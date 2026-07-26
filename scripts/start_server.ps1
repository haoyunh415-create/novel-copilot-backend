$env:MOCK_PAYMENTS_ENABLED = "true"
Set-Location "C:\Users\32639\novel-copilot-backend"
& "C:\Users\32639\novel-copilot-backend\venv\Scripts\python.exe" -m uvicorn main:app --host 127.0.0.1 --port 8000

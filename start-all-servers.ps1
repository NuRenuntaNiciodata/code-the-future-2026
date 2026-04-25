# Start all servers for Windows PC
# This script starts: Vite frontend, Express backend, and WebSocket server

Write-Host "Starting Siemens WebApp - All Servers" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green

# Check if node_modules exists
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install
}

# Start Vite frontend in a new window
Write-Host "Starting Vite frontend server..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit -Command `"npx vite --host`"" -WindowStyle Normal

# Wait a moment for Vite to start
Start-Sleep -Seconds 2

# Start Express backend in a new window
Write-Host "Starting Express backend server..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit -Command `"node backend.js`"" -WindowStyle Normal

# Wait a moment for backend to start
Start-Sleep -Seconds 2

# Start WebSocket server in a new window
Write-Host "Starting WebSocket server..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit -Command `"node server.js`"" -WindowStyle Normal

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "All servers started!" -ForegroundColor Green
Write-Host "Frontend: http://localhost:5173" -ForegroundColor Yellow
Write-Host "Backend:  http://localhost:3000" -ForegroundColor Yellow
Write-Host "WebSocket: ws://localhost:8080" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Green

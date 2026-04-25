#!/bin/bash

# Start all servers for Raspberry Pi
# This script starts: Vite frontend, Express backend, and WebSocket server

echo "Starting Siemens WebApp - All Servers"
echo "========================================"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Create a function to handle cleanup on exit
cleanup() {
    echo ""
    echo "Shutting down all servers..."
    kill $VITE_PID $BACKEND_PID $WEBSOCKET_PID 2>/dev/null
    exit 0
}

# Set trap to catch Ctrl+C
trap cleanup INT TERM

# Start Vite frontend
echo "Starting Vite frontend server..."
npx vite --host > /tmp/vite.log 2>&1 &
VITE_PID=$!

# Wait a moment
sleep 2

# Start Express backend
echo "Starting Express backend server..."
node backend.js > /tmp/backend.log 2>&1 &
BACKEND_PID=$!

# Wait a moment
sleep 2

# Start WebSocket server
echo "Starting WebSocket server..."
node server.js > /tmp/websocket.log 2>&1 &
WEBSOCKET_PID=$!

echo ""
echo "========================================"
echo "All servers started!"
echo "Frontend: http://localhost:5173"
echo "Backend:  http://localhost:3000"
echo "WebSocket: ws://localhost:8080"
echo "========================================"
echo ""
echo "View logs with:"
echo "  tail -f /tmp/vite.log"
echo "  tail -f /tmp/backend.log"
echo "  tail -f /tmp/websocket.log"
echo ""
echo "Press Ctrl+C to stop all servers"
echo ""

# Wait for all background processes
wait

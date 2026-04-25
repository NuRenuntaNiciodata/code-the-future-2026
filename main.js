const { app, BrowserWindow, screen } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const { setupPopupSystem } = require("./popup");

let mainWindow;
let backendProcess;

function startBackend() {
  const backendPath = path.join(__dirname, "backend.js");

  backendProcess = spawn(process.execPath, [backendPath], {
    env: { ...process.env, NODE_ENV: "production" },
  });

  backendProcess.stdout.on("data", (data) => {
    console.log("[backend]", data.toString());
  });

  backendProcess.stderr.on("data", (data) => {
    console.error("[backend error]", data.toString());
  });

  backendProcess.on("exit", (code) => {
    console.log("[backend] exited with code", code);
  });
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  const windowWidth = 420;
  const windowHeight = 520;
  const margin = 20;

  const x = workArea.x + workArea.width - windowWidth - margin;
  const y = workArea.y + margin;

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x,
    y,
    resizable: true,
    autoHideMenuBar: true,
    maximizable: false,
    minimizable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "dist", "index.html"), {
    query: { mode: "app" },
  });

  setupPopupSystem(mainWindow);
}

app.whenReady().then(() => {
  startBackend();        
  createWindow();
});

app.on("window-all-closed", () => {
  if (backendProcess) backendProcess.kill(); 
  if (process.platform !== "darwin") app.quit();
});
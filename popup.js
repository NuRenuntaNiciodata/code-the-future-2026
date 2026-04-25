// popup.js
const express = require("express");
const { ipcMain } = require("electron");

function setupPopupSystem(mainWindow) {
  const app = express();
  app.use(express.json());

  app.post("/api/posture/closeness", (req, res) => {
    const payload = req.body;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("camera-posture-update", payload);
    }

    res.json({ ok: true });
  });

  app.listen(3099, () => {
    console.log("Popup posture server running on http://localhost:3099");
  });

  ipcMain.on("bring-alert-to-front", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    mainWindow.setAlwaysOnTop(true);
    mainWindow.show();
    mainWindow.focus();

    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(false);
      }
    }, 5000);
  });
}

module.exports = { setupPopupSystem };
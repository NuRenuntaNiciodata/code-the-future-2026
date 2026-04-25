const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  bringAlertToFront: () => ipcRenderer.send("bring-alert-to-front"),
  onCameraPostureUpdate: (callback) => {
    ipcRenderer.on("camera-posture-update", (_event, data) => callback(data));
  },
});
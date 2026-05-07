// Preload — exposes a narrow, typed-looking API to the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pupa", {
  session: {
    load: (sessionId) => ipcRenderer.invoke("session:load", sessionId),
    save: (data) => ipcRenderer.invoke("session:save", data),
    list: () => ipcRenderer.invoke("session:list"),
    create: (partial) => ipcRenderer.invoke("session:create", partial),
    delete: (sessionId) => ipcRenderer.invoke("session:delete", sessionId),
  },
  dialog: {
    openImage: () => ipcRenderer.invoke("dialog:openImage"),
    openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
  },
  file: {
    readImageDataUrl: (path) => ipcRenderer.invoke("file:readImageDataUrl", path),
    listDemoScans: () => ipcRenderer.invoke("file:listDemoScans"),
  },
  cnn: {
    detect: (imagePath) => ipcRenderer.invoke("cnn:detect", imagePath),
    info: () => ipcRenderer.invoke("cnn:info"),
  },
  scanner: {
    listDevices: () => ipcRenderer.invoke("scanner:listDevices"),
    scan: (params) => ipcRenderer.invoke("scanner:scan", params),
  },
});

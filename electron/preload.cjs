const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("rosterDesktop", {
  chooseFolder: () => ipcRenderer.invoke("roster:choose-folder"),
  openLogs: () => ipcRenderer.invoke("roster:open-logs"),
  copyDiagnostics: () => ipcRenderer.invoke("roster:copy-diagnostics"),
  onOpenSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("roster:open-settings", listener);
    return () => ipcRenderer.removeListener("roster:open-settings", listener);
  },
});

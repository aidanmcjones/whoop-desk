const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whoop', {
  getDashboard: () => ipcRenderer.invoke('whoop:getDashboard'),
  refresh: () => ipcRenderer.invoke('whoop:refresh'),
});

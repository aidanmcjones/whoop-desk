const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whoop', {
  getDashboard: () => ipcRenderer.invoke('whoop:getDashboard'),
  refresh: () => ipcRenderer.invoke('whoop:refresh'),

  getHistory: (opts) => ipcRenderer.invoke('whoop:getHistory', opts),
  getBackfillStatus: () => ipcRenderer.invoke('whoop:getBackfillStatus'),
  getHeartRate: () => ipcRenderer.invoke('whoop:getHeartRate'),

  getAnalytics: (opts) => ipcRenderer.invoke('whoop:getAnalytics', opts),

  coachStatus: () => ipcRenderer.invoke('whoop:coachStatus'),
  askCoach: (payload) => ipcRenderer.invoke('whoop:askCoach', payload),

  exportCsv: (opts) => ipcRenderer.invoke('whoop:exportCsv', opts),

  getSettings: () => ipcRenderer.invoke('whoop:getSettings'),
  setSettings: (patch) => ipcRenderer.invoke('whoop:setSettings', patch),

  onUpdated: (cb) => {
    const listener = (_event, dashboard) => cb(dashboard);
    ipcRenderer.on('whoop:updated', listener);
    return () => ipcRenderer.removeListener('whoop:updated', listener);
  },
  onBackfillProgress: (cb) => {
    const listener = (_event, progress) => cb(progress);
    ipcRenderer.on('whoop:backfillProgress', listener);
    return () => ipcRenderer.removeListener('whoop:backfillProgress', listener);
  },
  onHeartRate: (cb) => {
    const listener = (_event, progress) => cb(progress);
    ipcRenderer.on('whoop:heartRate', listener);
    return () => ipcRenderer.removeListener('whoop:heartRate', listener);
  },
});

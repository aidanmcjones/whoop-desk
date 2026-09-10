const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whoop', {
  getDashboard: () => ipcRenderer.invoke('whoop:getDashboard'),
  refresh: () => ipcRenderer.invoke('whoop:refresh'),

  getHistory: (opts) => ipcRenderer.invoke('whoop:getHistory', opts),
  getBackfillStatus: () => ipcRenderer.invoke('whoop:getBackfillStatus'),

  getAnalytics: (opts) => ipcRenderer.invoke('whoop:getAnalytics', opts),

  getJournal: (opts) => ipcRenderer.invoke('whoop:getJournal', opts),
  addJournalEntry: (entry) => ipcRenderer.invoke('whoop:addJournalEntry', entry),
  updateJournalEntry: (id, patch) => ipcRenderer.invoke('whoop:updateJournalEntry', id, patch),
  deleteJournalEntry: (id) => ipcRenderer.invoke('whoop:deleteJournalEntry', id),
  journalTags: () => ipcRenderer.invoke('whoop:journalTags'),

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
});

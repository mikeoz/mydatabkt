const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  signIn: () => ipcRenderer.invoke('sign-in'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s))
});

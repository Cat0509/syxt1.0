const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    startBackend: () => ipcRenderer.send('start-backend')
});

window.addEventListener('DOMContentLoaded', () => {
    console.log('Preload script loaded successfully.');
});

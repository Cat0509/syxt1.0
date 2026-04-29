const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    setupComplete: () => ipcRenderer.send('setup-complete')
});

window.addEventListener('DOMContentLoaded', () => {
    console.log('Setup wizard preload script loaded.');
});

// Ponte da janelinha de aviso de atualização — separada do preload.js
// principal pelo mesmo motivo do picker-preload.js: essa janela nunca
// carrega o site do Sinal, só o nosso próprio update.html local, escopo
// mínimo (receber a versão nova, mandar de volta a escolha).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updateAPI', {
  onInfo: (callback) => ipcRenderer.on('update-info', (_event, info) => callback(info)),
  restartNow: () => ipcRenderer.send('update:choice', true),
  later: () => ipcRenderer.send('update:choice', false)
});

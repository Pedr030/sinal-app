// Ponte da janelinha de seleção de tela/janela — separada do preload.js
// principal de propósito: essa janela nunca carrega o site do Sinal, só o
// nosso próprio picker.html local, então o escopo exposto aqui nem precisa
// ser o mesmo (superfície mínima: receber a lista de fontes, mandar de volta
// a escolha).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pickerAPI', {
  onSources: (callback) => ipcRenderer.on('sources', (_event, data) => callback(data)),
  choose: (sourceId, quality) => ipcRenderer.send('picker:choose', { sourceId, quality }),
  cancel: () => ipcRenderer.send('picker:choose', null)
});

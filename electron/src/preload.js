// Ponte segura entre o processo principal e o site carregado (contextIsolation
// ligado, nodeIntegration desligado — o site continua sendo uma página web
// normal, sem acesso a Node/filesystem). Só expõe o mínimo que o app.js
// precisa pra saber que está rodando dentro do Electron.
//
// app.js detecta isso via `window.sinalElectron` — ver a mudança em
// toggleShare() (public/app.js) que usa essa flag pra pular a captura de
// áudio via getDisplayMedia (que no Windows só ofereceria o sistema inteiro).
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('sinalElectron', {
  isElectron: true
  // Os métodos de captura de áudio isolado (addon nativo próprio,
  // electron/native/sinal-audio-loopback — já funcionando, ver HANDOFF §15.2)
  // entram aqui na integração com o main.js/IPC — ainda não plugado.
});

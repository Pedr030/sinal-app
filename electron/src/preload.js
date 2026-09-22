// Ponte segura entre o processo principal e o site carregado (contextIsolation
// ligado, nodeIntegration desligado — o site continua sendo uma página web
// normal, sem acesso a Node/filesystem). Só expõe o mínimo que o app.js
// precisa pra saber que está rodando dentro do Electron e pra receber o
// áudio isolado capturado pelo processo principal (ver HANDOFF §15.2).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sinalElectron', {
  isElectron: true,

  // Chamado pelo app.js logo depois que a tela/janela começa a ser
  // compartilhada. O processo principal já escolheu o PID certo (a partir
  // da fonte selecionada no picker.html) e já começou a capturar quando o
  // getDisplayMedia() resolveu — aqui só liga um listener pra receber os
  // pedaços de PCM conforme chegam. `buf` chega como Uint8Array (structured
  // clone não preserva a subclasse Buffer do Node).
  onAudioChunk: (callback) => {
    ipcRenderer.on('sinal:audio-chunk', (_event, buf) => callback(buf));
  },

  // Chamado pelo app.js quando o usuário para de compartilhar. Sem isso a
  // captura nativa ficaria rodando pra sempre em segundo plano na próxima
  // vez que alguém compartilhasse.
  stopIsolatedAudio: () => {
    ipcRenderer.send('sinal:audio-stop');
  }
});

// Ponte segura entre o processo principal e o site carregado (contextIsolation
// ligado, nodeIntegration desligado — o site continua sendo uma página web
// normal, sem acesso a Node/filesystem). Só expõe o mínimo que o app.js
// precisa pra saber que está rodando dentro do Electron e pra receber o
// áudio isolado capturado pelo processo principal (ver HANDOFF §15.2).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sinalElectron', {
  isElectron: true,

  // Chamado pelo app.js logo depois que a tela/janela começa a ser
  // compartilhada. O processo principal já escolheu o(s) PID(s) certo(s) (a
  // partir da fonte selecionada no picker.html) e já começou a capturar
  // quando o getDisplayMedia() resolveu — aqui só liga um listener pra
  // receber os pedaços de PCM conforme chegam. `pid` identifica de qual
  // fonte veio (no modo "compartilhar tela inteira" pode ter mais de uma
  // captura simultânea — ver HANDOFF §15.13); `buf` chega como Uint8Array
  // (structured clone não preserva a subclasse Buffer do Node).
  onAudioChunk: (callback) => {
    ipcRenderer.on('sinal:audio-chunk', (_event, { pid, buf }) => callback(pid, buf));
  },

  // Modo "compartilhar tela inteira": lista de apps detectados fazendo som
  // agora (atualiza sozinha, ver scanAudioSources em main.js). app.js usa
  // isso pra desenhar o checklist de fontes.
  onAudioSources: (callback) => {
    ipcRenderer.on('sinal:audio-sources', (_event, sources) => callback(sources));
  },

  // Avisa quando uma fonte específica parou de vez (app fechou) — pra
  // app.js limpar a fila de mixagem dela sem esperar o próximo scan.
  onAudioSourceRemoved: (callback) => {
    ipcRenderer.on('sinal:audio-source-removed', (_event, pid) => callback(pid));
  },

  // Usuário marcou/desmarcou um app no checklist de fontes.
  toggleAudioSource: (pid, exeName, enabled) => {
    ipcRenderer.send('sinal:audio-toggle-source', { pid, exeName, enabled });
  },

  // Chamado pelo app.js quando o usuário para de compartilhar. Sem isso a
  // captura nativa ficaria rodando pra sempre em segundo plano na próxima
  // vez que alguém compartilhasse — e, como cada início de compartilhamento
  // registra listeners novos via onAudioChunk/onAudioSources/
  // onAudioSourceRemoved (sem isso aqui, eles se acumulariam a cada ciclo de
  // compartilhar/parar), remove todos antes de avisar o processo principal
  // pra parar a captura nativa.
  stopIsolatedAudio: () => {
    ipcRenderer.removeAllListeners('sinal:audio-chunk');
    ipcRenderer.removeAllListeners('sinal:audio-sources');
    ipcRenderer.removeAllListeners('sinal:audio-source-removed');
    ipcRenderer.send('sinal:audio-stop');
  }
});

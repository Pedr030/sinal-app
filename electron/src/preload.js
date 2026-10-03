// Ponte segura entre o processo principal e o site carregado (contextIsolation
// ligado, nodeIntegration desligado — o site continua sendo uma página web
// normal, sem acesso a Node/filesystem). Só expõe o mínimo que o app.js
// precisa pra saber que está rodando dentro do Electron e pra receber o
// áudio isolado capturado pelo processo principal (ver HANDOFF §15.2).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sinalElectron', {
  isElectron: true,

  // Versão do INSTALADOR (electron/package.json), não a do site
  // (APP_VERSION em app.js) — pro rodapé mostrar algo que combine com "isso
  // é um app de verdade", não o número de versão do deploy do site.
  // sendSync porque precisa estar pronto antes da página rodar.
  appVersion: ipcRenderer.sendSync('sinal:get-app-version'),

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
  },

  // Atalho global (padrão Ctrl+Alt+S, configurável — ver settings abaixo,
  // registrado em main.js) — dispara mesmo com a janela minimizada/sem
  // foco, pra compartilhar/parar sem precisar alt-tab.
  onToggleShareShortcut: (callback) => {
    ipcRenderer.on('sinal:toggle-share-shortcut', () => callback());
  },

  // Aba de configurações (atalho global) — settings ficam num JSON próprio
  // do app, não no localStorage do site (ver comentário em main.js/
  // SETTINGS_PATH sobre o porquê).
  getSettings: () => ipcRenderer.invoke('sinal:get-settings'),
  setSettings: (partial) => ipcRenderer.invoke('sinal:set-settings', partial),

  // Chamado logo antes de toggleShare() quando o atalho disparou começando
  // um compartilhamento com "tela inteira direto" ligado — main.js pula o
  // seletor nessa próxima chamada de getDisplayMedia.
  requestQuickShare: () => ipcRenderer.send('sinal:request-quick-share'),

  // Atualizações (v0.3.11+) — o site avisa se está numa sala (main.js espera
  // sair dela pra perguntar se reinicia) e mostra o status na seção
  // "Atualizações" das configurações. Site antigo não chama nada disso.
  // roomCode: pra recuperação depois de uma queda voltar pra mesma sala.
  setInRoom: (inRoom, roomCode) => ipcRenderer.send('sinal:set-in-room', !!inRoom, typeof roomCode === 'string' ? roomCode : undefined),
  // Registro do app (v0.3.13+): o site anota eventos (início/fim de
  // transmissão…) e o "Enviar relatório" lê o final do arquivo.
  log: (message) => ipcRenderer.send('sinal:log', String(message)),
  getLogTail: () => ipcRenderer.invoke('sinal:get-log-tail'),
  getUpdateState: () => ipcRenderer.invoke('sinal:get-update-state'),
  checkForUpdates: () => ipcRenderer.invoke('sinal:check-for-updates'),
  installUpdate: () => ipcRenderer.send('sinal:install-update'),
  onUpdateState: (callback) => {
    ipcRenderer.on('sinal:update-state', (_event, state) => callback(state));
  },
  // Tela de "sem conexão" (offline.html): botão "Tentar agora" e volta da rede.
  retryConnection: () => ipcRenderer.send('sinal:retry-connection'),
  onOfflineNextRetry: (callback) => {
    ipcRenderer.on('sinal:offline-next-retry', (_event, seconds) => callback(seconds));
  },

  // Item "Procurar atualização" da bandeja abre as configurações nessa seção.
  onOpenSettings: (callback) => {
    ipcRenderer.on('sinal:open-settings', (_event, section) => callback(section));
  }
});

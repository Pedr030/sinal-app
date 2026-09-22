// Processo principal do Electron. Responsabilidades:
//  1. Abrir uma janela carregando o MESMO site de produção (nada duplicado —
//     a UI inteira do Sinal continua vivendo em public/, só ganha uma casca
//     nativa por cima). Ver HANDOFF.md, seção Electron.
//  2. Minimizar pra bandeja em vez de fechar (segundo plano de verdade —
//     motivo nº1 de ter isso, ver auditoria Parte 5).
//  3. Registrar setDisplayMediaRequestHandler — sem isso, o
//     getDisplayMedia() que o LiveKit chama por baixo do setScreenShareEnabled
//     lança "DOMException: Not supported" dentro do Electron (bug documentado).
//     Com o handler registrado, o app.js NÃO precisa mudar nada na chamada de
//     vídeo — só a main precisa saber resolver o pedido.
//  4. No Windows não existe seletor nativo pro Electron (useSystemPicker só
//     funciona no macOS 15+), então a gente mostra nosso próprio seletor
//     (picker.html) com os thumbnails do desktopCapturer.
const { app, BrowserWindow, Tray, Menu, session, desktopCapturer, ipcMain, nativeImage, dialog } = require('electron');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');

// URL de produção real — mesma que https://sinal-app-stream.vercel.app serve
// pro navegador. Ver README/HANDOFF pra histórico de migração de domínio.
const SINAL_URL = 'https://sinal-app-stream.vercel.app';

// Addon nativo de áudio isolado por processo (ver HANDOFF §15.2) — carregado
// com try/catch de propósito: se o binário não existir (plataforma errada,
// build não rodou) ou falhar por qualquer motivo, o app inteiro não pode
// cair por causa disso — só significa que a sala roda sem áudio isolado,
// igual sempre foi.
//
// Sempre a build "release" (`cargo build --release` na pasta do addon), não
// "debug" — mesmo em desenvolvimento: é o artefato que também vai pro
// instalador (ver "files"/"asarUnpack" em package.json), então testar contra
// ele em dev já testa o caminho real, em vez de mudar de binário entre um
// ambiente e outro.
let audioAddon = null;
try{
  audioAddon = require('../native/sinal-audio-loopback/target/release/sinal_audio_loopback.node');
}catch(e){
  console.error('[sinal] addon de áudio isolado não carregou (sala funciona sem isso):', e.message);
}

let mainWindow = null;
let tray = null;
let pickerWindow = null;
let isQuitting = false;
let audioLoopback = null; // instância ativa do AudioLoopback nativo, se houver

function createMainWindow(){
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Sinal',
    icon: path.join(__dirname, '../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadURL(SINAL_URL);

  // Fechar a janela só minimiza pra bandeja — é o motivo nº1 de existir essa
  // versão desktop (background de verdade, ver auditoria Parte 5). Só fecha
  // de fato quando alguém escolhe "Sair" no menu da bandeja.
  mainWindow.on('close', (event) => {
    if(isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function createTray(){
  const icon = nativeImage.createFromPath(path.join(__dirname, '../build/icon.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Sinal');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Sinal', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Sair', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
}

// Mostra o seletor de tela/janela numa janelinha própria (não dá pra usar
// window.prompt/confirm aqui — precisa dos thumbnails de verdade). Devolve o
// source escolhido (ou null se cancelado) pra quem chamou.
function showSourcePicker(sources){
  return new Promise((resolve) => {
    pickerWindow = new BrowserWindow({
      width: 720,
      height: 480,
      parent: mainWindow,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Escolha o que compartilhar',
      webPreferences: {
        preload: path.join(__dirname, 'picker-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    pickerWindow.setMenuBarVisibility(false);
    pickerWindow.loadFile(path.join(__dirname, 'picker.html'));

    let settled = false;
    const finish = (result) => {
      if(settled) return;
      settled = true;
      resolve(result);
      if(pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
      pickerWindow = null;
    };

    pickerWindow.webContents.once('did-finish-load', () => {
      // Manda os metadados serializáveis (thumbnail vira data URL) — não dá
      // pra mandar o objeto do desktopCapturer cru por IPC.
      const serializable = sources.map((s) => ({
        id: s.id,
        name: s.name,
        thumbnailDataUrl: s.thumbnail.toDataURL(),
        isScreen: s.id.startsWith('screen:')
      }));
      pickerWindow.webContents.send('sources', serializable);
    });

    ipcMain.once('picker:choose', (event, sourceId) => {
      const chosen = sources.find((s) => s.id === sourceId) || null;
      finish(chosen);
    });
    pickerWindow.on('closed', () => finish(null)); // fechou sem escolher = cancelou
  });
}

// A partir da fonte escolhida no seletor, decide COMO isolar o áudio:
//  - compartilhando uma janela específica -> modo "incluir", só o processo
//    dono daquela janela (descobre o PID a partir do HWND embutido no id do
//    desktopCapturer, formato "window:<hwnd>:0").
//  - compartilhando a tela inteira -> modo "excluir", sempre o Discord (é o
//    caso que resolve o eco/vazamento da call de voz).
// Devolve null se não der pra determinar um alvo (ex: Discord não tá
// rodando ao compartilhar tela inteira — nada pra isolar, segue sem áudio
// isolado mesmo, não é erro).
function determineAudioTarget(chosen){
  if(!audioAddon) return null;
  if(chosen.id.startsWith('screen:')){
    const pid = audioAddon.findDiscordRootPid();
    return pid == null ? null : { pid, exclude: true };
  }
  if(chosen.id.startsWith('window:')){
    const hwnd = Number(chosen.id.split(':')[1]);
    const pid = audioAddon.getWindowProcessId(hwnd);
    return pid == null ? null : { pid, exclude: false };
  }
  return null;
}

function stopIsolatedAudio(){
  if(audioLoopback){
    try{ audioLoopback.stop(); }catch(e){ console.error('[sinal-audio] stop() falhou:', e); }
    audioLoopback = null;
  }
}

function startIsolatedAudio(target){
  stopIsolatedAudio(); // nunca duas capturas ao mesmo tempo
  audioLoopback = new audioAddon.AudioLoopback();
  try{
    audioLoopback.start(target.pid, target.exclude, (err, buf) => {
      if(err){ console.error('[sinal-audio] erro no callback de captura:', err); return; }
      if(mainWindow && !mainWindow.isDestroyed()){
        mainWindow.webContents.send('sinal:audio-chunk', buf);
      }
    });
    console.log(`[sinal-audio] captura iniciada — pid=${target.pid} exclude=${target.exclude}`);
  }catch(e){
    // Não trava o compartilhamento por causa disso — a tela já está sendo
    // compartilhada nesse ponto, só fica sem o áudio isolado.
    console.error('[sinal-audio] falha ao iniciar captura, seguindo sem áudio isolado:', e);
    audioLoopback = null;
  }
}

// Renderer avisa quando parou de compartilhar (ver public/app.js toggleShare)
// — sem isso a captura nativa ficaria rodando pra sempre em segundo plano.
ipcMain.on('sinal:audio-stop', stopIsolatedAudio);

// Auto-update via GitHub Releases (tag "desktop-vX.Y.Z", ver build.publish em
// package.json). Só funciona em build empacotado — em dev não existe
// app-update.yml e o electron-updater lançaria erro à toa. Baixa sozinho em
// segundo plano, mas só reinicia com confirmação explícita da pessoa (nunca
// interrompe sem avisar, principalmente porque fechar a janela só esconde
// pra bandeja normalmente — reiniciar pra instalar é a exceção).
//
// Importante: instaladores publicados ANTES desta versão (v0.1.0, v0.2.0)
// não têm o electron-updater embutido nem o latest.yml no release — quem
// estiver nessas versões não recebe update automático, só a partir de quem
// já instalou uma versão com isso (v0.3.0+). Ver HANDOFF.md.
function setupAutoUpdater(){
  if(!app.isPackaged){
    console.log('[sinal-update] pulando auto-update (rodando em dev, não empacotado)');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.error('[sinal-update] erro checando/baixando atualização:', err);
  });
  autoUpdater.on('checking-for-update', () => {
    console.log('[sinal-update] checando por atualização...');
  });
  autoUpdater.on('update-available', (info) => {
    console.log('[sinal-update] atualização disponível:', info.version);
  });
  autoUpdater.on('update-not-available', () => {
    console.log('[sinal-update] já está na versão mais recente');
  });
  autoUpdater.on('update-downloaded', async (info) => {
    console.log('[sinal-update] atualização baixada:', info.version);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Atualização do Sinal',
      message: `Uma nova versão do Sinal (${info.version}) foi baixada.`,
      detail: 'Reiniciar agora pra instalar, ou depois na próxima vez que abrir o app.',
      buttons: ['Reiniciar agora', 'Depois'],
      defaultId: 0,
      cancelId: 1
    });
    if(response === 0){
      isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  });

  // Primeira checagem logo após abrir (com um respiro pra não competir com o
  // carregamento da janela principal), depois repete a cada 4h — o app fica
  // rodando em segundo plano por muito tempo (é o ponto da bandeja).
  setTimeout(() => autoUpdater.checkForUpdates().catch((e) => console.error('[sinal-update] falha na checagem inicial:', e)), 10_000);
  setInterval(() => autoUpdater.checkForUpdates().catch((e) => console.error('[sinal-update] falha na checagem periódica:', e)), 4 * 60 * 60 * 1000);
}

app.whenReady().then(() => {
  // Tira a barra de menu padrão do Electron (File/Edit/View/Window) — sem
  // função nenhuma nesse app (não tem "abrir arquivo", desfazer, etc.) e
  // deixa parecendo ferramenta de desenvolvedor em vez de um app de verdade.
  Menu.setApplicationMenu(null);

  // session.defaultSession só existe depois do app pronto — chamar isso no
  // nível superior do módulo (fora do whenReady) derruba o processo inteiro
  // com "Session can only be received when app is ready" antes mesmo de
  // abrir qualquer janela. Pegou essa em teste real (ver HANDOFF).
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try{
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 300, height: 200 },
        fetchWindowIcons: true
      });
      const chosen = await showSourcePicker(sources);
      if(!chosen){
        // Cancelou o seletor — devolve vazio, o getDisplayMedia() do lado do
        // app.js rejeita como se a pessoa tivesse cancelado o seletor nativo do
        // Chrome (mesmo comportamento de hoje no navegador).
        callback({});
        return;
      }
      // audio: propositalmente OMITIDO aqui. Áudio isolado por processo (ver
      // HANDOFF, seção Electron) é capturado à parte via addon nativo e
      // publicado como uma track separada — não pelo caminho do
      // getDisplayMedia, que no Windows só ofereceria loopback do sistema
      // inteiro (mesma limitação de hoje no navegador, não é uma melhora).
      const audioTarget = determineAudioTarget(chosen);
      if(audioTarget) startIsolatedAudio(audioTarget);
      callback({ video: chosen });
    }catch(e){
      console.error('[sinal] setDisplayMediaRequestHandler falhou:', e);
      callback({});
    }
  });

  createMainWindow();
  createTray();
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  // Não sai — a bandeja é quem controla o ciclo de vida (ver comentário no
  // 'close' acima). Isso só dispara se alguém destruir a janela por fora do
  // fluxo normal.
});

app.on('before-quit', () => { isQuitting = true; stopIsolatedAudio(); });

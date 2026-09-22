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
const { app, BrowserWindow, Tray, Menu, session, desktopCapturer, ipcMain, nativeImage } = require('electron');
const path = require('node:path');

// URL de produção real — mesma que https://sinal-app-stream.vercel.app serve
// pro navegador. Ver README/HANDOFF pra histórico de migração de domínio.
const SINAL_URL = 'https://sinal-app-stream.vercel.app';

let mainWindow = null;
let tray = null;
let pickerWindow = null;
let isQuitting = false;

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

app.whenReady().then(() => {
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
      callback({ video: chosen });
    }catch(e){
      console.error('[sinal] setDisplayMediaRequestHandler falhou:', e);
      callback({});
    }
  });

  createMainWindow();
  createTray();
});

app.on('window-all-closed', () => {
  // Não sai — a bandeja é quem controla o ciclo de vida (ver comentário no
  // 'close' acima). Isso só dispara se alguém destruir a janela por fora do
  // fluxo normal.
});

app.on('before-quit', () => { isQuitting = true; });

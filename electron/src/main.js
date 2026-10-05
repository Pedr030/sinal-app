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
const { app, BrowserWindow, Tray, Menu, session, desktopCapturer, ipcMain, nativeImage, globalShortcut, screen, crashReporter, shell } = require('electron');
const { buildLoginUrl, parseAuthUrl } = require('./auth-url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { autoUpdater } = require('electron-updater');

// ---- Registro (log) do app — HANDOFF §37 ----
// Antes, tudo que o app anotava ia pro console interno e sumia ao fechar —
// numa queda real (Valorant em Fluido, 2026-10-02) não sobrou nada pra
// investigar. Agora: arquivo em %AppData%/sinal-desktop/logs/sinal.log
// (gira em 1MB, guarda o anterior como sinal.old.log), com tudo que o
// processo principal escreve no console + avisos "[sinal…]" do site +
// quedas de processo do Chromium. Só sai do PC se a pessoa clicar em
// "Enviar relatório" (configurações) — e aí sem caminhos/usuário do Windows.
// Relatório de falha nativo do Electron (minidump) fica só no PC.
crashReporter.start({ uploadToServer: false });
const LOG_MAX_BYTES = 1024 * 1024;
const LOG_PATH = path.join(app.getPath('userData'), 'logs', 'sinal.log');
const LOG_OLD_PATH = LOG_PATH.replace(/\.log$/, '.old.log');
function formatLogPart(x){
  if(x instanceof Error) return x.stack || `${x.name}: ${x.message}`;
  if(typeof x === 'string') return x;
  try{ return JSON.stringify(x); }catch(e){ return String(x); }
}
function writeLog(level, parts){
  try{
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    try{ if(fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) fs.renameSync(LOG_PATH, LOG_OLD_PATH); }catch(e){ /* ainda não existe */ }
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [${level}] ${parts.map(formatLogPart).join(' ')}\n`);
  }catch(e){ /* registro nunca pode derrubar o app */ }
}
for(const [method, level] of [['log', 'info'], ['warn', 'warn'], ['error', 'error']]){
  const original = console[method].bind(console);
  console[method] = (...args) => { original(...args); writeLog(level, args); };
}
// Últimos ~60KB do registro pro "Enviar relatório" — sem o caminho da pasta
// do usuário nem o nome dele no Windows (aparecem em caminhos de arquivo).
function escapeRegExp(v){ return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function readLogTail(maxBytes = 60 * 1024){
  let text = '';
  for(const file of [LOG_OLD_PATH, LOG_PATH]){
    try{ text += fs.readFileSync(file, 'utf8'); }catch(e){ /* pode não existir */ }
  }
  if(text.length > maxBytes) text = text.slice(text.length - maxBytes);
  const home = os.homedir();
  const user = os.userInfo().username;
  if(home){
    text = text.replace(new RegExp(escapeRegExp(home), 'gi'), '~');
    text = text.replace(new RegExp(escapeRegExp(home.replace(/\\/g, '/')), 'gi'), '~');
  }
  if(user && user.length > 2) text = text.replace(new RegExp(escapeRegExp(user), 'gi'), '<usuario>');
  return text;
}

// URL de produção real — mesma que https://sinal-app-stream.vercel.app serve
// pro navegador. Ver README/HANDOFF pra histórico de migração de domínio.
// SINAL_DEV_URL só vale rodando em desenvolvimento (`npm start`, não
// empacotado) — serve pra testar a tela de sem conexão apontando pra um
// endereço local desligado/ligado. O app instalado ignora.
const SINAL_URL = (!app.isPackaged && process.env.SINAL_DEV_URL) || 'https://sinal-app-stream.vercel.app';

// ---- Segurança (HANDOFF §42): quem pode falar com o processo principal ----
// O preload expõe `window.sinalElectron` a QUALQUER página carregada na janela. Se alguma outra
// página aparecesse ali (um link, um redirecionamento, uma falha no site), ela herdaria esse
// poder — inclusive o de iniciar uma captura de tela sem seletor. Por isso: (1) a janela só
// navega pro próprio site (links externos abrem no navegador), (2) janelas novas são negadas,
// (3) permissões (câmera, captura…) só valem pro site do Sinal e (4) cada IPC confere de onde
// veio a mensagem.
const SINAL_ORIGIN = new URL(SINAL_URL).origin;
const OFFLINE_PAGE_URL = require('url').pathToFileURL(path.join(__dirname, 'offline.html')).href;

function isSinalUrl(raw){
  try{ return new URL(raw).origin === SINAL_ORIGIN; }catch(e){ return false; }
}

// Quem enviou a mensagem IPC: o site do Sinal ou a tela local de "sem conexão" (offline.html).
function fromSinal(event){
  try{
    const url = (event.senderFrame && event.senderFrame.url) || '';
    return isSinalUrl(url) || url.startsWith(OFFLINE_PAGE_URL);
  }catch(e){
    return false;
  }
}

// Só https abre no navegador — nunca file:, javascript:, protocolos do sistema etc.
const LF_TEST = String.fromCharCode(10);
function openExternalSafe(raw){
  try{
    const parsed = new URL(raw);
    if(parsed.protocol !== 'https:') return;
    // Só nos testes em modo dev (app não empacotado): anota a URL em vez de abrir o navegador.
    if(!app.isPackaged && process.env.SINAL_TEST_EXTERNAL_FILE){
      fs.appendFileSync(process.env.SINAL_TEST_EXTERNAL_FILE, parsed.toString() + LF_TEST);
      return;
    }
    shell.openExternal(parsed.toString());
  }catch(e){ /* URL inválida: ignora */ }
}

// ipcMain.on/handle que só atendem mensagens vindas do site do Sinal (ver fromSinal).
const trustedIpc = {
  on(channel, listener){
    ipcMain.on(channel, (event, ...args) => {
      if(fromSinal(event)) return listener(event, ...args);
      console.warn('[sinal] mensagem IPC recusada (origem não confiável):', channel);
      if(channel === 'sinal:get-app-version') event.returnValue = ''; // o preload espera resposta síncrona
    });
  },
  handle(channel, listener){
    ipcMain.handle(channel, (event, ...args) => {
      if(fromSinal(event)) return listener(event, ...args);
      console.warn('[sinal] mensagem IPC recusada (origem não confiável):', channel);
      return undefined;
    });
  }
};

// Protocolo customizado (sinal://) pra links de convite abrirem o app
// instalado em vez de só o navegador — ver "Abrir no app" em public/app.js
// (o botão que gera esse link) e HANDOFF.md. Formato: sinal://join?sala=CODIGO.
//
// Instância única: sem isso, clicar um link sinal:// com o app já aberto
// abriria um processo Electron NOVO do zero (nova janela, nova sessão) em
// vez de só focar o que já tá rodando — pior ainda, o áudio isolado nativo
// não teria como coexistir com duas instâncias capturando ao mesmo tempo.
// Precisa ser a primeira coisa a rodar: se perder o lock, sai na hora sem
// registrar janela/bandeja/nada.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if(!gotSingleInstanceLock){
  app.quit();
}
app.setAsDefaultProtocolClient('sinal');

function extractRoomCodeFromProtocolUrl(url){
  const m = /[?&]sala=([^&]+)/.exec(url || '');
  if(!m) return null;
  let code;
  // %-sequência malformada (ex: "%") faria o decode lançar e derrubar o processo principal —
  // qualquer página da internet pode abrir um sinal:// assim. Ignora em vez de quebrar.
  try{ code = decodeURIComponent(m[1]); }catch(e){ return null; }
  // Só o formato de uma sala de verdade (código ou nome interno de sala de servidor).
  return /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : null;
}

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

// Settings do app desktop (atalho global, inicialização, apps excluídos do
// áudio) — guardadas num JSON próprio na pasta de dados do usuário, NÃO no
// localStorage do site. Motivo: o atalho e o "abrir escondido" precisam ser
// decididos no processo principal já em app.whenReady(), antes da página
// sequer começar a carregar — o processo principal não tem como ler o
// localStorage de uma página web (isso é sandboxed pro renderer).
// De propósito só guarda o mínimo necessário pra essa feature — nada
// pessoal (nome, sala, etc — isso continua só no localStorage do site).
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = {
  shortcutEnabled: true,
  shortcut: 'Control+Alt+S',
  quickShareWholeScreen: false,
  // Os dois começam desligados — o app não se coloca pra abrir com o
  // Windows sem a pessoa pedir.
  startWithWindows: false,
  startMinimized: false,
  // Nomes de executável em minúsculo (ex: "spotify.exe"), marcados como
  // "não incluir no áudio" no checklist do modo tela inteira — lembrado
  // entre compartilhamentos, removível pela aba de configurações.
  excludedAudioApps: [],
  // Qualidade da tela ('leve' | 'nitido' | 'fluido'), escolhida no seletor
  // (picker.html) e lembrada — o atalho de "tela inteira direto" usa ela. A
  // existência desse campo é o que avisa o site (app.js) que é o seletor
  // quem escolhe a qualidade, e não mais o botão do site.
  shareQuality: 'nitido'
};
const SHARE_QUALITIES = ['leve', 'nitido', 'fluido'];

function loadSettings(){
  try{
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  }catch(e){
    return { ...DEFAULT_SETTINGS }; // primeira vez, arquivo corrompido, etc — cai no padrão
  }
}

function saveSettings(settings){
  try{
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  }catch(e){
    console.error('[sinal] não consegui salvar settings.json:', e.message);
  }
}

let appSettings = loadSettings();

// Iniciar com o Windows: entrada na chave Run do registro, com `--hidden`
// sempre nos argumentos — quem decide se abre escondido é a preferência
// startMinimized, lida em tempo de execução (assim ligar/desligar
// "minimizado" não precisa mexer no registro). Reaplicado a cada
// abertura, não só quando muda: mantém a entrada apontando pro .exe atual
// mesmo depois de reinstalar. Em dev (npm start) não mexe — registraria o
// electron.exe cru pra abrir no boot.
const HIDDEN_LAUNCH_ARG = '--hidden';

function applyLoginItemSetting(){
  if(!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!appSettings.startWithWindows, args: [HIDDEN_LAUNCH_ARG] });
}

// Setado pelo renderer (via requestQuickShare(), ver preload.js) bem antes
// de chamar toggleShare() quando: era pra COMEÇAR a compartilhar (não
// parar) via atalho E a preferência "tela inteira direto" tá ligada. Um
// tiro só — consumido (e resetado) na próxima chamada de getDisplayMedia,
// não fica "grudado" afetando um compartilhamento manual depois.
let skipPickerOnce = false;
let lastShortcutAt = 0; // quando o atalho global disparou de verdade (só o processo principal sabe)

let mainWindow = null;
let splashWindow = null;
let tray = null;
let pickerWindow = null;
let isQuitting = false;
let audioLoopback = null; // instância ativa do AudioLoopback nativo, se houver

// Tela de splash com a cara do Sinal (mesmo padrão do update.html) enquanto
// o site de produção carrega pela rede — sem isso, abrir o app mostrava uma
// janela branca/preta em branco por uma fração de segundo antes do conteúdo
// aparecer (pedido do usuário, ver HANDOFF §19 "outras ideias cogitadas").
// Não tem preload/IPC — arquivo local estático, só decorativo.
function createSplashWindow(){
  splashWindow = new BrowserWindow({
    width: 320,
    height: 200,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    backgroundColor: '#0b0c0e',
    webPreferences: { sandbox: true }
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
}

function closeSplashAndShowMain(){
  if(splashWindow && !splashWindow.isDestroyed()){
    splashWindow.close();
    splashWindow = null;
  }
  if(mainWindow && !mainWindow.isDestroyed()){
    mainWindow.show();
    mainWindow.focus();
  }
}

// ---- Sem conexão: tela própria + nova tentativa automática ----
// Espera entre tentativas dobra a cada falha (5s, 10s, 20s, 40s, depois de
// 60 em 60s) — pedido do usuário: não ficar martelando a rede quando a
// internet cai por mais tempo. "Tentar agora" e o evento `online` do Windows
// tentam na hora, sem esperar a contagem.
const OFFLINE_RETRY_FIRST_MS = 5000;
const OFFLINE_RETRY_MAX_MS = 60000;
let offlineRetryTimer = null;
let offlineRetryDelay = OFFLINE_RETRY_FIRST_MS;
let offlineTargetUrl = SINAL_URL;   // a página que falhou — volta pra ela (ex: link de convite)
let offlineAttemptRunning = false;
let offlineActive = false;
let offlineNextRetryAt = 0;

function isOfflinePageShown(){
  return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.getURL().endsWith('offline.html');
}

function sendOfflineCountdown(){
  if(!isOfflinePageShown()) return;
  const seconds = Math.max(0, Math.ceil((offlineNextRetryAt - Date.now()) / 1000));
  mainWindow.webContents.send('sinal:offline-next-retry', seconds);
}

function stopOfflineRetry(){
  clearTimeout(offlineRetryTimer);
  offlineRetryTimer = null;
  offlineActive = false;
  offlineRetryDelay = OFFLINE_RETRY_FIRST_MS;
}

function scheduleOfflineRetry({ grow = true } = {}){
  clearTimeout(offlineRetryTimer);
  const delay = offlineRetryDelay;
  offlineRetryTimer = setTimeout(() => tryReconnect(), delay);
  offlineNextRetryAt = Date.now() + delay;
  if(grow) offlineRetryDelay = Math.min(offlineRetryDelay * 2, OFFLINE_RETRY_MAX_MS);
  // A tela de sem conexão mostra "Tentando novamente em Ns".
  sendOfflineCountdown();
}

// Só navega de volta pro site quando ele RESPONDE — navegar às cegas e
// falhar de novo faria a tela piscar a cada tentativa.
async function tryReconnect({ manual = false } = {}){
  if(!offlineActive || offlineAttemptRunning || !mainWindow || mainWindow.isDestroyed()) return;
  // Saiu da tela de sem conexão por outro caminho (ex: link de convite que
  // carregou): para de tentar, sem puxar a janela de volta pra outra página.
  if(!isOfflinePageShown() && !mainWindow.webContents.isLoading()){ stopOfflineRetry(); return; }
  offlineAttemptRunning = true;
  let online = false;
  try{
    const res = await fetch(SINAL_URL, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(4000) });
    online = res.status < 500;
  }catch(e){ /* ainda sem conexão */ }
  offlineAttemptRunning = false;
  if(online){
    stopOfflineRetry();
    mainWindow.loadURL(offlineTargetUrl);
  } else {
    // Tentativa pedida na mão (botão / rede voltou) que falhou não aumenta
    // a espera da contagem automática — só reinicia a contagem atual.
    scheduleOfflineRetry({ grow: !manual });
  }
}

function showOfflinePage(failedUrl){
  offlineTargetUrl = failedUrl || SINAL_URL;
  if(!offlineActive){
    offlineActive = true;
    offlineRetryDelay = OFFLINE_RETRY_FIRST_MS;
  }
  mainWindow.loadFile(path.join(__dirname, 'offline.html'));
  // O temporizador começa já; a contagem chega na tela quando ela terminar
  // de carregar (listener de did-finish-load em createMainWindow).
  if(!offlineRetryTimer) scheduleOfflineRetry();
}

trustedIpc.on('sinal:retry-connection', () => { tryReconnect({ manual: true }); });

function createMainWindow(initialRoomCode, startHidden){
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Sinal',
    icon: path.join(__dirname, '../build/icon.png'),
    show: false, // só aparece depois que o site termina de carregar (ver abaixo)
    backgroundColor: '#0b0c0e', // se algo aparecer antes do CSS, é escuro, não branco
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const startUrl = initialRoomCode
    ? `${SINAL_URL}/?sala=${encodeURIComponent(initialRoomCode)}`
    : SINAL_URL;
  mainWindow.loadURL(startUrl);

  // Troca do splash pra janela de verdade assim que o carregamento
  // terminar — de um jeito (carregou) ou de outro (falhou, ex: sem rede).
  // Sem o did-fail-load, uma falha de rede deixaria a pessoa presa
  // olhando pro splash pra sempre, sem nenhum feedback de erro.
  // Abrindo escondido (Windows iniciando + "minimizado" ligado) não tem
  // splash nem janela: o site carrega igual por trás, e a janela só
  // aparece quando a pessoa abrir pela bandeja ou clicar no atalho de novo
  // (esse segundo clique cai no 'second-instance', que já mostra a janela).
  if(!startHidden){
    mainWindow.webContents.once('did-finish-load', closeSplashAndShowMain);
    mainWindow.webContents.once('did-fail-load', closeSplashAndShowMain);
  }

  // Sem internet (ou site fora): antes a janela ficava preta pra sempre e só
  // voltava matando o processo (relato do usuário, 2026-10-02). Agora mostra
  // offline.html e tenta de novo sozinho até o site responder.
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDesc, validatedURL, isMainFrame) => {
    // -3 = navegação cancelada (ex: trocou de página no meio) — não é falta de rede.
    if(!isMainFrame || errorCode === -3 || !isSinalUrl(validatedURL)) return;
    console.error(`[sinal] site não carregou (${errorCode} ${errorDesc}) — mostrando a tela de sem conexão`);
    showOfflinePage(validatedURL);
  });
  // A tela de sem conexão terminou de carregar: manda quanto falta pra
  // próxima tentativa (o temporizador já está correndo desde showOfflinePage).
  // OBS: NÃO usar did-finish-load pra concluir "voltou a internet" — quando o
  // site falha, o Chromium carrega uma página de erro interna que ainda tem a
  // URL do Sinal e também dispara did-finish-load. Era isso que desligava as
  // tentativas e deixava a tela presa (bug real da v0.3.12, 2026-10-02).
  mainWindow.webContents.on('did-finish-load', () => {
    rendererGone = false; // a página recarregou (depois de uma queda): pode voltar a receber mensagens
    if(offlineActive && isOfflinePageShown()) sendOfflineCountdown();
  });

  // Fechar a janela só minimiza pra bandeja — é o motivo nº1 de existir essa
  // versão desktop (background de verdade, ver auditoria Parte 5). Só fecha
  // de fato quando alguém escolhe "Sair" no menu da bandeja.
  mainWindow.on('unresponsive', () => console.warn('[sinal] janela parou de responder'));
  mainWindow.on('responsive', () => console.log('[sinal] janela voltou a responder'));
  // Avisos e erros do próprio site ("[sinal] …") também vão pro registro.
  // Electron novo passa um objeto (level 'warning'/'error'); o antigo, argumentos.
  // Só o objeto do evento (Electron 40+): declarar os argumentos antigos
  // (level, message…) faz o Electron avisar que estão obsoletos.
  mainWindow.webContents.on('console-message', (event) => {
    const { level, message } = event;
    const isProblem = level === 'warning' || level === 'error' || level === 2 || level === 3;
    if(isProblem && typeof message === 'string' && message.startsWith('[sinal')) writeLog('site', [message.slice(0, 600)]);
  });

  mainWindow.on('close', (event) => {
    if(isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function createTray(){
  // Uma imagem com várias resoluções (16/20/24/32px = escala 100/125/150/200%)
  // em vez de uma só de 16px: em tela com escala (comum em notebook), o
  // Windows desenha a bandeja maior e esticava os 16px, deixando o ícone
  // borrado. Assim ele escolhe a representação certa pra cada tela.
  const source = nativeImage.createFromPath(path.join(__dirname, '../build/icon.png'));
  const icon = nativeImage.createEmpty();
  for(const scaleFactor of [1, 1.25, 1.5, 2]){
    const size = Math.round(16 * scaleFactor);
    icon.addRepresentation({
      scaleFactor,
      width: size,
      height: size,
      buffer: source.resize({ width: size, height: size, quality: 'best' }).toPNG()
    });
  }
  tray = new Tray(icon);
  tray.setToolTip('Sinal');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Sinal', click: () => { mainWindow.show(); mainWindow.focus(); } },
    // Abre o app direto na seção de atualizações das configurações e já
    // procura — pra quando a pessoa sabe que saiu versão e não quer esperar.
    { label: 'Procurar atualização', click: () => {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('sinal:open-settings', 'updates');
      checkForUpdates({ manual: true });
    } },
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
      width: 760,
      height: 590,
      parent: mainWindow,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      // Sem a barra de título branca do Windows — o picker.html desenha um
      // cabeçalho próprio (arrastar + X), igual à janela de atualização.
      frame: false,
      backgroundColor: '#0b0c0e',
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
      pickerWindow.webContents.send('sources', { sources: serializable, quality: appSettings.shareQuality });
    });

    const onPickerChoose = (event, choice) => {
      // Só o seletor desta janela responde (antes era `once` no canal inteiro: qualquer mensagem
      // consumia o ouvinte, e ele ficava pendurado se a janela fosse fechada sem escolher).
      if(!pickerWindow || event.sender !== pickerWindow.webContents) return;
      ipcMain.removeListener('picker:choose', onPickerChoose);
      const { sourceId, quality } = choice || {};
      const chosen = sources.find((s) => s.id === sourceId) || null;
      // Grava ANTES de devolver a fonte: o site lê getSettings() logo que a
      // captura começa pra saber qual qualidade publicar.
      if(chosen && SHARE_QUALITIES.includes(quality) && quality !== appSettings.shareQuality){
        appSettings = { ...appSettings, shareQuality: quality };
        saveSettings(appSettings);
      }
      finish(chosen);
    };
    ipcMain.on('picker:choose', onPickerChoose);
    pickerWindow.on('closed', () => { ipcMain.removeListener('picker:choose', onPickerChoose); finish(null); }); // fechou sem escolher = cancelou
  });
}

// Janelinha própria pro aviso de atualização, no lugar do dialog.showMessageBox
// nativo do Windows — pedido explícito (ver HANDOFF §19): o diálogo do SO
// não tem como ser estilizado, quebrava a identidade visual do app bem na
// hora que mais reforça "isso é um app de verdade". Mesmo padrão do
// showSourcePicker: janela modal própria, some sozinha depois da escolha.
// Itens das Novidades daquela versão do app (public/changelog.json no site —
// fonte única das notas, ver HANDOFF §34). Falhou/sem entrada = caixa sem lista,
// igual era antes.
async function fetchReleaseNotes(version){
  try{
    const res = await fetch(`${SINAL_URL}/changelog.json`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if(!res.ok) return [];
    const entries = await res.json();
    const entry = Array.isArray(entries) && entries.find((e) => e && e.app === version);
    return entry && Array.isArray(entry.items) ? entry.items.filter((i) => typeof i === 'string').slice(0, 8) : [];
  }catch(e){
    console.error('[sinal-update] não consegui buscar as novidades:', e.message);
    return [];
  }
}

async function showUpdateDialog(info){
  const notes = await fetchReleaseNotes(info.version);
  return new Promise((resolve) => {
    let updateWindow = new BrowserWindow({
      width: notes.length ? 440 : 380,
      // cresce pra caber a lista "O que muda" (cada item ~1-2 linhas)
      height: notes.length ? Math.min(600, 320 + notes.length * 42) : 260,
      parent: mainWindow,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      frame: false,
      backgroundColor: '#0b0c0e',
      webPreferences: {
        preload: path.join(__dirname, 'update-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    updateWindow.loadFile(path.join(__dirname, 'update.html'));

    let settled = false;
    const finish = (restartNow) => {
      if(settled) return;
      settled = true;
      resolve(restartNow);
      if(updateWindow && !updateWindow.isDestroyed()) updateWindow.close();
      updateWindow = null;
    };

    updateWindow.webContents.once('did-finish-load', () => {
      updateWindow.webContents.send('update-info', { version: info.version, notes });
    });

    const onUpdateChoice = (event, restartNow) => {
      if(!updateWindow || event.sender !== updateWindow.webContents) return;
      ipcMain.removeListener('update:choice', onUpdateChoice);
      finish(restartNow === true);
    };
    ipcMain.on('update:choice', onUpdateChoice);
    updateWindow.on('closed', () => { ipcMain.removeListener('update:choice', onUpdateChoice); finish(false); }); // fechou sem escolher = "depois"
  });
}

// A partir da fonte escolhida no seletor, decide COMO isolar o áudio:
//  - compartilhando uma janela específica -> modo "single": incluir só o
//    processo dono daquela janela (descobre o PID a partir do HWND embutido
//    no id do desktopCapturer, formato "window:<hwnd>:0") — já isola bem
//    sozinho, sem precisar de multi-fonte (confirmado em HANDOFF §15.12).
//  - compartilhando a tela inteira -> modo "multi": em vez de só excluir o
//    Discord (que também deixava vazar o áudio do próprio Sinal tocando
//    localmente — ver HANDOFF §15.13), descobre TODOS os apps fazendo som
//    agora, tira Discord e o próprio Sinal da lista, e inclui cada um
//    individualmente — misturados numa faixa só do lado do renderer
//    (public/app.js). Reavalia sozinho de tempos em tempos, então um app
//    que abre DEPOIS que a transmissão já começou também entra.
function determineAudioTarget(chosen){
  if(!audioAddon) return null;
  if(chosen.id.startsWith('screen:')) return { mode: 'multi' };
  if(chosen.id.startsWith('window:')){
    const hwnd = Number(chosen.id.split(':')[1]);
    const pid = audioAddon.getWindowProcessId(hwnd);
    return pid == null ? null : { mode: 'single', pid, exclude: false };
  }
  return null;
}

function stopIsolatedAudio(){
  stopSingleSourceAudio();
  stopMultiSourceAudio();
}

// Manda algo pra página só se ela estiver viva. Depois que o renderer cai (ou enquanto recarrega) a captura
// nativa de áudio continuaria despejando pedaços (dezenas por segundo, por fonte) num frame que não existe
// mais — o registro de 2026-10-04 às 16:53:53 ficou cheio de "Render frame was disposed".
let rendererGone = false;
function sendToPage(channel, payload){
  if(rendererGone || !mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if(wc.isDestroyed()) return;
  try{ wc.send(channel, payload); }catch(e){ /* o frame sumiu entre a checagem e o envio */ }
}

// ---- Modo single (compartilhar uma janela específica) ----
function stopSingleSourceAudio(){
  if(audioLoopback){
    try{ audioLoopback.stop(); }catch(e){ console.error('[sinal-audio] stop() falhou:', e); }
    audioLoopback = null;
  }
}

function startIsolatedAudio(target){
  stopIsolatedAudio(); // nunca duas capturas ao mesmo tempo, nenhum dos dois modos
  audioLoopback = new audioAddon.AudioLoopback();
  try{
    audioLoopback.start(target.pid, target.exclude, (err, buf) => {
      if(err){ console.error('[sinal-audio] erro no callback de captura:', err); return; }
      sendToPage('sinal:audio-chunk', { pid: target.pid, buf });
    });
    console.log(`[sinal-audio] captura iniciada (single) — pid=${target.pid} exclude=${target.exclude}`);
  }catch(e){
    // Não trava o compartilhamento por causa disso — a tela já está sendo
    // compartilhada nesse ponto, só fica sem o áudio isolado.
    console.error('[sinal-audio] falha ao iniciar captura, seguindo sem áudio isolado:', e);
    audioLoopback = null;
  }
}

// ---- Modo multi (compartilhar a tela inteira) ----
// Um AudioLoopback por processo detectado (todos em modo "incluir"), cada
// um mandando seus próprios pedaços de PCM marcados com o pid — a mistura
// de verdade acontece do lado do renderer (createElectronIsolatedAudioTrack
// em public/app.js), não aqui.
const MULTI_SCAN_INTERVAL_MS = 2000;
const multiSources = new Map(); // pid -> { loopback, exeName }
let multiScanTimer = null;

// Apps desmarcados no checklist ficam em appSettings.excludedAudioApps
// (settings.json) — antes era um Set zerado a cada compartilhamento, e a
// pessoa tinha que desmarcar os mesmos apps toda vez.
function excludedAudioApps(){
  return Array.isArray(appSettings.excludedAudioApps) ? appSettings.excludedAudioApps : [];
}

// Nunca aparece na lista nem no checklist — Discord e o próprio Sinal são
// sempre fora, não é uma escolha do usuário (ver HANDOFF §15.11/§15.13).
function isEligibleSource(session, discordRootPid){
  const exe = session.exeName.toLowerCase();
  if(exe === 'discord.exe' || exe === 'sinal.exe') return false;
  if(session.pid === discordRootPid) return false;
  return true;
}

function startSourceCapture(pid, exeName){
  const loopback = new audioAddon.AudioLoopback();
  try{
    loopback.start(pid, false, (err, buf) => {
      if(err){ console.error(`[sinal-audio] erro na captura multi-fonte (pid=${pid}):`, err); return; }
      sendToPage('sinal:audio-chunk', { pid, buf });
    });
    multiSources.set(pid, { loopback, exeName });
    console.log(`[sinal-audio] fonte adicionada — pid=${pid} exe=${exeName}`);
  }catch(e){
    // Uma fonte falhando não derruba as outras — só essa fica de fora.
    console.error(`[sinal-audio] falha ao capturar pid=${pid} (${exeName}), ignorando essa fonte:`, e);
  }
}

function stopSourceCapture(pid){
  const source = multiSources.get(pid);
  if(!source) return;
  try{ source.loopback.stop(); }catch(e){ console.error('[sinal-audio] stop() de fonte falhou:', e); }
  multiSources.delete(pid);
  sendToPage('sinal:audio-source-removed', pid);
  console.log(`[sinal-audio] fonte removida — pid=${pid}`);
}

function scanAudioSources(){
  if(!audioAddon) return;
  let sessions;
  try{ sessions = audioAddon.listAudioSessions(); }
  catch(e){ console.error('[sinal-audio] listAudioSessions() falhou:', e); return; }

  const discordRootPid = audioAddon.findDiscordRootPid();
  const seenPids = new Set();
  // Lista completa mandada pro renderer — inclui os DESMARCADOS também
  // (senão, depois de desmarcar um app ele sumiria da tela e não teria como
  // marcar de volta sem parar e começar a compartilhar de novo).
  const candidates = [];
  for(const s of sessions){
    if(seenPids.has(s.pid)) continue; // listAudioSessions às vezes repete PID (mais de uma sessão no mesmo processo)
    seenPids.add(s.pid);
    if(!isEligibleSource(s, discordRootPid)) continue;
    const enabled = !excludedAudioApps().includes(s.exeName.toLowerCase());
    candidates.push({ pid: s.pid, exeName: s.exeName, enabled });
    if(enabled && !multiSources.has(s.pid)) startSourceCapture(s.pid, s.exeName);
  }
  // Some quem fechou de vez (pid não aparece mais em sessão nenhuma) — quem
  // foi desmarcado manualmente já foi removido na hora, não precisa checar aqui.
  for(const pid of [...multiSources.keys()]){
    if(!seenPids.has(pid)) stopSourceCapture(pid);
  }

  sendToPage('sinal:audio-sources', candidates);
}

function startMultiSourceAudio(){
  stopIsolatedAudio();
  scanAudioSources();
  multiScanTimer = setInterval(scanAudioSources, MULTI_SCAN_INTERVAL_MS);
  console.log('[sinal-audio] captura multi-fonte iniciada');
}

function stopMultiSourceAudio(){
  if(multiScanTimer){ clearInterval(multiScanTimer); multiScanTimer = null; }
  for(const pid of [...multiSources.keys()]) stopSourceCapture(pid);
}

// Renderer avisa quando o usuário marca/desmarca um app na lista de fontes
// (checkbox por app, só existe no modo multi — ver public/app.js).
// Fica lembrado (settings.json) pros próximos compartilhamentos.
trustedIpc.on('sinal:audio-toggle-source', (event, payload) => {
  const { pid, exeName, enabled } = payload && typeof payload === 'object' ? payload : {};
  const exe = typeof exeName === 'string' ? exeName.toLowerCase().slice(0, 80) : '';
  if(!exe) return;
  const others = excludedAudioApps().filter((e) => e !== exe);
  appSettings = { ...appSettings, excludedAudioApps: (enabled ? others : [...others, exe]).slice(0, 100) };
  saveSettings(appSettings);
  if(!enabled && typeof pid === 'number' && multiSources.has(pid)) stopSourceCapture(pid);
});

// Renderer avisa quando parou de compartilhar (ver public/app.js toggleShare)
// — sem isso a(s) captura(s) nativa(s) ficariam rodando pra sempre em segundo plano.
trustedIpc.on('sinal:audio-stop', stopIsolatedAudio);

// Versão do instalador (não a do site) pro rodapé mostrar dentro do app
// desktop — ver preload.js/app.js. Síncrono (sendSync/returnValue) porque o
// preload precisa do valor pronto antes da página rodar, sem virar Promise
// espalhada pelo app.js só pra isso.
trustedIpc.on('sinal:get-app-version', (event) => { event.returnValue = app.getVersion(); });

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
// Estado da atualização, compartilhado com a aba de configurações do site
// (seção "Atualizações") — antes era tudo silencioso até a caixa aparecer.
let updateState = { status: 'idle', version: null, percent: null }; // idle | checking | latest | downloading | ready | error | dev
let lastUpdateCheckAt = 0;
let pendingUpdateInfo = null;   // baixada, esperando a hora certa de perguntar
let updatePromptOpen = false;
let waitingForShow = false;     // já tem um "pergunta quando a janela aparecer" registrado
let updateDismissed = false;    // clicou "Depois" — não pergunta sozinho de novo nesta execução (instala ao fechar)
let manualUpdateCheck = false;  // pedida na mão (bandeja/configurações) — pergunta mesmo dentro de uma sala
// O site avisa quando entra/sai de uma sala (setInRoom no preload). Site
// antigo nunca avisa → fica false → comportamento de antes (pergunta direto).
let inRoom = false;

function setUpdateState(patch){
  updateState = { ...updateState, ...patch };
  if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sinal:update-state', updateState);
}

function checkForUpdates({ manual = false } = {}){
  if(!app.isPackaged){ setUpdateState({ status: 'dev' }); return; }
  if(manual) manualUpdateCheck = true;
  if(updateState.status === 'checking' || updateState.status === 'downloading') return;
  // Já tem uma baixada esperando a hora de perguntar (ex: a pessoa ficou horas numa
  // call). Pedido manual pergunta na hora, MAS a checagem continua: antes ela parava
  // aqui e, se saísse uma versão mais nova nesse meio-tempo, o app instalava a velha e
  // só depois descobria a nova (o amigo na 0.3.12 teve que atualizar duas vezes, 0.3.13
  // e 0.3.14). Agora ele baixa a mais nova e instala essa direto.
  const hadReady = updateState.status === 'ready';
  if(hadReady && manual) maybePromptUpdate();
  lastUpdateCheckAt = Date.now();
  if(!hadReady) setUpdateState({ status: 'checking' }); // com uma pronta, o status "pronta" fica até haver outra
  autoUpdater.checkForUpdates().catch((e) => {
    console.error('[sinal-update] falha na checagem:', e);
    manualUpdateCheck = false;
    setUpdateState(pendingUpdateInfo ? { status: 'ready', percent: null } : { status: 'error' });
  });
}

// Ao sair da sala com uma atualização esperando: procura de novo ANTES de perguntar
// (se passou mais de 2 min da última checagem) — se saiu uma mais nova, baixa e
// pergunta uma vez só, pela mais nova.
async function promptAfterFreshCheck(){
  if(pendingUpdateInfo && app.isPackaged && Date.now() - lastUpdateCheckAt > 2 * 60 * 1000){
    lastUpdateCheckAt = Date.now();
    try{ await autoUpdater.checkForUpdates(); }catch(e){ console.error('[sinal-update] checagem ao sair da sala falhou:', e); }
  }
  maybePromptUpdate();
}

// Pergunta na hora certa: nunca no meio de uma call (a menos que tenha sido
// pedido na mão), e nunca com a janela escondida na bandeja (roubaria o foco
// de um jogo em janela/borderless — espera a janela aparecer).
function maybePromptUpdate(){
  if(!pendingUpdateInfo || updatePromptOpen) return;
  if(updateState.status === 'downloading') return; // baixando uma mais nova que a pendente: espera ela ('update-downloaded' chama de novo)
  if(updateDismissed && !manualUpdateCheck) return;
  if(inRoom && !manualUpdateCheck) return; // sinal:set-in-room(false) chama de novo ao sair da sala
  if(!mainWindow.isVisible()){
    if(!waitingForShow){
      waitingForShow = true;
      mainWindow.once('show', () => { waitingForShow = false; maybePromptUpdate(); });
    }
    return;
  }
  updatePromptOpen = true;
  manualUpdateCheck = false;
  showUpdateDialog(pendingUpdateInfo).then((restartNow) => {
    updatePromptOpen = false;
    if(restartNow){
      isQuitting = true;
      autoUpdater.quitAndInstall();
    } else {
      updateDismissed = true;
    }
  });
}

function setupAutoUpdater(){
  if(!app.isPackaged){
    console.log('[sinal-update] pulando auto-update (rodando em dev, não empacotado)');
    setUpdateState({ status: 'dev' });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.error('[sinal-update] erro checando/baixando atualização:', err);
    manualUpdateCheck = false;
    // Se já tem uma baixada, ela continua valendo (o erro foi na busca por uma mais nova).
    setUpdateState(pendingUpdateInfo ? { status: 'ready', percent: null } : { status: 'error', percent: null });
  });
  autoUpdater.on('checking-for-update', () => {
    console.log('[sinal-update] checando por atualização...');
  });
  autoUpdater.on('update-available', (info) => {
    console.log('[sinal-update] atualização disponível:', info.version);
    // A mesma que já está baixada: não volta pra "baixando" (o arquivo vem do cache).
    if(pendingUpdateInfo && pendingUpdateInfo.version === info.version) return;
    setUpdateState({ status: 'downloading', version: info.version, percent: 0 });
  });
  autoUpdater.on('download-progress', (progress) => {
    setUpdateState({ status: 'downloading', percent: Math.round(progress.percent || 0) });
  });
  autoUpdater.on('update-not-available', () => {
    console.log('[sinal-update] já está na versão mais recente');
    manualUpdateCheck = false;
    if(pendingUpdateInfo) return; // já tem uma baixada esperando — não some com ela
    setUpdateState({ status: 'latest', version: app.getVersion(), percent: null });
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[sinal-update] atualização baixada:', info.version);
    pendingUpdateInfo = info;
    setUpdateState({ status: 'ready', version: info.version, percent: null });
    maybePromptUpdate();
  });

  // Antes era 10s depois de abrir + a cada 4h: com o app aberto na bandeja
  // por dias, uma versão nova levava até 4h pra ser notada (pedido do
  // usuário, 2026-10-02). Agora a cada 30 min (o GitHub aceita 60
  // consultas/h por IP sem login — sobra muito) e também ao trazer a janela
  // da bandeja, no máximo 1x a cada 10 min.
  setTimeout(() => checkForUpdates(), 10_000);
  setInterval(() => checkForUpdates(), 30 * 60 * 1000);
  mainWindow.on('show', () => {
    if(Date.now() - lastUpdateCheckAt > 10 * 60 * 1000) checkForUpdates();
  });
}

trustedIpc.on('sinal:set-in-room', (event, value, roomCode) => {
  inRoom = !!value;
  lastRoomCode = inRoom && typeof roomCode === 'string' ? roomCode.slice(0, 64) : null;
  if(!inRoom) promptAfterFreshCheck();
});

// ---- Login com Discord pelo navegador padrão (HANDOFF §39, fase 2c) ----
// O site pede (sinal:open-login) → abrimos o navegador na URL do PRÓPRIO Sinal
// (montada aqui, o site só fornece o nonce) → depois do login o navegador chama
// sinal://auth?session=…&nonce=… → entregamos ao site, que confere o nonce.
let pendingAuth = null;

function deliverAuth(auth){
  if(!mainWindow || mainWindow.isDestroyed()){ pendingAuth = auth; return; }
  if(mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if(mainWindow.webContents.isLoading()){ pendingAuth = auth; return; } // o site pega ao carregar
  mainWindow.webContents.send('sinal:auth', auth);
}

trustedIpc.handle('sinal:open-login', async (event, nonce, options) => {
  const target = buildLoginUrl(SINAL_URL, nonce, { refresh: !!(options && options.refresh) });
  if(!target) return false;
  // Só nos testes em modo dev (app não empacotado): grava a URL em vez de abrir o navegador de verdade.
  if(!app.isPackaged && process.env.SINAL_TEST_LOGIN_FILE){
    require('fs').writeFileSync(process.env.SINAL_TEST_LOGIN_FILE, target);
    return true;
  }
  try{ await shell.openExternal(target); return true; }catch(e){
    console.error('[sinal] não consegui abrir o navegador pro login:', e && e.message);
    return false;
  }
});

trustedIpc.handle('sinal:take-pending-auth', () => {
  const auth = pendingAuth;
  pendingAuth = null;
  return auth;
});

// Avisos do site pro registro (início/fim/troca de transmissão etc).
trustedIpc.on('sinal:log', (event, message) => {
  if(typeof message === 'string') writeLog('site', [message.slice(0, 600).replace(/[\r\n]+/g, ' ')]);
});
trustedIpc.handle('sinal:get-log-tail', () => {
  const header = [
    `Sinal ${app.getVersion()} · Electron ${process.versions.electron} · Chrome ${process.versions.chrome}`,
    `Windows ${os.release()} · ${os.arch()} · ${Math.round(os.totalmem() / 1073741824)} GB RAM`,
    `Gerado em ${new Date().toISOString()}`,
    ''
  ].join('\n');
  return header + readLogTail();
});

// ---- Recuperação: a página (Chromium) morreu → recarrega e volta pra sala ----
// Antes: tela preta e a transmissão caía pra todo mundo até matar o processo
// (relato real, Valorant em Fluido). Agora o app recarrega sozinho; se estava
// numa sala, volta pra ela (o site entra sozinho com ?retomar=1). Duas
// quedas em 5 min → recarrega só a tela inicial, pra não entrar em ciclo.
let lastRoomCode = null;
let crashTimes = [];
function recoverMainWindow(details){
  if(!mainWindow || mainWindow.isDestroyed() || (details && details.reason === 'clean-exit')) return;
  const now = Date.now();
  crashTimes = crashTimes.filter((t) => now - t < 5 * 60 * 1000);
  crashTimes.push(now);
  const rejoin = !!lastRoomCode && crashTimes.length <= 1;
  const url = rejoin ? `${SINAL_URL}/?sala=${encodeURIComponent(lastRoomCode)}&retomar=1` : SINAL_URL;
  console.warn('[sinal] recuperando a janela depois da queda', { rejoin, quedasEm5min: crashTimes.length });
  inRoom = false;
  setTimeout(() => { if(mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(url); }, 800);
}
app.on('render-process-gone', (event, webContents, details) => {
  console.error('[sinal] a página caiu:', details);
  if(mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents){
    if(details && details.reason !== 'clean-exit'){
      // Pista pro próximo diagnóstico: a queda de 2026-10-04 aconteceu com o áudio isolado ligado.
      console.error(`[sinal] áudio isolado no momento da queda: janela única=${!!audioLoopback}, fontes (tela inteira)=${multiSources.size}`);
      rendererGone = true;
      stopIsolatedAudio(); // ninguém mais escuta; volta quando a pessoa transmitir de novo
    }
    recoverMainWindow(details);
  }
});
// GPU/áudio/rede do Chromium: ele mesmo reinicia, mas anotar é o que conta
// pra achar padrão (ex: codificador da placa de vídeo quebrando com jogo).
app.on('child-process-gone', (event, details) => {
  console.error('[sinal] processo do Chromium caiu:', details);
});
trustedIpc.handle('sinal:get-update-state', () => updateState);
trustedIpc.handle('sinal:check-for-updates', () => { checkForUpdates({ manual: true }); return updateState; });
trustedIpc.on('sinal:install-update', () => {
  if(updateState.status !== 'ready') return;
  isQuitting = true;
  autoUpdater.quitAndInstall();
});

app.whenReady().then(() => {
  console.log(`[sinal] app iniciado — v${app.getVersion()}, Electron ${process.versions.electron}, Windows ${os.release()}`);
  app.getGPUInfo('basic').then((info) => {
    const gpus = (info && info.gpuDevice || []).map((g) => ({ vendorId: g.vendorId, deviceId: g.deviceId, active: g.active, driver: g.driverVersion }));
    console.log('[sinal] placa de vídeo:', gpus);
  }).catch(() => {});
  // Tira a barra de menu padrão do Electron (File/Edit/View/Window) — sem
  // função nenhuma nesse app (não tem "abrir arquivo", desfazer, etc.) e
  // deixa parecendo ferramenta de desenvolvedor em vez de um app de verdade.
  Menu.setApplicationMenu(null);

  // session.defaultSession só existe depois do app pronto — chamar isso no
  // nível superior do módulo (fora do whenReady) derruba o processo inteiro
  // com "Session can only be received when app is ready" antes mesmo de
  // abrir qualquer janela. Pegou essa em teste real (ver HANDOFF).
  // Permissões em lista de permitidas, só pro site do Sinal. O padrão do Electron é liberar TUDO
  // pra qualquer página sem perguntar (câmera, microfone, localização…).
  const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isSinalUrl((details && details.requestingUrl) || webContents.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && isSinalUrl(requestingOrigin);
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    // Captura de tela só pro site do Sinal (nenhuma outra página que algum dia apareça aqui).
    if(!isSinalUrl(request.securityOrigin || '')){ callback({}); return; }
    try{
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 300, height: 200 },
        fetchWindowIcons: true
      });

      let chosen;
      if(skipPickerOnce){
        skipPickerOnce = false;
        // desktopCapturer não garante ordem, então casa pelo display_id
        // com o monitor primário de verdade em vez de só pegar sources[0].
        const primaryId = String(screen.getPrimaryDisplay().id);
        chosen = sources.find((s) => s.id.startsWith('screen:') && s.display_id === primaryId)
          || sources.find((s) => s.id.startsWith('screen:'))
          || null;
      } else {
        chosen = await showSourcePicker(sources);
      }

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
      if(audioTarget){
        if(audioTarget.mode === 'multi') startMultiSourceAudio();
        else startIsolatedAudio(audioTarget);
      }
      callback({ video: chosen });
    }catch(e){
      console.error('[sinal] setDisplayMediaRequestHandler falhou:', e);
      callback({});
    }
  });

  // Abrir via link sinal:// (app ainda fechado): no Windows a URL chega como
  // um argumento de linha de comando desse primeiro lançamento — procura
  // nele antes de criar a janela, pra já abrir direto na sala certa em vez
  // de abrir vazio e só depois navegar.
  const launchUrl = process.argv.find((arg) => arg.startsWith('sinal://'));
  const launchAuth = parseAuthUrl(launchUrl);
  if(launchAuth) pendingAuth = launchAuth; // o site pega assim que carregar (sinal:take-pending-auth)
  // `--hidden` só vem da entrada de "iniciar com o Windows" — abrir pelo
  // atalho/menu iniciar nunca tem, então nesse caso a janela aparece
  // normal mesmo com "minimizado" ligado.
  const startHidden = process.argv.includes(HIDDEN_LAUNCH_ARG) && !!appSettings.startMinimized;
  if(!startHidden) createSplashWindow();
  createMainWindow(extractRoomCodeFromProtocolUrl(launchUrl), startHidden);
  createTray();
  setupAutoUpdater();

  registerShareShortcut();
  applyLoginItemSetting();
});

// Atalho global pra compartilhar/parar de compartilhar sem precisar focar a
// janela — pedido do usuário (ver HANDOFF §19). Só manda o aviso pro
// renderer chamar a MESMA toggleShare() do botão — essa função já funciona
// mesmo fora de uma sala (é um no-op, `if(!room) return`), então não
// precisa checar estado nenhum aqui do lado do processo principal. Não
// força a janela a aparecer: parar de compartilhar às pressas sem precisar
// alt-tab é o cenário que mais importa aqui.
//
// Reutilizável: chamada no início E toda vez que a aba de settings muda o
// atalho ou liga/desliga ele (ver trustedIpc.handle('sinal:set-settings')
// abaixo) — sempre desregistra o anterior antes, senão um rebind ficaria
// com os dois atalhos (o velho E o novo) registrados ao mesmo tempo.
function registerShareShortcut(){
  globalShortcut.unregisterAll();
  if(!appSettings.shortcutEnabled) return true;
  const ok = globalShortcut.register(appSettings.shortcut, () => {
    lastShortcutAt = Date.now();
    if(mainWindow && !mainWindow.isDestroyed()){
      mainWindow.webContents.send('sinal:toggle-share-shortcut');
    }
  });
  if(!ok){
    console.error(`[sinal] não consegui registrar o atalho ${appSettings.shortcut} (outro programa já usa essa combinação?)`);
  }
  return ok;
}

app.on('will-quit', () => { globalShortcut.unregisterAll(); });

// Nenhuma janela do app abre outra janela nem sai do site: link externo vai pro navegador (só
// https) e o resto é negado. Vale pra principal, seletor, aviso de atualização e splash.
app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: 'deny' }; });
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.on('will-navigate', (e, url) => {
    if(isSinalUrl(url) || url.startsWith(OFFLINE_PAGE_URL)) return;
    e.preventDefault();
    openExternalSafe(url);
  });
  contents.on('will-redirect', (e, url) => {
    if(!isSinalUrl(url)) e.preventDefault();
  });
});

// Settings da aba de configurações (ver public/app.js) — só o necessário
// pra essa feature, nada pessoal (ver comentário em SETTINGS_PATH).
trustedIpc.handle('sinal:get-settings', () => appSettings);

// Valida o que o site manda: só as chaves conhecidas, com o tipo certo. Antes qualquer chave era
// gravada em settings.json e o atalho aceitava qualquer combinação — um site comprometido poderia
// registrar, por exemplo, Ctrl+C como atalho GLOBAL e quebrar o copiar/colar do Windows inteiro.
const ACCELERATOR_MODIFIERS = ['Control', 'Alt', 'Shift', 'Super'];
function isSafeAccelerator(value){
  if(typeof value !== 'string' || value.length > 40) return false;
  const parts = value.split('+');
  const key = parts.pop();
  if(!/^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4]))$/.test(key)) return false;
  if(!parts.length || new Set(parts).size !== parts.length) return false;
  if(!parts.every((m) => ACCELERATOR_MODIFIERS.includes(m))) return false;
  // Só Ctrl ou só Shift + tecla é copiar/colar/digitar: pega por cima de todos os programas.
  if(parts.length === 1 && (parts[0] === 'Control' || parts[0] === 'Shift')) return false;
  if(key === 'F4' && parts.length === 1 && parts[0] === 'Alt') return false; // Alt+F4 fecha janelas
  return true;
}

function sanitizeSettingsPatch(patch){
  const out = {};
  if(!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for(const key of ['shortcutEnabled', 'quickShareWholeScreen', 'startWithWindows', 'startMinimized']){
    if(typeof patch[key] === 'boolean') out[key] = patch[key];
  }
  if(isSafeAccelerator(patch.shortcut)) out.shortcut = patch.shortcut;
  if(SHARE_QUALITIES.includes(patch.shareQuality)) out.shareQuality = patch.shareQuality;
  if(Array.isArray(patch.excludedAudioApps)){
    out.excludedAudioApps = [...new Set(patch.excludedAudioApps
      .filter((x) => typeof x === 'string')
      .map((x) => x.toLowerCase().slice(0, 80))
      .filter(Boolean))].slice(0, 100);
  }
  return out;
}

trustedIpc.handle('sinal:set-settings', (event, partial) => {
  appSettings = { ...appSettings, ...sanitizeSettingsPatch(partial) };
  saveSettings(appSettings);
  const shortcutRegistered = registerShareShortcut();
  applyLoginItemSetting();
  return { settings: appSettings, shortcutRegistered };
});

// Chamado pelo renderer bem antes de toggleShare() quando o atalho disparou
// COMEÇANDO um compartilhamento (não parando) com "tela inteira direto"
// ligado — ver setupGlobalShareShortcut() em app.js.
trustedIpc.on('sinal:request-quick-share', () => {
  // Pular o seletor entrega a tela inteira SEM nenhuma pergunta — então só vale se o atalho
  // global acabou de ser apertado de verdade (o renderer pode pedir isso a qualquer hora, o
  // processo principal é quem sabe se houve atalho) e com a opção ligada. Um tiro só, que
  // expira sozinho se a captura não vier.
  if(!appSettings.quickShareWholeScreen || Date.now() - lastShortcutAt > 3000) return;
  skipPickerOnce = true;
  setTimeout(() => { skipPickerOnce = false; }, 5000);
});

// Abrir via link sinal:// com o app JÁ rodando: o Windows lança um processo
// novo (que perde o lock lá em cima e sai na hora), mas antes disso emite
// esse evento na instância original com a URL na linha de comando — foca a
// janela existente e navega pra sala em vez de deixar passar batido.
app.on('second-instance', (event, commandLine) => {
  if(mainWindow){
    if(mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  const url = commandLine.find((arg) => arg.startsWith('sinal://'));
  const auth = parseAuthUrl(url);
  if(auth){ deliverAuth(auth); return; }
  const code = extractRoomCodeFromProtocolUrl(url);
  if(code && mainWindow){
    mainWindow.loadURL(`${SINAL_URL}/?sala=${encodeURIComponent(code)}`);
  }
});

app.on('window-all-closed', () => {
  // Não sai — a bandeja é quem controla o ciclo de vida (ver comentário no
  // 'close' acima). Isso só dispara se alguém destruir a janela por fora do
  // fluxo normal.
});

app.on('before-quit', () => { isQuitting = true; stopIsolatedAudio(); });

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
const { app, BrowserWindow, Tray, Menu, session, desktopCapturer, ipcMain, nativeImage, globalShortcut, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { autoUpdater } = require('electron-updater');

// URL de produção real — mesma que https://sinal-app-stream.vercel.app serve
// pro navegador. Ver README/HANDOFF pra histórico de migração de domínio.
const SINAL_URL = 'https://sinal-app-stream.vercel.app';

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
  return m ? decodeURIComponent(m[1]) : null;
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
  if(grow) offlineRetryDelay = Math.min(offlineRetryDelay * 2, OFFLINE_RETRY_MAX_MS);
  // A tela de sem conexão mostra "próxima tentativa em Ns".
  if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sinal:offline-next-retry', Math.round(delay / 1000));
}

// Só navega de volta pro site quando ele RESPONDE — navegar às cegas e
// falhar de novo faria a tela piscar a cada tentativa.
async function tryReconnect({ manual = false } = {}){
  if(!offlineActive || offlineAttemptRunning || !mainWindow || mainWindow.isDestroyed()) return;
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
  // Agenda depois que a página carregar, pra ela receber a contagem.
  mainWindow.webContents.once('did-finish-load', () => scheduleOfflineRetry());
}

ipcMain.on('sinal:retry-connection', () => { tryReconnect({ manual: true }); });

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
    if(!isMainFrame || errorCode === -3 || !String(validatedURL).startsWith(SINAL_URL)) return;
    console.error(`[sinal] site não carregou (${errorCode} ${errorDesc}) — mostrando a tela de sem conexão`);
    showOfflinePage(validatedURL);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if(mainWindow.webContents.getURL().startsWith(SINAL_URL)) stopOfflineRetry();
  });

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

    ipcMain.once('picker:choose', (event, choice) => {
      const { sourceId, quality } = choice || {};
      const chosen = sources.find((s) => s.id === sourceId) || null;
      // Grava ANTES de devolver a fonte: o site lê getSettings() logo que a
      // captura começa pra saber qual qualidade publicar.
      if(chosen && SHARE_QUALITIES.includes(quality) && quality !== appSettings.shareQuality){
        appSettings = { ...appSettings, shareQuality: quality };
        saveSettings(appSettings);
      }
      finish(chosen);
    });
    pickerWindow.on('closed', () => finish(null)); // fechou sem escolher = cancelou
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

    ipcMain.once('update:choice', (event, restartNow) => finish(restartNow));
    updateWindow.on('closed', () => finish(false)); // fechou sem escolher = "depois"
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
      if(mainWindow && !mainWindow.isDestroyed()){
        mainWindow.webContents.send('sinal:audio-chunk', { pid: target.pid, buf });
      }
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
      if(mainWindow && !mainWindow.isDestroyed()){
        mainWindow.webContents.send('sinal:audio-chunk', { pid, buf });
      }
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
  if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sinal:audio-source-removed', pid);
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

  if(mainWindow && !mainWindow.isDestroyed()){
    mainWindow.webContents.send('sinal:audio-sources', candidates);
  }
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
ipcMain.on('sinal:audio-toggle-source', (event, { pid, exeName, enabled }) => {
  const exe = (exeName || '').toLowerCase();
  if(!exe) return;
  const others = excludedAudioApps().filter((e) => e !== exe);
  appSettings = { ...appSettings, excludedAudioApps: enabled ? others : [...others, exe] };
  saveSettings(appSettings);
  if(!enabled && multiSources.has(pid)) stopSourceCapture(pid);
});

// Renderer avisa quando parou de compartilhar (ver public/app.js toggleShare)
// — sem isso a(s) captura(s) nativa(s) ficariam rodando pra sempre em segundo plano.
ipcMain.on('sinal:audio-stop', stopIsolatedAudio);

// Versão do instalador (não a do site) pro rodapé mostrar dentro do app
// desktop — ver preload.js/app.js. Síncrono (sendSync/returnValue) porque o
// preload precisa do valor pronto antes da página rodar, sem virar Promise
// espalhada pelo app.js só pra isso.
ipcMain.on('sinal:get-app-version', (event) => { event.returnValue = app.getVersion(); });

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
  // Já baixou antes (e a pessoa disse "Depois"): pedido manual pergunta de novo.
  if(updateState.status === 'ready'){ if(manual) maybePromptUpdate(); return; }
  if(updateState.status === 'checking' || updateState.status === 'downloading') return;
  lastUpdateCheckAt = Date.now();
  setUpdateState({ status: 'checking' });
  autoUpdater.checkForUpdates().catch((e) => {
    console.error('[sinal-update] falha na checagem:', e);
    manualUpdateCheck = false;
    setUpdateState({ status: 'error' });
  });
}

// Pergunta na hora certa: nunca no meio de uma call (a menos que tenha sido
// pedido na mão), e nunca com a janela escondida na bandeja (roubaria o foco
// de um jogo em janela/borderless — espera a janela aparecer).
function maybePromptUpdate(){
  if(!pendingUpdateInfo || updatePromptOpen) return;
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
    setUpdateState({ status: 'error', percent: null });
  });
  autoUpdater.on('checking-for-update', () => {
    console.log('[sinal-update] checando por atualização...');
  });
  autoUpdater.on('update-available', (info) => {
    console.log('[sinal-update] atualização disponível:', info.version);
    setUpdateState({ status: 'downloading', version: info.version, percent: 0 });
  });
  autoUpdater.on('download-progress', (progress) => {
    setUpdateState({ status: 'downloading', percent: Math.round(progress.percent || 0) });
  });
  autoUpdater.on('update-not-available', () => {
    console.log('[sinal-update] já está na versão mais recente');
    manualUpdateCheck = false;
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

ipcMain.on('sinal:set-in-room', (event, value) => {
  inRoom = !!value;
  if(!inRoom) maybePromptUpdate();
});
ipcMain.handle('sinal:get-update-state', () => updateState);
ipcMain.handle('sinal:check-for-updates', () => { checkForUpdates({ manual: true }); return updateState; });
ipcMain.on('sinal:install-update', () => {
  if(updateState.status !== 'ready') return;
  isQuitting = true;
  autoUpdater.quitAndInstall();
});

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
// atalho ou liga/desliga ele (ver ipcMain.handle('sinal:set-settings')
// abaixo) — sempre desregistra o anterior antes, senão um rebind ficaria
// com os dois atalhos (o velho E o novo) registrados ao mesmo tempo.
function registerShareShortcut(){
  globalShortcut.unregisterAll();
  if(!appSettings.shortcutEnabled) return true;
  const ok = globalShortcut.register(appSettings.shortcut, () => {
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

// Settings da aba de configurações (ver public/app.js) — só o necessário
// pra essa feature, nada pessoal (ver comentário em SETTINGS_PATH).
ipcMain.handle('sinal:get-settings', () => appSettings);

ipcMain.handle('sinal:set-settings', (event, partial) => {
  appSettings = { ...appSettings, ...partial };
  saveSettings(appSettings);
  const shortcutRegistered = registerShareShortcut();
  applyLoginItemSetting();
  return { settings: appSettings, shortcutRegistered };
});

// Chamado pelo renderer bem antes de toggleShare() quando o atalho disparou
// COMEÇANDO um compartilhamento (não parando) com "tela inteira direto"
// ligado — ver setupGlobalShareShortcut() em app.js.
ipcMain.on('sinal:request-quick-share', () => { skipPickerOnce = true; });

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

// Teste de ponta a ponta da integração de áudio: reproduz o MESMO fluxo do
// main.js real (escolher fonte no seletor -> decidir PID/modo -> iniciar
// captura nativa -> mandar chunks por IPC) e confirma que chunks de PCM de
// verdade chegam do outro lado, no processo de renderização, exatamente
// como o app.js vai receber via window.sinalElectron.
import { app, BrowserWindow, session, desktopCapturer, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const audioAddon = require('../native/sinal-audio-loopback/target/debug/sinal_audio_loopback.node');

let audioLoopback = null;
let mainWindow = null;

// --- réplica fiel da lógica de main.js (ver HANDOFF §15.2 pro porquê de
// duplicar em vez de importar: main.js não exporta nada, roda por efeito
// colateral no app.whenReady) ---
function determineAudioTarget(chosen){
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

function startIsolatedAudio(target){
  audioLoopback = new audioAddon.AudioLoopback();
  audioLoopback.start(target.pid, target.exclude, (err, buf) => {
    if(err) return;
    if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sinal:audio-chunk', buf);
  });
}

app.whenReady().then(async () => {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    console.log('[teste] handler chamado');
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 1, height: 1 } });
    console.log('[teste] fontes obtidas:', sources.length);
    const chosen = sources[0]; // escolhe a 1a (tela cheia) direto, sem picker -- não é isso que estamos testando aqui
    console.log('[teste] fonte escolhida:', chosen.id, chosen.name);
    const target = determineAudioTarget(chosen);
    console.log('[teste] alvo de áudio determinado:', target);
    if(target) startIsolatedAudio(target);
    console.log('[teste] chamando callback({video})...');
    callback({ video: chosen });
    console.log('[teste] callback devolvida');
  });

  mainWindow = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'audio-preload.js'), contextIsolation: true }
  });
  await mainWindow.loadFile(path.join(__dirname, 'blank.html'));

  console.log('[teste] chamando getDisplayMedia() pra disparar todo o fluxo...');
  // Não retorna o MediaStream pro processo principal (executeJavaScript tenta
  // clonar o valor de retorno, e MediaStream não é serializável — dá "An
  // object could not be cloned"). Só dispara e devolve algo simples.
  await mainWindow.webContents.executeJavaScript(`
    navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => true)
  `);

  console.log('[teste] esperando 3s de chunks de áudio chegarem via IPC (toque algum som pra um teste melhor)...');
  await new Promise((r) => setTimeout(r, 3000));

  const stats = await mainWindow.webContents.executeJavaScript('window.audioTest.getStats()');
  console.log('[teste] RESULTADO — chunks recebidos no renderer via IPC:', stats);

  if(audioLoopback) audioLoopback.stop();
  app.exit(stats.chunks > 0 ? 0 : 1);
});

// Mesmo teste de antes, mas usando o preload.js REAL do app (não uma versão
// de teste) — confirma que window.sinalElectron.onAudioChunk() funciona de
// verdade do jeito que o app.js vai usar.
import { app, BrowserWindow, session, desktopCapturer, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const audioAddon = require('../native/sinal-audio-loopback/target/debug/sinal_audio_loopback.node');

let audioLoopback = null;
let mainWindow = null;

function determineAudioTarget(chosen){
  if(chosen.id.startsWith('screen:')){
    const pid = audioAddon.findDiscordRootPid();
    return pid == null ? null : { pid, exclude: true };
  }
  return null;
}

ipcMain.on('sinal:audio-stop', () => {
  if(audioLoopback){ audioLoopback.stop(); audioLoopback = null; }
});

app.whenReady().then(async () => {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 1, height: 1 } });
    const chosen = sources[0];
    const target = determineAudioTarget(chosen);
    if(target){
      audioLoopback = new audioAddon.AudioLoopback();
      audioLoopback.start(target.pid, target.exclude, (err, buf) => {
        if(err) return;
        if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sinal:audio-chunk', buf);
      });
    }
    callback({ video: chosen });
  });

  mainWindow = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true }
  });
  await mainWindow.loadFile(path.join(__dirname, 'blank.html'));

  // Chama window.sinalElectron.onAudioChunk exatamente como o app.js vai
  // chamar -- mas o script termina com "; true;" de propósito, pra garantir
  // que o valor devolvido pro executeJavaScript seja serializável (o bug
  // anterior era o retorno implícito de ipcRenderer.on() vazando).
  await mainWindow.webContents.executeJavaScript(`
    window.__stats = { chunks: 0, bytes: 0, maxAmp: 0 };
    window.sinalElectron.onAudioChunk((buf) => {
      window.__stats.chunks++;
      window.__stats.bytes += buf.length;
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for(let i = 0; i + 1 < buf.length; i += 2){
        const s = Math.abs(view.getInt16(i, true));
        if(s > window.__stats.maxAmp) window.__stats.maxAmp = s;
      }
    });
    true;
  `);

  console.log('[teste] window.sinalElectron.isElectron:', await mainWindow.webContents.executeJavaScript('window.sinalElectron.isElectron'));
  console.log('[teste] disparando getDisplayMedia()...');
  await mainWindow.webContents.executeJavaScript(`navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => true)`);

  console.log('[teste] esperando 3s (toque som)...');
  await new Promise((r) => setTimeout(r, 3000));

  const stats = await mainWindow.webContents.executeJavaScript('window.__stats');
  console.log('[teste] RESULTADO via preload.js REAL:', stats);

  console.log('[teste] testando stopIsolatedAudio()...');
  await mainWindow.webContents.executeJavaScript('window.sinalElectron.stopIsolatedAudio(); true;');
  await new Promise((r) => setTimeout(r, 300));
  console.log('[teste] audioLoopback ficou null depois do stop?', audioLoopback === null);

  app.exit(stats.chunks > 0 ? 0 : 1);
});

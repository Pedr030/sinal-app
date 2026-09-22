// Teste de ponta a ponta COMPLETO: main.js real (com áudio isolado
// integrado) + app.js real (modificado, servido local em localhost:3050,
// não a versão publicada) + LiveKit real (self-hosted, mesmo servidor de
// produção — as credenciais vêm do .env local). Cria uma sala de verdade,
// compartilha a tela inteira, e confirma que TANTO a track de vídeo QUANTO
// a de áudio isolado publicam com sucesso no LiveKit real.
import { app, BrowserWindow, session, desktopCapturer, ipcMain, Tray, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const audioAddon = require('../native/sinal-audio-loopback/target/debug/sinal_audio_loopback.node');

const LOCAL_URL = 'http://localhost:3050';

let audioLoopback = null;
let mainWindow = null;

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

function stopIsolatedAudio(){
  if(audioLoopback){ try{ audioLoopback.stop(); }catch(e){} audioLoopback = null; }
}

function startIsolatedAudio(target){
  stopIsolatedAudio();
  audioLoopback = new audioAddon.AudioLoopback();
  try{
    audioLoopback.start(target.pid, target.exclude, (err, buf) => {
      if(err) return;
      if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sinal:audio-chunk', buf);
    });
    console.log(`[teste] captura nativa iniciada pid=${target.pid} exclude=${target.exclude}`);
  }catch(e){
    console.error('[teste] falha ao iniciar captura nativa:', e);
    audioLoopback = null;
  }
}

ipcMain.on('sinal:audio-stop', stopIsolatedAudio);

app.whenReady().then(async () => {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 1, height: 1 } });
    const chosen = sources.find((s) => s.id.startsWith('screen:')) || sources[0]; // força tela inteira -> modo exclude Discord
    console.log('[teste] fonte escolhida:', chosen.id, chosen.name);
    const target = determineAudioTarget(chosen);
    console.log('[teste] alvo de áudio:', target);
    if(target) startIsolatedAudio(target);
    callback({ video: chosen });
  });

  mainWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../src/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await mainWindow.loadURL(LOCAL_URL);
  console.log('[teste] site local carregado:', await mainWindow.webContents.executeJavaScript('document.title'));

  // Cria uma sala de verdade e compartilha a tela, exatamente como um
  // clique real faria -- roomCode/myName/room são globais do app.js.
  const result = await mainWindow.webContents.executeJavaScript(`
    (async () => {
      try {
        document.getElementById('nameInput').value = 'TesteIntegracao';
        createRoom();
        // espera conectar (roomScreen fica visível quando conecta de verdade)
        for (let i = 0; i < 50 && document.getElementById('roomScreen').style.display !== 'flex'; i++) {
          await new Promise(r => setTimeout(r, 200));
        }
        if (!room) return { ok: false, etapa: 'conectar', erro: 'sala não conectou' };

        await toggleShare();
        await new Promise(r => setTimeout(r, 1500)); // dá tempo do publish assentar

        const { Track } = LivekitClient;
        const videoPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
        const audioPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
        return {
          ok: true,
          roomCode,
          videoPublicado: !!(videoPub && videoPub.videoTrack),
          audioIsoladoPublicado: !!(audioPub && audioPub.audioTrack),
          audioTrackKind: audioPub && audioPub.audioTrack ? audioPub.audioTrack.kind : null
        };
      } catch (e) {
        return { ok: false, etapa: 'excecao', erro: e.message, stack: e.stack };
      }
    })()
  `);
  console.log('[teste] RESULTADO:', JSON.stringify(result, null, 2));

  // limpeza
  await mainWindow.webContents.executeJavaScript('if (room) { leaveRoom(); } true;').catch(() => {});
  stopIsolatedAudio();

  app.exit(result.ok && result.videoPublicado && result.audioIsoladoPublicado ? 0 : 1);
});

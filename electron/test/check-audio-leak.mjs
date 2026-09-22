// Confirma se o MediaStream que vem do getDisplayMedia() -- via
// setScreenShareEnabled(true, {audio:true,...}) -- ganha uma track de audio
// MESMO com o callback do main process so devolvendo {video: chosen} (sem
// campo audio nenhum). Se sim, essa e provavelmente a fonte do vazamento:
// uma SEGUNDA track de audio (sistema inteiro, sem filtro nenhum) publicada
// junto com a nossa isolada.
import { app, BrowserWindow, session, desktopCapturer } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.whenReady().then(async () => {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    console.log('[teste] request.audioRequested:', request.audioRequested);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    callback({ video: sources[0] }); // SEM campo audio, igual o main.js real
  });

  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  await win.loadFile(path.join(__dirname, 'blank.html'));

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      return {
        videoTracks: stream.getVideoTracks().length,
        audioTracks: stream.getAudioTracks().length,
        audioTrackLabels: stream.getAudioTracks().map(t => t.label)
      };
    })()
  `);
  console.log('[teste] RESULTADO:', JSON.stringify(result, null, 2));
  app.exit(0);
});

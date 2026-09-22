// Teste de ponta a ponta da parte de vídeo do Electron, isolado do resto do
// app (não precisa entrar numa sala): abre uma janela em branco, chama
// getDisplayMedia() padrão (exatamente o que o LiveKit chama por baixo do
// setScreenShareEnabled), confirma que o seletor customizado (picker.html)
// abre com fontes reais, escolhe a primeira, e confirma que a Promise
// resolve com uma track de vídeo de verdade.
import { app, BrowserWindow, session, desktopCapturer, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.SINAL_TEST_OUT || __dirname;

let pickerWindow = null;

function showSourcePicker(sources){
  return new Promise((resolve) => {
    pickerWindow = new BrowserWindow({
      width: 720, height: 480, resizable: false,
      webPreferences: { preload: path.join(__dirname, '../src/picker-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    pickerWindow.setMenuBarVisibility(false);
    pickerWindow.loadFile(path.join(__dirname, '../src/picker.html'));

    let settled = false;
    const finish = (result) => { if(settled) return; settled = true; resolve(result); if(pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close(); pickerWindow = null; };

    pickerWindow.webContents.once('did-finish-load', async () => {
      const serializable = sources.map((s) => ({ id: s.id, name: s.name, thumbnailDataUrl: s.thumbnail.toDataURL(), isScreen: s.id.startsWith('screen:') }));
      pickerWindow.webContents.send('sources', serializable);

      // Espera renderizar e tira print pra prova visual.
      await new Promise((r) => setTimeout(r, 400));
      const img = await pickerWindow.webContents.capturePage();
      writeFileSync(path.join(OUT_DIR, 'picker-screenshot.png'), img.toPNG());
      console.log('[teste] screenshot do picker salvo, fontes mostradas:', serializable.length);

      // Simula clicar na primeira fonte (em vez de clique de mouse de
      // verdade — o objetivo aqui é validar o fluxo de dados, não o CSS).
      setTimeout(() => {
        if(sources.length > 0) ipcMain.emit('picker:choose', { }, sources[0].id);
      }, 200);
    });

    ipcMain.once('picker:choose', (event, sourceId) => {
      const chosen = sources.find((s) => s.id === sourceId) || null;
      finish(chosen);
    });
    pickerWindow.on('closed', () => finish(null));
  });
}

app.whenReady().then(async () => {
  // Mesma pegadinha do main.js real: session.defaultSession só existe depois
  // do app pronto.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    console.log('[teste] setDisplayMediaRequestHandler chamado. videoRequested=', request.videoRequested, 'audioRequested=', request.audioRequested);
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 300, height: 200 } });
    console.log('[teste] desktopCapturer.getSources devolveu', sources.length, 'fontes:', sources.map((s) => s.name));
    const chosen = await showSourcePicker(sources);
    if(!chosen){ callback({}); return; }
    callback({ video: chosen });
  });

  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  // about:blank não é contexto seguro pro Chromium — mediaDevices nem existe
  // lá. file:// conta como seguro, então serve pra esse teste isolado (o app
  // de verdade carrega https://, então não tem esse problema).
  await win.loadFile(path.join(__dirname, 'blank.html'));

  console.log('[teste] chamando getDisplayMedia() padrao (mesma API que o LiveKit usa)...');
  try{
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
          const track = stream.getVideoTracks()[0];
          return { ok: true, trackLabel: track.label, trackKind: track.kind, trackReadyState: track.readyState, settings: track.getSettings() };
        } catch (e) {
          return { ok: false, error: e.message, name: e.name };
        }
      })()
    `);
    console.log('[teste] RESULTADO getDisplayMedia():', JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  }catch(e){
    console.error('[teste] executeJavaScript falhou:', e);
    process.exitCode = 1;
  }
  app.quit();
});

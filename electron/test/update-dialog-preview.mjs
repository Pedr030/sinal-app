// Preview visual isolado da janela de update (electron/src/update.html) —
// não passa pelo main.js inteiro (evita subir a janela principal/bandeja/
// captura de áudio), só abre a janelinha sozinha com dados falsos, pra
// conferir o visual antes de depender de um ciclo real de atualização.
// Roda com `npx electron test/update-dialog-preview.mjs`, fecha sozinho
// depois de alguns segundos.
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 380,
    height: 260,
    frame: false,
    backgroundColor: '#0b0c0e',
    webPreferences: {
      preload: path.join(__dirname, '../src/update-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, '../src/update.html'));
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('update-info', { version: '0.3.3' });
    console.log('=== janela de update carregada, tirando screenshot em 1s ===');
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      const fs = await import('node:fs');
      const outPath = path.join(__dirname, '../../update-dialog-preview.png');
      fs.writeFileSync(outPath, img.toPNG());
      console.log('screenshot salva em', outPath);
      app.quit();
    }, 1000);
  });
});

const { contextBridge, ipcRenderer } = require('electron');

// Acumula direto aqui no preload (em vez de repassar uma função-callback
// pro mundo isolado via contextBridge) -- mais simples de depurar, evita
// qualquer questão de serialização de função através da ponte.
const stats = { chunks: 0, bytes: 0, maxAmp: 0 };

ipcRenderer.on('sinal:audio-chunk', (_e, buf) => {
  stats.chunks++;
  stats.bytes += buf.length;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for(let i = 0; i + 1 < buf.length; i += 2){
    const s = Math.abs(view.getInt16(i, true));
    if(s > stats.maxAmp) stats.maxAmp = s;
  }
});

contextBridge.exposeInMainWorld('audioTest', {
  getStats: () => ({ ...stats })
});

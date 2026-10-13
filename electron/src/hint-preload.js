// Ponte do aviso no canto da tela (hint.html, ver main.js / HANDOFF §69) — separada do preload.js principal pelo
// mesmo motivo do update-preload.js: essa janela só carrega o nosso hint.html local, escopo mínimo.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hintAPI', {
  open: () => ipcRenderer.send('hint:choice', 'open'),
  close: () => ipcRenderer.send('hint:choice', 'close'),
  // a janela ignora o mouse fora do cartão (os cantos transparentes não seguram clique do jogo)
  setMouseOver: (over) => ipcRenderer.send('hint:mouse', over === true)
});

// Teste da tela de sem conexão no Electron de verdade (modo dev), observando
// pela porta de depuração (CDP). Abre uma janela do app por ~20s — feche o
// app instalado antes (ele só deixa uma cópia rodando). Ver HANDOFF §35.
//
// Uso (na raiz do repo):
//   ELECTRON_DIR=electron PUBLIC_DIR=public NOCACHE_SERVER=electron/test/nocache-server.mjs //     node electron/test/offline-recovery-test.mjs auto     # e depois: manual
//
// O servidor de teste PRECISA mandar "Cache-Control: no-store" (como a Vercel
// manda revalidar): com cache heurístico (ex: python -m http.server), o
// Chromium serve a página guardada sem tentar a rede e a tela de sem conexão
// nunca aparece — falso negativo achado ao escrever este teste.
//   auto   -> servidor fora; liga depois de ~7s; app tem que voltar sozinho
//   manual -> servidor fora; liga; clica "Tentar agora" -> volta na hora
import { spawn } from 'node:child_process';

const ELECTRON_DIR = process.env.ELECTRON_DIR;
const PUBLIC_DIR = process.env.PUBLIC_DIR;
const PORT = Number(process.env.TEST_PORT || 3093), DBG = 9333;
const scenario = process.argv[2] || 'auto';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

async function pages(){
  try{ return await (await fetch(`http://127.0.0.1:${DBG}/json`)).json(); }catch{ return []; }
}
async function mainPage(){
  const list = await pages();
  return list.find((p) => p.type === 'page' && (p.url.includes('offline.html') || p.url.includes(`:${PORT}`)));
}
async function evalIn(page, expr){
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const res = await new Promise((resolve) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if(d.id === 1) resolve(d.result); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });
  ws.close();
  return res && res.result ? res.result.value : undefined;
}

const app = spawn('npx', ['electron', '.', `--remote-debugging-port=${DBG}`], {
  cwd: ELECTRON_DIR, shell: true, env: { ...process.env, SINAL_DEV_URL: `http://127.0.0.1:${PORT}` }
});
let server = null;
const cleanup = () => {
  try{ server && spawn('taskkill', ['/F', '/T', '/PID', String(server.pid)], { shell: true }); }catch{}
  spawn('taskkill', ['/F', '/T', '/PID', String(app.pid)], { shell: true });
};
process.on('exit', cleanup);

try{
  // 1) sem servidor = sem conexão
  let page = null;
  for(let i = 0; i < 40 && !(page && page.url.includes('offline.html')); i++){ await sleep(500); page = await mainPage(); }
  log('página aberta:', page ? page.url.replace(/^.*\//, '') : 'nenhuma');
  if(!page || !page.url.includes('offline.html')) throw new Error('não mostrou a tela de sem conexão');
  for(let i = 0; i < 3; i++){ log('texto:', await evalIn(page, "document.getElementById('statusText').textContent")); await sleep(1500); }

  if(scenario === 'manual'){ await sleep(2500); log('texto antes de ligar:', await evalIn(page, "document.getElementById('statusText').textContent")); }
  // 2) "internet volta"
  server = spawn('node', [process.env.NOCACHE_SERVER, PUBLIC_DIR, String(PORT)]);
  let up = false;
  for(let i = 0; i < 20 && !up; i++){ await sleep(300); try{ up = (await fetch(`http://127.0.0.1:${PORT}/`, { method: 'HEAD' })).ok; }catch{} }
  log('servidor ligado (internet voltou) — respondendo pro teste:', up);
  if(scenario === 'manual'){
    await sleep(1500);
    page = await mainPage();
    await evalIn(page, "document.getElementById('retryBtn').click(); 'click'");
    log('cliquei em Tentar agora');
  }
  let back = null;
  for(let i = 0; i < 70; i++){
    await sleep(500);
    const p = await mainPage();
    if(p && p.url.startsWith(`http://127.0.0.1:${PORT}`)){ back = p; break; }
    if(i % 4 === 0 && p && p.url.includes('offline.html')) log('ainda offline, texto:', await evalIn(p, "document.getElementById('statusText').textContent"));
  }
  log(back ? `VOLTOU sozinho pra ${back.url}` : 'NÃO voltou em 35s');
  if(back){ await sleep(1500); log('título do site:', await evalIn(back, 'document.title')); }
}catch(e){
  log('ERRO:', e.message);
}finally{
  cleanup();
  await sleep(1500);
  process.exit(0);
}

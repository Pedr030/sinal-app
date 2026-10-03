// Teste da recuperação automática + registro do app no Electron de verdade
// (modo dev), observando pela porta de depuração (CDP). Abre uma janela do app
// por ~20s — feche o app instalado antes. Ver HANDOFF §37.
//
// Uso (na raiz do repo):
//   ELECTRON_DIR=electron PUBLIC_DIR=public NOCACHE_SERVER=electron/test/nocache-server.mjs \
//     node electron/test/crash-recovery-test.mjs
//
// Passos: abre o app apontando pra um servidor local -> avisa que está na sala
// "TESTE1" -> derruba o renderer com Page.crash -> confere que a janela voltou
// sozinha (com ?sala=TESTE1), que o registro tem a falha e que getLogTail()
// entrega o texto sem o nome de usuário do Windows.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const ELECTRON_DIR = process.env.ELECTRON_DIR;
const PUBLIC_DIR = process.env.PUBLIC_DIR;
const PORT = Number(process.env.TEST_PORT || 3094), DBG = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const LOG_FILE = join(process.env.APPDATA || '', 'sinal-desktop', 'logs', 'sinal.log');
let failures = 0;
const check = (ok, what) => { log(ok ? 'OK  ' : 'FALHOU', what); if(!ok) failures++; };

async function mainPage(){
  try{
    const list = await (await fetch(`http://127.0.0.1:${DBG}/json`)).json();
    return list.find((p) => p.type === 'page' && p.url.includes(`:${PORT}`));
  }catch{ return null; }
}
async function cdp(page, method, params = {}){
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const res = await new Promise((resolve) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if(d.id === 1) resolve(d.result); };
    ws.send(JSON.stringify({ id: 1, method, params }));
    if(method === 'Page.crash') setTimeout(() => resolve(null), 500);
  });
  try{ ws.close(); }catch{}
  return res;
}
const evalIn = async (page, expr) => (await cdp(page, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;

const server = spawn('node', [process.env.NOCACHE_SERVER, PUBLIC_DIR, String(PORT)]);
await sleep(800);
const app = spawn('npx', ['electron', '.', `--remote-debugging-port=${DBG}`], {
  cwd: ELECTRON_DIR, shell: true, env: { ...process.env, SINAL_DEV_URL: `http://127.0.0.1:${PORT}` }
});
const cleanup = () => {
  spawn('taskkill', ['/F', '/T', '/PID', String(server.pid)], { shell: true });
  spawn('taskkill', ['/F', '/T', '/PID', String(app.pid)], { shell: true });
};
process.on('exit', cleanup);

try{
  let page = null;
  for(let i = 0; i < 40 && !page; i++){ await sleep(500); page = await mainPage(); }
  if(!page) throw new Error('o app não abriu');
  await sleep(2500);
  log('página:', page.url);
  check(await evalIn(page, "typeof window.sinalElectron.getLogTail === 'function'"), 'preload expõe getLogTail');

  await evalIn(page, "window.sinalElectron.log('[sinal-teste] linha de teste'); window.sinalElectron.setInRoom(true, 'TESTE1'); 1");
  await sleep(500);
  const tail = await evalIn(page, 'window.sinalElectron.getLogTail()');
  check(typeof tail === 'string' && tail.includes('[sinal-teste] linha de teste'), 'registro recebeu a linha do renderer');
  const user = os.userInfo().username;
  check(typeof tail === 'string' && !tail.includes(user), `getLogTail não contém o usuário do Windows ("${user.slice(0, 2)}…")`);

  log('derrubando o renderer (Page.crash)…');
  await cdp(page, 'Page.crash');
  let back = null;
  for(let i = 0; i < 40; i++){
    await sleep(500);
    const p = await mainPage();
    // o alvo pode manter o mesmo id depois de recarregar: vale quando a página responde de novo
    if(p && String(await evalIn(p, 'location.search').catch(() => '')).includes('sala=TESTE1')){ back = p; break; }
  }
  check(!!back, 'a janela voltou sozinha depois do crash');
  if(back){
    await sleep(2500);
    const href = await evalIn(back, 'location.search + " | " + document.title');
    log('depois da recuperação:', href);
    check(typeof href === 'string' && href.includes('sala=TESTE1'), 'voltou com ?sala=TESTE1');
    check(typeof href === 'string' && !href.includes('retomar'), 'o ?retomar=1 foi limpo da URL');
  }
  await sleep(500);
  const file = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8') : '';
  check(/a página caiu/.test(file) && /recuperando a janela/.test(file), 'arquivo de registro tem a falha e a recuperação');
  log('últimas linhas do registro:\n' + file.trim().split('\n').slice(-8).join('\n'));
}catch(e){
  failures++; log('ERRO:', e.message);
}finally{
  log(failures ? `${failures} verificação(ões) falharam` : 'tudo certo');
  cleanup(); await sleep(1500); process.exit(0);
}

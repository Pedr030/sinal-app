// Teste do login pelo navegador padrão no Electron de verdade (modo dev), pela
// porta de depuração (CDP). Abre uma janela do app por ~25s — feche o app
// instalado antes (ele só deixa uma cópia rodando). Ver HANDOFF §39 (fase 2c).
//
// NÃO abre navegador nenhum: em modo dev o main grava a URL de login num arquivo
// (SINAL_TEST_LOGIN_FILE) em vez de chamar shell.openExternal. O retorno do
// navegador (sinal://auth) é simulado lançando uma SEGUNDA instância do app com a
// URL — que é exatamente o que o Windows faz — e cai no caminho real do
// 'second-instance'.
//
// Uso (na raiz do repo):
//   ELECTRON_DIR=electron PUBLIC_DIR=public NOCACHE_SERVER=electron/test/nocache-server.mjs \
//     node electron/test/browser-login-test.mjs
//
// Verifica: (1) o botão "Entrar com Discord" no app pede o login ao main com um
// nonce e a URL gerada tem origem do Sinal + o MESMO nonce guardado pelo site;
// (2) sinal://auth com nonce errado é recusado; (3) com o nonce certo a sessão
// é aceita (login aparece, sessão salva); (4) o nonce é de uso único (repetir o
// mesmo link não loga de novo).
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ELECTRON_DIR = process.env.ELECTRON_DIR;
const PUBLIC_DIR = process.env.PUBLIC_DIR;
const PORT = Number(process.env.TEST_PORT || 3095), DBG = 9333;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const LOGIN_FILE = join(tmpdir(), 'sinal-test-login-url.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
let failures = 0;
const check = (ok, what) => { log(ok ? 'OK  ' : 'FALHOU', what); if(!ok) failures++; };

async function mainPage(){
  try{
    const list = await (await fetch(`http://127.0.0.1:${DBG}/json`)).json();
    return list.find((p) => p.type === 'page' && p.url.startsWith(ORIGIN));
  }catch{ return null; }
}
async function cdp(page, method, params = {}){
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const res = await new Promise((resolve) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if(d.id === 1) resolve(d.result); };
    ws.send(JSON.stringify({ id: 1, method, params }));
  });
  try{ ws.close(); }catch{}
  return res;
}
const evalIn = async (page, expr) => (await cdp(page, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;

// Sessão de mentira só no FORMATO (o site só lê o conteúdo; quem confere a assinatura é o servidor).
function fakeSession(name){
  const payload = Buffer.from(JSON.stringify({
    v: 1, id: '900000000000000009', name, avatar: 'https://cdn.discordapp.com/embed/avatars/1.png', admin: false,
    guilds: [['800000000000000001', 'Servidor de Teste', '', 'x']], exp: Date.now() + 60 * 60 * 1000
  })).toString('base64url');
  return payload + '.assinaturaDeTesteSemValor_-0123456789';
}

function launchSecondInstance(url){
  // Igual ao Windows ao clicar num sinal://… com o app já aberto: processo novo com a URL no argv.
  return spawn('npx', ['electron', '.', url], { cwd: ELECTRON_DIR, shell: true, stdio: 'ignore' });
}

if(existsSync(LOGIN_FILE)) rmSync(LOGIN_FILE);
const server = spawn('node', [process.env.NOCACHE_SERVER, PUBLIC_DIR, String(PORT)]);
await sleep(800);
const app = spawn('npx', ['electron', '.', `--remote-debugging-port=${DBG}`], {
  cwd: ELECTRON_DIR, shell: true,
  env: { ...process.env, SINAL_DEV_URL: ORIGIN, SINAL_TEST_LOGIN_FILE: LOGIN_FILE }
});
let page = null;
const cleanup = async () => {
  try{ if(page) await cdp(page, 'Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' }); }catch{}
  spawn('taskkill', ['/F', '/T', '/PID', String(server.pid)], { shell: true });
  spawn('taskkill', ['/F', '/T', '/PID', String(app.pid)], { shell: true });
  try{ rmSync(LOGIN_FILE, { force: true }); }catch{}
};

try{
  for(let i = 0; i < 40 && !page; i++){ await sleep(500); page = await mainPage(); }
  if(!page) throw new Error('o app não abriu');
  await sleep(2500);
  await evalIn(page, "localStorage.clear(); 1"); // começa sem login nenhum
  check(await evalIn(page, "typeof window.sinalElectron.openLogin === 'function' && typeof window.sinalElectron.onAuth === 'function'"), 'preload expõe openLogin/onAuth/takePendingAuth');

  // 1) clicar em "Entrar com Discord" pede o login ao main
  await evalIn(page, "document.getElementById('discordLoginBtn').click(); 1");
  await sleep(1200);
  const stored = JSON.parse((await evalIn(page, "localStorage.getItem('sinal:loginNonce')")) || 'null');
  const url = existsSync(LOGIN_FILE) ? readFileSync(LOGIN_FILE, 'utf8') : '';
  log('URL que o app abriria:', url.replace(/nonce=[a-f0-9]{32}/, 'nonce=<…>'));
  check(!!stored && /^[a-f0-9]{32}$/.test(stored.nonce), 'o site gerou e guardou um nonce');
  check(url === `${ORIGIN}/api/discord-login?client=app&nonce=${stored && stored.nonce}`, 'a URL é do próprio Sinal, com client=app e o mesmo nonce guardado');
  const status1 = await evalIn(page, "document.getElementById('entryStatus').textContent");
  check(/navegador/.test(status1), 'o site avisa pra continuar no navegador: "' + status1 + '"');

  // 2) retorno com nonce ERRADO é recusado
  launchSecondInstance(`sinal://auth?session=${fakeSession('Invasor')}&nonce=${'0'.repeat(32)}`);
  await sleep(4000);
  check(!(await evalIn(page, "localStorage.getItem('sinal:session')")), 'sinal://auth com nonce errado NÃO loga');

  // o nonce errado já consumiu o nonce de uso único — pede outro login
  await evalIn(page, "document.getElementById('discordLoginBtn').click(); 1");
  await sleep(1000);
  const stored2 = JSON.parse(await evalIn(page, "localStorage.getItem('sinal:loginNonce')"));

  // 3) retorno com o nonce certo loga
  const goodUrl = `sinal://auth?session=${fakeSession('Pessoa de Teste')}&nonce=${stored2.nonce}`;
  launchSecondInstance(goodUrl);
  let logged = null;
  for(let i = 0; i < 20 && !logged; i++){ await sleep(500); logged = await evalIn(page, "(discordUser && discordUser.name) || null"); }
  check(logged === 'Pessoa de Teste', 'sinal://auth com o nonce certo loga: ' + logged);
  check(!!(await evalIn(page, "localStorage.getItem('sinal:session')")), 'a sessão ficou salva');
  check((await evalIn(page, "document.getElementById('discordStatus').textContent")).includes('Pessoa de Teste'), 'a tela mostra "Conectado como…"');
  check((await evalIn(page, "!!document.getElementById('srvRail') && !document.getElementById('srvRail').hidden")), 'o trilho de servidores apareceu');

  // 4) nonce é de uso único: repetir o MESMO link depois de deslogar não loga
  await evalIn(page, "clearDiscordUser(); 1");
  launchSecondInstance(goodUrl);
  await sleep(4000);
  check(!(await evalIn(page, "localStorage.getItem('sinal:session')")), 'repetir o mesmo link (nonce já usado) NÃO loga de novo');
}catch(e){
  failures++; log('ERRO:', e.message);
}finally{
  log(failures ? `${failures} verificação(ões) falharam` : 'tudo certo');
  await cleanup(); await sleep(1500); process.exit(0);
}

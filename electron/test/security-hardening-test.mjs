// Teste do endurecimento de segurança do Electron (HANDOFF §42) no app de verdade (modo dev),
// pela porta de depuração (CDP). Abre uma janela do app por ~45s, num perfil temporário
// (não precisa fechar o app instalado nem mexe nas suas configurações).
//
// Uso (na raiz do repo):
//   ELECTRON_DIR=electron PUBLIC_DIR=public NOCACHE_SERVER=electron/test/nocache-server.mjs \
//     node electron/test/security-hardening-test.mjs
//
// Nada abre o navegador de verdade: links externos viram linhas num arquivo (só em modo dev).
// Verifica: (1) window.open e link externo NÃO abrem janela do app (https vai pro navegador,
// http não); (2) navegar a janela pra fora do site é bloqueado; (3) outra ORIGEM que consiga
// carregar no app não ganha poder nenhum (IPC recusado, permissões negadas); (4) o site só
// consegue gravar configurações válidas (atalho perigoso e chaves desconhecidas ignorados);
// (5) pedir "captura sem seletor" fora do atalho global de verdade não entrega a tela;
// (6) link sinal:// malformado não derruba o app e código estranho é ignorado.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ELECTRON_DIR = process.env.ELECTRON_DIR;
const PUBLIC_DIR = process.env.PUBLIC_DIR;
const PORT = Number(process.env.TEST_PORT || 3096), FOREIGN_PORT = PORT + 1, DBG = 9333;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const FOREIGN = `http://127.0.0.1:${FOREIGN_PORT}`;
// Perfil só do teste (pasta temporária): não precisa fechar o app instalado e não mexe nas suas configurações.
const PROFILE = process.env.TEST_PROFILE || mkdtempSync(join(tmpdir(), 'sinal-test-profile-'));
const PROFILE_ARG = `--user-data-dir="${PROFILE}"`;
const EXT_FILE = join(tmpdir(), 'sinal-test-external-urls.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
let failures = 0;
const check = (ok, what) => { log(ok ? 'OK  ' : 'FALHOU', what); if(!ok) failures++; };

async function targets(){
  try{ return await (await fetch(`http://127.0.0.1:${DBG}/json`)).json(); }catch{ return []; }
}
const pageTargets = async () => (await targets()).filter((t) => t.type === 'page');
const findPage = async (prefix) => (await pageTargets()).find((t) => t.url.startsWith(prefix));

async function cdp(target, method, params = {}){
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const res = await new Promise((resolve) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if(d.id === 1) resolve(d); };
    ws.send(JSON.stringify({ id: 1, method, params }));
  });
  try{ ws.close(); }catch{}
  return res.result;
}
const evalIn = async (target, expr, userGesture = false) =>
  (await cdp(target, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture }))?.result?.value;
const hostOf = (raw) => { try{ return new URL(raw).hostname; }catch{ return ''; } };
const externalUrls = () => (existsSync(EXT_FILE) ? readFileSync(EXT_FILE, 'utf8').split(String.fromCharCode(10)).filter(Boolean) : []);

function launchSecondInstance(url){
  // Igual ao Windows ao abrir um sinal://… com o app já rodando (aspas por causa do "&" no cmd).
  return spawn('npx', ['electron', '.', PROFILE_ARG, `"${url}"`], { cwd: ELECTRON_DIR, shell: true, stdio: 'ignore' });
}

if(existsSync(EXT_FILE)) rmSync(EXT_FILE);
writeFileSync(EXT_FILE, '');
const servers = [PORT, FOREIGN_PORT].map((p) => spawn('node', [process.env.NOCACHE_SERVER, PUBLIC_DIR, String(p)]));
await sleep(900);
const app = spawn('npx', ['electron', '.', `--remote-debugging-port=${DBG}`, PROFILE_ARG], {
  cwd: ELECTRON_DIR, shell: true,
  env: { ...process.env, SINAL_DEV_URL: ORIGIN, SINAL_TEST_EXTERNAL_FILE: EXT_FILE }
});
let page = null, originalSettings = null;
const cleanup = async () => {
  try{
    const p = await findPage(ORIGIN) || page;
    if(p && originalSettings){
      const { shortcut, shortcutEnabled, quickShareWholeScreen, startWithWindows, startMinimized, excludedAudioApps, shareQuality } = originalSettings;
      await evalIn(p, `window.sinalElectron.setSettings(${JSON.stringify({ shortcut, shortcutEnabled, quickShareWholeScreen, startWithWindows, startMinimized, excludedAudioApps, shareQuality })})`);
    }
    if(p){
      for(const origin of [ORIGIN, FOREIGN]) await cdp(p, 'Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    }
  }catch{}
  servers.forEach((srv) => spawn('taskkill', ['/F', '/T', '/PID', String(srv.pid)], { shell: true }));
  spawn('taskkill', ['/F', '/T', '/PID', String(app.pid)], { shell: true });
  try{ rmSync(EXT_FILE, { force: true }); }catch{}
  setTimeout(() => { try{ rmSync(PROFILE, { recursive: true, force: true }); }catch{} }, 2500);
};

try{
  for(let i = 0; i < 40 && !page; i++){ await sleep(500); page = await findPage(ORIGIN); }
  if(!page) throw new Error('o app não abriu');
  await sleep(2500);
  originalSettings = await evalIn(page, 'window.sinalElectron.getSettings()');
  check(!!originalSettings && typeof originalSettings.shortcut === 'string', 'IPC legítimo (site do Sinal) funciona: getSettings');

  // ---- (1) janelas novas e links externos ----
  const before = (await pageTargets()).length;
  await evalIn(page, "window.open('https://example.com/pelo-window-open'); 1", true);
  await evalIn(page, "(() => { const a = document.createElement('a'); a.href = 'https://example.com/link-target-blank'; a.target = '_blank'; document.body.appendChild(a); a.click(); a.remove(); return 1; })()", true);
  await evalIn(page, "window.open('http://example.com/sem-https'); 1", true);
  await evalIn(page, "window.open('file:///C:/Windows/System32/drivers/etc/hosts'); 1", true);
  await sleep(1500);
  const after = await pageTargets();
  check(after.length === before, `window.open / target=_blank não abrem janela do app (páginas antes=${before}, depois=${after.length})`);
  const ext = externalUrls();
  const extSet = new Set(ext);
  check(extSet.has('https://example.com/pelo-window-open') && extSet.has('https://example.com/link-target-blank'), 'links https vão pro navegador do sistema: ' + JSON.stringify(ext));
  check(ext.every((u) => new URL(u).protocol === 'https:'), 'http: e file: NUNCA são abertos');

  // ---- (2) navegar a janela pra fora do site ----
  await evalIn(page, "location.href = 'https://example.org/navegacao'; 1", true);
  await sleep(1500);
  const stillHere = await findPage(ORIGIN);
  check(!!stillHere && !(await pageTargets()).some((t) => hostOf(t.url) === 'example.org'), 'a janela não saiu do site ao tentar navegar pra https://example.org');
  check(new Set(externalUrls()).has('https://example.org/navegacao'), 'a navegação bloqueada foi encaminhada ao navegador do sistema');
  page = stillHere;

  // ---- (4) configurações válidas ----
  const bad = await evalIn(page, "window.sinalElectron.setSettings({ shortcut: 'Control+C', junk: 123, startMinimized: 'sim', shareQuality: 'ultra', excludedAudioApps: 'nao-lista' })");
  check(bad && bad.settings.shortcut === originalSettings.shortcut, 'atalho global perigoso (Ctrl+C) é ignorado');
  check(bad && !('junk' in bad.settings), 'chave desconhecida não é gravada');
  check(bad && bad.settings.startMinimized === originalSettings.startMinimized && bad.settings.shareQuality === originalSettings.shareQuality, 'valores do tipo errado/fora da lista são ignorados');
  for(const perigoso of ['Shift+A', 'Control+V', 'Alt+F4', 'Control+Alt+Enter', 'Control+Control+A', 'Control+Alt+AB']){
    const r = await evalIn(page, `window.sinalElectron.setSettings({ shortcut: ${JSON.stringify(perigoso)} })`);
    check(r.settings.shortcut === originalSettings.shortcut, `atalho "${perigoso}" recusado`);
  }
  const good = await evalIn(page, "window.sinalElectron.setSettings({ shortcut: 'Control+Alt+K' })");
  check(good.settings.shortcut === 'Control+Alt+K', 'atalho válido (Ctrl+Alt+K) é aceito');
  await evalIn(page, `window.sinalElectron.setSettings({ shortcut: ${JSON.stringify(originalSettings.shortcut)} })`);

  // ---- permissões no site do Sinal ----
  const geo = await evalIn(page, "navigator.permissions.query({ name: 'geolocation' }).then((r) => r.state)");
  check(geo === 'denied', 'localização é negada pro site (lista de permitidas): ' + geo);
  const cam = await evalIn(page, "navigator.permissions.query({ name: 'camera' }).then((r) => r.state)");
  check(cam !== 'denied', 'câmera continua permitida pro site do Sinal (precisa pra ligar a câmera): ' + cam);

  // ---- (5) captura sem seletor fora do atalho global ----
  await evalIn(page, "window.sinalElectron.setSettings({ quickShareWholeScreen: true })");
  await evalIn(page, "window.sinalElectron.requestQuickShare(); 1");
  await evalIn(page, "window.__cap = null; navigator.mediaDevices.getDisplayMedia({ video: true }).then((s) => { window.__cap = 'CAPTUROU'; s.getTracks().forEach((t) => t.stop()); }).catch((e) => { window.__cap = 'recusou:' + e.name; }); 1", true);
  let pickerTarget = null;
  for(let i = 0; i < 12 && !pickerTarget; i++){ await sleep(400); pickerTarget = (await pageTargets()).find((t) => t.url.includes('picker.html')); }
  const captured = await evalIn(page, 'window.__cap');
  check(captured !== 'CAPTUROU' && !!pickerTarget, 'requestQuickShare fora do atalho NÃO entrega a tela sem seletor — o seletor apareceu (captura=' + captured + ')');
  if(pickerTarget) await evalIn(pickerTarget, 'pickerAPI.cancel(); 1');
  await sleep(1000);
  await evalIn(page, "window.sinalElectron.setSettings({ quickShareWholeScreen: false })");

  // ---- (3) outra ORIGEM carregada no app ----
  await cdp(page, 'Page.navigate', { url: FOREIGN + '/' });
  let foreign = null;
  for(let i = 0; i < 20 && !foreign; i++){ await sleep(400); foreign = await findPage(FOREIGN); }
  if(!foreign){
    log('(a navegação por CDP até a outra origem também foi bloqueada — o bloqueio de navegação vale até pra isso; pulando testes de IPC entre origens)');
  } else {
    await sleep(1500);
    const hasApi = await evalIn(foreign, "typeof window.sinalElectron");
    log('API exposta na outra origem pelo preload:', hasApi);
    const settingsFromForeign = await evalIn(foreign, "window.sinalElectron && window.sinalElectron.getSettings ? window.sinalElectron.getSettings().then((x) => (x === undefined ? 'recusado' : 'RESPONDEU')).catch(() => 'recusado') : 'sem api'");
    check(settingsFromForeign !== 'RESPONDEU', 'IPC getSettings vindo de OUTRA origem é recusado: ' + settingsFromForeign);
    const writeFromForeign = await evalIn(foreign, "window.sinalElectron && window.sinalElectron.setSettings ? window.sinalElectron.setSettings({ startMinimized: true }).then((x) => (x === undefined ? 'recusado' : 'RESPONDEU')).catch(() => 'recusado') : 'sem api'");
    check(writeFromForeign !== 'RESPONDEU', 'IPC setSettings vindo de OUTRA origem é recusado: ' + writeFromForeign);
    const logFromForeign = await evalIn(foreign, "window.sinalElectron && window.sinalElectron.getLogTail ? window.sinalElectron.getLogTail().then((x) => (x === undefined ? 'recusado' : 'RESPONDEU')).catch(() => 'recusado') : 'sem api'");
    check(logFromForeign !== 'RESPONDEU', 'IPC getLogTail vindo de OUTRA origem é recusado: ' + logFromForeign);
    const versionFromForeign = await evalIn(foreign, "window.sinalElectron ? window.sinalElectron.appVersion : 'sem api'");
    check(!versionFromForeign || versionFromForeign === 'sem api', 'appVersion (síncrono) vem vazio pra outra origem: ' + JSON.stringify(versionFromForeign));
    const camForeign = await evalIn(foreign, "navigator.permissions.query({ name: 'camera' }).then((r) => r.state)");
    check(camForeign === 'denied', 'câmera é NEGADA pra outra origem: ' + camForeign);
    const geoForeign = await evalIn(foreign, "navigator.permissions.query({ name: 'geolocation' }).then((r) => r.state)");
    check(geoForeign === 'denied', 'localização é NEGADA pra outra origem: ' + geoForeign);
    const capForeign = await evalIn(foreign, "navigator.mediaDevices.getDisplayMedia({ video: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'CAPTUROU'; }).catch((e) => 'recusou:' + e.name)", true);
    check(capForeign !== 'CAPTUROU', 'captura de tela por OUTRA origem é recusada: ' + capForeign);
    await cdp(foreign, 'Page.navigate', { url: ORIGIN + '/' });
    for(let i = 0; i < 20 && !(page = await findPage(ORIGIN)); i++) await sleep(400);
    await sleep(1500);
  }
  check(!!(await evalIn(page, 'window.sinalElectron.getSettings()')), 'depois de voltar ao site do Sinal, o IPC legítimo volta a funcionar');

  // ---- (6) links sinal:// ----
  launchSecondInstance('sinal://join?sala=%');
  await sleep(4000);
  check((await evalIn(page, '1 + 1')) === 2, 'sinal://join?sala=% (percent malformado) NÃO derruba o app');
  launchSecondInstance('sinal://join?sala=../../etc/passwd');
  await sleep(3500);
  check(!(await findPage(ORIGIN)).url.includes('etc'), 'código de sala estranho (../../etc/passwd) é ignorado');
  launchSecondInstance('sinal://join?sala=ABC123');
  let navigated = false;
  for(let i = 0; i < 15 && !navigated; i++){ await sleep(500); const t = await findPage(ORIGIN); navigated = !!t && t.url.includes('sala=ABC123'); }
  check(navigated, 'sinal://join?sala=ABC123 (normal) continua funcionando');
  page = await findPage(ORIGIN);
}catch(e){
  failures++; log('ERRO:', e.message);
}finally{
  log(failures ? `${failures} verificação(ões) falharam` : 'tudo certo');
  await cleanup(); await sleep(1500); process.exit(0);
}

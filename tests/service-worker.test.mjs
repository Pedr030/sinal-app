// public/sw.js (service worker do site). Regressão de 2026-10-04: com o CSP restrito (connect-src só
// o próprio site e o LiveKit), o fetch() do service worker passou a ser BLOQUEADO para qualquer
// pedido de outro domínio (fontes do Google, avatares do Discord, script do livekit-client no
// jsDelivr). Resultado: depois de um refresh normal a página abria sem fonte, sem imagem e sem o
// LiveKit (sem entrar em sala); só o Ctrl+Shift+R (que pula o service worker) funcionava.
// O service worker só pode tratar pedidos do PRÓPRIO site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const swSource = readFileSync(join(ROOT, 'public/sw.js'), 'utf8');

// Roda o sw.js num "escopo de service worker" falso e devolve o ouvinte de 'fetch'.
function loadServiceWorker({ fetchImpl } = {}){
  const handlers = {};
  const self = {
    location: { origin: 'https://sinal.test' },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting(){},
    clients: { claim: async () => {} }
  };
  const sandbox = {
    self,
    caches: { open: async () => ({ addAll: async () => {} }), keys: async () => [], delete: async () => true, match: async () => undefined },
    fetch: fetchImpl || (async () => new Response('rede')),
    Response, URL, Promise
  };
  vm.runInNewContext(swSource, sandbox);
  return { fetchHandler: handlers.fetch, sandbox };
}

// Simula um FetchEvent e diz se o service worker assumiu o pedido (respondWith) e o que respondeu.
async function dispatch(fetchHandler, url, method = 'GET'){
  let responded;
  fetchHandler({ request: { url, method }, respondWith: (p) => { responded = Promise.resolve(p); } });
  return responded ? { handled: true, response: await responded } : { handled: false };
}

test('pedido do PRÓPRIO site (GET): o service worker trata (rede primeiro)', async () => {
  const { fetchHandler } = loadServiceWorker();
  const r = await dispatch(fetchHandler, 'https://sinal.test/app.js');
  assert.equal(r.handled, true);
  assert.equal(await r.response.text(), 'rede');
});

test('pedido de OUTRO domínio NÃO é tratado: fontes, avatares do Discord e o script do LiveKit vão direto pro navegador', async () => {
  const { fetchHandler } = loadServiceWorker();
  for(const url of [
    'https://fonts.googleapis.com/css2?family=Inter&display=swap',
    'https://fonts.gstatic.com/s/inter/v13/arquivo.woff2',
    'https://cdn.discordapp.com/avatars/1/abc.png?size=64',
    'https://cdn.jsdelivr.net/npm/livekit-client@2.22.3/dist/livekit-client.umd.min.js',
    'https://sinal-app.duckdns.org/rtc/validate',
    'https://sinal.test.evil.com/app.js',   // parece o site mas é outro host
    'http://sinal.test/app.js'              // mesmo host, protocolo diferente = outra origem
  ]){
    const r = await dispatch(fetchHandler, url);
    assert.equal(r.handled, false, url);
  }
});

test('método que não é GET (POST de /api) segue ignorado', async () => {
  const { fetchHandler } = loadServiceWorker();
  assert.equal((await dispatch(fetchHandler, 'https://sinal.test/api/get-token', 'POST')).handled, false);
});

test('rede caiu e não há cache: falha de verdade (Response.error), sem respondWith(undefined)', async () => {
  const { fetchHandler } = loadServiceWorker({ fetchImpl: async () => { throw new TypeError('offline'); } });
  const r = await dispatch(fetchHandler, 'https://sinal.test/index.html');
  assert.equal(r.handled, true);
  assert.equal(r.response.type, 'error');
});

test('rede caiu mas o arquivo está no cache: devolve o cache (janela abre mesmo offline)', async () => {
  const cached = new Response('do cache');
  const handlers = {};
  const self = { location: { origin: 'https://sinal.test' }, addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting(){}, clients: { claim: async () => {} } };
  vm.runInNewContext(swSource, {
    self,
    caches: { open: async () => ({ addAll: async () => {} }), keys: async () => [], delete: async () => true, match: async () => cached },
    fetch: async () => { throw new TypeError('offline'); },
    Response, URL, Promise
  });
  const r = await dispatch(handlers.fetch, 'https://sinal.test/index.html');
  assert.equal(await r.response.text(), 'do cache');
});

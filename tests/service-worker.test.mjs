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
// O Request do Node não aceita endereço relativo ('./index.html'); este guarda só o que o sw.js passa.
class FakeRequest { constructor(url, init){ this.url = url; this.cache = init && init.cache; } }

function loadServiceWorker({ fetchImpl, cached = {}, added = [] } = {}){
  const handlers = {};
  const self = {
    location: { origin: 'https://sinal.test' },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting(){},
    clients: { claim: async () => {} }
  };
  const sandbox = {
    self,
    caches: {
      open: async () => ({ addAll: async (list) => { added.push(...list); } }), keys: async () => [], delete: async () => true,
      match: async (req) => cached[typeof req === 'string' ? req : req.url]
    },
    fetch: fetchImpl || (async () => new Response('rede')),
    Response, URL, Promise, Request: FakeRequest
  };
  vm.runInNewContext(swSource, sandbox);
  return { fetchHandler: handlers.fetch, installHandler: handlers.install, sandbox };
}

// Simula um FetchEvent e diz se o service worker assumiu o pedido (respondWith) e o que respondeu.
async function dispatch(fetchHandler, url, method = 'GET', mode){
  let responded;
  fetchHandler({ request: { url, method, mode }, respondWith: (p) => { responded = Promise.resolve(p); } });
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
  const { fetchHandler } = loadServiceWorker({
    fetchImpl: async () => { throw new TypeError('offline'); },
    cached: { 'https://sinal.test/index.html': new Response('do cache') }
  });
  const r = await dispatch(fetchHandler, 'https://sinal.test/index.html');
  assert.equal(await r.response.text(), 'do cache');
});

test('resposta de erro com o arquivo no cache: usa o cache (um 503 no CSS não abre a página sem estilo)', async () => {
  const { fetchHandler } = loadServiceWorker({
    fetchImpl: async () => new Response('erro', { status: 503 }),
    cached: { 'https://sinal.test/style.css': new Response('do cache') }
  });
  const r = await dispatch(fetchHandler, 'https://sinal.test/style.css');
  assert.equal(await r.response.text(), 'do cache');
});

test('resposta de erro sem nada no cache: a resposta original passa (a página vê o 401 da API, não uma falha de rede)', async () => {
  const { fetchHandler } = loadServiceWorker({ fetchImpl: async () => new Response('negado', { status: 401 }) });
  const r = await dispatch(fetchHandler, 'https://sinal.test/api/lives');
  assert.equal(r.response.status, 401);
});

test('navegação offline por "/" e por convite "/?sala=X" cai na index.html guardada', async () => {
  const { fetchHandler } = loadServiceWorker({
    fetchImpl: async () => { throw new TypeError('offline'); },
    cached: { './index.html': new Response('página guardada') }
  });
  for(const url of ['https://sinal.test/', 'https://sinal.test/?sala=ABC123']){
    const r = await dispatch(fetchHandler, url, 'GET', 'navigate');
    assert.equal(await r.response.clone().text(), 'página guardada', url);
  }
});

test('navegação com erro do servidor (5xx) cai na index.html; um 404 continua 404', async () => {
  const cached = { './index.html': new Response('página guardada') };
  const erro503 = loadServiceWorker({ fetchImpl: async () => new Response('erro', { status: 503 }), cached });
  assert.equal(await (await dispatch(erro503.fetchHandler, 'https://sinal.test/', 'GET', 'navigate')).response.text(), 'página guardada');
  const erro404 = loadServiceWorker({ fetchImpl: async () => new Response('não existe', { status: 404 }), cached });
  assert.equal((await dispatch(erro404.fetchHandler, 'https://sinal.test/nada', 'GET', 'navigate')).response.status, 404);
});

test('login: redirecionamento na navegação (opaqueredirect) passa direto e /api nunca vira a página inicial', async () => {
  const cached = { './index.html': new Response('página guardada') };
  const redirect = { ok: false, status: 0, type: 'opaqueredirect' };
  const login = loadServiceWorker({ fetchImpl: async () => redirect, cached });
  assert.equal((await dispatch(login.fetchHandler, 'https://sinal.test/api/discord-login', 'GET', 'navigate')).response, redirect);
  const caiu = loadServiceWorker({ fetchImpl: async () => new Response('erro', { status: 502 }), cached });
  assert.equal((await dispatch(caiu.fetchHandler, 'https://sinal.test/api/discord-callback?code=x', 'GET', 'navigate')).response.status, 502);
  const offline = loadServiceWorker({ fetchImpl: async () => { throw new TypeError('offline'); }, cached });
  assert.equal((await dispatch(offline.fetchHandler, 'https://sinal.test/api/discord-login', 'GET', 'navigate')).response.type, 'error');
});

test('pré-cache pede tudo com cache:"reload": versão nova não guarda arquivo velho do cache HTTP', async () => {
  const added = [];
  const { installHandler } = loadServiceWorker({ added });
  let done;
  installHandler({ waitUntil: (p) => { done = p; } });
  await done;
  assert.ok(added.length >= 5);
  assert.ok(added.every((r) => r.cache === 'reload'));
  assert.ok(added.some((r) => r.url === './index.html'));
});

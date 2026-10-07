// IMPORTANTE: mude o número da versão aqui a cada publicação (mesmo sem mexer no resto
// do arquivo) — é assim que o navegador percebe que existe uma atualização e avisa o app.
const CACHE = 'sinal-shell-0.8.62';
const SHELL = ['./index.html', './style.css', './app.js', './audio-mixer-worklet.js', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// network-first: a ferramenta precisa de rede real pra funcionar (é WebRTC ao vivo),
// o cache aqui só garante que a janela do app abre mesmo com uma rede instável.
self.addEventListener('fetch', (event) => {
  // Só GET passa por aqui. A partir da v0.8.31 o app faz POST em /api/get-token,
  // e POST não é cacheável: cairia no caches.match(), que devolve undefined, e
  // respondWith(undefined) quebra a requisição. Deixar passar direto pra rede.
  if(event.request.method !== 'GET') return;
  // Só o que é do PRÓPRIO site passa por aqui. Pedido de outro domínio (fontes do Google, avatares
  // e ícones do Discord, o script do livekit-client no jsDelivr…) vai direto pro navegador, que
  // confere o CSP DA PÁGINA. Se o service worker pegasse esses pedidos, o fetch() dele seria
  // conferido pelo CSP do próprio sw.js (connect-src, que restringe pra só o site e o LiveKit) e
  // seria BLOQUEADO — a página abria sem fonte, sem imagem e, pior, sem o script do LiveKit (sem
  // ele não entra em sala). Era o bug de "só funciona com Ctrl+Shift+R" (HANDOFF §42).
  if(new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    // Sem cache pra devolver, falha de verdade (Response.error) em vez de respondWith(undefined).
    fetch(event.request).catch(async () => (await caches.match(event.request)) || Response.error())
  );
});

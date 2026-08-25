// IMPORTANTE: mude o número da versão aqui a cada publicação (mesmo sem mexer no resto
// do arquivo) — é assim que o navegador percebe que existe uma atualização e avisa o app.
const CACHE = 'sinal-shell-0.8.11';
const SHELL = ['./index.html', './style.css', './app.js', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

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
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

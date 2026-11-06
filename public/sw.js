// IMPORTANTE: mude o número da versão aqui a cada publicação (mesmo sem mexer no resto
// do arquivo) — é assim que o navegador percebe que existe uma atualização e avisa o app.
const CACHE = 'sinal-shell-0.8.87';
const SHELL = ['./index.html', './style.css', './app.js', './audio-mixer-worklet.js', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // cache:'reload' pula o cache HTTP do navegador: sem isso, uma versão nova podia guardar arquivo velho.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// O que está guardado pra esse pedido. A página aberta por "/" ou "/?sala=X" não tem entrada própria no cache, então
// a navegação cai na index.html guardada. As funções em /api ficam de fora: login e callback não viram a página inicial.
async function fromCache(request, useShell){
  const hit = await caches.match(request);
  if(hit) return hit;
  if(!useShell || request.mode !== 'navigate' || new URL(request.url).pathname.startsWith('/api/')) return undefined;
  return caches.match('./index.html');
}

async function networkFirst(request){
  let res;
  try{
    res = await fetch(request);
  }catch(e){
    // Sem cache pra devolver, falha de verdade (Response.error) em vez de respondWith(undefined).
    return (await fromCache(request, true)) || Response.error();
  }
  // Navegação recebe redirecionamento como "opaqueredirect" (status 0, ok false): é o login do Discord, não é erro.
  if(res.ok || res.type === 'opaqueredirect') return res;
  // Resposta de erro não vale como arquivo: um 503 no style.css abria a página sem CSS mesmo com o CSS guardado.
  // A index.html só substitui erro do servidor (5xx); um 404 de verdade continua sendo 404.
  return (await fromCache(request, res.status >= 500)) || res;
}

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
  event.respondWith(networkFirst(event.request));
});

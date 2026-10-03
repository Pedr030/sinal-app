// Login com Discord pelo navegador padrão (HANDOFF §39, fase 2c) — peças puras,
// separadas do main.js pra poderem ser testadas sem abrir o Electron
// (tests/auth-url.test.mjs).
//
// Fluxo: o site (rodando no app) gera um nonce e pede ao main pra abrir o
// navegador em <site>/api/discord-login?client=app&nonce=…; depois do login o
// navegador chama sinal://auth?session=…&nonce=… e o main entrega pro site, que
// só aceita se o nonce for o que ele mesmo gerou.

const NONCE_RE = /^[a-f0-9]{32}$/;
const SESSION_RE = /^[A-Za-z0-9_.-]{20,10000}$/;
const MAX_URL_CHARS = 12000;

function isValidNonce(nonce){
  return typeof nonce === 'string' && NONCE_RE.test(nonce);
}

// URL que o main abre no navegador. Origem sempre a do próprio Sinal (nunca
// vem do site), e o nonce é conferido antes de montar.
function buildLoginUrl(siteUrl, nonce, { refresh } = {}){
  if(!isValidNonce(nonce)) return null;
  return `${siteUrl}/api/discord-login?client=app&nonce=${nonce}${refresh ? '&refresh=1' : ''}`;
}

// sinal://auth?session=…&nonce=… → { session, nonce } ou null. Formato estrito:
// o que não for exatamente o que o servidor gera é descartado.
function parseAuthUrl(raw){
  if(typeof raw !== 'string' || raw.length > MAX_URL_CHARS || !raw.startsWith('sinal://auth')) return null;
  let url;
  try{ url = new URL(raw); }catch(e){ return null; }
  if(url.host !== 'auth') return null;
  const session = url.searchParams.get('session') || '';
  const nonce = url.searchParams.get('nonce') || '';
  if(!SESSION_RE.test(session) || !isValidNonce(nonce)) return null;
  return { session, nonce };
}

module.exports = { isValidNonce, buildLoginUrl, parseAuthUrl };

// api/discord-login.js e api/discord-callback.js com o Discord "de mentira"
// (fetch trocado): confere os escopos pedidos, a sessão assinada no fragmento
// da URL e o que acontece quando o Discord falha.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GET as callback } from '../api/discord-callback.js';
import { GET as login } from '../api/discord-login.js';
import { verifySession } from '../lib/session.js';

const SECRET = 'segredo-do-discord-de-teste';
const realFetch = globalThis.fetch;
let calls;

before(() => {
  process.env.DISCORD_CLIENT_ID = 'client-id-teste';
  process.env.DISCORD_CLIENT_SECRET = SECRET;
  process.env.ADMIN_DISCORD_IDS = '777000000000000001, 555000000000000002';
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls = []; });

function fakeDiscord({ profile, guilds, guildsStatus = 200, tokenStatus = 200 }){
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const u = String(url);
    if(u.endsWith('/oauth2/token')) return tokenStatus === 200 ? Response.json({ access_token: 'tok' }) : new Response('x', { status: tokenStatus });
    if(u.endsWith('/users/@me')) return Response.json(profile);
    if(u.endsWith('/users/@me/guilds')) return guildsStatus === 200 ? Response.json(guilds) : new Response('x', { status: guildsStatus });
    throw new Error('chamada inesperada: ' + u);
  };
}
const CSRF = 'c0ffee00c0ffee00c0ffee00c0ffee00';
// Por padrão manda o cookie que o discord-login.js deixaria no navegador (a validação anti login-CSRF).
const cb = (qs, cookie = 'sinal_oauth=' + CSRF) => callback(new Request('https://sinal.test/api/discord-callback?' + qs, cookie ? { headers: { cookie } } : undefined));
const sessionFrom = (res) => verifySession(new URL(res.headers.get('location')).hash.replace('#session=', ''), SECRET);

test('login pede identify + guilds; o state é "<nonce>.<SALA>" e o MESMO nonce vai num cookie HttpOnly', async () => {
  const res = await login(new Request('https://sinal.test/api/discord-login?sala=abc123'));
  const url = new URL(res.headers.get('location'));
  assert.equal(res.status, 302);
  assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(url.searchParams.get('scope'), 'identify guilds');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://sinal.test/api/discord-callback');
  const [nonce, sala] = url.searchParams.get('state').split('.');
  assert.match(nonce, /^[a-f0-9]{32}$/);
  assert.equal(sala, 'ABC123');
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie.startsWith('sinal_oauth=' + nonce + ';'));
  for(const part of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/api/discord-callback', 'Max-Age=600']) assert.ok(cookie.includes(part), part);
});

test('login: cada pedido gera um nonce diferente', async () => {
  const get = async () => new URL((await login(new Request('https://sinal.test/api/discord-login'))).headers.get('location')).searchParams.get('state');
  assert.notEqual(await get(), await get());
});

test('login com refresh=1 usa prompt=none (renovar servers sem tela de consentimento); sem refresh, não', async () => {
  const withRefresh = new URL((await login(new Request('https://sinal.test/api/discord-login?refresh=1'))).headers.get('location'));
  assert.equal(withRefresh.searchParams.get('prompt'), 'none');
  const normal = new URL((await login(new Request('https://sinal.test/api/discord-login'))).headers.get('location'));
  assert.equal(normal.searchParams.get('prompt'), null);
});

test('callback: sessão assinada no FRAGMENTO (não na query) com nome, avatar e servers', async () => {
  fakeDiscord({
    profile: { id: '100000000000000001', username: 'u', global_name: 'Fulano', avatar: 'h' },
    guilds: [{ id: '1', name: 'Galera', icon: 'i', owner: true, permissions: '0' }]
  });
  const res = await cb('code=xyz&state=' + CSRF + '.ABC123');
  const loc = new URL(res.headers.get('location'));
  assert.equal(res.status, 302);
  assert.equal(loc.origin, 'https://sinal.test');
  assert.equal(loc.searchParams.get('sala'), 'ABC123');
  assert.match(res.headers.get('set-cookie'), /^sinal_oauth=; Max-Age=0/); // o cookie é apagado depois de usado
  assert.equal([...loc.searchParams.keys()].some((k) => k.startsWith('discord_')), false); // nada do formato antigo
  assert.equal(loc.search.includes('session'), false);
  const s = sessionFrom(res);
  assert.equal(s.name, 'Fulano');
  assert.equal(s.admin, false);
  assert.deepEqual(s.guilds, [['1', 'Galera', 'i', 'o']]);
  // o token do Discord é usado nas duas chamadas e não vai a lugar nenhum
  assert.ok(calls.filter((c) => c.opts.headers && c.opts.headers.authorization === 'Bearer tok').length === 2);
  assert.equal(res.headers.get('location').includes('Bearer'), false);
});

test('callback: ID de ADMIN_DISCORD_IDS vira admin do Sinal', async () => {
  fakeDiscord({ profile: { id: '555000000000000002', username: 'dono' }, guilds: [] });
  assert.equal(sessionFrom(await cb('code=xyz&state=' + CSRF)).admin, true);
});

test('callback: se a lista de servers falhar, o login continua (sem servers)', async () => {
  fakeDiscord({ profile: { id: '100000000000000001', username: 'u' }, guilds: [], guildsStatus: 429 });
  const s = sessionFrom(await cb('code=xyz&state=' + CSRF));
  assert.equal(s.name, 'u');
  assert.deepEqual(s.guilds, []);
});

test('callback: sem code, ou Discord recusando o code: volta com ?discord_error=1 e sem sessão', async () => {
  const noCode = await cb('state=' + CSRF);
  assert.equal(new URL(noCode.headers.get('location')).searchParams.get('discord_error'), '1');
  fakeDiscord({ profile: {}, guilds: [], tokenStatus: 400 });
  const refused = await cb('code=ruim&state=' + CSRF);
  const loc = new URL(refused.headers.get('location'));
  assert.equal(loc.searchParams.get('discord_error'), '1');
  assert.equal(loc.hash, '');
});

// ---------- login pedido pelo app desktop (HANDOFF §39, fase 2c) ----------
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

test('login do app: o nonce vai no state ("app.<nonce>") e a sala digitada é ignorada', async () => {
  const res = await login(new Request(`https://sinal.test/api/discord-login?client=app&nonce=${NONCE}&sala=ABC123`));
  assert.equal(new URL(res.headers.get('location')).searchParams.get('state'), 'app.' + NONCE);
});

test('login do app: com refresh=1 também usa prompt=none', async () => {
  const res = await login(new Request(`https://sinal.test/api/discord-login?client=app&nonce=${NONCE}&refresh=1`));
  assert.equal(new URL(res.headers.get('location')).searchParams.get('prompt'), 'none');
});

test('login do app: sem nonce ou com nonce fora do formato é recusado (400)', async () => {
  for(const q of ['client=app', 'client=app&nonce=abc', 'client=app&nonce=' + NONCE.toUpperCase() + 'x', 'client=app&nonce=a%26b']){
    const res = await login(new Request('https://sinal.test/api/discord-login?' + q));
    assert.equal(res.status, 400, q);
  }
});

test('callback do app: vai pra /login-app.html (não pra home), sessão e nonce no FRAGMENTO', async () => {
  fakeDiscord({ profile: { id: '100000000000000001', username: 'u', global_name: 'Fulano', avatar: 'h' }, guilds: [{ id: '1', name: 'G', icon: '', owner: true, permissions: '0' }] });
  const res = await cb('code=xyz&state=app.' + NONCE);
  const loc = new URL(res.headers.get('location'));
  assert.equal(res.status, 302);
  assert.equal(loc.pathname, '/login-app.html');
  assert.equal(loc.search, '');
  const hash = new URLSearchParams(loc.hash.replace(/^#/, ''));
  assert.equal(hash.get('nonce'), NONCE);
  assert.equal(verifySession(hash.get('session'), SECRET).name, 'Fulano');
});

test('callback do app: falhas (sem code, Discord recusando) vão pra /login-app.html#error=1, sem sessão', async () => {
  const noCode = new URL((await cb('state=app.' + NONCE)).headers.get('location'));
  assert.equal(noCode.pathname, '/login-app.html');
  assert.equal(noCode.hash, '#error=1');
  fakeDiscord({ profile: {}, guilds: [], tokenStatus: 400 });
  const refused = new URL((await cb('code=ruim&state=app.' + NONCE)).headers.get('location'));
  assert.equal(refused.pathname, '/login-app.html');
  assert.equal(refused.hash, '#error=1');
});

test('anti login-CSRF: sem o cookie do login, ou com cookie diferente do state, o callback recusa e NÃO gera sessão', async () => {
  fakeDiscord({ profile: { id: '100000000000000001', username: 'u' }, guilds: [] });
  const attempts = [
    cb('code=xyz&state=' + CSRF, ''),                                   // sem cookie (vítima que nunca iniciou o login)
    cb('code=xyz&state=' + CSRF, 'sinal_oauth=' + 'a'.repeat(32)),      // cookie de outro login
    cb('code=xyz&state=' + CSRF, 'outro=1; sinal_oauth='),             // cookie vazio
    cb('code=xyz', 'sinal_oauth=' + CSRF),                              // sem state
    cb('code=xyz&state=ABC123', 'sinal_oauth=' + CSRF),                 // formato antigo (só a sala)
    cb('code=xyz&state=app.nao-e-hex', 'sinal_oauth=' + CSRF)           // "parece" do app mas o nonce é inválido
  ];
  for(const p of attempts){
    const loc = new URL((await p).headers.get('location'));
    assert.equal(loc.searchParams.get('discord_error'), '1');
    assert.equal(loc.hash, '');
  }
});

test('callback: o cookie certo entre vários cookies funciona', async () => {
  fakeDiscord({ profile: { id: '100000000000000001', username: 'u' }, guilds: [] });
  const res = await cb('code=xyz&state=' + CSRF, 'a=1; sinal_oauth=' + CSRF + '; b=2');
  assert.ok(new URL(res.headers.get('location')).hash.startsWith('#session='));
});

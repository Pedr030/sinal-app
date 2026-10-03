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
const cb = (qs) => callback(new Request('https://sinal.test/api/discord-callback?' + qs));
const sessionFrom = (res) => verifySession(new URL(res.headers.get('location')).hash.replace('#session=', ''), SECRET);

test('login pede identify + guilds e leva a sala em "state"', async () => {
  const res = await login(new Request('https://sinal.test/api/discord-login?sala=abc123'));
  const url = new URL(res.headers.get('location'));
  assert.equal(res.status, 302);
  assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(url.searchParams.get('scope'), 'identify guilds');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://sinal.test/api/discord-callback');
  assert.equal(url.searchParams.get('state'), 'ABC123');
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
  const res = await cb('code=xyz&state=ABC123');
  const loc = new URL(res.headers.get('location'));
  assert.equal(res.status, 302);
  assert.equal(loc.origin, 'https://sinal.test');
  assert.equal(loc.searchParams.get('sala'), 'ABC123');
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
  assert.equal(sessionFrom(await cb('code=xyz')).admin, true);
});

test('callback: se a lista de servers falhar, o login continua (sem servers)', async () => {
  fakeDiscord({ profile: { id: '100000000000000001', username: 'u' }, guilds: [], guildsStatus: 429 });
  const s = sessionFrom(await cb('code=xyz'));
  assert.equal(s.name, 'u');
  assert.deepEqual(s.guilds, []);
});

test('callback: sem code, ou Discord recusando o code: volta com ?discord_error=1 e sem sessão', async () => {
  const noCode = await cb('state=X');
  assert.equal(new URL(noCode.headers.get('location')).searchParams.get('discord_error'), '1');
  fakeDiscord({ profile: {}, guilds: [], tokenStatus: 400 });
  const refused = await cb('code=ruim');
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

test('callback: state que só PARECE do app (nonce inválido) é tratado como código de sala comum', async () => {
  fakeDiscord({ profile: { id: '100000000000000001', username: 'u' }, guilds: [] });
  const loc = new URL((await cb('code=xyz&state=app.nao-e-hex')).headers.get('location'));
  assert.equal(loc.pathname, '/');
  assert.ok(loc.hash.startsWith('#session='));
});

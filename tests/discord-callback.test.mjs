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

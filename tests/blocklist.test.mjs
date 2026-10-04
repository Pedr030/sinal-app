// Lista de bloqueio por ID do Discord (HANDOFF §42): BLOCKED_DISCORD_IDS.
// Quem está nela não loga e a sessão que já tinha deixa de valer em TODAS as rotas.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadApi, resetFake, TEST_SECRET } from './helpers/api-harness.mjs';
import { signSession, verifySession, isBlockedUser } from '../lib/session.js';

const G = '111111111111111111';
const BLOCKED = '900000000000000666';
const OK = '900000000000000001';
const mkSession = (id) => signSession({ v: 1, id, name: 'Fulano', admin: false, guilds: [[G, 'Servidor', '', 'x']], exp: Date.now() + 1e6 }, TEST_SECRET);

let getToken, lives, cleanups = [];
const post = (fn, path, body) => fn(new Request('http://localhost' + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.7.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250) },
  body: JSON.stringify(body)
}));

before(async () => {
  const a = await loadApi('get-token.js'); getToken = a.mod.POST; cleanups.push(a.cleanup);
  const b = await loadApi('lives.js'); lives = b.mod.POST; cleanups.push(b.cleanup);
});
after(() => { cleanups.forEach((c) => c()); delete process.env.BLOCKED_DISCORD_IDS; });
beforeEach(() => { resetFake(); process.env.BLOCKED_DISCORD_IDS = ` ${BLOCKED} , 123 ,, `; });

test('isBlockedUser: lê a lista separada por vírgula (com espaços e itens vazios) e compara o ID exato', () => {
  const env = { BLOCKED_DISCORD_IDS: ' 111 , 222,, ' };
  assert.equal(isBlockedUser('111', env), true);
  assert.equal(isBlockedUser('222', env), true);
  assert.equal(isBlockedUser('11', env), false);       // não é "contém"
  assert.equal(isBlockedUser('1111', env), false);
  assert.equal(isBlockedUser('333', env), false);
  assert.equal(isBlockedUser('111', {}), false);        // sem a variável, ninguém é bloqueado
  assert.equal(isBlockedUser('111', { BLOCKED_DISCORD_IDS: '' }), false);
});

test('a sessão de quem está bloqueado deixa de valer; a dos outros continua', () => {
  assert.equal(verifySession(mkSession(BLOCKED), TEST_SECRET), null);
  assert.equal(verifySession(mkSession(OK), TEST_SECRET).id, OK);
});

test('tirar o ID da lista devolve o acesso (a sessão não foi apagada, só deixou de ser aceita)', () => {
  const token = mkSession(BLOCKED);
  assert.equal(verifySession(token, TEST_SECRET), null);
  process.env.BLOCKED_DISCORD_IDS = '';
  assert.equal(verifySession(token, TEST_SECRET).id, BLOCKED);
});

test('get-token (todos os modos com sessão) recusa o bloqueado com 401 e aceita os outros', async () => {
  globalThis.__fakeLivekit.rooms = [{ name: 'EXISTE1', numParticipants: 1 }];
  for(const body of [
    { room: 'existe1', name: 'x', mode: 'join' },
    { mode: 'server-create', guild: G, title: 'x' },
    { mode: 'presence', guilds: [G] }
  ]){
    assert.equal((await post(getToken, '/api/get-token', { ...body, session: mkSession(BLOCKED) })).status, 401, body.mode);
    assert.equal((await post(getToken, '/api/get-token', { ...body, session: mkSession(OK) })).status, 200, body.mode);
  }
});

test('lives recusa o bloqueado com 401', async () => {
  assert.equal((await post(lives, '/api/lives', { session: mkSession(BLOCKED), guilds: [G] })).status, 401);
  assert.equal((await post(lives, '/api/lives', { session: mkSession(OK), guilds: [G] })).status, 200);
});

test('o login (callback do Discord) não dá sessão nova a quem está bloqueado', async () => {
  const { GET: callback } = await import('../api/discord-callback.js');
  process.env.DISCORD_CLIENT_ID = 'id-teste';
  process.env.DISCORD_CLIENT_SECRET = TEST_SECRET;
  const realFetch = globalThis.fetch;
  const CSRF = 'c0ffee00c0ffee00c0ffee00c0ffee00';
  const withProfile = (id) => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if(u.endsWith('/oauth2/token')) return Response.json({ access_token: 't' });
      if(u.endsWith('/users/@me')) return Response.json({ id, username: 'u' });
      if(u.endsWith('/users/@me/guilds')) return Response.json([]);
      throw new Error('inesperado ' + u);
    };
  };
  try{
    const go = () => callback(new Request('https://sinal.test/api/discord-callback?code=x&state=' + CSRF, { headers: { cookie: 'sinal_oauth=' + CSRF } }));
    withProfile(BLOCKED);
    const blocked = new URL((await go()).headers.get('location'));
    assert.equal(blocked.searchParams.get('discord_error'), '1');
    assert.equal(blocked.hash, '');
    withProfile(OK);
    assert.ok(new URL((await go()).headers.get('location')).hash.startsWith('#session='));
  } finally {
    globalThis.fetch = realFetch;
  }
});

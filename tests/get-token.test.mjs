// Testa api/get-token.js DE VERDADE contra um fake do livekit-server-sdk
// (ver tests/helpers/api-harness.mjs): salas por código (visitante e logado)
// e salas de server (HANDOFF §38).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadApi, resetFake, TEST_SECRET } from './helpers/api-harness.mjs';
import { signSession, buildSession } from '../lib/session.js';

const GUILD = '111111111111111111';
const OTHER_GUILD = '222222222222222222';
let POST, cleanup, fake;

before(async () => {
  ({ mod: { POST }, cleanup } = await loadApi('get-token.js'));
});
after(() => cleanup && cleanup());
beforeEach(() => { fake = resetFake(); });

const post = (body) => POST(new Request('http://localhost/api/get-token', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
}));
const grantOf = async (res) => JSON.parse((await res.json()).token.split('FAKE_JWT.')[1]);

// Sessão como o discord-callback montaria. `tier` do usuário no GUILD.
function sessionFor({ id = '900000000000000001', tier = 'x', admin = false, extraGuild = false } = {}){
  const guilds = [{ id: GUILD, name: 'Galera', icon: 'abc', owner: tier === 'o', permissions: tier === 'a' ? '8' : tier === 'm' ? '32' : '0' }];
  if(extraGuild) guilds.push({ id: OTHER_GUILD, name: 'Outro', icon: '', owner: false, permissions: '0' });
  return buildSession({
    profile: { id, username: 'fulano', global_name: 'Fulano', avatar: 'hash1' },
    guilds,
    adminIds: admin ? [id] : [],
    secret: TEST_SECRET
  });
}
const serverRoom = `s${GUILD}-abc123`;
const openRoom = (extra = {}) => ({
  name: serverRoom, numParticipants: 1,
  metadata: JSON.stringify({ v: 1, guild: GUILD, title: 'Valorant', creator: { id: '1', name: 'X' }, access: 'open', createdAt: 1 }),
  ...extra
});

// ---------- salas por código (o "Início") ----------

test('exporta POST (não GET) — efeito colateral não pode ser um GET', () => {
  assert.equal(typeof POST, 'function');
});

test('join numa sala que existe devolve token', async () => {
  fake.rooms = [{ name: 'EXISTE1', numParticipants: 1 }];
  const res = await post({ room: 'existe1', name: 'Pedro', mode: 'join' });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok(json.token);
  assert.equal(json.url, 'wss://fake.example.com');
  assert.equal(json.room, 'EXISTE1');
});

test('join numa sala que não existe devolve 404', async () => {
  const res = await post({ room: 'naoexiste', name: 'Pedro', mode: 'join' });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'room-not-found');
});

test('create dispara createRoom com timeouts curtos', async () => {
  const res = await post({ room: 'novasala', name: 'Pedro', mode: 'create' });
  assert.equal(res.status, 200);
  assert.equal(fake.created.name, 'NOVASALA');
  assert.equal(fake.created.emptyTimeout, 60);
  assert.equal(fake.created.departureTimeout, 60);
});

test('visitante não tem metadata, avatar do corpo é ignorado e não é admin', async () => {
  fake.rooms = [{ name: 'EXISTE1', numParticipants: 1 }];
  const res = await post({ room: 'existe1', name: 'Pedro', mode: 'join', avatar: 'https://cdn.discordapp.com/avatars/1/a.png', adminProof: 'x', admin: true });
  assert.equal(res.status, 200);
  const payload = await grantOf(res);
  assert.equal(payload.metadata, undefined);
  assert.equal(payload.grant.roomAdmin, undefined);
});

test('corpo JSON malformado devolve 400 (não derruba a function)', async () => {
  const res = await POST(new Request('http://localhost/api/get-token', { method: 'POST', body: 'isso não é json{' }));
  assert.equal(res.status, 400);
});

test('corpo sem room/name devolve 400', async () => {
  assert.equal((await post({})).status, 400);
});

test('tipos não-string no corpo não lançam exceção não tratada', async () => {
  const res = await post({ room: 123, name: { foo: 'bar' }, mode: 'join', session: 42 });
  assert.ok([400, 404].includes(res.status));
});

test('modo desconhecido cai em join (o mais restrito)', async () => {
  const res = await post({ room: 'qualquer', name: 'Pedro', mode: 'banana' });
  assert.equal(res.status, 404);
});

// ---------- sessão do Discord ----------

test('sessão válida: identity leva o ID do Discord e a metadata vem da sessão (não do corpo)', async () => {
  fake.rooms = [{ name: 'EXISTE1', numParticipants: 1 }];
  const res = await post({ room: 'existe1', name: 'Fulano', mode: 'join', session: sessionFor(), avatar: 'https://cdn.discordapp.com/avatars/9/z.png' });
  assert.equal(res.status, 200);
  const payload = await grantOf(res);
  assert.match(payload.identity, /^d900000000000000001-/);
  const meta = JSON.parse(payload.metadata);
  assert.equal(meta.avatarUrl, 'https://cdn.discordapp.com/avatars/900000000000000001/hash1.png?size=64');
  assert.equal(meta.userId, '900000000000000001');
  assert.equal(meta.isAdmin, undefined);
  assert.equal(payload.grant.roomAdmin, undefined);
});

test('sem nome no corpo, usa o nome da sessão', async () => {
  fake.rooms = [{ name: 'EXISTE1', numParticipants: 1 }];
  const res = await post({ room: 'existe1', mode: 'join', session: sessionFor() });
  assert.equal(res.status, 200);
  assert.equal((await grantOf(res)).name, 'Fulano');
});

test('admin do Sinal: coroa na metadata e roomAdmin em sala por código', async () => {
  fake.rooms = [{ name: 'EXISTE1', numParticipants: 1 }];
  const res = await post({ room: 'existe1', name: 'Fulano', mode: 'join', session: sessionFor({ admin: true }) });
  const payload = await grantOf(res);
  assert.equal(JSON.parse(payload.metadata).isAdmin, true);
  assert.equal(payload.grant.roomAdmin, true);
});

test('sessão adulterada ou de outro segredo devolve 401 (não vira visitante em silêncio)', async () => {
  fake.rooms = [{ name: 'EXISTE1', numParticipants: 1 }];
  const good = sessionFor();
  const tampered = good.replace(/^[^.]+/, (p) => p.slice(0, -2) + 'AA');
  assert.equal((await post({ room: 'existe1', name: 'x', mode: 'join', session: tampered })).status, 401);
  const forged = signSession({ v: 1, id: '1', name: 'x', admin: true, guilds: [], exp: Date.now() + 1e6 }, 'outro-segredo');
  assert.equal((await post({ room: 'existe1', name: 'x', mode: 'join', session: forged })).status, 401);
  assert.equal((await post({ room: 'existe1', name: 'x', mode: 'join', session: 'lixo' })).status, 401);
});

test('sessão vencida devolve 401', async () => {
  const expired = signSession({ v: 1, id: '1', name: 'x', admin: false, guilds: [], exp: Date.now() - 1000 }, TEST_SECRET);
  assert.equal((await post({ room: 'x', name: 'x', mode: 'join', session: expired })).status, 401);
});

// ---------- salas de server ----------

test('server-create sem sessão: 401', async () => {
  const res = await post({ mode: 'server-create', guild: GUILD, title: 'x', name: 'x' });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'login-necessario');
});

test('server-create num server de que a pessoa não faz parte: 403', async () => {
  const res = await post({ mode: 'server-create', guild: OTHER_GUILD, title: 'x', session: sessionFor() });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'fora-do-server');
});

test('server-create cria sala s<guild>-xxxxxx com metadados, limite de gente e devolve o nome', async () => {
  const res = await post({ mode: 'server-create', guild: GUILD, title: '  Valorant   <b>5x5</b> ', session: sessionFor() });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.match(json.room, new RegExp(`^s${GUILD}-[a-z0-9]{6}$`));
  assert.equal(fake.created.name, json.room);
  assert.equal(fake.created.maxParticipants, 25);
  assert.equal(fake.created.emptyTimeout, 60);
  const meta = JSON.parse(fake.created.metadata);
  assert.equal(meta.guild, GUILD);
  assert.equal(meta.title, 'Valorant b5x5/b'); // sem < > e com espaços normalizados
  assert.equal(meta.access, 'open');
  assert.equal(meta.creator.id, '900000000000000001');
  const payload = await grantOf(await post({ mode: 'server-create', guild: GUILD, session: sessionFor() }));
  assert.equal(payload.grant.room.startsWith(`s${GUILD}-`), true);
});

test('server-create respeita o limite de 10 salas por server', async () => {
  fake.rooms = Array.from({ length: 10 }, (_, i) => ({ name: `s${GUILD}-aaaaa${i}`, numParticipants: 1 }));
  const res = await post({ mode: 'server-create', guild: GUILD, title: 'x', session: sessionFor() });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'limite-de-salas');
  // salas de outro server não contam
  fake.rooms = Array.from({ length: 10 }, (_, i) => ({ name: `s${OTHER_GUILD}-aaaaa${i}`, numParticipants: 1 }));
  assert.equal((await post({ mode: 'server-create', guild: GUILD, title: 'x', session: sessionFor() })).status, 200);
});

test('server-join numa sala aberta do server: token, sem roomAdmin pra membro comum', async () => {
  fake.rooms = [openRoom()];
  const res = await post({ mode: 'server-join', room: serverRoom, session: sessionFor() });
  assert.equal(res.status, 200);
  const payload = await grantOf(res);
  assert.equal(payload.grant.room, serverRoom);
  assert.equal(payload.grant.roomAdmin, undefined);
});

test('server-join: dono, Administrador e Gerenciar Servidor moderam (roomAdmin)', async () => {
  fake.rooms = [openRoom()];
  for(const tier of ['o', 'a', 'm']){
    const res = await post({ mode: 'server-join', room: serverRoom, session: sessionFor({ tier }) });
    assert.equal((await grantOf(res)).grant.roomAdmin, true, `tier ${tier}`);
  }
});

test('server-join: sala inexistente 404; nome fora do formato 400; server alheio 403', async () => {
  assert.equal((await post({ mode: 'server-join', room: serverRoom, session: sessionFor() })).status, 404);
  assert.equal((await post({ mode: 'server-join', room: 'ABC123', session: sessionFor() })).status, 400);
  assert.equal((await post({ mode: 'server-join', room: serverRoom, session: signSession({ v: 1, id: '5', name: 'x', admin: false, guilds: [[OTHER_GUILD, 'o', '', 'x']], exp: Date.now() + 1e6 }, TEST_SECRET) })).status, 403);
});

test('server-join em sala privada: só admin do Sinal, dono e Administrador entram direto', async () => {
  fake.rooms = [openRoom({ metadata: JSON.stringify({ v: 1, guild: GUILD, title: 'Secreta', creator: { id: '1', name: 'X' }, access: 'password', createdAt: 1 }) })];
  const join = (opts) => post({ mode: 'server-join', room: serverRoom, session: sessionFor(opts) });
  assert.equal((await join({ tier: 'x' })).status, 403);
  assert.equal((await join({ tier: 'm' })).status, 403); // Gerenciar Servidor modera mas não entra em privada
  assert.equal((await join({ tier: 'a' })).status, 200);
  assert.equal((await join({ tier: 'o' })).status, 200);
  assert.equal((await join({ tier: 'x', admin: true })).status, 200);
});

test('sala de server nunca é criada por join por código (nome minúsculo não passa por uppercase)', async () => {
  const res = await post({ mode: 'join', room: serverRoom, name: 'x' });
  assert.equal(res.status, 404); // virou S1111...-ABC123 em maiúsculo, que não existe
});

test('não há mais aviso de webhook ao criar sala', async () => {
  let called = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return new Response('{}'); };
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/0/teste';
  try{
    await post({ room: 'novasala', name: 'Pedro', mode: 'create', session: sessionFor() });
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.DISCORD_WEBHOOK_URL;
  }
  assert.equal(called, false);
});

// ---------- presença (push em tempo real, HANDOFF §39) ----------

test('presence: sem sessão 401; sem servers válidos 400', async () => {
  assert.equal((await post({ mode: 'presence', guilds: [GUILD] })).status, 401);
  const none = await post({ mode: 'presence', guilds: [OTHER_GUILD, 'lixo', 5], session: sessionFor() });
  assert.equal(none.status, 400);
  assert.equal((await none.json()).error, 'sem-servidores');
});

test('presence: token só escuta, na sala "presence", com os servers (∩ sessão) no atributo assinado', async () => {
  const res = await post({ mode: 'presence', guilds: [GUILD, OTHER_GUILD, GUILD], session: sessionFor() });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.room, 'presence');
  const payload = JSON.parse(json.token.split('FAKE_JWT.')[1]);
  assert.deepEqual(payload.attributes, { guilds: GUILD }); // OTHER_GUILD não é da pessoa; duplicado sai
  assert.equal(payload.grant.room, 'presence');
  assert.equal(payload.grant.canPublish, false);
  assert.equal(payload.grant.canPublishData, false);
  assert.equal(payload.grant.canSubscribe, true);
  assert.equal(payload.grant.roomAdmin, undefined);
  assert.match(payload.identity, /^d900000000000000001-/);
  assert.equal(fake.created, null); // não cria sala nenhuma
});

test('presence: não dá pra pedir servers a mais — o atributo vem da sessão, não do corpo', async () => {
  const s = sessionFor({ extraGuild: true });
  const res = await post({ mode: 'presence', guilds: [GUILD, OTHER_GUILD, '333333333333333333'], session: s });
  const payload = JSON.parse((await res.json()).token.split('FAKE_JWT.')[1]);
  assert.deepEqual(payload.attributes.guilds.split(',').sort(), [GUILD, OTHER_GUILD].sort());
});

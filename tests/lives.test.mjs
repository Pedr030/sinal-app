// api/lives.js contra o fake do LiveKit: só mostra salas de servers de que a
// pessoa faz parte, esconde salas vazias antigas e nunca vaza nada interno.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadApi, resetFake, TEST_SECRET } from './helpers/api-harness.mjs';
import { signSession } from '../lib/session.js';

const G1 = '111111111111111111';
const G2 = '222222222222222222';
const G3 = '333333333333333333';
let POST, cleanup, fake;

before(async () => { ({ mod: { POST }, cleanup } = await loadApi('lives.js')); });
after(() => cleanup && cleanup());
beforeEach(() => { fake = resetFake(); });

const session = (guilds = [[G1, 'Um', '', 'x'], [G2, 'Dois', '', 'x']]) =>
  signSession({ v: 1, id: '9', name: 'Eu', admin: false, guilds, exp: Date.now() + 1e6 }, TEST_SECRET);
const call = (body) => POST(new Request('http://localhost/api/lives', { method: 'POST', body: JSON.stringify(body) }));
const meta = (guild, title, access = 'open') => JSON.stringify({ v: 1, guild, title, creator: { id: '1', name: 'Dono' }, access, createdAt: 1000 });
const nowSec = () => Math.floor(Date.now() / 1000);

test('sem sessão ou com sessão inválida: 401', async () => {
  assert.equal((await call({ guilds: [G1] })).status, 401);
  assert.equal((await call({ session: 'lixo', guilds: [G1] })).status, 401);
  assert.equal((await call({ session: signSession({ v: 1, id: '9', guilds: [], exp: Date.now() + 1e6 }, 'outro'), guilds: [G1] })).status, 401);
});

test('corpo malformado: 400', async () => {
  const res = await POST(new Request('http://localhost/api/lives', { method: 'POST', body: '{' }));
  assert.equal(res.status, 400);
});

test('lista só os servers pedidos E de que a pessoa faz parte; ignora o resto', async () => {
  fake.rooms = [
    { name: `s${G1}-aaaaaa`, numParticipants: 2, metadata: meta(G1, 'Valorant'), creationTime: nowSec() - 600 },
    { name: `s${G3}-bbbbbb`, numParticipants: 1, metadata: meta(G3, 'Secreto de outro server'), creationTime: nowSec() - 600 },
    { name: 'CODIGO', numParticipants: 3, creationTime: nowSec() - 600 }
  ];
  fake.participants[`s${G1}-aaaaaa`] = [{ identity: 'd1-x', name: 'Ana', metadata: JSON.stringify({ avatarUrl: 'https://cdn.discordapp.com/a.png' }), tracks: [{ source: 3 }], joinedAt: 100 }];
  const res = await call({ session: session(), guilds: [G1, G3] });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(json.guilds), [G1]);   // G3 não é da pessoa; G2 não foi pedido
  assert.equal(json.guilds[G1].length, 1);
  const r = json.guilds[G1][0];
  assert.equal(r.room, `s${G1}-aaaaaa`);
  assert.equal(r.title, 'Valorant');
  assert.equal(r.access, 'open');
  assert.equal(r.creator, 'Dono');
  assert.equal(r.participants[0].name, 'Ana');
  assert.equal(r.participants[0].screen, true);
  assert.equal(r.participants[0].camera, false);
  assert.equal(r.participants[0].avatar, 'https://cdn.discordapp.com/a.png');
});

test('sala vazia antiga some; sala recém-criada ainda vazia aparece', async () => {
  fake.rooms = [
    { name: `s${G1}-velha1`, numParticipants: 0, metadata: meta(G1, 'Velha'), creationTime: nowSec() - 300 },
    { name: `s${G1}-nova11`, numParticipants: 0, metadata: meta(G1, 'Nova'), creationTime: nowSec() - 5 }
  ];
  const json = await (await call({ session: session(), guilds: [G1] })).json();
  assert.deepEqual(json.guilds[G1].map((r) => r.title), ['Nova']);
});

test('servers pedidos sem salas voltam como lista vazia; pedido vazio não consulta o LiveKit', async () => {
  const json = await (await call({ session: session(), guilds: [G1, G2] })).json();
  assert.deepEqual(json.guilds, { [G1]: [], [G2]: [] });
  assert.deepEqual(await (await call({ session: session(), guilds: [] })).json(), { guilds: {} });
  assert.deepEqual(await (await call({ session: session(), guilds: 'x' })).json(), { guilds: {} });
});

test('campos bigint do LiveKit não quebram o JSON; salas saem em ordem de criação', async () => {
  fake.rooms = [
    { name: `s${G1}-bbbbbb`, numParticipants: 1, metadata: JSON.stringify({ v: 1, guild: G1, title: 'B', creator: {}, access: 'open', createdAt: 2000 }), creationTime: BigInt(nowSec() - 60) },
    { name: `s${G1}-aaaaaa`, numParticipants: 1, metadata: JSON.stringify({ v: 1, guild: G1, title: 'A', creator: {}, access: 'open', createdAt: 1000 }), creationTime: BigInt(nowSec() - 60) }
  ];
  fake.participants[`s${G1}-aaaaaa`] = [{ identity: 'x', name: 'N', tracks: [], joinedAt: 5n }];
  const res = await call({ session: session(), guilds: [G1] });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.guilds[G1].map((r) => r.title), ['A', 'B']);
});

test('sala privada aparece (com cadeado) mas sem nenhum segredo', async () => {
  fake.rooms = [{ name: `s${G1}-priv11`, numParticipants: 1, metadata: JSON.stringify({ v: 1, guild: G1, title: 'P', creator: { id: '1', name: 'D' }, access: 'password', pw: 'hash-secreto', createdAt: 1 }), creationTime: nowSec() - 60 }];
  const text = await (await call({ session: session(), guilds: [G1] })).text();
  assert.match(text, /"access":"password"/);
  assert.doesNotMatch(text, /hash-secreto/);
});

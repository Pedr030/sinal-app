// api/moderate.js (HANDOFF §41): quem pode moderar e a HIERARQUIA — admin do Sinal >
// dono > administrador > "gerencia o servidor". O nível de cada um vem assinado no
// token/metadata (get-token), então aqui os "tokens" do fake carregam isso direto.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadApi, resetFake } from './helpers/api-harness.mjs';

const G = '111111111111111111';
const OTHER_G = '222222222222222222';
const ROOM = `s${G}-abc123`;
let POST, cleanup, fake;

before(async () => { ({ mod: { POST }, cleanup } = await loadApi('moderate.js')); });
after(() => cleanup && cleanup());

// Quem está na sala (o fake lê isso em listParticipants).
const WHO = {
  sinal:  { identity: 'sinal-1',  meta: { isAdmin: true, userId: '1', tier: 'x', guild: G } },
  dono:   { identity: 'dono-1',   meta: { userId: '2', tier: 'o', guild: G } },
  admin:  { identity: 'admin-1',  meta: { userId: '3', tier: 'a', guild: G } },
  admin2: { identity: 'admin-2',  meta: { userId: '4', tier: 'a', guild: G } },
  gerente:{ identity: 'ger-1',    meta: { userId: '5', tier: 'm', guild: G } },
  comum:  { identity: 'comum-1',  meta: { userId: '6', tier: 'x', guild: G } }
};
beforeEach(() => {
  fake = resetFake();
  fake.participants[ROOM] = Object.values(WHO).map((p) => ({ identity: p.identity, name: p.identity, metadata: JSON.stringify(p.meta), tracks: [] }));
});

// Token do fake: o mesmo formato que o AccessToken falso gera.
function tokenOf(who, { room = ROOM, roomAdmin } = {}){
  const w = typeof who === 'string' ? WHO[who] : who;
  return 'FAKE_JWT.' + JSON.stringify({
    identity: w.identity, metadata: JSON.stringify(w.meta),
    grant: { room, roomJoin: true, roomAdmin: roomAdmin === undefined ? (w.meta.isAdmin ? true : undefined) : roomAdmin }
  });
}
const act = (token, body) => POST(new Request('http://localhost/api/moderate', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify({ room: ROOM, ...body })
}));
const kick = (who, target) => act(tokenOf(who), { action: 'kick', targetIdentity: WHO[target].identity });

test('sem token: 401; token inválido: 401', async () => {
  assert.equal((await act('', { action: 'kick', targetIdentity: 'comum-1' })).status, 401);
  assert.equal((await act('lixo', { action: 'kick', targetIdentity: 'comum-1' })).status, 401);
});

test('o admin do Sinal expulsa QUALQUER um (dono, admin, gerente, comum)', async () => {
  for(const alvo of ['dono', 'admin', 'gerente', 'comum']){
    const res = await kick('sinal', alvo);
    assert.equal(res.status, 200, alvo);
  }
  assert.deepEqual(fake.actions.map((a) => a.identity), ['dono-1', 'admin-1', 'ger-1', 'comum-1']);
});

test('NINGUÉM expulsa o admin do Sinal — nem o dono do servidor', async () => {
  for(const quem of ['dono', 'admin', 'gerente', 'comum']){
    const res = await kick(quem, 'sinal');
    assert.equal(res.status, 403, quem);
  }
  assert.equal(fake.actions.length, 0);
  assert.equal((await (await kick('dono', 'sinal')).json()).error, 'sem-permissao-sobre-alvo');
});

test('dono expulsa admin, gerente e comum — mas não outro dono nem a si mesmo', async () => {
  for(const alvo of ['admin', 'gerente', 'comum']) assert.equal((await kick('dono', alvo)).status, 200, alvo);
  assert.equal((await kick('dono', 'dono')).status, 403);
  assert.equal(fake.actions.length, 3);
});

test('administrador expulsa gerente e comum — NÃO o dono, outro administrador nem o admin do Sinal', async () => {
  for(const alvo of ['gerente', 'comum']) assert.equal((await kick('admin', alvo)).status, 200, alvo);
  for(const alvo of ['dono', 'admin2', 'sinal']) assert.equal((await kick('admin', alvo)).status, 403, alvo);
  assert.equal(fake.actions.length, 2);
});

test('gerencia o servidor expulsa só membro comum', async () => {
  assert.equal((await kick('gerente', 'comum')).status, 200);
  for(const alvo of ['dono', 'admin', 'sinal']) assert.equal((await kick('gerente', alvo)).status, 403, alvo);
  assert.equal(fake.actions.length, 1);
});

test('membro comum não modera (sem permissão), mesmo com metadata mentindo que é admin', async () => {
  assert.equal((await kick('comum', 'gerente')).status, 403);
  const forjado = { identity: 'comum-1', meta: { userId: '6', tier: 'x', guild: G, isAdmin: true } }; // sem o grant roomAdmin
  assert.equal((await act(tokenOf(forjado, { roomAdmin: false }), { action: 'kick', targetIdentity: 'ger-1' })).status, 403);
  assert.equal(fake.actions.length, 0);
});

test('dono de OUTRO servidor, ou token de outra sala, não moderam aqui', async () => {
  const donoDeFora = { identity: 'fora-1', meta: { userId: '9', tier: 'o', guild: OTHER_G } };
  assert.equal((await act(tokenOf(donoDeFora), { action: 'kick', targetIdentity: 'comum-1' })).status, 403);
  assert.equal((await act(tokenOf('dono', { room: 's999999999999999999-zzzzzz' }), { action: 'kick', targetIdentity: 'comum-1' })).status, 403);
  assert.equal(fake.actions.length, 0);
});

test('staff de servidor não modera sala por código (só o admin do Sinal)', async () => {
  const codeRoom = 'ABC123';
  fake.participants[codeRoom] = [{ identity: 'comum-1', metadata: '{}', tracks: [] }];
  const res = await POST(new Request('http://localhost/api/moderate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tokenOf('dono', { room: codeRoom }) },
    body: JSON.stringify({ room: codeRoom, action: 'kick', targetIdentity: 'comum-1' })
  }));
  assert.equal(res.status, 403);
  const adminRes = await POST(new Request('http://localhost/api/moderate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tokenOf('sinal', { room: codeRoom }) },
    body: JSON.stringify({ room: codeRoom, action: 'kick', targetIdentity: 'comum-1' })
  }));
  assert.equal(adminRes.status, 200);
});

test('alvo que já saiu: 404 e nada é feito', async () => {
  const res = await act(tokenOf('dono'), { action: 'kick', targetIdentity: 'fantasma-9' });
  assert.equal(res.status, 404);
  assert.equal(fake.actions.length, 0);
});

test('desligar tela/câmera segue a mesma hierarquia e exige a faixa', async () => {
  const ok = await act(tokenOf('dono'), { action: 'muteScreen', targetIdentity: 'admin-1', trackSid: 'TR_1' });
  assert.equal(ok.status, 200);
  assert.deepEqual(fake.actions[0], { type: 'mute', room: ROOM, identity: 'admin-1', sid: 'TR_1', muted: true });
  assert.equal((await act(tokenOf('dono'), { action: 'muteScreen', targetIdentity: 'sinal-1', trackSid: 'TR_2' })).status, 403);
  assert.equal((await act(tokenOf('dono'), { action: 'muteCamera', targetIdentity: 'comum-1' })).status, 400); // sem trackSid
  assert.equal(fake.actions.length, 1);
});

test('expulsar revoga o token que a pessoa estava usando (não volta na hora com o mesmo token)', async () => {
  assert.equal((await kick('dono', 'comum')).status, 200);
  const { options } = fake.actions[0];
  assert.equal(typeof options.revokeTokenTs, 'bigint');
  const agora = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(Number(options.revokeTokenTs) - agora) <= 5);
});

test('limite de pedidos de moderação por IP', async () => {
  const send = (ip) => POST(new Request('http://localhost/api/moderate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, authorization: 'Bearer ' + tokenOf('dono') },
    body: JSON.stringify({ room: ROOM, action: 'kick', targetIdentity: 'comum-1' })
  }));
  for(let i = 0; i < 60; i++) assert.notEqual((await send('198.51.100.7')).status, 429);
  assert.equal((await send('198.51.100.7')).status, 429);
  assert.notEqual((await send('198.51.100.8')).status, 429);
});

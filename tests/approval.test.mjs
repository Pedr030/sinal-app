// Salas de server COM APROVAÇÃO (HANDOFF §49): regras puras (lib/rooms.js), criação e "bater na porta"
// (api/get-token.js), decisão do responsável (api/room-admin.js) e a expulsão que desfaz a aprovação
// (api/moderate.js), tudo contra o fake do livekit-server-sdk.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadApi, resetFake, TEST_SECRET } from './helpers/api-harness.mjs';
import { buildSession } from '../lib/session.js';
import {
  buildRoomMetadata, parseRoomMetadata, cleanAccess, canEnterRoom, withApproved, withDenied, withoutAllowed,
  approvalDeciders, participantInfo, MAX_ALLOWED, MAX_DENIED, DENY_TTL_MS
} from '../lib/rooms.js';

const G = '111111111111111111';
const ROOM = `s${G}-abc123`;
const CRIADOR = '900000000000000001';
const VISITANTE = '900000000000000002';
const OUTRO = '900000000000000003';

// ---------- regras puras ----------
test('cleanAccess: só "approval" vale; qualquer outra coisa vira aberta', () => {
  assert.equal(cleanAccess('approval'), 'approval');
  for(const v of ['open', 'password', '', null, undefined, 5, {}, 'APPROVAL']) assert.equal(cleanAccess(v), 'open', String(v));
});

test('metadata da sala: com aprovação nasce com allowed/denied vazios; aberta não tem essas listas', () => {
  const com = JSON.parse(buildRoomMetadata({ guildId: G, title: 'T', creator: { id: CRIADOR, name: 'C' }, access: 'approval', now: 5 }));
  assert.equal(com.access, 'approval');
  assert.deepEqual(com.allowed, []);
  assert.deepEqual(com.denied, []);
  const aberta = JSON.parse(buildRoomMetadata({ guildId: G, title: 'T', creator: { id: CRIADOR, name: 'C' }, now: 5 }));
  assert.equal(aberta.access, 'open');
  assert.equal('allowed' in aberta, false);
});

const sess = (o = {}) => ({ id: o.id || VISITANTE, name: 'x', admin: !!o.admin, guilds: [[G, 'Galera', '', o.tier || 'x']] });
const metaApr = (extra = {}) => ({ v: 1, guild: G, title: 'T', creator: { id: CRIADOR, name: 'C' }, access: 'approval', allowed: [], denied: [], ...extra });

test('canEnterRoom: aberta entra; com aprovação só staff, criador e aprovados; o resto fica de fora', () => {
  assert.equal(canEnterRoom({ meta: null, session: sess(), guildId: G, userId: VISITANTE }).allowed, true);
  assert.equal(canEnterRoom({ meta: metaApr({ access: 'open' }), session: sess(), guildId: G, userId: VISITANTE }).allowed, true);
  const pede = (o) => canEnterRoom({ meta: o.meta || metaApr(), session: sess(o.s), guildId: G, userId: (o.s && o.s.id) || VISITANTE, now: o.now });
  assert.equal(pede({}).allowed, false);
  assert.equal(pede({ s: { tier: 'm' } }).allowed, false);                       // Gerenciar Servidor modera mas não entra
  assert.deepEqual(pede({ s: { tier: 'a' } }), { allowed: true, reason: 'staff', denied: false });
  assert.equal(pede({ s: { tier: 'o' } }).reason, 'staff');
  assert.equal(pede({ s: { admin: true } }).reason, 'staff');
  assert.equal(pede({ s: { id: CRIADOR } }).reason, 'creator');
  assert.equal(pede({ meta: metaApr({ allowed: [VISITANTE] }) }).reason, 'approved');
});

test('canEnterRoom: tipo de acesso desconhecido ou futuro (senha) FALHA FECHADO', () => {
  for(const access of ['password', 'secreta', '', undefined, 7]){
    assert.equal(canEnterRoom({ meta: metaApr({ access }), session: sess(), guildId: G, userId: VISITANTE }).allowed, false, String(access));
  }
});

test('canEnterRoom: recusa recente aparece como "denied" por 5 min e depois expira', () => {
  const meta = metaApr({ denied: [[VISITANTE, 1000]] });
  assert.equal(canEnterRoom({ meta, session: sess(), guildId: G, userId: VISITANTE, now: 1000 + DENY_TTL_MS - 1 }).denied, true);
  assert.equal(canEnterRoom({ meta, session: sess(), guildId: G, userId: VISITANTE, now: 1000 + DENY_TTL_MS }).denied, false);
  assert.equal(canEnterRoom({ meta, session: sess({ id: OUTRO }), guildId: G, userId: OUTRO, now: 2000 }).denied, false); // outra pessoa
});

test('withApproved / withDenied / withoutAllowed: devolvem cópia, sem duplicar, e aprovar limpa a recusa (e vice-versa)', () => {
  const base = metaApr({ denied: [[VISITANTE, 10]] });
  const aprov = withApproved(base, VISITANTE);
  assert.deepEqual(aprov.allowed, [VISITANTE]);
  assert.deepEqual(aprov.denied, []);
  assert.deepEqual(base.allowed, []); // original intacto
  assert.deepEqual(withApproved(aprov, VISITANTE).allowed, [VISITANTE]); // sem duplicar
  const rec = withDenied(aprov, VISITANTE, 50);
  assert.deepEqual(rec.allowed, []);
  assert.deepEqual(rec.denied, [[VISITANTE, 50]]);
  assert.deepEqual(withoutAllowed(aprov, VISITANTE).allowed, []);
});

test('listas têm teto: aprovados guardam os MAX_ALLOWED mais recentes; recusas os MAX_DENIED mais recentes', () => {
  let m = metaApr();
  const id = (i) => '1' + String(i).padStart(17, '0'); // IDs do Discord têm 17-19 dígitos: tratar como texto, nunca como número
  for(let i = 0; i < MAX_ALLOWED + 5; i++) m = withApproved(m, id(i));
  assert.equal(m.allowed.length, MAX_ALLOWED);
  assert.equal(m.allowed[m.allowed.length - 1], id(MAX_ALLOWED + 4));
  assert.equal(m.allowed.includes(id(0)), false);
  let d = metaApr();
  for(let i = 0; i < MAX_DENIED + 5; i++) d = withDenied(d, '2' + String(i).padStart(17, '0'), 1000 + i);
  assert.equal(d.denied.length, MAX_DENIED);
});

test('approvalDeciders: responsável (criador se estiver, senão o 1º a entrar) + sempre staff presente; vazio se ninguém', () => {
  const p = (identity, userId, joinedAt, extra = {}) => ({ identity, userId, joinedAt, ...extra });
  const meta = metaApr();
  assert.deepEqual(approvalDeciders(meta, []), []);
  // criador presente: ele (mais o gerente, que sempre pode)
  const comCriador = approvalDeciders(meta, [p('a', VISITANTE, 1), p('c', CRIADOR, 5), p('g', OUTRO, 9, { tier: 'm' })]);
  assert.deepEqual([...comCriador].sort(), ['c', 'g']);
  // criador ausente: quem entrou primeiro
  assert.deepEqual(approvalDeciders(meta, [p('b', OUTRO, 8), p('a', VISITANTE, 2)]), ['a']);
  // admin do Sinal e dono/Administrador presentes também decidem
  const staff = approvalDeciders(meta, [p('a', VISITANTE, 1), p('s', '5', 7, { isAdmin: true }), p('d', '6', 8, { tier: 'o' }), p('x', '7', 9, { tier: 'x' })]);
  assert.deepEqual([...staff].sort(), ['a', 'd', 's']);
});

test('participantInfo: lê userId/nível do metadata assinado; visitante sem metadata vira userId vazio', () => {
  assert.deepEqual(participantInfo({ identity: 'i', metadata: JSON.stringify({ userId: '123', tier: 'a', isAdmin: true }), joinedAt: 7 }), { identity: 'i', userId: '123', joinedAt: 7, tier: 'a', isAdmin: true });
  assert.deepEqual(participantInfo({ identity: 'v', metadata: '', joinedAt: undefined }), { identity: 'v', userId: '', joinedAt: 0, tier: undefined, isAdmin: false });
  assert.equal(participantInfo({ identity: 'z', metadata: '{quebrado' }).userId, '');
});

// ---------- get-token: criar e bater na porta ----------
let postToken, cleanTok, fake;
let ip = 0;
const call = (body) => postToken(new Request('http://localhost/api/get-token', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.7.0.' + (++ip) }, body: JSON.stringify(body)
}));
const session = ({ id = VISITANTE, tier = 'x', admin = false } = {}) => buildSession({
  profile: { id, username: 'fulano' + id.slice(-2), global_name: 'Fulano ' + id.slice(-2), avatar: 'h' + id.slice(-2) },
  guilds: [{ id: G, name: 'Galera', icon: '', owner: tier === 'o', permissions: tier === 'a' ? '8' : tier === 'm' ? '32' : '0' }],
  adminIds: admin ? [id] : [], secret: TEST_SECRET
});
const roomApr = (meta = {}) => ({ name: ROOM, numParticipants: 1, metadata: JSON.stringify(metaApr(meta)) });
const join = (s, extra = {}) => call({ mode: 'server-join', room: ROOM, session: s, ...extra });

let postAdmin, cleanAdm, postMod, cleanMod;
before(async () => {
  ({ mod: { POST: postToken }, cleanup: cleanTok } = await loadApi('get-token.js'));
  ({ mod: { POST: postAdmin }, cleanup: cleanAdm } = await loadApi('room-admin.js'));
  ({ mod: { POST: postMod }, cleanup: cleanMod } = await loadApi('moderate.js'));
});
after(() => { cleanTok && cleanTok(); cleanAdm && cleanAdm(); cleanMod && cleanMod(); });
beforeEach(() => { fake = resetFake(); });

test('criar com access "approval" grava o metadata da sala; sem o campo (ou valor estranho) a sala é aberta', async () => {
  const mk = async (access) => { fake.created = null; await call({ mode: 'server-create', guild: G, title: 'Privada', session: session({ id: CRIADOR }), ...(access === undefined ? {} : { access }) }); return JSON.parse(fake.created.metadata); };
  const com = await mk('approval');
  assert.equal(com.access, 'approval');
  assert.deepEqual(com.allowed, []);
  assert.equal(com.creator.id, CRIADOR);
  assert.equal((await mk(undefined)).access, 'open');
  assert.equal((await mk('password')).access, 'open');
  assert.equal((await mk({ evil: 1 })).access, 'open');
});

test('entrar numa sala com aprovação SEM pedir: 403 "sala-privada" (e nenhum aviso é enviado)', async () => {
  fake.rooms = [roomApr()];
  const res = await join(session());
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'sala-privada', access: 'approval' });
  assert.equal(fake.sent.length, 0);
});

test('bater na porta (knock): avisa SÓ os que podem decidir (topic knock) e responde "aguardando-aprovacao"', async () => {
  fake.rooms = [roomApr()];
  fake.participants[ROOM] = [
    { identity: 'd' + CRIADOR + '-a', metadata: JSON.stringify({ userId: CRIADOR, tier: 'x' }), joinedAt: 10 },
    { identity: 'd' + OUTRO + '-b', metadata: JSON.stringify({ userId: OUTRO, tier: 'x' }), joinedAt: 20 }
  ];
  const res = await join(session(), { knock: true });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'aguardando-aprovacao');
  assert.equal(fake.sent.length, 1);
  const s = fake.sent[0];
  assert.equal(s.room, ROOM);
  assert.equal(s.options.topic, 'knock');
  assert.deepEqual(s.options.destinationIdentities, ['d' + CRIADOR + '-a']); // só o responsável (o criador), não o outro
  const msg = JSON.parse(s.text);
  assert.equal(msg.type, 'knock');
  assert.equal(msg.userId, VISITANTE);
  assert.equal(msg.room, ROOM);
  assert.match(msg.name, /Fulano/);
});

test('knock repetido em menos de 12 s NÃO reenvia o aviso (o responsável não é inundado), mas segue "aguardando"', async () => {
  fake.rooms = [roomApr()];
  fake.participants[ROOM] = [{ identity: 'c-1', metadata: JSON.stringify({ userId: CRIADOR }), joinedAt: 1 }];
  const s = session({ id: '900000000000000010' }); // pessoa própria: o limitador de aviso é por pessoa+sala e vive no módulo
  for(let i = 0; i < 4; i++){
    const res = await join(s, { knock: true });
    assert.equal((await res.json()).error, 'aguardando-aprovacao');
  }
  assert.equal(fake.sent.length, 1);
});

test('knock sem ninguém que possa decidir na sala: "sem-responsavel" (nada é enviado)', async () => {
  fake.rooms = [roomApr()];
  fake.participants[ROOM] = [];
  const res = await join(session(), { knock: true });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'sem-responsavel');
  assert.equal(fake.sent.length, 0);
});

test('depois de aprovado (id em allowed) entra direto; recusado recente recebe "recusado" mesmo batendo de novo', async () => {
  fake.rooms = [roomApr({ allowed: [VISITANTE] })];
  const ok = await join(session());
  assert.equal(ok.status, 200);
  fake.rooms = [roomApr({ denied: [[VISITANTE, Date.now()]] })];
  fake.participants[ROOM] = [{ identity: 'c-1', metadata: JSON.stringify({ userId: CRIADOR }), joinedAt: 1 }];
  const rec = await join(session(), { knock: true });
  assert.equal(rec.status, 403);
  assert.equal((await rec.json()).error, 'recusado');
  assert.equal(fake.sent.length, 0); // recusado não incomoda o responsável de novo
});

test('criador, admin do Sinal e dono/Administrador entram sem pedir; "gerencia o servidor" e visitantes comuns não', async () => {
  fake.rooms = [roomApr()];
  assert.equal((await join(session({ id: CRIADOR }))).status, 200);
  assert.equal((await join(session({ id: OUTRO, tier: 'o' }))).status, 200);
  assert.equal((await join(session({ id: OUTRO, tier: 'a' }))).status, 200);
  assert.equal((await join(session({ id: OUTRO, admin: true }))).status, 200);
  assert.equal((await join(session({ id: OUTRO, tier: 'm' }))).status, 403);
  assert.equal((await join(session({ id: OUTRO }))).status, 403);
});

test('sala aberta ignora knock: entra normal e ninguém é incomodado', async () => {
  fake.rooms = [roomApr({ access: 'open' })];
  const res = await join(session(), { knock: true });
  assert.equal(res.status, 200);
  assert.equal(fake.sent.length, 0);
});

test('tipo de acesso futuro/desconhecido (ex.: senha): "sala-privada" e knock NÃO abre porta', async () => {
  fake.rooms = [roomApr({ access: 'password' })];
  fake.participants[ROOM] = [{ identity: 'c-1', metadata: JSON.stringify({ userId: CRIADOR }), joinedAt: 1 }];
  const res = await join(session(), { knock: true });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'sala-privada');
  assert.equal(fake.sent.length, 0);
});

test('fora do servidor do Discord nem chega a bater: 403 "fora-do-server"', async () => {
  fake.rooms = [roomApr()];
  const forasteiro = buildSession({ profile: { id: OUTRO, username: 'x', global_name: 'X', avatar: null }, guilds: [{ id: '333333333333333333', name: 'Outro', icon: '', owner: false, permissions: '0' }], adminIds: [], secret: TEST_SECRET });
  const res = await join(forasteiro, { knock: true });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'fora-do-server');
  assert.equal(fake.sent.length, 0);
});

// ---------- room-admin: aprovar / recusar ----------
let adminIp = 0;
const tokenOf = (identity, meta, { room = ROOM } = {}) => 'FAKE_JWT.' + JSON.stringify({ identity, name: identity, metadata: JSON.stringify(meta), grant: { room, roomJoin: true } });
const decide = (token, body) => postAdmin(new Request('http://localhost/api/room-admin', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.8.0.' + (++adminIp), ...(token ? { authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify({ room: ROOM, userId: VISITANTE, ...body })
}));
const CRIADOR_ID = 'd' + CRIADOR + '-a';
function salaComCriador(){
  fake.rooms = [roomApr()];
  fake.participants[ROOM] = [
    { identity: CRIADOR_ID, metadata: JSON.stringify({ userId: CRIADOR, tier: 'x' }), joinedAt: 10 },
    { identity: 'd' + OUTRO + '-b', metadata: JSON.stringify({ userId: OUTRO, tier: 'x' }), joinedAt: 20 },
    { identity: 'gerente-1', metadata: JSON.stringify({ userId: '555555555555555555', tier: 'm', guild: G }), joinedAt: 30 }
  ];
}

test('room-admin: o responsável aprova — o id entra em allowed e o get-token passa a deixar entrar', async () => {
  salaComCriador();
  const res = await decide(tokenOf(CRIADOR_ID, { userId: CRIADOR }), { action: 'approve' });
  assert.equal(res.status, 200);
  const up = fake.actions.find((a) => a.type === 'room-metadata');
  assert.deepEqual(JSON.parse(up.metadata).allowed, [VISITANTE]);
  assert.equal((await join(session())).status, 200); // o fake aplicou o metadata na sala
});

test('room-admin: recusar grava em denied e o pedinte passa a receber "recusado"', async () => {
  salaComCriador();
  assert.equal((await decide(tokenOf(CRIADOR_ID, { userId: CRIADOR }), { action: 'deny' })).status, 200);
  const meta = JSON.parse(fake.actions.find((a) => a.type === 'room-metadata').metadata);
  assert.equal(meta.denied[0][0], VISITANTE);
  assert.equal((await (await join(session(), { knock: true })).json()).error, 'recusado');
});

test('room-admin: quem NÃO é responsável nem staff (participante comum) recebe 403 e nada é gravado', async () => {
  salaComCriador();
  const res = await decide(tokenOf('d' + OUTRO + '-b', { userId: OUTRO }), { action: 'approve' });
  assert.equal(res.status, 403);
  assert.equal(fake.actions.length, 0);
});

test('room-admin: o "gerencia o servidor" presente também decide; criador ausente => o 1º a entrar decide', async () => {
  salaComCriador();
  assert.equal((await decide(tokenOf('gerente-1', { userId: '555555555555555555', tier: 'm', guild: G }), { action: 'approve' })).status, 200);
  fake = resetFake();
  fake.rooms = [roomApr()];
  fake.participants[ROOM] = [
    { identity: 'primeiro', metadata: JSON.stringify({ userId: VISITANTE }), joinedAt: 5 },
    { identity: 'segundo', metadata: JSON.stringify({ userId: OUTRO }), joinedAt: 6 }
  ];
  assert.equal((await decide(tokenOf('primeiro', { userId: VISITANTE }), { action: 'approve', userId: '777777777777777777' })).status, 200);
  assert.equal((await decide(tokenOf('segundo', { userId: OUTRO }), { action: 'approve', userId: '777777777777777777' })).status, 403);
});

test('room-admin: token de OUTRA sala, token que não está mais na sala, sem token e token inválido não decidem', async () => {
  salaComCriador();
  assert.equal((await decide(tokenOf(CRIADOR_ID, { userId: CRIADOR }, { room: `s${G}-zzzzzz` }), { action: 'approve' })).status, 403);
  assert.equal((await decide(tokenOf('d999-saiu', { userId: CRIADOR }), { action: 'approve' })).status, 403); // não está entre os presentes
  assert.equal((await decide('', { action: 'approve' })).status, 401);
  assert.equal((await decide('lixo', { action: 'approve' })).status, 401);
  assert.equal(fake.actions.length, 0);
});

test('room-admin: pedidos malformados e sala sem aprovação são recusados', async () => {
  salaComCriador();
  const t = tokenOf(CRIADOR_ID, { userId: CRIADOR });
  assert.equal((await decide(t, { action: 'apagar' })).status, 400);
  assert.equal((await decide(t, { action: 'approve', userId: 'abc' })).status, 400);
  assert.equal((await decide(t, { action: 'approve', userId: 123456789012345678 })).status, 400);
  assert.equal((await decide(t, { action: 'approve', room: 'ABC123' })).status, 400);
  fake.rooms = [roomApr({ access: 'open' })];
  assert.equal((await decide(t, { action: 'approve' })).status, 400); // sala aberta não tem aprovação
  fake.rooms = [];
  assert.equal((await decide(t, { action: 'approve' })).status, 404);
});

// ---------- moderate: expulsar desfaz a aprovação ----------
const kickAs = (identity, meta, target) => postMod(new Request('http://localhost/api/moderate', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.6.0.' + (++adminIp), authorization: 'Bearer ' + 'FAKE_JWT.' + JSON.stringify({ identity, metadata: JSON.stringify(meta), grant: { room: ROOM, roomJoin: true } }) },
  body: JSON.stringify({ room: ROOM, action: 'kick', targetIdentity: target })
}));

test('expulsar alguém de sala com aprovação remove a aprovação dessa pessoa (ela precisa pedir de novo)', async () => {
  fake.rooms = [roomApr({ allowed: [VISITANTE, OUTRO] })];
  fake.participants[ROOM] = [
    { identity: 'dono-1', metadata: JSON.stringify({ userId: '2', tier: 'o', guild: G }), joinedAt: 1 },
    { identity: 'v-1', metadata: JSON.stringify({ userId: VISITANTE, tier: 'x', guild: G }), joinedAt: 2 }
  ];
  const res = await kickAs('dono-1', { userId: '2', tier: 'o', guild: G }, 'v-1');
  assert.equal(res.status, 200);
  assert.equal(fake.actions.find((a) => a.type === 'kick').identity, 'v-1');
  assert.deepEqual(JSON.parse(fake.actions.find((a) => a.type === 'room-metadata').metadata).allowed, [OUTRO]);
});

test('expulsar numa sala ABERTA não mexe em metadata nenhuma', async () => {
  fake.rooms = [roomApr({ access: 'open' })];
  fake.participants[ROOM] = [
    { identity: 'dono-1', metadata: JSON.stringify({ userId: '2', tier: 'o', guild: G }), joinedAt: 1 },
    { identity: 'v-1', metadata: JSON.stringify({ userId: VISITANTE, tier: 'x', guild: G }), joinedAt: 2 }
  ];
  assert.equal((await kickAs('dono-1', { userId: '2', tier: 'o', guild: G }, 'v-1')).status, 200);
  assert.equal(fake.actions.some((a) => a.type === 'room-metadata'), false);
});

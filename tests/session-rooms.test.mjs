// Lógica pura dos servers (lib/session.js e lib/rooms.js): assinatura da
// sessão, níveis do Discord, nomes de sala, quem modera / entra em sala
// privada e quem é o "responsável" da sala (HANDOFF §36/§38).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  signSession, verifySession, buildSession, tierFromDiscord, guildTier, SESSION_TTL_MS
} from '../lib/session.js';
import {
  parseServerRoom, newServerRoomName, cleanTitle, buildRoomMetadata, parseRoomMetadata,
  canModerate, canEnterPrivate, responsibleOf, moderationRank, canModerateTarget, isModeratorToken
} from '../lib/rooms.js';

const SECRET = 'segredo-de-teste';
const profile = { id: '123456789012345678', username: 'fulano', global_name: 'Fulano', avatar: 'abc' };

// ---------- sessão ----------

test('assina e verifica; mudar qualquer byte do conteúdo invalida', () => {
  const t = signSession({ v: 1, id: '1', exp: Date.now() + 60000 }, SECRET);
  assert.equal(verifySession(t, SECRET).id, '1');
  const [payload, sig] = t.split('.');
  const evil = Buffer.from(JSON.stringify({ v: 1, id: '1', admin: true, exp: Date.now() + 60000 })).toString('base64url');
  assert.equal(verifySession(`${evil}.${sig}`, SECRET), null);
  assert.equal(verifySession(`${payload}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`, SECRET), null); // troca o último caractere por outro (antes: "A" fixo, que 1 em 16 vezes era igual e o teste falhava à toa)
});

test('segredo errado, vencida, malformada e sem segredo não valem', () => {
  const t = signSession({ v: 1, id: '1', exp: Date.now() + 60000 }, SECRET);
  assert.equal(verifySession(t, 'outro'), null);
  assert.equal(verifySession(t, ''), null);
  assert.equal(verifySession(signSession({ v: 1, id: '1', exp: Date.now() - 1 }, SECRET), SECRET), null);
  assert.equal(verifySession('a.b.c', SECRET), null);
  assert.equal(verifySession(undefined, SECRET), null);
  assert.equal(verifySession(signSession({ v: 2, id: '1', exp: Date.now() + 1e6 }, SECRET), SECRET), null);
});

test('um adminProof antigo (assinado com a chave crua, sem v:1) não vale como sessão', () => {
  const payload = Buffer.from(JSON.stringify({ id: '1', exp: Date.now() + 1e9 })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  assert.equal(verifySession(`${payload}.${sig}`, SECRET), null);
});

test('níveis do Discord: dono > Administrador > Gerenciar Servidor > membro', () => {
  assert.equal(tierFromDiscord({ owner: true, permissions: '0' }), 'o');
  assert.equal(tierFromDiscord({ owner: false, permissions: '8' }), 'a');
  assert.equal(tierFromDiscord({ owner: false, permissions: String(0x8 | 0x20) }), 'a');
  assert.equal(tierFromDiscord({ owner: false, permissions: '32' }), 'm');
  assert.equal(tierFromDiscord({ owner: false, permissions: '1024' }), 'x');
  assert.equal(tierFromDiscord({ owner: false }), 'x');
  assert.equal(tierFromDiscord({ owner: false, permissions: 'lixo' }), 'x');
  // permissões grandes (além de 32 bits) vêm como string e não podem estourar
  assert.equal(tierFromDiscord({ owner: false, permissions: '2251799813685247' }), 'a');
});

test('buildSession: perfil, admin do Sinal por ID, servers ordenados por nível, validade de 7 dias', () => {
  const now = 1_000_000;
  const token = buildSession({
    profile,
    guilds: [
      { id: '1', name: 'Comum', icon: null, owner: false, permissions: '0' },
      { id: '2', name: 'Meu', icon: 'h', owner: true, permissions: '0' },
      { id: '3', name: 'Mod', icon: 'm', owner: false, permissions: '32' }
    ],
    adminIds: ['123456789012345678'], secret: SECRET, now
  });
  const data = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  assert.equal(data.name, 'Fulano');
  assert.equal(data.admin, true);
  assert.equal(data.avatar, 'https://cdn.discordapp.com/avatars/123456789012345678/abc.png?size=64');
  assert.deepEqual(data.guilds.map((g) => g[3]), ['o', 'm', 'x']);
  assert.equal(data.exp, now + SESSION_TTL_MS);
});

test('buildSession: não-admin, sem avatar usa o padrão, lista vazia/ruim não quebra', () => {
  const token = buildSession({ profile: { id: '5', username: 'x' }, guilds: null, adminIds: ['9'], secret: SECRET });
  const data = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  assert.equal(data.admin, false);
  assert.match(data.avatar, /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
  assert.deepEqual(data.guilds, []);
});

test('buildSession: 200 servers cabem no limite do redirect e os de mais poder ficam', () => {
  const guilds = Array.from({ length: 200 }, (_, i) => ({
    id: String(100000000000000000n + BigInt(i)), name: 'Servidor com nome bem comprido número ' + i,
    icon: 'a'.repeat(32), owner: i === 199, permissions: '0'
  }));
  const token = buildSession({ profile, guilds, adminIds: [], secret: SECRET });
  assert.ok(token.length <= 7000, 'tamanho ' + token.length);
  const s = verifySession(token, SECRET);
  assert.equal(s.guilds[0][3], 'o'); // o único onde é dono sobrevive ao corte
});

test('guildTier: nível no server, ou null se não faz parte', () => {
  const s = { guilds: [['1', 'a', '', 'm']] };
  assert.equal(guildTier(s, '1'), 'm');
  assert.equal(guildTier(s, '2'), null);
  assert.equal(guildTier(null, '1'), null);
  assert.equal(guildTier({}, '1'), null);
});

// ---------- salas ----------

test('nome de sala de server: formato, parse e unicidade', () => {
  const a = newServerRoomName('111111111111111111');
  assert.match(a, /^s111111111111111111-[a-z0-9]{6}$/);
  assert.equal(parseServerRoom(a).guildId, '111111111111111111');
  assert.notEqual(a, newServerRoomName('111111111111111111'));
  for(const bad of ['ABC123', 's1-abc123', 's111111111111111111-ABC123', 's111111111111111111-abc12', 's111111111111111111-abc1234', '', null, undefined, 42]){
    assert.equal(parseServerRoom(bad), null, String(bad));
  }
});

test('título: sem < >, sem controle, espaços normalizados, máximo de 40', () => {
  assert.equal(cleanTitle('  Val   <script>x</script>\n\tvalendo '), 'Val scriptx/script valendo');
  assert.equal(cleanTitle('a'.repeat(100)).length, 40);
  assert.equal(cleanTitle(undefined), '');
  assert.equal(cleanTitle({ x: 1 }), '');
});

test('metadados da sala: ida e volta; lixo vira null', () => {
  const raw = buildRoomMetadata({ guildId: '1', title: 'T', creator: { id: '9', name: 'N' }, now: 5 });
  assert.deepEqual(parseRoomMetadata(raw), { v: 1, guild: '1', title: 'T', creator: { id: '9', name: 'N' }, access: 'open', createdAt: 5 });
  assert.equal(parseRoomMetadata(''), null);
  assert.equal(parseRoomMetadata('{"v":2}'), null);
  assert.equal(parseRoomMetadata('não é json'), null);
  assert.equal(parseRoomMetadata(undefined), null);
});

const sess = (tier, admin = false) => ({ admin, guilds: [['1', 'S', '', tier]] });

test('quem modera: dono, Administrador, Gerenciar Servidor e admin do Sinal — só nos servers de que fazem parte', () => {
  assert.equal(canModerate(sess('x'), '1'), false);
  for(const t of ['o', 'a', 'm']) assert.equal(canModerate(sess(t), '1'), true, t);
  assert.equal(canModerate(sess('x', true), '1'), true);
  assert.equal(canModerate(sess('o'), '2'), false);          // outro server
  assert.equal(canModerate(sess('x', true), '2'), false);    // admin do Sinal só nos servers dele
  assert.equal(canModerate(null, '1'), false);
});

test('quem entra em privada sem pedir: dono, Administrador e admin do Sinal — Gerenciar Servidor não', () => {
  assert.equal(canEnterPrivate(sess('x'), '1'), false);
  assert.equal(canEnterPrivate(sess('m'), '1'), false);
  assert.equal(canEnterPrivate(sess('a'), '1'), true);
  assert.equal(canEnterPrivate(sess('o'), '1'), true);
  assert.equal(canEnterPrivate(sess('x', true), '1'), true);
  assert.equal(canEnterPrivate(sess('o'), '2'), false);
});

test('responsável: o criador se estiver, senão quem entrou primeiro; saída em massa não deixa sala sem responsável', () => {
  const meta = { creator: { id: 'c' } };
  const p = (identity, userId, joinedAt) => ({ identity, userId, joinedAt });
  assert.equal(responsibleOf(meta, [p('a', 'x', 10), p('b', 'c', 50), p('c', 'y', 5)]).identity, 'b'); // criador mesmo entrando depois
  assert.equal(responsibleOf(meta, [p('a', 'x', 10), p('c', 'y', 5)]).identity, 'c');                  // criador saiu: o mais antigo
  assert.equal(responsibleOf(meta, [p('z', 'x', 7), p('a', 'y', 7)]).identity, 'a');                   // empate: ordem estável
  assert.equal(responsibleOf(meta, [p('a', 'x', 10)]).identity, 'a');                                  // sobrou um só
  assert.equal(responsibleOf(meta, []), null);                                                          // sala vazia some
  assert.equal(responsibleOf(null, [p('a', 'x', 1)]).identity, 'a');                                    // sala sem metadados
});

// ---------- hierarquia de moderação (HANDOFF §41) ----------

test('ranking: admin do Sinal > dono > administrador > gerencia > resto', () => {
  const r = (meta) => moderationRank(meta);
  assert.ok(r({ isAdmin: true }) < r({ tier: 'o' }));
  assert.ok(r({ tier: 'o' }) < r({ tier: 'a' }));
  assert.ok(r({ tier: 'a' }) < r({ tier: 'm' }));
  assert.ok(r({ tier: 'm' }) < r({ tier: 'x' }));
  assert.equal(r({ tier: 'x' }), r(null));
  assert.equal(r({ isAdmin: true, tier: 'm' }), 0); // admin do Sinal vale mais que qualquer cargo de servidor
});

test('hierarquia: só modera quem está ESTRITAMENTE abaixo; o admin do Sinal modera qualquer um e ninguém modera ele', () => {
  const sinal = { isAdmin: true }, dono = { tier: 'o' }, admin = { tier: 'a' }, gerente = { tier: 'm' }, comum = { tier: 'x' }, visitante = null;
  const pode = (a, b) => canModerateTarget(a, b);
  // o admin do Sinal expulsa todo mundo (inclusive outro admin do Sinal)
  for(const alvo of [dono, admin, gerente, comum, visitante, sinal]) assert.equal(pode(sinal, alvo), true);
  // dono: modera admin, gerente e comum — NÃO o admin do Sinal, nem outro dono
  assert.deepEqual([admin, gerente, comum, visitante].map((a) => pode(dono, a)), [true, true, true, true]);
  assert.equal(pode(dono, sinal), false);
  assert.equal(pode(dono, dono), false);
  // administrador: modera gerente e comum — NÃO dono, outro admin, nem o admin do Sinal
  assert.deepEqual([gerente, comum].map((a) => pode(admin, a)), [true, true]);
  assert.deepEqual([dono, admin, sinal].map((a) => pode(admin, a)), [false, false, false]);
  // gerencia: só comum
  assert.equal(pode(gerente, comum), true);
  assert.deepEqual([dono, admin, gerente, sinal].map((a) => pode(gerente, a)), [false, false, false, false]);
  // membro comum e visitante não moderam ninguém
  for(const alvo of [dono, admin, gerente, comum, sinal]){ assert.equal(pode(comum, alvo), false); assert.equal(pode(visitante, alvo), false); }
});

test('quem é moderador pelo token: admin do Sinal (roomAdmin) em qualquer sala; staff só na sala de servidor do próprio guild', () => {
  const room = 's111111111111111111-abc123';
  assert.equal(isModeratorToken({ video: { room, roomAdmin: true }, metadata: null }, room), true);
  assert.equal(isModeratorToken({ video: { room: 'ABC123', roomAdmin: true }, metadata: null }, 'ABC123'), true); // sala por código
  for(const tier of ['o', 'a', 'm']) assert.equal(isModeratorToken({ video: { room }, metadata: { tier, guild: '111111111111111111' } }, room), true, tier);
  assert.equal(isModeratorToken({ video: { room }, metadata: { tier: 'x', guild: '111111111111111111' } }, room), false);
  assert.equal(isModeratorToken({ video: { room }, metadata: { tier: 'o', guild: '222222222222222222' } }, room), false); // dono de OUTRO servidor
  assert.equal(isModeratorToken({ video: { room: 'outra' , roomAdmin: true }, metadata: null }, room), false);               // token de outra sala
  assert.equal(isModeratorToken({ video: { room: 'ABC123' }, metadata: { tier: 'o', guild: '111111111111111111' } }, 'ABC123'), false); // staff em sala por código
  assert.equal(isModeratorToken({ video: null, metadata: null }, room), false);
});

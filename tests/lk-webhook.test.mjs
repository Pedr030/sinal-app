// api/lk-webhook.js (push em tempo real, HANDOFF §39) contra o fake do
// LiveKit: assinatura, filtro de eventos, entrega só pra quem está ouvindo
// aquele server, saída/fechamento tirados da foto e pacote grande demais.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadApi, resetFake } from './helpers/api-harness.mjs';

const G1 = '111111111111111111';
const G2 = '222222222222222222';
const ROOM = `s${G1}-aaaaaa`;
let POST, cleanup, fake;

before(async () => { ({ mod: { POST }, cleanup } = await loadApi('lk-webhook.js')); });
after(() => cleanup && cleanup());
beforeEach(() => {
  fake = resetFake();
  fake.rooms = [{ name: ROOM, numParticipants: 2, metadata: JSON.stringify({ v: 1, guild: G1, title: 'Treino', creator: { id: '1', name: 'Dono' }, access: 'open', createdAt: 1 }), creationTime: 1 }];
  fake.participants[ROOM] = [
    { identity: 'd1-a', name: 'Ana', metadata: '{}', tracks: [{ source: 3 }], joinedAt: 5 },
    { identity: 'd2-b', name: 'Beto', metadata: '{}', tracks: [], joinedAt: 6 }
  ];
  fake.participants.presence = [
    { identity: 'd1-p', attributes: { guilds: `${G1},${G2}` } },
    { identity: 'd2-p', attributes: { guilds: G2 } },
    { identity: 'd3-p', attributes: { guilds: G1 } },
    { identity: 'd4-p' }
  ];
});

const hook = (event, auth = 'assinatura-valida') => POST(new Request('http://localhost/api/lk-webhook', {
  method: 'POST',
  headers: { authorization: auth, 'content-type': 'application/webhook+json' },
  body: JSON.stringify(event)
}));

test('sem assinatura válida: 401 e nada é enviado', async () => {
  const res = await hook({ event: 'participant_joined', room: { name: ROOM } }, 'falsa');
  assert.equal(res.status, 401);
  assert.equal(fake.sent.length, 0);
});

test('entrada numa sala do server: manda a foto SÓ pra quem ouve aquele server', async () => {
  const res = await hook({ event: 'participant_joined', room: { name: ROOM }, participant: { identity: 'd2-b' } });
  assert.equal(res.status, 200);
  assert.equal(fake.sent.length, 1);
  const m = fake.sent[0];
  assert.equal(m.room, 'presence');
  assert.equal(m.options.topic, 'lives');
  assert.deepEqual(m.options.destinationIdentities.sort(), ['d1-p', 'd3-p']); // d2-p só ouve G2, d4-p sem atributo
  const data = JSON.parse(m.text);
  assert.equal(data.guild, G1);
  assert.equal(data.rooms.length, 1);
  assert.equal(data.rooms[0].title, 'Treino');
  assert.deepEqual(data.rooms[0].participants.map((p) => [p.name, p.screen]), [['Ana', true], ['Beto', false]]);
});

test('participant_left: quem saiu já não aparece na foto, mesmo que a listagem ainda mostre', async () => {
  await hook({ event: 'participant_left', room: { name: ROOM }, participant: { identity: 'd2-b' } });
  const data = JSON.parse(fake.sent[0].text);
  assert.deepEqual(data.rooms[0].participants.map((p) => p.name), ['Ana']);
});

test('room_finished: a sala some da foto', async () => {
  await hook({ event: 'room_finished', room: { name: ROOM } });
  assert.deepEqual(JSON.parse(fake.sent[0].text), { guild: G1, rooms: [] });
});

test('track_published e unpublished também atualizam', async () => {
  for(const ev of ['track_published', 'track_unpublished', 'room_started']){
    fake.sent.length = 0;
    await hook({ event: ev, room: { name: ROOM } });
    assert.equal(fake.sent.length, 1, ev);
  }
});

test('ignora sala por código, sala de presença, evento que não interessa e corpo sem sala', async () => {
  for(const ev of [
    { event: 'participant_joined', room: { name: 'ABC123' } },
    { event: 'participant_joined', room: { name: 'presence' } },
    { event: 'egress_started', room: { name: ROOM } },
    { event: 'participant_joined' }
  ]){
    const res = await hook(ev);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ignored, true);
  }
  assert.equal(fake.sent.length, 0);
});

test('ninguém ouvindo aquele server: não monta foto nem envia', async () => {
  fake.participants.presence = [{ identity: 'd2-p', attributes: { guilds: G2 } }];
  const res = await hook({ event: 'participant_joined', room: { name: ROOM } });
  assert.deepEqual(await res.json(), { delivered: 0 });
  assert.equal(fake.sent.length, 0);
});

test('sala de presença ainda não existe (listParticipants falha): 200, nada enviado', async () => {
  delete fake.participants.presence;
  const res = await hook({ event: 'participant_joined', room: { name: ROOM } });
  assert.equal(res.status, 200);
  assert.equal(fake.sent.length, 0);
});

test('foto grande demais vira só "atualize" (o cliente busca em api/lives)', async () => {
  fake.participants[ROOM] = Array.from({ length: 25 }, (_, i) => ({
    identity: 'x' + i, name: 'Pessoa ' + i, metadata: JSON.stringify({ avatarUrl: 'https://cdn.discordapp.com/avatars/1/' + 'a'.repeat(60) + '.png' }), tracks: [], joinedAt: i
  }));
  fake.rooms = Array.from({ length: 5 }, (_, i) => ({ name: `s${G1}-bbbbb${i}`, numParticipants: 25, creationTime: 1 }));
  for(let i = 0; i < 5; i++) fake.participants[`s${G1}-bbbbb${i}`] = fake.participants[ROOM];
  await hook({ event: 'participant_joined', room: { name: ROOM } });
  assert.deepEqual(JSON.parse(fake.sent[0].text), { guild: G1, refresh: true });
});

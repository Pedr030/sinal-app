// Testa api/get-token.js DE VERDADE (o arquivo é copiado pra uma pasta
// temporária a cada execução, nunca duplicado à mão) contra um fake do
// livekit-server-sdk. A cópia é necessária porque o get-token.js real importa
// 'livekit-server-sdk' por specifier nu — pra substituir isso por um fake sem
// mexer no arquivo de produção nem depender de flag experimental de mock de
// módulo do Node, a gente monta uma pasta com a mesma estrutura relativa
// (api/, lib/, node_modules/livekit-server-sdk) e importa de lá.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let testDir;
let POST;

before(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'sinal-get-token-test-'));
  mkdirSync(join(testDir, 'api'));
  mkdirSync(join(testDir, 'lib'));
  mkdirSync(join(testDir, 'node_modules', 'livekit-server-sdk'), { recursive: true });

  copyFileSync(join(ROOT, 'api/get-token.js'), join(testDir, 'api/get-token.js'));
  copyFileSync(join(ROOT, 'lib/adminProof.js'), join(testDir, 'lib/adminProof.js'));

  writeFileSync(
    join(testDir, 'node_modules/livekit-server-sdk/package.json'),
    JSON.stringify({ name: 'livekit-server-sdk', version: '0.0.0-fake', type: 'module', main: 'index.js' })
  );
  writeFileSync(
    join(testDir, 'node_modules/livekit-server-sdk/index.js'),
    `
export class AccessToken {
  constructor(key, secret, opts){ this.opts = opts; this.grant = null; }
  addGrant(g){ this.grant = g; }
  async toJwt(){ return 'FAKE_JWT.' + JSON.stringify({ identity: this.opts.identity, name: this.opts.name, metadata: this.opts.metadata, grant: this.grant }); }
}
export class RoomServiceClient {
  constructor(url, key, secret){ this.url = url; }
  async listRooms(names){
    if(names && names.includes('EXISTE1')) return [{ name: 'EXISTE1', numParticipants: 1 }];
    return [];
  }
  async createRoom(opts){ globalThis.__lastCreateRoom = opts; return { name: opts.name }; }
}
`
  );

  process.env.LIVEKIT_API_KEY = 'fake-key';
  process.env.LIVEKIT_API_SECRET = 'fake-secret';
  process.env.LIVEKIT_URL = 'wss://fake.example.com';
  delete process.env.DISCORD_CLIENT_SECRET;
  delete process.env.DISCORD_WEBHOOK_URL;

  const mod = await import(pathToFileURL(join(testDir, 'api/get-token.js')).href);
  POST = mod.POST;
});

after(() => {
  if(testDir) rmSync(testDir, { recursive: true, force: true });
});

const post = (body) => POST(new Request('http://localhost/api/get-token', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
}));

test('exporta POST (não GET) — efeito colateral não pode ser um GET', () => {
  assert.equal(typeof POST, 'function');
});

test('join numa sala que existe devolve token', async () => {
  const res = await post({ room: 'existe1', name: 'Pedro', mode: 'join' });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok(json.token);
  assert.equal(json.url, 'wss://fake.example.com');
});

test('join numa sala que não existe devolve 404', async () => {
  const res = await post({ room: 'naoexiste', name: 'Pedro', mode: 'join' });
  const json = await res.json();
  assert.equal(res.status, 404);
  assert.equal(json.error, 'room-not-found');
});

test('create dispara createRoom com timeouts curtos', async () => {
  globalThis.__lastCreateRoom = null;
  const res = await post({ room: 'novasala', name: 'Pedro', mode: 'create' });
  assert.equal(res.status, 200);
  assert.equal(globalThis.__lastCreateRoom.name, 'NOVASALA');
  assert.equal(globalThis.__lastCreateRoom.emptyTimeout, 60);
  assert.equal(globalThis.__lastCreateRoom.departureTimeout, 60);
});

test('avatar válido no corpo não quebra o fluxo', async () => {
  const res = await post({ room: 'x1', name: 'Pedro', mode: 'join', avatar: 'https://cdn.discordapp.com/avatars/1/a.png?size=64' });
  await res.json();
  assert.equal(res.status, 404); // sala x1 não existe — mas chegou até aqui sem quebrar
});

test('avatar malicioso no corpo é neutralizado (não vai pro metadata)', async () => {
  const res = await post({ room: 'existe1', name: 'Pedro', mode: 'join', avatar: 'https://cdn.discordapp.com/a" onerror="alert(1)' });
  const json = await res.json();
  assert.equal(res.status, 200);
  const payload = JSON.parse(json.token.split('FAKE_JWT.')[1]);
  const meta = payload.metadata ? JSON.parse(payload.metadata) : null;
  assert.ok(!meta || !meta.avatarUrl);
});

test('corpo JSON malformado devolve 400 (não derruba a function)', async () => {
  const res = await POST(new Request('http://localhost/api/get-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'isso não é json{'
  }));
  assert.equal(res.status, 400);
});

test('corpo sem room/name devolve 400', async () => {
  const res = await post({});
  assert.equal(res.status, 400);
});

test('tipos não-string no corpo não lançam exceção não tratada', async () => {
  const res = await post({ room: 123, name: { foo: 'bar' }, mode: 'join' });
  assert.ok(res.status === 400 || res.status === 404);
});

test('adminProof inválido não derruba a requisição', async () => {
  const res = await post({ room: 'existe1', name: 'Pedro', mode: 'join', adminProof: 'lixo-qualquer' });
  assert.equal(res.status, 200);
});

// api/report.js (relatório de problema → canal privado do Discord) e lib/ratelimit.js:
// validação do corpo, tetos de tamanho, limite por IP e o que sai pro Discord.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadApi } from './helpers/api-harness.mjs';
import { createLimiter, clientIp } from '../lib/ratelimit.js';

let POST, cleanup, sent;
const realFetch = globalThis.fetch;

before(async () => {
  process.env.DISCORD_REPORT_WEBHOOK_URL = 'https://webhook.invalid/teste';
  ({ mod: { POST }, cleanup } = await loadApi('report.js'));
});
after(() => { globalThis.fetch = realFetch; cleanup && cleanup(); delete process.env.DISCORD_REPORT_WEBHOOK_URL; });
beforeEach(() => {
  sent = [];
  globalThis.fetch = async (url, opts) => { sent.push({ url: String(url), body: opts && opts.body }); return new Response('{}', { status: 200 }); };
});

let n = 0;
const send = (body, { ip, headers } = {}) => POST(new Request('http://localhost/api/report', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': ip || ('192.0.2.' + (++n)), ...(headers || {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body)
}));

test('relatório válido vai pro webhook; menções são neutralizadas', async () => {
  const res = await send({ description: 'tela preta @everyone', name: 'PH', appVersion: '0.3.15', siteVersion: '0.8.55', log: 'linha 1' });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  const payload = JSON.parse(sent[0].body.get('payload_json'));
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.ok(payload.content.includes('tela preta'));
});

test('corpo que não é objeto (null, lista, número) ou JSON quebrado: 400, sem exceção', async () => {
  for(const body of ['null', '[]', '1', '"x"', 'nao é json{']){
    assert.equal((await send(body)).status, 400, body);
  }
  assert.equal(sent.length, 0);
});

test('vazio (sem descrição e sem registro): 400; registro acima de 80 KB: 413; corpo gigante recusado antes de ler: 413', async () => {
  assert.equal((await send({})).status, 400);
  assert.equal((await send({ description: 'x', log: 'a'.repeat(81 * 1024) })).status, 413);
  assert.equal((await send({ description: 'x' }, { headers: { 'content-length': String(500 * 1024) } })).status, 413);
  assert.equal(sent.length, 0);
});

test('limite por IP: o 4º envio em 10 minutos leva 429; outro IP não é afetado', async () => {
  const ip = '198.51.100.99';
  for(let i = 0; i < 3; i++) assert.equal((await send({ description: 'x' }, { ip })).status, 200);
  assert.equal((await send({ description: 'x' }, { ip })).status, 429);
  assert.equal((await send({ description: 'x' }, { ip: '198.51.100.98' })).status, 200);
});

test('sem a variável do webhook: 503 (desligado)', async () => {
  const saved = process.env.DISCORD_REPORT_WEBHOOK_URL;
  delete process.env.DISCORD_REPORT_WEBHOOK_URL;
  try{ assert.equal((await send({ description: 'x' })).status, 503); }
  finally{ process.env.DISCORD_REPORT_WEBHOOK_URL = saved; }
});

test('Discord recusando: 502, sem vazar o motivo', async () => {
  globalThis.fetch = async () => new Response('segredo-do-discord', { status: 500 });
  const original = console.error; console.error = () => {};
  try{
    const res = await send({ description: 'x' });
    assert.equal(res.status, 502);
    assert.ok(!(await res.text()).includes('segredo-do-discord'));
  } finally { console.error = original; }
});

// ---------- lib/ratelimit.js ----------

test('limitador: respeita o máximo na janela e libera de novo depois dela', () => {
  const l = createLimiter({ max: 2, windowMs: 1000 });
  assert.equal(l.allow('a', 0), true);
  assert.equal(l.allow('a', 100), true);
  assert.equal(l.allow('a', 200), false);
  assert.equal(l.allow('b', 200), true);          // chaves independentes
  assert.equal(l.allow('a', 1100), true);         // a primeira saiu da janela
});

test('limitador: não cresce sem limite (muitas chaves distintas não estouram a memória)', () => {
  const l = createLimiter({ max: 1, windowMs: 1000, maxKeys: 50 });
  for(let i = 0; i < 500; i++) l.allow('ip-' + i, i);
  assert.equal(l.allow('ip-novo', 600), true); // continua funcionando depois da poda
});

test('IP do cliente: primeiro do x-forwarded-for, depois x-real-ip, senão valor fixo; truncado', () => {
  const req = (h) => new Request('http://x', { headers: h });
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })), '1.2.3.4');
  assert.equal(clientIp(req({ 'x-real-ip': '9.9.9.9' })), '9.9.9.9');
  assert.equal(clientIp(req({})), 'desconhecido');
  assert.equal(clientIp(req({ 'x-forwarded-for': 'a'.repeat(500) })).length, 64);
});

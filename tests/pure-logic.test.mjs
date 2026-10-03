// Testa funções puras extraídas do código REAL (não uma cópia mantida à parte
// aqui) — public/app.js é um script clássico (sem export), então não dá pra
// importar direto; extraímos a função de dentro do arquivo por regex, do
// mesmo jeito que foi validado manualmente durante a v0.8.29/v0.8.31.
// Se a assinatura da função mudar de um jeito que o regex não reconheça mais,
// o teste falha com "não achei X" em vez de silenciosamente testar código
// desatualizado — isso é intencional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(join(ROOT, 'public/app.js'), 'utf8');

function extractFunction(src, name){
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}', 'm'));
  if(!m) throw new Error('não achei a função ' + name + ' em ' + name);
  return m[0];
}

const escapeHtml = new Function(extractFunction(appJs, 'escapeHtml') + '; return escapeHtml;')();

test('escapeHtml escapa aspas duplas (contexto de atributo)', () => {
  assert.equal(escapeHtml('x" onerror="alert(1)'), 'x&quot; onerror=&quot;alert(1)');
});

test('escapeHtml escapa aspas simples', () => {
  assert.equal(escapeHtml("x' onerror='alert(1)"), 'x&#39; onerror=&#39;alert(1)');
});

test('escapeHtml escapa tags', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('escapeHtml escapa & antes dos outros (sem duplo-escape)', () => {
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('escapeHtml trata null/undefined como string vazia', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml não mexe em texto normal', () => {
  assert.equal(escapeHtml('Pedro Henrique'), 'Pedro Henrique');
});

// ---------- servers no Sinal (HANDOFF §39): helpers puros do app.js ----------
const serverHelpers = new Function(
  "const SERVER_ROOM_RE = /^s[0-9]{15,21}-[a-z0-9]{6}$/;" +
  extractFunction(appJs, 'isServerRoomName') + extractFunction(appJs, 'guildIconUrl') +
  extractFunction(appJs, 'guildInitials') + extractFunction(appJs, 'isDiscordAvatarUrl') +
  '; return { isServerRoomName, guildIconUrl, guildInitials, isDiscordAvatarUrl };'
)();

test('isServerRoomName: só o formato s<id>-xxxxxx em minúsculas', () => {
  assert.equal(serverHelpers.isServerRoomName('s800000000000000001-abc123'), true);
  for(const bad of ['ABC123', 'S800000000000000001-ABC123', 's1-abc123', 's800000000000000001-abc12', '', null, undefined]){
    assert.equal(serverHelpers.isServerRoomName(bad), false, String(bad));
  }
});

test('guildIconUrl: monta a URL do CDN só com id e hash válidos', () => {
  assert.equal(serverHelpers.guildIconUrl({ id: '800000000000000001', icon: 'a_1b2c3' }), 'https://cdn.discordapp.com/icons/800000000000000001/a_1b2c3.png?size=64');
  assert.equal(serverHelpers.guildIconUrl({ id: '800000000000000001', icon: '' }), '');
  assert.equal(serverHelpers.guildIconUrl({ id: '800000000000000001', icon: 'x"onerror="1' }), '');
  assert.equal(serverHelpers.guildIconUrl({ id: 'abc', icon: 'ok' }), '');
  assert.equal(serverHelpers.guildIconUrl(null), '');
});

test('guildInitials: iniciais de duas palavras, ou as duas primeiras letras', () => {
  assert.equal(serverHelpers.guildInitials('Galera do Valorant'), 'GV');
  assert.equal(serverHelpers.guildInitials('Sinal'), 'SI');
  assert.equal(serverHelpers.guildInitials('Estudos e Café'), 'EC');
  assert.equal(serverHelpers.guildInitials('de'), '?');
  assert.equal(serverHelpers.guildInitials(''), '?');
  assert.equal(serverHelpers.guildInitials(undefined), '?');
});

test('isDiscordAvatarUrl: só imagens do CDN do Discord', () => {
  assert.equal(serverHelpers.isDiscordAvatarUrl('https://cdn.discordapp.com/avatars/1/a.png?size=64'), true);
  assert.equal(serverHelpers.isDiscordAvatarUrl('https://evil.com/a.png'), false);
  assert.equal(serverHelpers.isDiscordAvatarUrl('https://cdn.discordapp.com/a" onerror="x'), false);
  assert.equal(serverHelpers.isDiscordAvatarUrl(undefined), false);
});

// ---------- login pelo navegador no app desktop (HANDOFF §39, fase 2c) ----------
const newLoginNonce = new Function(extractFunction(appJs, 'newLoginNonce') + '; return newLoginNonce;')();

test('newLoginNonce: 32 hex minúsculos (o formato que o servidor e o app exigem) e diferente a cada vez', () => {
  const a = newLoginNonce();
  const b = newLoginNonce();
  assert.match(a, /^[a-f0-9]{32}$/);
  assert.notEqual(a, b);
});

// ---------- campo "entrar em sala existente": só código de sala por código ----------
const pickPrefillCode = new Function(extractFunction(appJs, 'pickPrefillCode') + '; return pickPrefillCode;')();
const SERVER_ROOM = 's800000000000000001-abc123';

test('prefill: convite com código normal vira o código em maiúsculas (e tem prioridade sobre o último)', () => {
  assert.deepEqual(pickPrefillCode('abc123', 'ZZZ999'), { code: 'ABC123', dropLast: false, dropSala: false });
});

test('prefill: sem convite, relembra o último código por código', () => {
  assert.deepEqual(pickPrefillCode(null, 'ZZZ999'), { code: 'ZZZ999', dropLast: false, dropSala: false });
  assert.deepEqual(pickPrefillCode('', ''), { code: '', dropLast: false, dropSala: false });
});

test('prefill: nome de sala de servidor NUNCA aparece no campo (nem do convite, nem do último salvo)', () => {
  // ?sala= de servidor: não mostra, tira da URL e cai no último código normal, se houver
  assert.deepEqual(pickPrefillCode(SERVER_ROOM, 'ZZZ999'), { code: 'ZZZ999', dropLast: false, dropSala: true });
  assert.deepEqual(pickPrefillCode(SERVER_ROOM, null), { code: '', dropLast: false, dropSala: true });
  // último salvo era de servidor (bug antigo): esquece o valor
  assert.deepEqual(pickPrefillCode(null, SERVER_ROOM), { code: '', dropLast: true, dropSala: false });
  // também a versão em maiúsculas que o campo mostrava
  assert.deepEqual(pickPrefillCode(null, SERVER_ROOM.toUpperCase()), { code: '', dropLast: true, dropSala: false });
});

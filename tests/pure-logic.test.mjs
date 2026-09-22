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
const getTokenJs = readFileSync(join(ROOT, 'api/get-token.js'), 'utf8');

function extractFunction(src, name){
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}', 'm'));
  if(!m) throw new Error('não achei a função ' + name + ' em ' + name);
  return m[0];
}

const escapeHtml = new Function(extractFunction(appJs, 'escapeHtml') + '; return escapeHtml;')();

const avatarRegexMatch = getTokenJs.match(/const avatar = (\/\^https[^;]+?)\.test\(avatarRaw\)/);
if(!avatarRegexMatch) throw new Error('não achei o regex de validação de avatar em api/get-token.js');
const avatarRegex = new Function('return ' + avatarRegexMatch[1])();
const validaAvatar = (raw) => (avatarRegex.test(raw) ? raw : '');

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

test('avatar: aceita URLs reais do CDN do Discord', () => {
  assert.equal(
    validaAvatar('https://cdn.discordapp.com/avatars/123456789012345678/a1b2c3d4e5f6.png?size=64'),
    'https://cdn.discordapp.com/avatars/123456789012345678/a1b2c3d4e5f6.png?size=64'
  );
  assert.equal(validaAvatar('https://cdn.discordapp.com/embed/avatars/3.png'), 'https://cdn.discordapp.com/embed/avatars/3.png');
});

test('avatar: bloqueia payload de XSS mesmo com prefixo certo', () => {
  assert.equal(validaAvatar('https://cdn.discordapp.com/a" onerror="alert(1)'), '');
});

test('avatar: bloqueia domínio parecido mas diferente', () => {
  assert.equal(validaAvatar('https://cdn.discordapp.com.evil.com/x.png'), '');
});

test('avatar: bloqueia http (exige https)', () => {
  assert.equal(validaAvatar('http://cdn.discordapp.com/x.png'), '');
});

test('avatar: bloqueia string qualquer', () => {
  assert.equal(validaAvatar('x'), '');
});

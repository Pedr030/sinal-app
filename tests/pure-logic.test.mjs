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

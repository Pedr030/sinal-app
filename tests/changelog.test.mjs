// public/changelog.json alimenta a aba Novidades, a janela de atualização do app e as notas da release.
// Garante o formato (inclusive o campo "destaque", que marca as mudanças maiores).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const entries = JSON.parse(readFileSync(join(ROOT, 'public/changelog.json'), 'utf8'));

test('changelog: lista não vazia, ids únicos e datas no formato AAAA-MM-DD', () => {
  assert.ok(Array.isArray(entries) && entries.length > 0);
  const ids = entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  for(const e of entries) assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, e.id);
});

test('changelog: cada entrada tem título e ao menos um item de texto', () => {
  for(const e of entries){
    assert.ok(typeof e.title === 'string' && e.title.length > 0, e.id);
    assert.ok(Array.isArray(e.items) && e.items.length > 0, e.id);
    for(const item of e.items) assert.ok(typeof item === 'string' && item.length > 0, e.id);
  }
});

test('changelog: "destaque", quando existe, é exatamente true (só as mudanças grandes)', () => {
  for(const e of entries) if('destaque' in e) assert.equal(e.destaque, true, e.id);
  assert.ok(entries.some((e) => e.destaque === true));
  assert.ok(entries.some((e) => e.destaque !== true)); // se tudo fosse destaque, nada se destacaria
});

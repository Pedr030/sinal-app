// electron/src/auth-url.js — as peças puras do login pelo navegador padrão
// (HANDOFF §39, fase 2c): validação do nonce, URL que o app abre e o parse do
// sinal://auth que volta. É CommonJS (o main do Electron), importado daqui.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import authUrl from '../electron/src/auth-url.js';

const { isValidNonce, buildLoginUrl, parseAuthUrl } = authUrl;
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SESSION = 'eyJ2IjoxLCJpZCI6IjEifQ.assinaturaFalsaMasComFormatoCerto_-123';

test('nonce: exatamente 32 caracteres hex minúsculos', () => {
  assert.equal(isValidNonce(NONCE), true);
  for(const bad of ['', 'abc', NONCE.toUpperCase(), NONCE + '0', 'g'.repeat(32), null, undefined, 42, { x: 1 }]){
    assert.equal(isValidNonce(bad), false, String(bad));
  }
});

test('URL de login: origem do próprio Sinal, client=app e o nonce; refresh só quando pedido', () => {
  assert.equal(buildLoginUrl('https://sinal.test', NONCE), `https://sinal.test/api/discord-login?client=app&nonce=${NONCE}`);
  assert.equal(buildLoginUrl('https://sinal.test', NONCE, { refresh: true }), `https://sinal.test/api/discord-login?client=app&nonce=${NONCE}&refresh=1`);
});

test('URL de login: nonce inválido não gera URL (o site não consegue injetar outra coisa)', () => {
  assert.equal(buildLoginUrl('https://sinal.test', 'x&redirect=https://evil.com'), null);
  assert.equal(buildLoginUrl('https://sinal.test', ''), null);
});

test('parse do sinal://auth: devolve sessão e nonce', () => {
  assert.deepEqual(parseAuthUrl(`sinal://auth?session=${SESSION}&nonce=${NONCE}`), { session: SESSION, nonce: NONCE });
});

test('parse do sinal://auth: descarta tudo que não é exatamente o formato gerado pelo servidor', () => {
  const bad = [
    `sinal://join?sala=ABC123`,                                  // outro tipo de link
    `sinal://auth?session=${SESSION}`,                           // sem nonce
    `sinal://auth?nonce=${NONCE}`,                               // sem sessão
    `sinal://auth?session=curta&nonce=${NONCE}`,                 // sessão curta demais
    `sinal://auth?session=${SESSION}&nonce=ZZZ`,                 // nonce ruim
    `sinal://auth?session=${SESSION}"<script>&nonce=${NONCE}`,   // caracteres fora do formato
    `sinal://evil/auth?session=${SESSION}&nonce=${NONCE}`,       // host diferente
    `sinal://auth?session=${'a'.repeat(20000)}&nonce=${NONCE}`,  // enorme
    'http://sinal.test/auth', '', null, undefined, 42
  ];
  for(const raw of bad) assert.equal(parseAuthUrl(raw), null, String(raw).slice(0, 60));
});

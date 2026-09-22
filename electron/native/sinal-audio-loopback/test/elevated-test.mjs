import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AudioLoopback } = require('../target/debug/sinal_audio_loopback.node');

const l = new AudioLoopback();
try {
  l.start(7452, true, (err, buf) => {});
  console.log('RESULTADO: OK ELEVADO — funcionou!');
  l.stop();
} catch (e) {
  console.error('RESULTADO: FALHOU ELEVADO tambem:', e.message);
}

// Smoke test: ativa o loopback excluindo um PID irrelevante (o do próprio
// processo Node, que não produz áudio) — deveria se comportar como "captura
// tudo", já que não há nada relevante sendo excluído. Só confirma que a
// ativação COM/WASAPI funciona de ponta a ponta e que chegam bytes de verdade.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AudioLoopback } = require('../target/debug/sinal_audio_loopback.node');

const loopback = new AudioLoopback();
let totalBytes = 0;
let chunks = 0;
let maxAbsSample = 0;

function onChunk(err, buf){
  if(err){ console.error('ERRO no callback:', err); return; }
  chunks++;
  totalBytes += buf.length;
  // PCM 16-bit little-endian — olha a amplitude máxima pra saber se tem
  // áudio de verdade chegando (silêncio puro = tudo perto de zero).
  for(let i = 0; i + 1 < buf.length; i += 2){
    const sample = Math.abs(buf.readInt16LE(i));
    if(sample > maxAbsSample) maxAbsSample = sample;
  }
}

console.log('Iniciando captura (exclude mode, PID irrelevante = process.pid)...');
try{
  loopback.start(process.pid, true, onChunk);
  console.log('start() retornou sem erro — ativação COM/WASAPI funcionou.');
}catch(e){
  console.error('FALHOU no start():', e);
  process.exit(1);
}

console.log('Capturando por 3 segundos (toque algum som no sistema pra um teste melhor)...');
await new Promise((r) => setTimeout(r, 3000));

loopback.stop();
console.log('--- resultado ---');
console.log('chunks recebidos:', chunks);
console.log('bytes totais:', totalBytes);
console.log('amplitude maxima (0-32767):', maxAbsSample);
console.log(chunks > 0 ? 'PASS: pacotes chegaram' : 'FALHA: nenhum pacote chegou');
process.exit(chunks > 0 ? 0 : 1);

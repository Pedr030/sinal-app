// Teste definitivo: exclui o Discord ENQUANTO uma call de voz REAL está
// rolando (não um processo de teste tocando WAV). Compara amplitude com o
// Discord excluído vs incluído (mesma call, mesmas pessoas falando).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AudioLoopback } = require('../native/sinal-audio-loopback/target/release/sinal_audio_loopback.node');

const DISCORD_ROOT_PID = 7448; // confirmado agora via Win32_Process

function captureFor(ms, pid, exclude){
  return new Promise((resolve) => {
    const loopback = new AudioLoopback();
    let maxAmp = 0, chunks = 0, sumAmp = 0, samples = 0;
    loopback.start(pid, exclude, (err, buf) => {
      if(err){ console.error('erro:', err); return; }
      chunks++;
      for(let i = 0; i + 1 < buf.length; i += 2){
        const s = Math.abs(buf.readInt16LE(i));
        if(s > maxAmp) maxAmp = s;
        sumAmp += s; samples++;
      }
    });
    setTimeout(() => {
      loopback.stop();
      resolve({ maxAmp, chunks, avgAmp: samples ? Math.round(sumAmp / samples) : 0 });
    }, ms);
  });
}

console.log('=== A: EXCLUINDO o Discord (pid ' + DISCORD_ROOT_PID + ') por 6s -- fala na call agora! ===');
const a = await captureFor(6000, DISCORD_ROOT_PID, true);
console.log('Resultado A (Discord excluído):', a);

await new Promise((r) => setTimeout(r, 500));

console.log('\n=== B: SEM excluir nada (PID irrelevante) por 6s -- continue falando ===');
const b = await captureFor(6000, process.pid, true); // exclui só a si mesmo, irrelevante -- deveria pegar tudo incluindo Discord
console.log('Resultado B (sistema inteiro, Discord incluído):', b);

console.log('\n--- CONCLUSÃO ---');
console.log('A (Discord excluído) amplitude máxima:', a.maxAmp, '| média:', a.avgAmp);
console.log('B (sistema inteiro) amplitude máxima:', b.maxAmp, '| média:', b.avgAmp);
if(b.maxAmp < 500){
  console.log('AVISO: B teve amplitude muito baixa -- ninguém falou durante o teste? Resultado inconclusivo, repetir.');
} else if(a.maxAmp < b.maxAmp * 0.3){
  console.log('PASS: excluir o Discord reduziu bastante a amplitude -- a exclusão está funcionando.');
} else {
  console.log('FALHA: excluir o Discord NÃO reduziu a amplitude de forma significativa -- vazamento confirmado, é bug de verdade.');
}

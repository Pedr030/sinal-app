// Teste com um app REAL e complexo tocando áudio agora (não um WAV sintético
// via PowerShell) — mais parecido com o caso real de Discord/navegador do
// que o exclude-filter-test.mjs original. Recebe o PID por argv.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AudioLoopback } = require('../native/sinal-audio-loopback/target/release/sinal_audio_loopback.node');

const targetPid = Number(process.argv[2]);
if (!targetPid) {
  console.error('uso: node exclude-real-app-test.mjs <pid>');
  process.exit(1);
}

function captureFor(ms, pid, exclude) {
  return new Promise((resolve) => {
    const loopback = new AudioLoopback();
    let maxAmp = 0, chunks = 0, sumAmp = 0, samples = 0;
    loopback.start(pid, exclude, (err, buf) => {
      if (err) { console.error('erro:', err); return; }
      chunks++;
      for (let i = 0; i + 1 < buf.length; i += 2) {
        const s = Math.abs(buf.readInt16LE(i));
        if (s > maxAmp) maxAmp = s;
        sumAmp += s; samples++;
      }
    });
    setTimeout(() => {
      loopback.stop();
      resolve({ maxAmp, chunks, avgAmp: samples ? Math.round(sumAmp / samples) : 0 });
    }, ms);
  });
}

console.log(`=== A: EXCLUINDO pid ${targetPid} por 5s ===`);
const a = await captureFor(5000, targetPid, true);
console.log('Resultado A (alvo excluído):', a);

await new Promise((r) => setTimeout(r, 500));

console.log('\n=== B: SEM excluir nada (pid irrelevante) por 5s ===');
const b = await captureFor(5000, process.pid, true);
console.log('Resultado B (sistema inteiro):', b);

console.log('\n--- CONCLUSÃO ---');
console.log('A (excluído) amplitude máxima:', a.maxAmp, '| média:', a.avgAmp);
console.log('B (sistema inteiro) amplitude máxima:', b.maxAmp, '| média:', b.avgAmp);
if (b.maxAmp < 200) {
  console.log('AVISO: B teve amplitude muito baixa -- o app parou de tocar som durante o teste? Inconclusivo.');
} else if (a.maxAmp < b.maxAmp * 0.3) {
  console.log('PASS: excluir o PID reduziu bastante a amplitude -- a exclusão está funcionando pra esse app.');
} else {
  console.log('FALHA: excluir o PID NÃO reduziu a amplitude de forma significativa -- vazamento confirmado.');
}

// Teste decisivo: confirma que o filtro por PROCESSO funciona de verdade,
// não só que a captura básica destravou. Toca um som de um processo
// específico e compara:
//   A) excluindo ESSE processo -> deveria vir quase silêncio
//   B) excluindo um processo IRRELEVANTE -> deveria vir o som de verdade
// Se A ficar bem mais baixo que B, o filtro por processo está funcionando.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { AudioLoopback } = require('../target/debug/sinal_audio_loopback.node');

function captureFor(ms, excludePid){
  return new Promise((resolve) => {
    const loopback = new AudioLoopback();
    let maxAmp = 0, chunks = 0;
    loopback.start(excludePid, true, (err, buf) => {
      if(err) return;
      chunks++;
      for(let i = 0; i + 1 < buf.length; i += 2){
        const s = Math.abs(buf.readInt16LE(i));
        if(s > maxAmp) maxAmp = s;
      }
    });
    setTimeout(() => { loopback.stop(); resolve({ maxAmp, chunks }); }, ms);
  });
}

function playSoundLoop(){
  // Toca o som em loop por ~6s, num processo FILHO próprio (pra ter um PID
  // real e isolado pra excluir).
  return spawn('powershell.exe', ['-c',
    "for($i=0;$i -lt 6;$i++){ (New-Object Media.SoundPlayer 'C:\\Windows\\Media\\tada.wav').PlaySync() }"
  ]);
}

console.log('=== Teste A: excluindo o processo QUE ESTÁ tocando o som (deveria ficar baixo) ===');
{
  const player = playSoundLoop();
  await new Promise((r) => setTimeout(r, 500)); // deixa o processo começar
  const result = await captureFor(3000, player.pid);
  console.log(`PID excluído: ${player.pid} (o que está tocando)`);
  console.log('amplitude maxima:', result.maxAmp, '| chunks:', result.chunks);
  player.kill();
  globalThis.__resultA = result.maxAmp;
}

await new Promise((r) => setTimeout(r, 800));

console.log('\n=== Teste B: excluindo um processo IRRELEVANTE (deveria pegar o som normal) ===');
{
  const player = playSoundLoop();
  await new Promise((r) => setTimeout(r, 500));
  const result = await captureFor(3000, process.pid); // exclui a nós mesmos, irrelevante
  console.log(`PID excluído: ${process.pid} (irrelevante, não é quem toca)`);
  console.log('amplitude maxima:', result.maxAmp, '| chunks:', result.chunks);
  player.kill();
  globalThis.__resultB = result.maxAmp;
}

console.log('\n--- CONCLUSÃO ---');
console.log('A (excluindo quem toca):', globalThis.__resultA);
console.log('B (excluindo irrelevante):', globalThis.__resultB);
const filtrou = globalThis.__resultA < globalThis.__resultB * 0.3; // A deve ser bem menor que B
console.log(filtrou
  ? 'PASS: o filtro por processo está funcionando de verdade (A << B)'
  : 'FALHA ou inconclusivo: A não ficou consistentemente menor que B'
);
process.exit(filtrou ? 0 : 1);

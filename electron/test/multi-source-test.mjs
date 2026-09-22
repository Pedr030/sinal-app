// Testa a lógica nova de captura multi-fonte (HANDOFF §15.13) FORA do
// Electron de verdade — reimplementa aqui o mesmo scanAudioSources()/
// startSourceCapture()/stopSourceCapture() do main.js, pra validar:
//   1. Várias instâncias de AudioLoopback rodando ao mesmo tempo não
//      conflitam entre si (cada uma captura só o que deveria).
//   2. Discord e Sinal.exe nunca entram na lista de fontes.
//   3. Um app que só aparece DEPOIS que o scan já começou é pego no scan
//      seguinte (sem precisar reiniciar nada).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const addon = require('../native/sinal-audio-loopback/target/release/sinal_audio_loopback.node');

const sources = new Map(); // pid -> { loopback, exeName, maxAmp, sumAmp, samples }

function isEligible(session, discordRootPid){
  const exe = session.exeName.toLowerCase();
  if(exe === 'discord.exe' || exe === 'sinal.exe') return false;
  if(session.pid === discordRootPid) return false;
  return true;
}

function startCapture(pid, exeName){
  const loopback = new addon.AudioLoopback();
  const stats = { loopback, exeName, maxAmp: 0, sumAmp: 0, samples: 0 };
  loopback.start(pid, false, (err, buf) => {
    if(err){ console.error(`[erro] pid=${pid}:`, err); return; }
    for(let i = 0; i + 1 < buf.length; i += 2){
      const s = Math.abs(buf.readInt16LE(i));
      if(s > stats.maxAmp) stats.maxAmp = s;
      stats.sumAmp += s; stats.samples++;
    }
  });
  sources.set(pid, stats);
  console.log(`[+] fonte adicionada — pid=${pid} exe=${exeName}`);
}

function stopCapture(pid){
  const s = sources.get(pid);
  if(!s) return;
  s.loopback.stop();
  console.log(`[-] fonte removida — pid=${pid} exe=${s.exeName} | maxAmp=${s.maxAmp} avgAmp=${s.samples ? Math.round(s.sumAmp / s.samples) : 0}`);
  sources.delete(pid);
}

function scan(){
  const sessions = addon.listAudioSessions();
  const discordRootPid = addon.findDiscordRootPid();
  const seenPids = new Set();
  for(const s of sessions){
    if(seenPids.has(s.pid)) continue;
    seenPids.add(s.pid);
    if(!isEligible(s, discordRootPid)) continue;
    if(!sources.has(s.pid)) startCapture(s.pid, s.exeName);
  }
  for(const pid of [...sources.keys()]){
    if(!seenPids.has(pid)) stopCapture(pid);
  }
  const active = [...sources.entries()].map(([pid, s]) => `${s.exeName}(${pid})`).join(', ') || '(nenhuma)';
  console.log(`[scan] fontes ativas: ${active}`);
}

console.log('=== Teste de captura multi-fonte — 16s, escaneando a cada 2s ===');
console.log('Discord root pid:', addon.findDiscordRootPid());
scan();
const interval = setInterval(scan, 2000);

setTimeout(() => {
  clearInterval(interval);
  console.log('\n=== Resultado final por fonte ===');
  for(const [pid, s] of sources){
    console.log(`pid=${pid} exe=${s.exeName} | maxAmp=${s.maxAmp} avgAmp=${s.samples ? Math.round(s.sumAmp / s.samples) : 0}`);
    s.loopback.stop();
  }
  console.log('\nDiscord/Sinal apareceram na lista?', [...sources.values()].some(s => ['discord.exe','sinal.exe'].includes(s.exeName.toLowerCase())) ? 'SIM (FALHA)' : 'não (correto)');
}, 16000);

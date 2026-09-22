// Testa list_audio_sessions() na THREAD PRINCIPAL de verdade do Electron
// (a mesma que o Chromium já inicializa COM como STA) — é exatamente esse
// conflito de modelo de apartamento (RPC_E_CHANGED_MODE) que quebrava
// scanAudioSources() dentro do app real, mas nunca reproduzia no teste
// isolado fora do Electron (thread "limpa", sem ninguém mais mexendo em
// COM antes da gente). Roda com `electron test/com-threading-test.mjs`,
// não com `node`.
import { app } from 'electron';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const addon = require('../native/sinal-audio-loopback/target/release/sinal_audio_loopback.node');

app.whenReady().then(() => {
  console.log('=== Chamando listAudioSessions() na thread principal do Electron ===');
  try {
    const sessions = addon.listAudioSessions();
    console.log('SUCESSO:', sessions.length, 'sessão(ões) encontrada(s)');
    for (const s of sessions) console.log(`  pid=${s.pid} exe=${s.exeName} ativa=${s.isActive}`);
  } catch (e) {
    console.error('FALHOU:', e.message);
  }
  // Chama de novo, simulando o scan periódico (2a chamada é onde o bug
  // batia antes, já que a primeira às vezes "ganhava" a corrida).
  console.log('=== Chamando de novo (simulando o scan periódico) ===');
  try {
    const sessions2 = addon.listAudioSessions();
    console.log('SUCESSO (2a chamada):', sessions2.length, 'sessão(ões)');
  } catch (e) {
    console.error('FALHOU (2a chamada):', e.message);
  }
  app.quit();
});

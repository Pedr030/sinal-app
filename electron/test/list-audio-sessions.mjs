// Diagnóstico real do vazamento de áudio (HANDOFF.md §15.4-15.6): lista toda
// sessão de áudio ATIVA no dispositivo de renderização padrão agora mesmo,
// com o PID dono e o nome do exe — sem achismo sobre quem tá fazendo som.
//
// Como usar pra investigar o vazamento do Discord de verdade:
//   1. Entra numa call de voz real (alguém falando, ou toca um som de teste).
//   2. Roda: node electron/test/list-audio-sessions.mjs
//   3. Confere: aparece uma sessão ATIVA com exe_name=Discord.exe? Qual PID?
//      Bate com o PID que find_discord_root_pid() acha (também impresso
//      abaixo) ou com algum dos processos filhos dele (ver `tasklist` ou
//      Get-CimInstance Win32_Process -Filter "Name='Discord.exe'")?
//   4. Se o PID ativo NÃO for nem a raiz nem descendente dela, a exclusão
//      nunca tinha chance de funcionar (alvo errado). Se FOR um descendente
//      da raiz e mesmo assim vazou, o problema é mais fundo que "PID errado"
//      (ver hipóteses no HANDOFF §15.4).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const addon = require('../native/sinal-audio-loopback/target/release/sinal_audio_loopback.node');

const discordRoot = addon.findDiscordRootPid();
console.log('find_discord_root_pid():', discordRoot ?? '(Discord não tá rodando)');

const sessions = addon.listAudioSessions();
console.log(`\n${sessions.length} sessão(ões) de áudio encontradas no endpoint padrão:\n`);
for (const s of sessions) {
  console.log(`  pid=${s.pid}\texe=${s.exeName}\tativa=${s.isActive}`);
}

const discordSessions = sessions.filter((s) => s.exeName.toLowerCase() === 'discord.exe');
console.log(`\nSessões do Discord.exe: ${discordSessions.length ? '' : '(nenhuma)'}`);
for (const s of discordSessions) {
  console.log(`  pid=${s.pid}\tativa=${s.isActive}${s.pid === discordRoot ? '  <- é a raiz' : ''}`);
}

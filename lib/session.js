// Sessão assinada do Sinal (HANDOFF §38) — substitui o antigo "adminProof".
//
// O login com Discord (api/discord-callback.js) é o único momento em que o
// Discord confirma de verdade quem a pessoa é e de quais servers ela faz
// parte. Daí o servidor assina esse resultado (HMAC-SHA256) e devolve pro
// navegador; a partir daí, cada rota (get-token, lives…) só precisa conferir
// a assinatura — sem banco de dados e sem refazer o OAuth a cada ação.
//
// O navegador consegue LER o conteúdo (é só base64 de um JSON) pra desenhar a
// interface, mas não consegue ALTERAR: qualquer mudança invalida a assinatura
// e o servidor recusa. Por isso toda decisão de permissão é tomada no servidor
// em cima da sessão verificada, nunca do que o cliente diz sobre si mesmo.
//
// Chave: derivada do DISCORD_CLIENT_SECRET (segredo só-de-servidor que já
// existe) com um rótulo de domínio, então nenhuma outra assinatura feita com
// o mesmo segredo vale como sessão. Trocar o secret no painel do Discord
// desloga todo mundo — é uma característica, não um defeito.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // o token do Discord também dura 7 dias
const MAX_TOKEN_CHARS = 7000; // cabe folgado no cabeçalho Location do redirect do login (limite ~8 KB)

// Nível da pessoa em cada server do Discord (do mais alto pro mais baixo):
//   o = dono, a = Administrador, m = Gerenciar Servidor, x = membro comum.
// "m" modera as salas do server mas não entra em sala privada (decisão do
// usuário, 2026-10-03: só os cargos de patente mais alta entram em privadas).
const PERM_ADMINISTRATOR = 0x8n;
const PERM_MANAGE_GUILD = 0x20n;
const TIER_ORDER = { o: 0, a: 1, m: 2, x: 3 };

export function tierFromDiscord(guild){
  if(guild.owner) return 'o';
  let perms = 0n;
  try{ perms = BigInt(guild.permissions || '0'); }catch(e){ /* campo ausente/estranho = sem permissão */ }
  if(perms & PERM_ADMINISTRATOR) return 'a';
  if(perms & PERM_MANAGE_GUILD) return 'm';
  return 'x';
}

function key(secret){
  return createHmac('sha256', secret).update('sinal-session-v1').digest();
}

function sign(payloadB64, secret){
  return createHmac('sha256', key(secret)).update(payloadB64).digest('base64url');
}

export function signSession(data, secret){
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

// Devolve os dados da sessão se a assinatura e a validade conferem; senão null.
export function verifySession(token, secret){
  if(!secret || !token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if(parts.length !== 2) return null;
  const [payload, sig] = parts;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload, secret));
  if(a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try{
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if(!data || data.v !== 1 || typeof data.id !== 'string' || typeof data.exp !== 'number' || data.exp <= Date.now()) return null;
    return data;
  }catch(e){
    return null;
  }
}

// Monta e assina a sessão a partir do que o Discord devolveu no login.
// `guilds` vem de GET /users/@me/guilds. Se a lista for grande demais pro
// redirect (Discord permite até 200 servers), ficam primeiro os servers onde a
// pessoa tem mais poder, depois os demais — e corta o que não couber.
export function buildSession({ profile, guilds, adminIds, secret, now = Date.now() }){
  const name = (profile.global_name || profile.username || 'Convidado').slice(0, 40);
  const avatar = profile.avatar
    ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=64`
    : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(profile.id) >> 22n) % 6n)}.png`;
  const list = (Array.isArray(guilds) ? guilds : [])
    .filter((g) => g && typeof g.id === 'string')
    .map((g) => [g.id, String(g.name || '').slice(0, 40), g.icon || '', tierFromDiscord(g)])
    .sort((x, y) => TIER_ORDER[x[3]] - TIER_ORDER[y[3]]);
  const data = {
    v: 1,
    id: profile.id,
    name,
    avatar,
    admin: adminIds.includes(profile.id),
    guilds: list,
    exp: now + SESSION_TTL_MS
  };
  let token = signSession(data, secret);
  while(token.length > MAX_TOKEN_CHARS && data.guilds.length > 0){
    data.guilds = data.guilds.slice(0, Math.max(0, data.guilds.length - Math.ceil(data.guilds.length / 10)));
    token = signSession(data, secret);
  }
  return token;
}

// Nível da pessoa num server, ou null se ela não faz parte (ou não é desse server).
export function guildTier(session, guildId){
  if(!session || !Array.isArray(session.guilds)) return null;
  const g = session.guilds.find((x) => x[0] === guildId);
  return g ? g[3] : null;
}

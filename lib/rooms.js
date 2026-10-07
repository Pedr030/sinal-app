// Regras puras das salas de server (HANDOFF §36/§38) — nada aqui fala com a
// rede, então dá pra testar tudo sem LiveKit nem Discord.
import { randomBytes } from 'node:crypto';
import { guildTier } from './session.js';

export const MAX_ROOMS_PER_GUILD = 10;       // decisão do usuário (2026-10-02)
export const MAX_PARTICIPANTS_PER_ROOM = 25; // teto anti-abuso; o limite real é a banda da VM
export const MAX_TITLE = 40;
export const PRESENCE_ROOM = 'presence'; // sala de "presença": só recebe o push da lista de salas (HANDOFF §39)
export const MAX_PRESENCE_GUILDS = 15;

// Sala de server = "s<idDoServer>-<6 letras/números minúsculos>". As salas por
// código do "Início" são sempre MAIÚSCULAS (get-token.js força), então os dois
// tipos nunca colidem.
const SERVER_ROOM_RE = /^s(\d{15,21})-([a-z0-9]{6})$/;

export function parseServerRoom(name){
  const m = SERVER_ROOM_RE.exec(typeof name === 'string' ? name : '');
  return m ? { guildId: m[1] } : null;
}

export function newServerRoomName(guildId){
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  // 256 não divide por 36: um "byte % 36" favoreceria de leve os primeiros caracteres. Joga fora os
  // bytes de 252 pra cima (sorteio com rejeição) e todo caractere sai com a mesma chance.
  const limit = 256 - (256 % alphabet.length);
  let suffix = '';
  while(suffix.length < 6){
    for(const byte of randomBytes(8)){
      if(byte < limit && suffix.length < 6) suffix += alphabet[byte % alphabet.length];
    }
  }
  return `s${guildId}-${suffix}`;
}

// Nome de exibição de quem entra (visitante ou Discord). Tira o que serve pra se passar por
// outra pessoa ou bagunçar a tela dos outros: caracteres de controle, "espaço de largura zero",
// marcas e sobreposições de direção do texto (RLO e cia. invertem o que vem depois) e a coroa
// (o selo de admin é separado e só o servidor concede). Mantém ZWJ/ZWNJ (emojis compostos e
// alguns alfabetos) e espaços normais. Feito por faixas de código (sem regex) pra não depender
// de escapes difíceis de ler.
const INVISIBLE_RANGES = [
  [0x00, 0x1f], [0x7f, 0x9f],   // controle
  [0x200b, 0x200b],             // espaço de largura zero
  [0x200e, 0x200f],             // marcas de direção (LRM/RLM)
  [0x2028, 0x202e],             // separadores de linha/parágrafo e sobreposições de direção (LRE..RLO)
  [0x2060, 0x2060],             // word joiner
  [0x2066, 0x206f],             // isolados de direção e formatação obsoleta
  [0xfeff, 0xfeff],             // BOM / zero-width no-break space
  [0xfff9, 0xfffb]              // âncoras de anotação
];
const CROWN = 0x1f451;

export function cleanDisplayName(value, max = 40){
  const text = (typeof value === 'string' ? value : '').normalize('NFC');
  let out = '';
  for(const ch of text){
    const code = ch.codePointAt(0);
    if(code === CROWN || INVISIBLE_RANGES.some(([from, to]) => code >= from && code <= to)) continue;
    out += ch;
  }
  return out.split(/\s+/).join(' ').trim().slice(0, max);
}

export function cleanTitle(value){
  return (typeof value === 'string' ? value : '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE);
}

// Tipos de acesso: "open" (qualquer um do servidor entra) e "approval" (quem entra precisa da aprovação do
// responsável da sala — HANDOFF §49). Senha fica pra depois.
export const ACCESS_TYPES = ['open', 'approval'];
export const MAX_ALLOWED = 40;               // aprovados guardados no metadata da sala (os mais antigos saem primeiro)
export const MAX_DENIED = 20;
export const DENY_TTL_MS = 5 * 60 * 1000;    // um "recusado" vale por 5 min; depois a pessoa pode pedir de novo

export function cleanAccess(value){
  return value === 'approval' ? 'approval' : 'open';
}

// Metadados que nascem junto com a sala no LiveKit. `allowed` (IDs do Discord já aprovados) e `denied`
// só existem em sala com aprovação; quem muda isso é só o servidor (api/room-admin.js).
export function buildRoomMetadata({ guildId, title, creator, access = 'open', now = Date.now() }){
  const kind = cleanAccess(access);
  const meta = {
    v: 1,
    guild: guildId,
    title,
    creator: { id: creator.id, name: creator.name },
    access: kind,
    createdAt: now
  };
  if(kind === 'approval'){ meta.allowed = []; meta.denied = []; }
  return JSON.stringify(meta);
}

export function parseRoomMetadata(raw){
  try{
    const m = JSON.parse(raw || '');
    if(m && m.v === 1 && typeof m.guild === 'string') return m;
  }catch(e){ /* sala sem metadados (ou de outro tipo) */ }
  return null;
}

// Quem pode moderar (expulsar, desligar tela) as salas de um server: dono,
// Administrador e Gerenciar Servidor, no próprio server; o admin do Sinal em
// qualquer server de que ele faça parte.
export function canModerate(session, guildId){
  if(!session) return false;
  const tier = guildTier(session, guildId);
  if(!tier) return false;
  return !!session.admin || tier === 'o' || tier === 'a' || tier === 'm';
}

// Hierarquia de moderação (HANDOFF §41): quem está mais acima não pode ser moderado por
// quem está abaixo. Do mais alto pro mais baixo: admin do Sinal > dono do servidor >
// administrador > "gerencia o servidor". `meta` é o metadata do participante no LiveKit
// ({ isAdmin, tier } — gravado pelo get-token a partir da sessão assinada, ninguém altera).
const MOD_RANK = { o: 1, a: 2, m: 3 };
export function moderationRank(meta){
  if(!meta) return 9;
  if(meta.isAdmin) return 0;
  return MOD_RANK[meta.tier] || 9;
}

// O admin do Sinal modera qualquer um; os demais só quem está ESTRITAMENTE abaixo
// (dois "administradores" não se expulsam).
export function canModerateTarget(callerMeta, targetMeta){
  const caller = moderationRank(callerMeta);
  if(caller === 0) return true;
  return caller < moderationRank(targetMeta);
}

// Quem pode MODERAR nesta sala, a partir do token do LiveKit já verificado:
//  - admin do Sinal: tem o grant roomAdmin (só ele — o roomAdmin do LiveKit dá acesso à API
//    administrativa do LiveKit inteira, então NÃO é dado a admins de servidor);
//  - dono/administrador/"gerencia" do servidor: o nível vai assinado no metadata do token
//    ({ tier, guild }) e só vale na sala de servidor daquele mesmo guild.
// A hierarquia (quem pode moderar quem) é conferida à parte, em canModerateTarget().
export function isModeratorToken({ video, metadata }, room){
  if(!video || video.room !== room) return false;
  if(video.roomAdmin === true) return true;
  const parsed = parseServerRoom(room);
  return !!(parsed && metadata && ['o', 'a', 'm'].includes(metadata.tier) && metadata.guild === parsed.guildId);
}

// Quem entra em sala PRIVADA sem pedir/senha: só o admin do Sinal e os cargos
// mais altos do server (dono e Administrador). "Gerenciar Servidor" não.
export function canEnterPrivate(session, guildId){
  if(!session) return false;
  const tier = guildTier(session, guildId);
  if(!tier) return false;
  return !!session.admin || tier === 'o' || tier === 'a';
}

// "Responsável" da sala — calculado, nunca transferido (evita o problema da
// sucessão de host da era PeerJS): o criador, se ainda estiver na sala;
// senão quem entrou primeiro entre os presentes. Recalculado pelo servidor a
// cada ação, então saída em massa não deixa a sala sem responsável.
// `participants`: [{ identity, userId, joinedAt }]
export function responsibleOf(meta, participants){
  if(!Array.isArray(participants) || participants.length === 0) return null;
  if(meta && meta.creator){
    const creator = participants.find((p) => p.userId === meta.creator.id);
    if(creator) return creator;
  }
  return [...participants].sort((a, b) => (a.joinedAt - b.joinedAt) || String(a.identity).localeCompare(String(b.identity)))[0];
}

// ---------- Sala com aprovação (HANDOFF §49) ----------

// Pode entrar agora? Devolve { allowed, reason, denied }.
//  - sala aberta ou sem metadata: sim. QUALQUER outro tipo de acesso (aprovação, e os futuros, ou um valor
//    desconhecido) falha FECHADO: só entra quem passar numa das regras abaixo;
//  - admin do Sinal e dono/Administrador do servidor: sempre ("staff");
//  - o criador da sala: sempre;
//  - quem já foi aprovado (IDs em meta.allowed): sim, enquanto a sala existir (recarregar a página não pede de novo);
//  - o resto: não; `denied` diz se o pedido recente foi recusado (vale DENY_TTL_MS).
export function canEnterRoom({ meta, session, guildId, userId, now = Date.now() }){
  if(!meta || meta.access === 'open') return { allowed: true, reason: 'open', denied: false };
  if(canEnterPrivate(session, guildId)) return { allowed: true, reason: 'staff', denied: false };
  if(meta.creator && meta.creator.id === userId) return { allowed: true, reason: 'creator', denied: false };
  if(Array.isArray(meta.allowed) && meta.allowed.includes(userId)) return { allowed: true, reason: 'approved', denied: false };
  const recent = Array.isArray(meta.denied) && meta.denied.some((d) => Array.isArray(d) && d[0] === userId && now - d[1] < DENY_TTL_MS);
  return { allowed: false, reason: null, denied: recent };
}

// As três funções abaixo devolvem uma CÓPIA do metadata (nunca mexem no original).
export function withApproved(meta, userId){
  const allowed = [...(Array.isArray(meta.allowed) ? meta.allowed : []).filter((id) => id !== userId), userId].slice(-MAX_ALLOWED);
  const denied = (Array.isArray(meta.denied) ? meta.denied : []).filter((d) => !(Array.isArray(d) && d[0] === userId));
  return { ...meta, allowed, denied };
}

export function withDenied(meta, userId, now = Date.now()){
  const denied = [...(Array.isArray(meta.denied) ? meta.denied : []).filter((d) => Array.isArray(d) && d[0] !== userId && now - d[1] < DENY_TTL_MS), [userId, now]].slice(-MAX_DENIED);
  const allowed = (Array.isArray(meta.allowed) ? meta.allowed : []).filter((id) => id !== userId);
  return { ...meta, allowed, denied };
}

// Expulsar alguém de uma sala com aprovação desfaz a aprovação: pra voltar, precisa pedir de novo.
export function withoutAllowed(meta, userId){
  return { ...meta, allowed: (Array.isArray(meta.allowed) ? meta.allowed : []).filter((id) => id !== userId) };
}

// Quem pode DECIDIR os pedidos de entrada (e quem recebe o aviso de que alguém bateu): o responsável da
// sala (criador se estiver, senão quem entrou primeiro) e, sempre que estiverem presentes, o admin do Sinal e
// dono/Administrador/"gerencia" do servidor. `participants`: [{ identity, userId, joinedAt, tier, isAdmin }]
export function approvalDeciders(meta, participants){
  if(!Array.isArray(participants) || participants.length === 0) return [];
  const out = new Set();
  const boss = responsibleOf(meta, participants);
  if(boss) out.add(boss.identity);
  for(const p of participants){
    if(p.isAdmin || ['o', 'a', 'm'].includes(p.tier)) out.add(p.identity);
  }
  return [...out];
}

// Participante do LiveKit -> o formato que responsibleOf/approvalDeciders esperam. O userId, o nível e o
// "é admin" vêm do metadata gravado pelo get-token a partir da sessão assinada (o cliente não altera).
export function participantInfo(p){
  let meta = null;
  try{ meta = JSON.parse(p.metadata || ''); }catch(e){ /* visitante sem metadata */ }
  return {
    identity: p.identity,
    userId: meta && typeof meta.userId === 'string' ? meta.userId : '',
    joinedAt: Number(p.joinedAt || 0),
    tier: meta ? meta.tier : undefined,
    isAdmin: !!(meta && meta.isAdmin)
  };
}

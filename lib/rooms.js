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
  const bytes = randomBytes(6);
  let suffix = '';
  for(let i = 0; i < 6; i++) suffix += alphabet[bytes[i] % alphabet.length];
  return `s${guildId}-${suffix}`;
}

export function cleanTitle(value){
  return (typeof value === 'string' ? value : '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE);
}

// Metadados que nascem junto com a sala no LiveKit. Nesta fase só existe a
// sala aberta; senha/aprovação entram na fase 3 (campo `access`).
export function buildRoomMetadata({ guildId, title, creator, now = Date.now() }){
  return JSON.stringify({
    v: 1,
    guild: guildId,
    title,
    creator: { id: creator.id, name: creator.name },
    access: 'open',
    createdAt: now
  });
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

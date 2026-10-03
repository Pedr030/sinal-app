// Lista as salas ao vivo dos servers escolhidos (HANDOFF §38) — é o que a
// coluna de salas "estilo canal de voz do Discord" mostra: por server, cada
// sala com nome, se tem cadeado e quem está dentro.
//
// Segurança: só devolve salas de servers em que a PESSOA FAZ PARTE segundo a
// sessão assinada (o cliente manda quais quer ver, mas o servidor cruza com os
// servers da sessão e ignora o resto). Nunca devolve segredo nenhum (a senha
// das salas privadas, quando existir, fica só nos metadados hasheados).
//
// Custo: uma chamada = listRooms + um listParticipants por sala ao vivo.
// Medido (HANDOFF §36): < ~5 ms de CPU com a function aquecida — cabe folgado
// no plano gratuito mesmo atualizando a cada 15 s.
import { RoomServiceClient } from 'livekit-server-sdk';
import { verifySession } from '../lib/session.js';
import { parseServerRoom, parseRoomMetadata } from '../lib/rooms.js';

const MAX_ROOMS_TOTAL = 60;      // trava de segurança: servers escolhidos × 10 salas
const FRESH_ROOM_MS = 30 * 1000; // sala recém-criada ainda sem ninguém continua na lista

function json(status, data){
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

// O LiveKit devolve alguns números como bigint (ids de 64 bits) — JSON não aceita.
const num = (v) => (v === undefined || v === null ? 0 : Number(v));

// TrackSource do LiveKit: CAMERA=1, MICROPHONE=2, SCREEN_SHARE=3 (aceita o nome também).
const isSource = (track, number, label) => track && (track.source === number || track.source === label);

export async function POST(request){
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;
  if(!apiKey || !apiSecret || !livekitUrl) return json(500, { error: 'Servidor não configurado' });

  let body;
  try{ body = await request.json(); }catch(e){ return json(400, { error: 'corpo-invalido' }); }

  const session = verifySession(typeof body.session === 'string' ? body.session : '', process.env.DISCORD_CLIENT_SECRET);
  if(!session) return json(401, { error: 'sessao-invalida' });

  // Servers que a pessoa quer ver ∩ servers de que ela faz parte.
  const mine = new Set((session.guilds || []).map((g) => g[0]));
  const wanted = Array.isArray(body.guilds) ? body.guilds.filter((g) => typeof g === 'string' && mine.has(g)) : [];
  const guildIds = [...new Set(wanted)].slice(0, 20);
  const result = {};
  for(const id of guildIds) result[id] = [];
  if(guildIds.length === 0) return json(200, { guilds: result });

  try{
    const roomServiceUrl = livekitUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
    const roomService = new RoomServiceClient(roomServiceUrl, apiKey, apiSecret);

    const now = Date.now();
    const rooms = (await roomService.listRooms())
      .map((r) => ({ r, parsed: parseServerRoom(r.name) }))
      .filter((x) => x.parsed && result[x.parsed.guildId])
      .filter((x) => num(x.r.numParticipants) > 0 || now - num(x.r.creationTime) * 1000 < FRESH_ROOM_MS)
      .slice(0, MAX_ROOMS_TOTAL);

    const details = await Promise.all(rooms.map(async ({ r, parsed }) => {
      let people = [];
      try{ people = await roomService.listParticipants(r.name); }catch(e){
        console.error('listParticipants falhou:', e && e.message);
      }
      const meta = parseRoomMetadata(r.metadata);
      return {
        guildId: parsed.guildId,
        entry: {
          room: r.name,
          title: (meta && meta.title) || 'Sala',
          access: (meta && meta.access) || 'open',
          creator: (meta && meta.creator && meta.creator.name) || '',
          createdAt: (meta && meta.createdAt) || num(r.creationTime) * 1000,
          participants: people.map((p) => {
            let pm = {};
            try{ pm = JSON.parse(p.metadata || '{}') || {}; }catch(e){ /* sem metadados */ }
            const tracks = p.tracks || [];
            return {
              name: p.name || p.identity,
              avatar: typeof pm.avatarUrl === 'string' ? pm.avatarUrl : '',
              admin: !!pm.isAdmin,
              screen: tracks.some((t) => isSource(t, 3, 'SCREEN_SHARE')),
              camera: tracks.some((t) => isSource(t, 1, 'CAMERA')),
              joinedAt: num(p.joinedAt) * 1000
            };
          })
        }
      };
    }));

    for(const d of details) result[d.guildId].push(d.entry);
    for(const id of guildIds) result[id].sort((a, b) => a.createdAt - b.createdAt);
    return json(200, { guilds: result });
  }catch(e){
    console.error('lives falhou:', e && e.message, e);
    return json(502, { error: 'falha-ao-listar' });
  }
}

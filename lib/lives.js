// Foto das salas ao vivo de um ou mais servers — usada por api/lives.js (a
// consulta) e por api/lk-webhook.js (o push em tempo real, HANDOFF §39).
// Recebe o RoomServiceClient já montado, então os dois caminhos mostram
// exatamente o mesmo formato.
import { parseServerRoom, parseRoomMetadata } from './rooms.js';

export const MAX_ROOMS_TOTAL = 60;      // trava de segurança: servers escolhidos × 10 salas
export const FRESH_ROOM_MS = 30 * 1000; // sala recém-criada ainda sem ninguém continua na lista

// O LiveKit devolve alguns números como bigint (ids de 64 bits) — JSON não aceita.
const num = (v) => (v === undefined || v === null ? 0 : Number(v));

// TrackSource do LiveKit: CAMERA=1, MICROPHONE=2, SCREEN_SHARE=3 (aceita o nome também).
const isSource = (track, number, label) => track && (track.source === number || track.source === label);

// Devolve { idDoServer: [sala, ...] } com uma lista (possivelmente vazia) pra
// cada server pedido. Opções (o webhook chega antes de a listagem refletir a
// saída de alguém, então ele diz quem tirar da foto):
//   excludeIdentity — participante que acabou de sair
//   excludeRoom     — sala que acabou de fechar
export async function buildGuildSnapshots(roomService, guildIds, { excludeIdentity, excludeRoom, now = Date.now() } = {}){
  const result = {};
  for(const id of guildIds) result[id] = [];
  if(guildIds.length === 0) return result;

  const rooms = (await roomService.listRooms())
    .map((r) => ({ r, parsed: parseServerRoom(r.name) }))
    .filter((x) => x.parsed && result[x.parsed.guildId] && x.r.name !== excludeRoom)
    .filter((x) => num(x.r.numParticipants) > 0 || now - num(x.r.creationTime) * 1000 < FRESH_ROOM_MS)
    .slice(0, MAX_ROOMS_TOTAL);

  const details = await Promise.all(rooms.map(async ({ r, parsed }) => {
    let people = [];
    try{ people = await roomService.listParticipants(r.name); }catch(e){
      console.error('listParticipants falhou:', e && e.message);
    }
    if(excludeIdentity) people = people.filter((p) => p.identity !== excludeIdentity);
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
  return result;
}

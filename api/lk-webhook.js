// Recebe os avisos (webhooks) do próprio LiveKit — alguém entrou/saiu de uma
// sala, uma sala abriu/fechou, uma tela começou/parou — e empurra a lista
// atualizada de salas ao vivo pra quem está olhando aquele server, na hora
// (HANDOFF §39). Sem isso a lista dependia de ficar perguntando a cada 15 s.
//
// Como chega no cliente: cada pessoa mantém uma conexão leve à sala
// "presence" (get-token, modo `presence`). Aqui montamos a foto do server onde
// algo mudou e mandamos por `sendData` SÓ pros participantes de presença cujo
// atributo `guilds` (assinado pelo servidor no token, o cliente não altera)
// inclui aquele server — ninguém recebe salas de server alheio.
//
// Autenticação: o LiveKit assina cada webhook com a API key/secret (JWT no
// cabeçalho Authorization, com o hash do corpo). Sem assinatura válida: 401.
// Depois de validado, sempre respondemos 200 — erro nosso não deve fazer o
// LiveKit reenviar o mesmo aviso em loop.
import { RoomServiceClient, WebhookReceiver, DataPacket_Kind } from 'livekit-server-sdk';
import { buildGuildSnapshots } from '../lib/lives.js';
import { parseServerRoom, PRESENCE_ROOM } from '../lib/rooms.js';

const EVENTS = new Set([
  'room_started', 'room_finished', 'participant_joined', 'participant_left', 'track_published', 'track_unpublished'
]);
// Pacote de dados do LiveKit: melhor ficar bem abaixo de ~15 KB. Se a foto
// passar disso (25 pessoas × 10 salas com avatar), manda só "atualize" e o
// cliente busca em api/lives.
const MAX_PAYLOAD_BYTES = 12 * 1024;

function json(status, data){
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export async function POST(request){
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;
  if(!apiKey || !apiSecret || !livekitUrl) return json(500, { error: 'Servidor não configurado' });

  const bodyText = await request.text();
  let event;
  try{
    event = await new WebhookReceiver(apiKey, apiSecret).receive(bodyText, request.headers.get('authorization') || undefined);
  }catch(e){
    return json(401, { error: 'assinatura-invalida' });
  }

  const roomName = event && event.room && event.room.name;
  const parsed = parseServerRoom(roomName);
  if(!EVENTS.has(event.event) || !parsed) return json(200, { ignored: true });
  const guildId = parsed.guildId;

  try{
    const roomServiceUrl = livekitUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
    const roomService = new RoomServiceClient(roomServiceUrl, apiKey, apiSecret);

    // Quem está ouvindo este server agora.
    let listeners = [];
    try{
      listeners = (await roomService.listParticipants(PRESENCE_ROOM))
        .filter((p) => ((p.attributes && p.attributes.guilds) || '').split(',').includes(guildId))
        .map((p) => p.identity);
    }catch(e){ /* sala de presença ainda não existe = ninguém ouvindo */ }
    if(listeners.length === 0) return json(200, { delivered: 0 });

    const snap = await buildGuildSnapshots(roomService, [guildId], {
      excludeIdentity: event.event === 'participant_left' && event.participant ? event.participant.identity : undefined,
      excludeRoom: event.event === 'room_finished' ? roomName : undefined
    });

    const encode = (obj) => new TextEncoder().encode(JSON.stringify(obj));
    let payload = encode({ guild: guildId, rooms: snap[guildId] });
    if(payload.length > MAX_PAYLOAD_BYTES) payload = encode({ guild: guildId, refresh: true });

    await roomService.sendData(PRESENCE_ROOM, payload, DataPacket_Kind.RELIABLE, {
      destinationIdentities: listeners,
      topic: 'lives'
    });
    return json(200, { delivered: listeners.length });
  }catch(e){
    console.error('lk-webhook falhou:', event.event, e && e.message, e);
    return json(200, { error: 'falha-ao-repassar' });
  }
}

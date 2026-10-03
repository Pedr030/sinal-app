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
// Medido (HANDOFF §36): < ~5 ms de CPU com a function aquecida. Com o push em
// tempo real (api/lk-webhook.js, §39) isso vira só a foto inicial e a rede de
// segurança — a lista não depende mais de consulta repetida.
import { RoomServiceClient } from 'livekit-server-sdk';
import { verifySession } from '../lib/session.js';
import { buildGuildSnapshots } from '../lib/lives.js';
import { createLimiter } from '../lib/ratelimit.js';

// Por pessoa (id do Discord da sessão). O site consulta no máximo ~4x/min; 120 deixa folga
// pra várias abas e reconexões sem deixar ninguém martelar a API do LiveKit.
const livesLimiter = createLimiter({ max: 120, windowMs: 60 * 1000 });

function json(status, data){
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export async function POST(request){
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;
  if(!apiKey || !apiSecret || !livekitUrl) return json(500, { error: 'Servidor não configurado' });

  let body;
  try{ body = await request.json(); }catch(e){ return json(400, { error: 'corpo-invalido' }); }
  if(!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'corpo-invalido' });

  const session = verifySession(typeof body.session === 'string' ? body.session : '', process.env.DISCORD_CLIENT_SECRET);
  if(!session) return json(401, { error: 'sessao-invalida' });
  if(!livesLimiter.allow(session.id)) return json(429, { error: 'muitos-pedidos' });

  // Servers que a pessoa quer ver ∩ servers de que ela faz parte.
  const mine = new Set((session.guilds || []).map((g) => g[0]));
  const wanted = Array.isArray(body.guilds) ? body.guilds.filter((g) => typeof g === 'string' && mine.has(g)) : [];
  const guildIds = [...new Set(wanted)].slice(0, 20);
  if(guildIds.length === 0) return json(200, { guilds: {} });

  try{
    const roomServiceUrl = livekitUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
    const roomService = new RoomServiceClient(roomServiceUrl, apiKey, apiSecret);
    return json(200, { guilds: await buildGuildSnapshots(roomService, guildIds) });
  }catch(e){
    console.error('lives falhou:', e && e.message, e);
    return json(502, { error: 'falha-ao-listar' });
  }
}

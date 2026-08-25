// Ações de moderação (expulsar, desligar tela/câmera de alguém) — só quem
// tem o grant roomAdmin no próprio token do LiveKit (ver api/get-token.js e
// lib/adminProof.js) consegue passar da verificação abaixo. O navegador
// manda o MESMO token que já usa pra falar com o LiveKit (não inventamos
// uma segunda credencial) — TokenVerifier confirma a assinatura e o grant
// antes de qualquer coisa rodar.
import { RoomServiceClient, TokenVerifier } from 'livekit-server-sdk';

export async function POST(request){
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;

  if(!apiKey || !apiSecret || !livekitUrl){
    return new Response(JSON.stringify({ error: 'Servidor não configurado' }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }

  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if(!token){
    return new Response(JSON.stringify({ error: 'sem-token' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    });
  }

  let body;
  try{ body = await request.json(); }catch(e){
    return new Response(JSON.stringify({ error: 'corpo-invalido' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }
  const { action, room, targetIdentity, trackSid } = body || {};
  if(!action || !room || !targetIdentity){
    return new Response(JSON.stringify({ error: 'parametros-faltando' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }

  let claims;
  try{
    claims = await new TokenVerifier(apiKey, apiSecret).verify(token);
  }catch(e){
    return new Response(JSON.stringify({ error: 'token-invalido' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    });
  }
  if(!claims.video || claims.video.roomAdmin !== true || claims.video.room !== room){
    return new Response(JSON.stringify({ error: 'sem-permissao' }), {
      status: 403,
      headers: { 'content-type': 'application/json' }
    });
  }

  try{
    const roomServiceUrl = livekitUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
    const roomService = new RoomServiceClient(roomServiceUrl, apiKey, apiSecret);

    if(action === 'kick'){
      await roomService.removeParticipant(room, targetIdentity);
    } else if(action === 'muteScreen' || action === 'muteCamera'){
      if(!trackSid){
        return new Response(JSON.stringify({ error: 'trackSid-faltando' }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        });
      }
      await roomService.mutePublishedTrack(room, targetIdentity, trackSid, true);
    } else {
      return new Response(JSON.stringify({ error: 'acao-desconhecida' }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }catch(e){
    console.error('Ação de moderação falhou:', action, e && e.message, e);
    return new Response(JSON.stringify({ error: 'falha-ao-executar' }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }
}

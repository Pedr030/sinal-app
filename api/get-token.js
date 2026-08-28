// Gera um token de acesso do LiveKit pro navegador poder entrar numa sala.
// Roda só aqui, no servidor — é a ÚNICA peça que enxerga a API secret do
// LiveKit (LIVEKIT_API_SECRET); ela nunca vai pro navegador. Sem essa
// função, o token teria que ser montado no cliente e a secret vazaria pra
// qualquer um que abrisse o "ver código-fonte" — e com ela, qualquer pessoa
// que soubesse a secret poderia entrar em qualquer sala se passando por
// qualquer um. Ver HANDOFF.md pra checklist de configuração (variáveis de
// ambiente, conta no LiveKit Cloud etc).
//
// Adaptado de netlify/functions/get-token.js na migração pra Vercel
// (2026-08-24, motivo: cota de deploy grátis do Netlify esgotada no meio da
// sessão). Mesma lógica de negócio — só a casca da function muda: Vercel usa
// export nomeado por verbo HTTP (`GET`) em vez de export default, mas o
// corpo (Request in, Response out, process.env.*) é o mesmo Web Handler.
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { verifyAdminProof } from '../lib/adminProof.js';

export async function GET(request){
  const url = new URL(request.url);
  const room = (url.searchParams.get('room') || '').trim().toUpperCase().slice(0, 32);
  const name = (url.searchParams.get('name') || '').trim().slice(0, 40);
  // Opcional — vem preenchido só quando a pessoa logou com Discord (ver
  // api/discord-callback.js). Vai pro metadata do participante no LiveKit,
  // que é como os OUTROS participantes enxergam o avatar de verdade (não só
  // quem logou).
  const avatar = (url.searchParams.get('avatar') || '').trim().slice(0, 300);
  // Opcional — comprovante assinado em api/discord-callback.js (ver
  // lib/adminProof.js) de que quem está pedindo o token é um Discord ID
  // admin. Verificado abaixo antes de conceder o grant roomAdmin.
  const adminProof = url.searchParams.get('adminProof') || '';
  // "join" é o padrão de propósito se vier ausente/inesperado — é o modo
  // mais restrito (dá erro em vez de criar sala à toa), falha mais seguro.
  const mode = url.searchParams.get('mode') === 'create' ? 'create' : 'join';

  if(!room || !name){
    return new Response(JSON.stringify({ error: 'room e name são obrigatórios' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;

  if(!apiKey || !apiSecret || !livekitUrl){
    return new Response(JSON.stringify({ error: 'Servidor não configurado (LIVEKIT_API_KEY/LIVEKIT_API_SECRET/LIVEKIT_URL ausentes nas variáveis de ambiente do Vercel)' }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }

  // Identity única por sessão de aba (não só pelo nome escolhido) — permite
  // duas pessoas com o mesmo nome, ou a mesma pessoa reconectando em duas
  // abas, sem colidir. O nome de exibição de verdade vai no campo "name".
  const identity = name.replace(/\s+/g, '_').replace(/[^\w-]/g, '') + '-' + Math.random().toString(36).slice(2, 8);

  try{
    // RoomServiceClient é uma API HTTP administrativa — precisa de
    // http(s)://, diferente do wss:// que o cliente usa pra conectar de
    // verdade.
    const roomServiceUrl = livekitUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
    const roomService = new RoomServiceClient(roomServiceUrl, apiKey, apiSecret);

    if(mode === 'join'){
      // "Entrar numa sala existente" precisa checar de verdade — sem isso,
      // roomJoin:true no token cria uma sala vazia silenciosa pra qualquer
      // código digitado (inclusive errado por engano), e a pessoa fica
      // sozinha achando que está esperando a galera aparecer (relato real,
      // 2026-08-24). Só gera token se a sala já existir de verdade.
      let exists = false;
      try{
        const rooms = await roomService.listRooms([room]);
        exists = rooms.some((r) => r.name === room);
      }catch(e){
        console.error('listRooms falhou:', e && e.message, e);
        // Não travar o usuário por causa de uma falha nossa de checagem —
        // segue como se existisse, deixa o LiveKit decidir (comportamento
        // antigo: cria se não existir). Prioriza "funciona" sobre "erro
        // preciso" quando a própria checagem está com problema.
        exists = true;
      }
      if(!exists){
        return new Response(JSON.stringify({ error: 'room-not-found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' }
        });
      }
    } else {
      // "Criar sala nova": garante que ela nasce com timeouts curtos, em vez
      // do padrão da plataforma — sem isso, a sala continuava "viva" e
      // aceitando gente muito tempo depois de ficar vazia (mesmo relato).
      try{
        await roomService.createRoom({ name: room, emptyTimeout: 60, departureTimeout: 60 });
      }catch(e){
        console.error('createRoom falhou:', e && e.message, e);
      }

      // Avisa automaticamente num canal do Discord que uma sala nova foi
      // aberta — opcional, só dispara se DISCORD_WEBHOOK_URL estiver
      // configurada. Não precisa de bot nem OAuth, é só uma URL secreta que
      // qualquer POST nela vira mensagem no canal. Falha aqui não pode
      // travar a criação da sala pra quem tá esperando o token.
      //
      // Só notifica se quem criou logou com Discord (indicado por `avatar`
      // vir preenchido — só acontece depois de login real via OAuth, ver
      // §8.1) — de propósito, pra não avisar toda vez que alguém de fora
      // (com o link, sem fazer parte do grupo) ou um teste rápido sem login
      // criar uma sala. Filtra pela origem (identidade verificada), não por
      // ambiente/deploy.
      const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
      if(webhookUrl && avatar){
        try{
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              content: `🟢 **${name}** abriu uma sala no Sinal: ${url.origin}/?sala=${room}`,
              // "name" é digitado livremente por quem entra — sem isso, dava
              // pra alguém colocar "@everyone" como nome e disparar um ping
              // geral no canal toda vez que criasse uma sala.
              allowed_mentions: { parse: [] }
            })
          });
        }catch(e){
          console.error('Webhook do Discord falhou:', e && e.message, e);
        }
      }
    }

    // roomAdmin só é concedido se o comprovante do Discord vier válido (ver
    // lib/adminProof.js) — sem isso, o grant fica de fora por padrão, igual
    // sempre foi.
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    const isAdmin = !!(adminProof && clientSecret && verifyAdminProof(adminProof, clientSecret));

    // metadata vai pro participante — é assim que os OUTROS enxergam o
    // avatar de verdade (ver §8.1) e agora também se essa pessoa é admin
    // (pra mostrar a coroa pra todo mundo, não só pra quem logou).
    const metadata = (avatar || isAdmin) ? JSON.stringify({ avatarUrl: avatar || undefined, isAdmin: isAdmin || undefined }) : undefined;

    // Sem "ttl" explícito: usa o padrão do SDK (6h), tempo de sobra pra uma
    // sessão longa de call/jogo sem cair no meio.
    const at = new AccessToken(apiKey, apiSecret, { identity, name, metadata });
    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      roomAdmin: isAdmin || undefined
    });
    const token = await at.toJwt();

    return new Response(JSON.stringify({ token, url: livekitUrl }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }catch(e){
    return new Response(JSON.stringify({ error: 'Falha ao gerar token: ' + e.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }
}

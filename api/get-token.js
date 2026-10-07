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
// export nomeado por verbo HTTP (`POST`) em vez de export default, mas o
// corpo (Request in, Response out, process.env.*) é o mesmo Web Handler.
//
// Quatro modos (campo `mode`):
//   join / create               — salas por CÓDIGO (o "Início": convidar quem
//                                 não usa Discord, ou uma sala rápida). Valem
//                                 pra visitante e pra quem logou.
//   server-join / server-create — salas de um SERVER do Discord (HANDOFF §38).
//                                 Exigem sessão assinada (lib/session.js) e que
//                                 a pessoa faça parte do server; nome de sala
//                                 `s<idDoServer>-<6>` e metadados no LiveKit.
//   presence                    — conexão leve à sala "presence" só pra RECEBER
//                                 o push da lista de salas ao vivo (HANDOFF §39):
//                                 sem publicar nada. Os servers dela vão num
//                                 atributo do participante assinado AQUI (o
//                                 cliente não consegue mudar), que o webhook usa
//                                 pra entregar só o que a pessoa pode ver.
import { AccessToken, RoomServiceClient, DataPacket_Kind } from 'livekit-server-sdk';
import { verifySession, guildTier } from '../lib/session.js';
import { createLimiter, clientIp } from '../lib/ratelimit.js';
import {
  MAX_ROOMS_PER_GUILD, MAX_PARTICIPANTS_PER_ROOM, PRESENCE_ROOM, MAX_PRESENCE_GUILDS,
  parseServerRoom, newServerRoomName, cleanTitle, cleanDisplayName,
  buildRoomMetadata, parseRoomMetadata, cleanAccess, cleanPassword, hashRoomPassword, verifyRoomPassword, encryptRoomPassword,
  canEnterRoom, approvalDeciders, participantInfo, withApproved, recentFailures, withFailedAttempt, MAX_PASSWORD_TRIES
} from '../lib/rooms.js';

const MODES = ['join', 'create', 'server-join', 'server-create', 'presence'];

// Pedidos de token por IP (melhor esforço, ver lib/ratelimit.js): sem isso qualquer um com um
// loop gasta a cota da Vercel e cria salas/conexões em massa na VM.
const tokenLimiter = createLimiter({ max: 60, windowMs: 60 * 1000 });
// "Bater na porta" de sala com aprovação: no máximo um aviso ao responsável a cada 12 s por pessoa e sala
// (o pedido repete enquanto a pessoa espera; sem isso o responsável seria inundado).
const knockLimiter = createLimiter({ max: 1, windowMs: 12 * 1000, maxKeys: 2000 });
// Palpites de senha de sala (HANDOFF §50): este limite em memória só segura rajadas dentro da MESMA instância; o limite de
// verdade é durável e fica registrado no metadata da sala (lib/rooms.js: recentFailures/withFailedAttempt).
const passwordLimiter = createLimiter({ max: 5, windowMs: 5 * 60 * 1000, maxKeys: 5000 });

function json(status, data){
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

// POST, e não GET: esta função tem efeito colateral de verdade (cria sala no
// LiveKit). Num GET, qualquer <img src="..."> numa página aleatória — ou um
// bot de preview de link que tocasse a URL — dispararia isso pelo navegador
// de quem passasse por lá. GET deveria ser seguro/idempotente, e este nunca
// foi. Bônus: a sessão (credencial de 7 dias) sai da query string e viaja no
// corpo, longe de log/histórico/Referer.
export async function POST(request){
  if(!tokenLimiter.allow(clientIp(request))) return json(429, { error: 'muitos-pedidos' });

  let body;
  try{ body = await request.json(); }catch(e){
    return json(400, { error: 'corpo-invalido' });
  }
  // JSON válido mas que não é um objeto (null, número, lista…) também é pedido inválido.
  if(!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'corpo-invalido' });

  // Antes vinha tudo de searchParams, que sempre devolve string. Agora é JSON,
  // então o cliente pode mandar número, objeto, null — e `.trim()` em cima
  // disso explodiria. Daí normalizar pra string antes de qualquer coisa.
  const str = (v) => (typeof v === 'string' ? v : '');
  // "join" é o padrão de propósito se vier ausente/inesperado — é o modo
  // mais restrito (dá erro em vez de criar sala à toa), falha mais seguro.
  const mode = MODES.includes(body.mode) ? body.mode : 'join';
  const isServerMode = mode.startsWith('server-');

  // Sessão do login com Discord: avatar, ID, "é admin do Sinal" e servers vêm
  // DELA (assinados pelo servidor), nunca do que o cliente diz sobre si. Se
  // veio uma sessão e ela não vale (adulterada ou vencida), recusa com 401 em
  // vez de tratar a pessoa como visitante sem avisar — o site responde pedindo
  // login de novo.
  const secret = process.env.DISCORD_CLIENT_SECRET;
  const sessionRaw = str(body.session);
  const session = sessionRaw ? verifySession(sessionRaw, secret) : null;
  if(sessionRaw && !session) return json(401, { error: 'sessao-invalida' });
  if((isServerMode || mode === 'presence') && !session) return json(401, { error: 'login-necessario' });

  const name = cleanDisplayName(str(body.name)) || (session ? cleanDisplayName(session.name) : '');
  if(!name) return json(400, { error: 'room e name são obrigatórios' });

  // Sala por código: sempre MAIÚSCULA (assim nunca colide com sala de server,
  // que é minúscula). Sala de server: o nome sai do servidor (create) ou é
  // conferido contra o formato exato (join).
  let room = '';
  let guildId = '';
  let title = '';
  let newAccess = 'open';
  let newPassword = null;
  if(isServerMode){
    if(mode === 'server-create'){
      guildId = str(body.guild).trim();
      title = cleanTitle(body.title) || 'Sala';
      newAccess = cleanAccess(str(body.access));
      if(newAccess === 'password'){
        newPassword = cleanPassword(body.password);
        if(!newPassword) return json(400, { error: 'senha-invalida' }); // 4 a 32 caracteres
      }
    } else {
      room = str(body.room).trim();
      const parsed = parseServerRoom(room);
      if(!parsed) return json(400, { error: 'sala-invalida' });
      guildId = parsed.guildId;
    }
    if(!/^\d{15,21}$/.test(guildId)) return json(400, { error: 'server-invalido' });
    if(!guildTier(session, guildId)) return json(403, { error: 'fora-do-server' });
  } else if(mode !== 'presence'){
    room = str(body.room).trim().toUpperCase().slice(0, 32);
    if(!room) return json(400, { error: 'room e name são obrigatórios' });
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;

  if(!apiKey || !apiSecret || !livekitUrl){
    console.error('get-token: LIVEKIT_API_KEY/LIVEKIT_API_SECRET/LIVEKIT_URL ausentes nas variáveis de ambiente da Vercel');
    return json(500, { error: 'servidor-nao-configurado' });
  }

  // Presença: token que só escuta. Não cria sala nem confere nada no LiveKit —
  // entrar com roomJoin já cria a sala "presence" (some sozinha quando esvazia).
  if(mode === 'presence'){
    const mine = new Set((session.guilds || []).map((g) => g[0]));
    const wanted = Array.isArray(body.guilds) ? body.guilds.filter((g) => typeof g === 'string' && mine.has(g)) : [];
    const guilds = [...new Set(wanted)].slice(0, MAX_PRESENCE_GUILDS);
    if(guilds.length === 0) return json(400, { error: 'sem-servidores' });
    const at = new AccessToken(apiKey, apiSecret, {
      identity: `d${session.id}-${Math.random().toString(36).slice(2, 8)}`,
      name: session.name,
      attributes: { guilds: guilds.join(',') }
    });
    // hidden: o participante de presença fica INVISÍVEL pros outros. Sem isso, qualquer pessoa
    // logada via nome, ID do Discord (no identity) e a lista de servidores de todo mundo que
    // estivesse online (testado — vazava até de servidores em comum nenhum). O servidor ainda
    // lista e entrega o push pra eles normalmente (testado no LiveKit real).
    at.addGrant({ room: PRESENCE_ROOM, roomJoin: true, canSubscribe: true, canPublish: false, canPublishData: false, hidden: true });
    return json(200, { token: await at.toJwt(), url: livekitUrl, room: PRESENCE_ROOM });
  }

  // Identity única por conexão (não só pelo nome escolhido) — permite duas
  // pessoas com o mesmo nome, ou a mesma pessoa reconectando em duas abas, sem
  // colidir. Quem logou leva o ID do Discord no começo (`d<id>-…`), que é o que
  // o servidor usa pra reconhecer "esse participante é fulano" (criador da
  // sala, moderação). O nome de exibição de verdade vai no campo "name".
  const rand = Math.random().toString(36).slice(2, 8);
  const identity = session
    ? `d${session.id}-${rand}`
    : name.replace(/\s+/g, '_').replace(/[^\w-]/g, '') + '-' + rand;

  try{
    // RoomServiceClient é uma API HTTP administrativa — precisa de
    // http(s)://, diferente do wss:// que o cliente usa pra conectar de
    // verdade.
    const roomServiceUrl = livekitUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
    const roomService = new RoomServiceClient(roomServiceUrl, apiKey, apiSecret);

    if(mode === 'server-create'){
      // Limite de salas ao vivo por server (decisão do usuário: 10). Cada sala
      // some sozinha minutos depois de esvaziar, então o limite só pega
      // quando o server de fato está cheio de salas em uso.
      let rooms = [];
      try{ rooms = await roomService.listRooms(); }catch(e){
        console.error('listRooms falhou:', e && e.message, e);
      }
      const prefix = `s${guildId}-`;
      if(rooms.filter((r) => typeof r.name === 'string' && r.name.startsWith(prefix)).length >= MAX_ROOMS_PER_GUILD){
        return json(429, { error: 'limite-de-salas' });
      }
      room = newServerRoomName(guildId);
      try{
        await roomService.createRoom({
          name: room,
          emptyTimeout: 60,
          departureTimeout: 60,
          maxParticipants: MAX_PARTICIPANTS_PER_ROOM,
          metadata: buildRoomMetadata({
            guildId, title, creator: { id: session.id, name }, access: newAccess,
            passwordHash: newAccess === 'password' ? hashRoomPassword(apiSecret, room, newPassword) : undefined,
            passwordEnc: newAccess === 'password' ? encryptRoomPassword(apiSecret, room, newPassword) : undefined
          })
        });
      }catch(e){
        console.error('createRoom (server) falhou:', e && e.message, e);
        return json(502, { error: 'falha-ao-criar-sala' });
      }
    } else if(mode === 'server-join' || mode === 'join'){
      // "Entrar numa sala existente" precisa checar de verdade — sem isso,
      // roomJoin:true no token cria uma sala vazia silenciosa pra qualquer
      // código digitado (inclusive errado por engano), e a pessoa fica
      // sozinha achando que está esperando a galera aparecer (relato real,
      // 2026-08-24). Só gera token se a sala já existir de verdade.
      let found = null;
      let checked = true;
      try{
        const rooms = await roomService.listRooms([room]);
        found = rooms.find((r) => r.name === room) || null;
      }catch(e){
        console.error('listRooms falhou:', e && e.message, e);
        // Não travar o usuário por causa de uma falha nossa de checagem —
        // segue como se existisse, deixa o LiveKit decidir (comportamento
        // antigo: cria se não existir). Prioriza "funciona" sobre "erro
        // preciso" quando a própria checagem está com problema.
        checked = false;
      }
      if(checked && !found) return json(404, { error: 'room-not-found' });
      // Regra de acesso da sala de server (HANDOFF §49). Sala com aprovação: entra direto o admin do
      // Sinal, dono/Administrador do servidor, o criador e quem já foi aprovado. Os outros recebem 403
      // "sala-privada"; se mandarem knock:true (a pessoa confirmou que quer pedir), o responsável da sala
      // é avisado e a resposta é "aguardando-aprovacao" (o cliente repete o pedido até sair a decisão).
      if(found && isServerMode){
        const meta = parseRoomMetadata(found.metadata);
        const gate = canEnterRoom({ meta, session, guildId, userId: session.id });
        if(!gate.allowed && meta.access === 'password'){
          // Sala com senha: sem senha no pedido = "sala-privada" (o app abre a caixa de senha). Com senha: confere
          // (limite de palpites por pessoa e sala); acertou => lembra a pessoa na sala (recarregar não pede de novo).
          if(typeof body.password !== 'string' || body.password === '') return json(403, { error: 'sala-privada', access: 'password' });
          if(recentFailures(meta, session.id) >= MAX_PASSWORD_TRIES || !passwordLimiter.allow(`${room}|${session.id}`)){
            return json(429, { error: 'muitas-tentativas' });
          }
          if(!verifyRoomPassword({ secret: apiSecret, meta, room, password: body.password })){
            try{
              await roomService.updateRoomMetadata(room, JSON.stringify(withFailedAttempt(meta, session.id)));
            }catch(e){
              console.error('registrar palpite errado de senha falhou:', e && e.message, e);
            }
            return json(403, { error: 'senha-incorreta' });
          }
          try{
            await roomService.updateRoomMetadata(room, JSON.stringify(withApproved(meta, session.id)));
          }catch(e){
            console.error('lembrar quem acertou a senha falhou:', e && e.message, e);
          }
        } else if(!gate.allowed){
          // Só sala com aprovação aceita pedido de entrada; qualquer outro tipo trancado só abre pra quem já pode.
          if(meta.access !== 'approval' || body.knock !== true) return json(403, { error: 'sala-privada', access: meta.access });
          if(gate.denied) return json(403, { error: 'recusado' });
          const people = (await roomService.listParticipants(room)).map(participantInfo);
          const deciders = approvalDeciders(meta, people);
          if(deciders.length === 0) return json(403, { error: 'sem-responsavel' });
          if(knockLimiter.allow(`${room}|${session.id}`)){
            try{
              await roomService.sendData(
                room,
                new TextEncoder().encode(JSON.stringify({ type: 'knock', room, userId: session.id, name, avatar: session.avatar || '' })),
                DataPacket_Kind.RELIABLE,
                { destinationIdentities: deciders, topic: 'knock' }
              );
            }catch(e){
              console.error('aviso de pedido de entrada falhou:', e && e.message, e);
            }
          }
          return json(403, { error: 'aguardando-aprovacao' });
        }
      }
    } else {
      // "Criar sala nova" por código: garante que ela nasce com timeouts
      // curtos, em vez do padrão da plataforma — sem isso, a sala continuava
      // "viva" e aceitando gente muito tempo depois de ficar vazia (mesmo
      // relato). (O aviso "fulano abriu uma sala" no canal do Discord saiu na
      // v0.8.51+: agora quem está no server vê a sala na lista, HANDOFF §38.)
      try{
        await roomService.createRoom({ name: room, emptyTimeout: 60, departureTimeout: 60, maxParticipants: MAX_PARTICIPANTS_PER_ROOM });
      }catch(e){
        console.error('createRoom falhou:', e && e.message, e);
      }
    }

    // roomAdmin (moderar: expulsar, desligar tela/câmera de alguém) vem da
    // sessão assinada: o admin do Sinal em qualquer sala; nas salas de server,
    // também dono/Administrador/Gerenciar Servidor daquele server.
    const isSinalAdmin = !!(session && session.admin);
    // Só o admin do Sinal recebe o grant roomAdmin (ele dá acesso à API administrativa do
    // LiveKit inteira). Dono/administrador/"gerencia" do servidor moderam pelo nível
    // assinado no metadata (tier + guild), conferido em api/moderate.js com a hierarquia.
    const roomAdmin = isSinalAdmin;

    // metadata vai pro participante — é assim que os OUTROS enxergam o avatar
    // de verdade e se essa pessoa é admin do Sinal (coroa pra todo mundo, não
    // só pra quem logou).
    const metadata = session
      ? JSON.stringify({
          avatarUrl: session.avatar || undefined,
          isAdmin: isSinalAdmin || undefined,
          userId: session.id,
          // nível no servidor (o/a/m/x) — usado na hierarquia de moderação (lib/rooms.js)
          tier: isServerMode ? guildTier(session, guildId) : undefined,
          guild: isServerMode ? guildId : undefined
        })
      : undefined;

    // Sem "ttl" explícito: usa o padrão do SDK (6h), tempo de sobra pra uma
    // sessão longa de call/jogo sem cair no meio.
    const at = new AccessToken(apiKey, apiSecret, { identity, name, metadata });
    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      roomAdmin: roomAdmin || undefined
    });
    const token = await at.toJwt();

    return json(200, { token, url: livekitUrl, room });
  }catch(e){
    console.error('get-token falhou:', e && e.message, e);
    return json(500, { error: 'falha-ao-gerar-token' });
  }
}

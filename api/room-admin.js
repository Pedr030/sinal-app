// Decisão sobre pedidos de entrada em sala COM APROVAÇÃO (HANDOFF §49): aprovar ou recusar. Também ver a senha
// (§50) e GERENCIAR a sala (§53, §54): trocar o nome, o tipo de acesso e a senha, passar a sala pra outra pessoa e encerrar.
//
// Quem chama manda o MESMO token do LiveKit que já usa na sala (como em api/moderate.js). O servidor
// confere a assinatura, que o token é DESTA sala e que quem chama está entre os que podem decidir agora:
// o responsável da sala (o criador, se estiver nela; senão quem entrou primeiro) e, quando presentes,
// o admin do Sinal e dono/Administrador/"gerencia" do servidor — tudo recalculado aqui a cada pedido, a
// partir do que o LiveKit diz de verdade (nada de "quem eu digo que sou" vindo do navegador).
//
// O resultado fica no metadata da sala (allowed/denied, ver lib/rooms.js): o get-token consulta isso
// quando a pessoa que pediu volta pra entrar.
import { RoomServiceClient, TokenVerifier } from 'livekit-server-sdk';
import { parseServerRoom, parseRoomMetadata, approvalDeciders, participantInfo, withApproved, withDenied, decryptRoomPassword,
  canManageRoom, withTitle, withNewPassword, withAccess, withCreator, cleanTitle, cleanPassword, cleanDisplayName, encryptRoomPassword, ACCESS_TYPES } from '../lib/rooms.js';
import { createLimiter, clientIp } from '../lib/ratelimit.js';

const adminLimiter = createLimiter({ max: 60, windowMs: 60 * 1000 });
const MANAGE_ACTIONS = ['rename', 'set-password', 'set-access', 'transfer', 'close'];

function json(status, data){
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export async function POST(request){
  if(!adminLimiter.allow(clientIp(request))) return json(429, { error: 'muitos-pedidos' });

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;
  if(!apiKey || !apiSecret || !livekitUrl) return json(500, { error: 'servidor-nao-configurado' });

  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if(!token) return json(401, { error: 'sem-token' });

  let body;
  try{ body = await request.json(); }catch(e){ return json(400, { error: 'corpo-invalido' }); }
  const { action, room, userId, title, password, access } = body && typeof body === 'object' ? body : {};
  if(typeof room !== 'string' || !parseServerRoom(room)) return json(400, { error: 'sala-invalida' });
  if(!['approve', 'deny', 'reveal', ...MANAGE_ACTIONS].includes(action)) return json(400, { error: 'acao-desconhecida' });
  if((action === 'approve' || action === 'deny' || action === 'transfer') && (typeof userId !== 'string' || !/^\d{15,21}$/.test(userId))) return json(400, { error: 'usuario-invalido' });
  if(action === 'set-access' && !ACCESS_TYPES.includes(access)) return json(400, { error: 'acesso-invalido' });
  const newTitle = action === 'rename' ? cleanTitle(title) : '';
  if(action === 'rename' && !newTitle) return json(400, { error: 'titulo-invalido' });
  // Senha nova: ao trocar a senha e ao mudar o acesso PARA "senha" (nos outros tipos o campo é ignorado).
  const wantsPassword = action === 'set-password' || (action === 'set-access' && access === 'password');
  const newPassword = wantsPassword ? cleanPassword(password) : null;
  if(wantsPassword && !newPassword) return json(400, { error: 'senha-invalida' });

  let claims;
  try{
    claims = await new TokenVerifier(apiKey, apiSecret).verify(token);
  }catch(e){
    return json(401, { error: 'token-invalido' });
  }
  // O token precisa ser DESTA sala (um token de outra sala não decide nada aqui).
  if(!claims.video || claims.video.room !== room) return json(403, { error: 'sem-permissao' });
  const callerIdentity = claims.sub;
  if(!callerIdentity) return json(403, { error: 'sem-permissao' });

  try{
    const roomServiceUrl = livekitUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
    const roomService = new RoomServiceClient(roomServiceUrl, apiKey, apiSecret);

    const rooms = await roomService.listRooms([room]);
    const found = rooms.find((r) => r.name === room);
    if(!found) return json(404, { error: 'sala-nao-encontrada' });
    const meta = parseRoomMetadata(found.metadata);
    const manage = MANAGE_ACTIONS.includes(action);
    if(manage){
      // Qualquer sala de servidor (aberta ou privada); só trocar a SENHA exige sala que já tem senha.
      if(!meta) return json(400, { error: 'sala-sem-dados' });
      if(action === 'set-password' && meta.access !== 'password') return json(400, { error: 'sala-nao-tem-senha' });
    } else if(action === 'reveal'){
      if(!meta || meta.access !== 'password') return json(400, { error: 'sala-nao-tem-senha' });
    } else if(!meta || meta.access !== 'approval') return json(400, { error: 'sala-nao-tem-aprovacao' });

    const rawPeople = await roomService.listParticipants(room);
    const people = rawPeople.map(participantInfo);
    if(manage){
      const caller = people.find((p) => p.identity === callerIdentity);
      if(!canManageRoom(meta, caller)) return json(403, { error: 'sem-permissao' });
      if(action === 'rename') await roomService.updateRoomMetadata(room, JSON.stringify(withTitle(meta, newTitle)));
      else if(action === 'set-password') await roomService.updateRoomMetadata(room, JSON.stringify(withNewPassword(meta, encryptRoomPassword(apiSecret, room, newPassword))));
      else if(action === 'set-access'){
        if((meta.access || 'open') === access) return json(400, { error: 'mesmo-acesso' });
        const passwordEnc = access === 'password' ? encryptRoomPassword(apiSecret, room, newPassword) : undefined;
        await roomService.updateRoomMetadata(room, JSON.stringify(withAccess(meta, { access, passwordEnc, admitted: people.map((p) => p.userId) })));
      } else if(action === 'transfer'){
        // O novo dono precisa estar NA sala agora (identidade vinda do metadata assinado, não do pedido) e ser outra pessoa.
        const idx = people.findIndex((p) => p.userId === userId);
        if(idx < 0) return json(404, { error: 'pessoa-nao-esta-na-sala' });
        if(meta.creator && meta.creator.id === userId) return json(400, { error: 'ja-e-dono' });
        const name = cleanDisplayName(rawPeople[idx].name) || 'Alguém';
        await roomService.updateRoomMetadata(room, JSON.stringify(withCreator(meta, { id: userId, name })));
      }
      else await roomService.deleteRoom(room); // encerrar: o LiveKit desconecta todo mundo (motivo "sala apagada")
      return json(200, { ok: true });
    }
    if(!approvalDeciders(meta, people).includes(callerIdentity)) return json(403, { error: 'sem-permissao' });

    // Ver a senha da sala: só entre quem pode cuidar dela (mesma regra de quem decide pedidos de entrada).
    if(action === 'reveal'){
      const password = decryptRoomPassword(apiSecret, room, meta.pwEnc);
      if(!password) return json(404, { error: 'senha-indisponivel' }); // sala criada antes de a senha poder ser vista
      return json(200, { password });
    }

    const next = action === 'approve' ? withApproved(meta, userId) : withDenied(meta, userId);
    await roomService.updateRoomMetadata(room, JSON.stringify(next));
    return json(200, { ok: true });
  }catch(e){
    console.error('room-admin falhou:', action, e && e.message, e);
    return json(500, { error: 'falha-ao-executar' });
  }
}

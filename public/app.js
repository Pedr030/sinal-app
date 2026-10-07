// SINAL — sala de tela ao vivo, via LiveKit self-hosted (SFU próprio).
//
// Migrado da malha P2P (PeerJS) pra um SFU depois de um relato real: alguém
// compartilhando Terraria via a versão em malha via CPU disparar, porque
// nessa arquitetura antiga quem compartilha recodifica o vídeo uma vez POR
// PESSOA assistindo. Com um SFU, a codificação é feita uma vez só — o
// servidor do LiveKit é quem retransmite pra todo mundo. Ver HANDOFF.md.

// Liga/desliga a tela de manutenção (#maintenanceScreen no index.html) — usar
// durante a migração de infraestrutura do LiveKit (ver HANDOFF.md), pra
// impedir criar/entrar em sala com um erro confuso no meio da troca em vez
// de uma mensagem clara. 100% reversível: só voltar pra `false` quando o
// servidor novo estiver pronto, nada mais precisa mudar.
const MAINTENANCE_MODE = false;

function genCode(){
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I
  let c = '';
  for(let i=0;i<6;i++) c += chars[Math.floor(Math.random()*chars.length)];
  return c;
}
function initials(name){
  const words = (name||'?').trim().split(/\s+/).filter(Boolean);
  if(words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] || '?').slice(0,2).toUpperCase();
}
// Nomes vêm de outros participantes e não são confiáveis — sem isso, alguém
// poderia colocar HTML/script no próprio nome e ele rodaria no navegador de
// todo mundo na sala, já que os nomes vão parar em innerHTML.
//
// ATENÇÃO à implementação: a versão antiga usava textContent -> innerHTML, que
// parece certa mas NÃO escapa aspas — o serializador de HTML só escapa &, < e >
// em nó de texto. Em contexto de texto isso bastava, mas nos lugares onde o
// valor ia dentro de um atributo entre aspas (src="...", data-name="...") dava
// pra fechar a aspa e injetar um onerror=. Daí o escape manual abaixo, que
// cobre os dois contextos. Mesmo assim, preferir montar via DOM
// (createElement + .textContent/.src) onde der — ver renderAvatars() e
// renderRosterPanel(); aí o problema deixa de existir em vez de depender de
// lembrar de escapar certo toda vez.
function escapeHtml(str){
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
// Botões só de ícone (câmera, compartilhar) não têm texto visível — o rótulo
// vira title/aria-label, que muda dinamicamente conforme o estado (ligado/desligado).
function setBtnLabel(btn, label){
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

let room = null;           // LivekitClient.Room atual
let myName = 'Você';
let roomCode = null;
let myAccessToken = null;  // token do LiveKit da sessão atual, reusado nas ações de moderação (api/moderate.js)
let selfInitiatedUnpublish = false; // true durante o unpublishTrack() do próprio toggleShare()/toggleCamera() — evita reagir ao TrackMuted que isso pode emitir como parte do processo
const tileStreams = new Map(); // tileId -> MediaStream (junta vídeo+áudio da mesma fonte, ex: tela+áudio da guia)
const tileVideoTracks = new Map(); // tileId -> Track de vídeo do LiveKit (pra amostrar getRTCStatsReport())

function setEntryStatus(msg){
  document.getElementById('entryStatus').textContent = msg || '';
  document.getElementById('srvStatus').textContent = msg || ''; // painel do servidor (HANDOFF §39)
}
function setRoomStatus(msg, isError){
  const el = document.getElementById('roomStatus');
  el.textContent = msg || '';
  el.className = isError ? 'error' : '';
}

function getName(){
  const v = document.getElementById('nameInput').value.trim();
  if(v){
    try{ localStorage.setItem('sinal:lastName', v); }catch(e){ /* modo privado etc — sem problema, só não vai lembrar da próxima vez */ }
    return v;
  }
  if(discordUser && discordUser.name) return discordUser.name;
  return 'Convidado' + Math.floor(Math.random()*90+10);
}

// ---------------- SOM DE NOTIFICAÇÃO ----------------
// Toca um "blip" curto gerado via WebAudio (sem precisar de arquivo de áudio,
// mantendo o app sem dependências externas) quando alguém começa a
// compartilhar tela/câmera. O navegador só deixa tocar som automaticamente
// depois de algum gesto do usuário na página — por isso "aquecemos" o
// AudioContext logo no clique de criar/entrar na sala.
let audioCtx = null;
function getAudioCtx(){
  if(!audioCtx){
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if(!Ctx) return null;
    audioCtx = new Ctx();
  }
  if(audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
function playNotifyChime(){
  const ctx = getAudioCtx();
  if(!ctx) return;
  try{
    const now = ctx.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = now + i * 0.09;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.24);
    });
  }catch(e){ /* sem suporte a áudio, segue sem som */ }
}

// Se a aba estiver em segundo plano quando alguém começa a compartilhar,
// troca o título até você voltar a olhar pra ela — útil pra quem deixa o
// Sinal minimizado atrás do jogo/Discord.
const ORIGINAL_TITLE = document.title;
let titleFlashing = false;

function flashTabTitle(){
  if(!document.hidden) return;
  titleFlashing = true;
  document.title = '🔴 Nova transmissão — SINAL';
}

document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible' && titleFlashing){
    titleFlashing = false;
    document.title = ORIGINAL_TITLE;
  }
});

// Avisa que uma transmissão NOVA começou (não dispara de novo só por
// clicar "assistir" num card que já existia, nem ao sincronizar quem já
// tava compartilhando antes de eu entrar — só no TrackPublished de verdade).
function notifyNewShare(){
  playNotifyChime();
  flashTabTitle();
}

// ---------------- ENTRY / CONEXÃO COM A SALA ----------------
function createRoom(){
  getAudioCtx();
  connectToRoom(genCode(), getName(), 'create');
}
function joinRoom(){
  getAudioCtx();
  const raw = document.getElementById('joinCodeInput').value.trim();
  if(!raw){ setEntryStatus('Digite o código da sala.'); return; }
  // Link de convite de sala de SERVER (s<id>-xxxxxx, minúsculo) entra pelo modo
  // próprio; o resto é código de sala normal, sempre em maiúsculas.
  const server = isServerRoomName(raw);
  connectToRoom(server ? raw : raw.toUpperCase(), getName(), server ? 'server-join' : 'join');
}

// Pede um token de acesso pra função serverless (que fala com a API do
// LiveKit usando a API secret — nunca exposta aqui no navegador) e conecta.
// "mode" distingue criar de entrar do lado do servidor: entrar num código
// que não existe dá erro de verdade ("sala não encontrada") em vez de criar
// uma sala vazia silenciosa — sem isso, digitar o código errado deixava a
// pessoa sozinha numa sala fantasma sem nenhum aviso (relato real, ver
// HANDOFF §5).
// mode: 'join' | 'create' (salas por código) | 'server-join' | 'server-create'
// (salas de um server do Discord). `extra` leva { guild, title } no server-create.
async function connectToRoom(code, name, mode, extra){
  myName = name;
  roomCode = code || '';
  const hadSession = !!(discordUser && discordUser.session);
  setEntryStatus('Conectando...');

  let token, url;
  try{
    // POST, e não GET, por dois motivos independentes:
    //
    // 1. Criar sala e avisar no canal do Discord são efeitos colaterais de
    //    verdade. Num GET, qualquer página da internet podia embutir um
    //    <img src="https://sinal.../api/get-token?...&mode=create"> e fazer o
    //    navegador de quem visitasse criar salas e mandar mensagem no Discord
    //    de vocês, sem clicar em nada.
    // 2. A sessão do Discord é uma credencial de 7 dias (ver lib/session.js). Em
    //    query string ela ia parar em log de plataforma, histórico do navegador
    //    e cabeçalho Referer, a cada entrada em sala. No corpo do POST, não vai.
    const res = await fetch('/api/get-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        room: code,
        name,
        mode,
        guild: extra && extra.guild,
        title: extra && extra.title,
        session: (discordUser && discordUser.session) || undefined
      })
    });
    if(res.status === 404){
      setEntryStatus('Sala não encontrada. Confira o código.');
      return;
    }
    if(res.status === 401){
      if(!hadSession){
        setEntryStatus('Essa sala é de um servidor do Discord — entre com o Discord pra abrir.');
        return;
      }
      // Sessão do Discord vencida (dura 7 dias) ou inválida — limpa e pede login de novo.
      clearDiscordUser();
      renderServersUI();
      setEntryStatus('Sua sessão do Discord expirou. Entre com o Discord de novo (ou use só o nome).');
      return;
    }
    if(res.status === 403){
      const why = (await res.json().catch(() => ({}))).error;
      setEntryStatus(why === 'sala-privada' ? 'Essa sala é privada.' : 'Você não faz parte desse servidor do Discord.');
      return;
    }
    if(res.status === 429){
      const why = (await res.json().catch(() => ({}))).error;
      setEntryStatus(why === 'muitos-pedidos'
        ? 'Muitos pedidos seguidos. Espere um instante e tente de novo.'
        : 'Esse servidor já tem 10 salas ao vivo. Entre numa delas ou espere alguma fechar.');
      return;
    }
    if(!res.ok) throw new Error('token-fetch-failed');
    const data = await res.json();
    token = data.token; url = data.url;
    if(data.room) roomCode = data.room; // sala de server: o nome sai do servidor
    if(!token || !url) throw new Error('token-fetch-empty');
  }catch(e){
    setEntryStatus('Não foi possível falar com o servidor. Confira sua internet e tente de novo.');
    return;
  }
  // Guardado pra reusar nas ações de moderação (api/moderate.js) — é o mesmo
  // token que já autentica a conexão com o LiveKit, sem precisar de uma
  // segunda credencial.
  myAccessToken = token;

  room = new LivekitClient.Room({ adaptiveStream: true, dynacast: true });
  wireRoomEvents(room);

  try{
    // autoSubscribe: false — igual ao Discord, ninguém recebe vídeo/áudio de
    // transmissão nenhuma até clicar pra assistir (ver addPendingTile/
    // watchTile abaixo). Sem isso, toda transmissão de tela/câmera de
    // qualquer participante tocava automaticamente pra todo mundo na sala,
    // mesmo quem só tá jogando e não quer ver — cada um tinha que mutar/
    // esconder na mão.
    await Promise.race([
      room.connect(url, token, { autoSubscribe: false }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
    ]);
  }catch(e){
    setEntryStatus('Não foi possível entrar na sala (tempo esgotado ou erro de conexão). Tente de novo.');
    try{ room.disconnect(); }catch(err){}
    room = null;
    return;
  }

  enterRoomUI();
}

function wireRoomEvents(liveRoom){
  const { RoomEvent, Track } = LivekitClient;

  // room.disconnect() (chamado em leaveRoom()) é assíncrono — se a pessoa
  // sair e reentrar rápido (mesmo código ou outro), a sala NOVA já pode estar
  // conectada e funcionando enquanto o evento "desconectei de verdade" da
  // sala ANTIGA ainda está pra chegar. Como os handlers escrevem em elementos
  // de UI compartilhados (ex: #roomStatus), um evento atrasado da sala velha
  // conseguia aparecer por cima da conexão nova (relato real, 2026-08-24: "só
  // que a mensagem 'Desconectado da sala' apareceu depois de eu sair e
  // voltar pelo código, a sala nova tava funcionando"). Cada handler só age
  // se `liveRoom` (a instância específica que ele pertence) ainda for a sala
  // atual (`room`, a variável global) — evento de instância abandonada é
  // ignorado.
  const isCurrent = () => liveRoom === room;

  liveRoom.on(RoomEvent.TrackSubscribed, (...args) => { if(isCurrent()) handleTrackAdded(...args); });
  liveRoom.on(RoomEvent.TrackUnsubscribed, (...args) => { if(isCurrent()) handleTrackRemoved(...args); });
  liveRoom.on(RoomEvent.ParticipantConnected, (participant) => {
    if(!isCurrent()) return;
    renderAvatars();
    // Quem chega agora não sabe quem já tá assistindo o quê — cada um manda
    // o próprio estado só pra essa pessoa (ver "Quem está assistindo").
    sendWatchSync([participant.identity]);
  });
  liveRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
    if(!isCurrent()) return;
    removeTile(participant.identity);
    removeTile(participant.identity + ':cam');
    forgetViewer(participant.identity);
    clearViewers(participant.identity);
    clearViewers(participant.identity + ':cam');
    myWatching.delete(participant.identity);
    myWatching.delete(participant.identity + ':cam');
    renderAvatars();
  });
  // Depois de uma queda e volta, mensagens podem ter se perdido no meio —
  // reenvia o estado completo pra sala toda.
  liveRoom.on(RoomEvent.Reconnected, () => { if(isCurrent()) sendWatchSync(); });
  liveRoom.on(RoomEvent.TrackPublished, (publication, participant) => {
    if(!isCurrent()) return;
    renderAvatars();
    // Com autoSubscribe:false, publicar não inscreve sozinho — mostra o
    // card "clique pra assistir" em vez de puxar vídeo/áudio na hora.
    if(publication.source === Track.Source.Camera){
      addPendingTile(participant.identity + ':cam', participant, true);
      notifyNewShare();
    } else if(publication.source === Track.Source.ScreenShare){
      addPendingTile(participant.identity, participant, false);
      notifyNewShare();
    }
  });
  liveRoom.on(RoomEvent.TrackUnpublished, (publication, participant) => {
    if(!isCurrent()) return;
    renderAvatars();
    // Se ninguém tinha clicado pra assistir ainda (card ainda era só o
    // "pendente"), TrackUnsubscribed nunca dispara pra limpar — faz aqui.
    if(publication.source === Track.Source.Camera || publication.source === Track.Source.ScreenShare){
      const tileId = publication.source === Track.Source.Camera ? participant.identity + ':cam' : participant.identity;
      const tile = tiles.get(tileId);
      if(tile && tile.classList.contains('pending-tile')) removeTile(tileId);
      clearViewers(tileId); // transmissão acabou — a próxima começa com ninguém assistindo
    }
  });
  // Cobre parar de compartilhar pelo controle nativo do navegador ("Parar
  // apresentação"), não só pelo nosso próprio botão.
  liveRoom.on(RoomEvent.LocalTrackUnpublished, (publication) => {
    if(!isCurrent()) return;
    if(publication.source === Track.Source.ScreenShare){ resetShareButton(); clearViewers(liveRoom.localParticipant.identity); }
    if(publication.source === Track.Source.Camera){ resetCameraButton(); clearViewers(liveRoom.localParticipant.identity + ':cam'); }
  });
  // Reação a mute forçado por admin (api/moderate.js) — 3ª tentativa
  // (2026-08-24). As duas primeiras usavam setCameraEnabled(false)/
  // setScreenShareEnabled(false), que descobrimos por log real que só MUTA
  // (não desliga de verdade — ver §12 no HANDOFF.md), causando reentrância
  // com o toggle normal. Agora usamos unpublishTrack() (o método correto,
  // já confirmado funcionando no toggle próprio) e um guard
  // (`selfInitiatedUnpublish`) pro caso de unpublishTrack() também emitir
  // TrackMuted como parte do próprio processo de desligar — evita reagir
  // à nossa própria chamada.
  liveRoom.on(RoomEvent.TrackMuted, (publication, participant) => {
    if(!isCurrent()) return;
    if(participant === liveRoom.localParticipant){
      if(selfInitiatedUnpublish) return;
      const track = publication.videoTrack || publication.track;
      if(track){
        liveRoom.localParticipant.unpublishTrack(track).catch((e) => console.error('[sinal] unpublish forçado (mute de admin) falhou:', e));
      }
      return;
    }
    // Participante remoto mutado — trata visualmente enquanto o unpublish
    // de verdade (acima, do lado dela) não chega.
    const tileId = publication.source === Track.Source.Camera ? participant.identity + ':cam' : participant.identity;
    const tile = tiles.get(tileId);
    if(!tile) return;
    tile.classList.add('render-off');
    const video = tile.querySelector('video');
    if(video) video.pause();
  });
  liveRoom.on(RoomEvent.TrackUnmuted, (publication, participant) => {
    if(!isCurrent()) return;
    if(participant === liveRoom.localParticipant) return;
    const tileId = publication.source === Track.Source.Camera ? participant.identity + ':cam' : participant.identity;
    const tile = tiles.get(tileId);
    if(!tile) return;
    tile.classList.remove('render-off');
    const video = tile.querySelector('video');
    if(video) video.play().catch(() => {});
  });
  liveRoom.on(RoomEvent.DataReceived, (payload, participant) => {
    if(!isCurrent()) return;
    try{
      const msg = JSON.parse(new TextDecoder().decode(payload));
      if(msg && msg.type === 'chat'){
        // O maxlength="500" do input é validação só de interface — quem manda
        // é outro navegador, e um cliente modificado pode publicar o que
        // quiser aqui. Truncar na entrada, que é a fronteira de confiança.
        renderChatMessage({
          name: (participant && (participant.name || participant.identity)) || 'Alguém',
          text: String(msg.text == null ? '' : msg.text).slice(0, 500),
          ts: typeof msg.ts === 'number' ? msg.ts : Date.now()
        }, false);
      } else if(msg && (msg.type === 'watch' || msg.type === 'watch-sync') && participant){
        handleWatchMessage(msg, participant);
      }
    }catch(e){ /* payload em formato inesperado, ignora */ }
  });
  liveRoom.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
    if(!isCurrent()) return;
    if(participant) updateQualityDot(participant.identity, quality);
  });
  liveRoom.on(RoomEvent.Disconnected, () => {
    if(!isCurrent()) return;
    // Chega aqui em qualquer desconexão que NÃO foi a gente mesmo chamando
    // leaveRoom() (isso já limpa `room` antes, então isCurrent() dá false e
    // esse handler nem roda) — inclui ser expulso por um admin, queda de
    // rede, etc. Antes só mostrava uma mensagem e ficava preso na tela da
    // sala sem conseguir fazer nada (bug real, achado em teste); agora volta
    // pra tela inicial de verdade, igual sair por conta própria.
    leaveRoom();
    setEntryStatus('Você foi desconectado da sala.');
  });
}

// Tela ou câmera podem vir com vídeo e áudio como tracks separados (ex:
// compartilhar uma guia com "áudio da guia" marcado) — junta os dois no
// mesmo MediaStream pra tocar junto no mesmo <video>, sem depender da ordem
// de chegada.
function handleTrackAdded(track, publication, participant){
  const { Track } = LivekitClient;
  const source = publication.source;
  let tileId, isCamera;
  if(source === Track.Source.Camera){ tileId = participant.identity + ':cam'; isCamera = true; }
  else if(source === Track.Source.ScreenShare || source === Track.Source.ScreenShareAudio){ tileId = participant.identity; isCamera = false; }
  else return; // microfone etc — a voz é 100% Discord, não usamos áudio de participante aqui

  let stream = tileStreams.get(tileId);
  if(!stream){ stream = new MediaStream(); tileStreams.set(tileId, stream); }
  stream.addTrack(track.mediaStreamTrack);

  if(track.kind === 'video'){
    const displayName = participant.name || participant.identity;
    const label = isCamera ? displayName + ' (câmera)' : displayName;
    addTile(tileId, label, stream);
    tileVideoTracks.set(tileId, track); // pra amostrar getRTCStatsReport() periodicamente
    // ConnectionQualityChanged só dispara quando a qualidade MUDA — com o
    // clique-pra-assistir o tile nasce bem depois disso, e com conexão
    // estável o evento não vem de novo nunca (a bolinha ficava cinza em
    // "Medindo conexão..." pra sempre). Puxa o valor atual na criação.
    updateQualityDot(participant.identity, participant.connectionQuality);
    setWatching(tileId, true);
  }
}

function handleTrackRemoved(track, publication, participant){
  const { Track } = LivekitClient;
  const source = publication.source;
  let tileId, isCamera;
  if(source === Track.Source.Camera){ tileId = participant.identity + ':cam'; isCamera = true; }
  else if(source === Track.Source.ScreenShare || source === Track.Source.ScreenShareAudio){ tileId = participant.identity; isCamera = false; }
  else return;

  const stream = tileStreams.get(tileId);
  if(stream) stream.removeTrack(track.mediaStreamTrack);
  if(track.kind === 'video'){
    tileStreams.delete(tileId);
    tileVideoTracks.delete(tileId);
    qualityDetails.delete(tileId);
    qualityBaseLabel.delete(tileId);
    qualityStatsPrev.delete(tileId);
    removeTile(tileId);
    setWatching(tileId, false);
    // Isso dispara tanto quando a PESSOA para de compartilhar quanto quando
    // EU clico em "parar de assistir" (setSubscribed(false), ver
    // stopWatchingTile). Só nesse segundo caso a publicação ainda existe —
    // aí volta o card "clique pra assistir" em vez de sumir sem rastro.
    const sourceKind = isCamera ? Track.Source.Camera : Track.Source.ScreenShare;
    if(participant.getTrackPublication(sourceKind)) addPendingTile(tileId, participant, isCamera);
  }
}

function enterRoomUI(){
  // App desktop (v0.3.11+): main.js espera sair da sala pra perguntar se
  // reinicia pra atualizar — nunca interrompe a call.
  if(window.sinalElectron && window.sinalElectron.setInRoom) window.sinalElectron.setInRoom(true, roomCode);
  document.getElementById('entryScreen').style.display = 'none';
  document.getElementById('roomScreen').style.display = 'flex';
  // Sala de SERVER entra-se pela lista do servidor (só quem faz parte vê e entra —
  // o servidor recusa o resto): não há código nem convite pra copiar, então os
  // botões somem (classe lida pelo CSS). Sala por código segue como sempre.
  document.getElementById('roomScreen').classList.toggle('server-room', isServerRoomName(roomCode));
  // Marca a sala ativa pro CSS deixar o rodapé compacto (§ ver style.css) —
  // o texto descritivo do rodapé só faz sentido na tela de entrada.
  document.body.classList.add('in-room');
  callView = '';
  renderCallSide();
  startLivesPolling();
  fetchLives(); // a foto da tela inicial pode estar velha
  // Sala de server: o chip mostra o NOME da sala (do metadata no LiveKit), não o id interno.
  let chipText = roomCode;
  if(isServerRoomName(roomCode)){
    try{ chipText = JSON.parse(room.metadata || '{}').title || 'Sala'; }catch(e){ chipText = 'Sala'; }
  }
  document.getElementById('roomCodeChip').textContent = chipText;
  document.getElementById('selfName').firstChild.textContent = myName + ' ';
  document.getElementById('chatMessages').innerHTML = '<div class="chat-empty mono">Sem mensagens ainda</div>';
  renderAvatars();
  // Quem já tava compartilhando ANTES de eu entrar não passa pelo evento
  // TrackPublished (isso só dispara pra publicações novas, depois que eu já
  // tô na sala) — sem isso, transmissão de quem chegou primeiro nunca
  // ganhava o card "clique pra assistir".
  syncExistingPublications();
  try{ if(!isServerRoomName(roomCode)) localStorage.setItem('sinal:lastRoomCode', roomCode); }catch(e){ /* modo privado etc — sem problema, só não vai lembrar da próxima vez */ }
}

function syncExistingPublications(){
  if(!room) return;
  const { Track } = LivekitClient;
  room.remoteParticipants.forEach((participant) => {
    const screenPub = participant.getTrackPublication(Track.Source.ScreenShare);
    if(screenPub && !screenPub.isSubscribed) addPendingTile(participant.identity, participant, false);
    const camPub = participant.getTrackPublication(Track.Source.Camera);
    if(camPub && !camPub.isSubscribed) addPendingTile(participant.identity + ':cam', participant, true);
  });
}

function flashCopyFeedback(btn){
  if(!btn) return;
  if(btn.classList.contains('icon-btn')){
    const originalTitle = btn.title;
    btn.classList.add('copied');
    btn.title = 'Copiado!';
    btn.disabled = true;
    setTimeout(() => { btn.classList.remove('copied'); btn.title = originalTitle; btn.disabled = false; }, 1400);
    return;
  }
  const original = btn.textContent;
  btn.textContent = 'Copiado!';
  btn.disabled = true;
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1400);
}

function copyRoomCode(btn){
  navigator.clipboard.writeText(roomCode);
  flashCopyFeedback(btn);
}

function copyRoomLink(btn){
  const url = new URL(window.location.href);
  url.search = '';
  url.pathname = url.pathname.replace(/index\.html$/i, ''); // limpa o "/index.html" do app instalado
  url.searchParams.set('sala', roomCode);
  navigator.clipboard.writeText(url.toString());
  flashCopyFeedback(btn);
}

// ---------------- CHAT ----------------
// Vai pelo canal de dados do próprio LiveKit (publishData/DataReceived) —
// sem histórico persistido, some ao sair da sala, igual ao resto do app.
let chatOpen = false;
let unreadChat = 0;

function toggleChatPanel(force){
  chatOpen = typeof force === 'boolean' ? force : !chatOpen;
  document.getElementById('chatPanel').classList.toggle('open', chatOpen);
  if(chatOpen){
    toggleRosterPanel(false);
    unreadChat = 0;
    updateChatBadge();
    document.getElementById('chatInput').focus();
    scrollChatToBottom();
  }
}

function updateChatBadge(){
  const badge = document.getElementById('chatBadge');
  badge.classList.toggle('show', unreadChat > 0);
  badge.textContent = unreadChat > 9 ? '9+' : String(unreadChat);
}

function scrollChatToBottom(){
  const list = document.getElementById('chatMessages');
  list.scrollTop = list.scrollHeight;
}

const CHAT_MAX_MESSAGES = 200; // quantas mensagens ficam no DOM (ver poda em renderChatMessage)

function renderChatMessage(msg, isMine){
  const list = document.getElementById('chatMessages');
  const empty = list.querySelector('.chat-empty');
  if(empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'chat-msg' + (isMine ? ' mine' : '');
  const time = new Date(msg.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  row.innerHTML = `<div class="chat-msg-meta"><span class="chat-msg-name">${escapeHtml(isMine ? 'Você' : msg.name)}</span><span class="chat-msg-time">${escapeHtml(time)}</span></div><div class="chat-msg-text"></div>`;
  row.querySelector('.chat-msg-text').textContent = msg.text; // sempre textContent, nome/texto vêm de outro participante
  list.appendChild(row);
  // Sessão longa fazia o DOM crescer sem parar — e um cliente modificado
  // publicando em loop inflaria a memória de todo mundo na sala. O histórico
  // não é persistido de qualquer forma (some ao sair), então podar as antigas
  // não perde nada que já não fosse perdido.
  while(list.children.length > CHAT_MAX_MESSAGES) list.removeChild(list.firstElementChild);
  scrollChatToBottom();
  if(!isMine && !chatOpen){ unreadChat++; updateChatBadge(); }
}

function sendChatMessage(text){
  text = (text || '').trim();
  if(!text || !room) return;
  const ts = Date.now();
  renderChatMessage({ name: 'Você', text, ts }, true);
  const payload = new TextEncoder().encode(JSON.stringify({ type: 'chat', text, ts }));
  room.localParticipant.publishData(payload, { reliable: true, topic: 'chat' });
}

document.getElementById('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('chatInput');
  sendChatMessage(input.value);
  input.value = '';
});

// ---------------- COMPARTILHAR TELA / CÂMERA ----------------
// Três qualidades pra tela (ver HANDOFF §32). Codec: H.265 pela placa de
// vídeo quando o PC de quem compartilha tiver codificador (o Chrome só lista
// H.265 nos codecs de envio quando existe hardware pra isso) — tira o peso
// da CPU e usa ~45% menos banda que VP8 na mesma imagem (medido). Sem H.265,
// sai VP8 como antes. Com H.265, o VP8 vai junto como reserva em "simulcast
// de codec": só é codificado/enviado enquanto alguém que não decodifica
// H.265 estiver assistindo (testado ponta a ponta pela VM).
// Carga na VM (2 telas vistas por 4 pessoas cada): Nítido H.265 ~32 Mbps,
// Fluido H.265 ~48 Mbps — igual ao Nítido VP8 de antes, zona sem aperto do
// teste de carga (§31/§32).
const SHARE_QUALITY_PRESETS = {
  leve: {
    name: 'Leve', short: '720p', desc: '720p · 30fps — upload fraco',
    resolution: { width: 1280, height: 720, frameRate: 30 },
    h265: { maxBitrate: 2_000_000, maxFramerate: 30 },
    h264: { maxBitrate: 3_000_000, maxFramerate: 30 },
    vp8: { maxBitrate: 2_500_000, maxFramerate: 30 },
    contentHint: 'detail'
  },
  nitido: {
    name: 'Nítido', short: '1080p', desc: '1080p · 30fps — texto e vídeo',
    resolution: { width: 1920, height: 1080, frameRate: 30 },
    h265: { maxBitrate: 4_000_000, maxFramerate: 30 },
    h264: { maxBitrate: 5_500_000, maxFramerate: 30 },
    vp8: { maxBitrate: 6_000_000, maxFramerate: 30 },
    contentHint: 'detail'
  },
  fluido: {
    name: 'Fluido', short: '60fps', desc: '1080p · 60fps — jogos',
    resolution: { width: 1920, height: 1080, frameRate: 60 },
    h265: { maxBitrate: 6_000_000, maxFramerate: 60 },
    // Fluido sai em H.264 por hardware (experimento, ver FLUIDO_CODEC abaixo). Mesmo teto de antes (6 Mbps/60fps).
    h264: { maxBitrate: 6_000_000, maxFramerate: 60 },
    // Só existe com H.265/H.264 por placa de vídeo (60fps em VP8 pesaria na CPU e na VM).
    // Esse VP8 é só a reserva do H.265 pra quem assiste sem H.265 — a 30fps, como o Nítido.
    vp8: { maxBitrate: 6_000_000, maxFramerate: 30 },
    contentHint: 'motion',
    requiresH265: true
  }
};

// EXPERIMENTO (2026-10-05, HANDOFF §46): o Fluido em H.265 derrubou o app 3 vezes (o Chromium aborta ao
// receber a saída do codificador H.265 da placa, em rtc_video_encoder.cc), e o Nítido em H.265 ficou 7 h
// estável. Então o Fluido usa H.264 por hardware (caminho muito mais usado do Chromium) e os outros seguem
// em H.265. Pra desfazer, basta trocar por 'h265'. H.264 gasta mais banda pra mesma imagem.
const FLUIDO_CODEC = 'h264';

// Codec principal de uma qualidade. Sem H.265 na placa: VP8 (e o Fluido nem existe, ver effectiveShareQuality).
function pickShareCodec(q, h265Supported){
  if(!h265Supported) return 'vp8';
  return q === 'fluido' ? FLUIDO_CODEC : 'h265';
}

// Limites de envio (bitrate/fps) de um preset pra um codec.
function shareEncodingFor(preset, codec){
  return codec === 'h265' ? preset.h265 : codec === 'h264' ? preset.h264 : preset.vp8;
}

// Trocar a qualidade NO MEIO da transmissão não republica, então o codec fica o mesmo. Sair do Fluido pra
// Nítido/Leve é ok (continua no mesmo codec); entrar no Fluido só dá se a transmissão já saiu no codec dele.
function canSwitchQualityLive(activeCodec, targetQuality, h265Supported){
  if(targetQuality !== 'fluido') return true;
  return activeCodec === pickShareCodec('fluido', h265Supported);
}
const FLUIDO_UNAVAILABLE_TEXT = 'Precisa de uma placa de vídeo com codificador H.265 — este PC/navegador não tem';
let shareQuality = 'nitido';
let activeShareQuality = null; // qualidade da transmissão em andamento (pro status/tooltip)
let activeShareCodec = null;   // 'h265' | 'h264' | 'vp8' — codec principal escolhido ao publicar

function canSendH265(){
  try{ return LivekitClient.supportsH265(); }catch(e){ return false; }
}

// Fluido salvo num PC que não suporta (ou o suporte sumiu, ex: driver) cai
// pro Nítido em vez de falhar.
function effectiveShareQuality(q){
  const preset = SHARE_QUALITY_PRESETS[q] ? q : 'nitido';
  if(SHARE_QUALITY_PRESETS[preset].requiresH265 && !canSendH265()) return 'nitido';
  return preset;
}

function updateQualityBtn(){
  const btn = document.getElementById('qualityBtn');
  if(!btn) return;
  // Transmitindo: mostra a qualidade da transmissão em andamento.
  const current = activeShareQuality || effectiveShareQuality(shareQuality);
  const preset = SHARE_QUALITY_PRESETS[current];
  btn.querySelector('.quality-label').textContent = preset.short;
  setBtnLabel(btn, `Qualidade: ${preset.name} (${preset.desc}) — clique pra mudar`);
  document.querySelectorAll('#qualityMenu .quality-option').forEach((opt) => {
    const key = opt.dataset.quality;
    const unavailable = SHARE_QUALITY_PRESETS[key].requiresH265 && !canSendH265();
    opt.disabled = unavailable;
    opt.title = unavailable ? FLUIDO_UNAVAILABLE_TEXT : '';
    opt.classList.toggle('selected', key === current);
  });
}

function setShareQuality(q){
  shareQuality = effectiveShareQuality(q);
  try{ localStorage.setItem('sinal:shareQuality', shareQuality); }catch(e){ /* modo privado etc — sem problema, só não vai lembrar da próxima vez */ }
  updateQualityBtn();
}

function toggleQualityMenu(force){
  const menu = document.getElementById('qualityMenu');
  const open = force != null ? force : menu.hidden;
  menu.hidden = !open;
  document.getElementById('qualityBtn').setAttribute('aria-expanded', String(open));
}

function setupQualityMenu(){
  const menu = document.getElementById('qualityMenu');
  Object.entries(SHARE_QUALITY_PRESETS).forEach(([key, preset]) => {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'quality-option';
    opt.dataset.quality = key;
    opt.setAttribute('role', 'menuitemradio');
    const name = document.createElement('span');
    name.className = 'quality-option-name';
    name.textContent = preset.name;
    const desc = document.createElement('span');
    desc.className = 'quality-option-desc mono';
    desc.textContent = preset.desc;
    opt.append(name, desc);
    opt.addEventListener('click', () => {
      setShareQuality(key);
      toggleQualityMenu(false);
      // Transmitindo: troca na hora. App com seletor: lembra no settings.json
      // também, pra próxima transmissão já abrir com essa qualidade.
      if(activeShareQuality) changeActiveShareQuality(key);
      if(electronPickerChoosesQuality() && window.sinalElectron.setSettings){
        window.sinalElectron.setSettings({ shareQuality: effectiveShareQuality(key) }).then((res) => {
          if(res && res.settings) electronSettings = res.settings;
        }).catch(() => {});
      }
    });
    menu.appendChild(opt);
  });
  document.addEventListener('click', (e) => {
    if(menu.hidden) return;
    if(!menu.contains(e.target) && !document.getElementById('qualityBtn').contains(e.target)) toggleQualityMenu(false);
  });
  document.addEventListener('keydown', (e) => { if(e.key === 'Escape') toggleQualityMenu(false); });
}

// ---------------- Enviar relatório de problema (app desktop) ----------------
// Manda o texto da pessoa + o final do registro do app pra api/report.js, que
// repassa pra um canal privado do Discord (HANDOFF §37). A pessoa vê
// exatamente o que vai junto ("Ver o que vai junto") antes de enviar.
let reportLogCache = null;

async function loadReportLog(){
  if(reportLogCache === null){
    try{ reportLogCache = await window.sinalElectron.getLogTail(); }catch(e){ reportLogCache = ''; }
  }
  return reportLogCache;
}

function openReportDialog(){
  reportLogCache = null;
  document.getElementById('reportText').value = '';
  document.getElementById('reportStatus').textContent = '';
  document.getElementById('reportPreview').hidden = true;
  document.getElementById('reportSendBtn').disabled = false;
  document.getElementById('reportOverlay').hidden = false;
  document.getElementById('reportText').focus();
}

function closeReportDialog(){ document.getElementById('reportOverlay').hidden = true; }

function setupReportDialog(){
  const overlay = document.getElementById('reportOverlay');
  const status = document.getElementById('reportStatus');
  const sendBtn = document.getElementById('reportSendBtn');
  document.getElementById('reportCloseBtn').addEventListener('click', closeReportDialog);
  overlay.addEventListener('click', (e) => { if(e.target === overlay) closeReportDialog(); });
  document.addEventListener('keydown', (e) => { if(e.key === 'Escape' && !overlay.hidden) closeReportDialog(); });
  document.getElementById('reportPreviewBtn').addEventListener('click', async () => {
    const pre = document.getElementById('reportPreview');
    pre.textContent = (await loadReportLog()) || '(o registro do app está vazio)';
    pre.hidden = !pre.hidden;
  });
  sendBtn.addEventListener('click', async () => {
    sendBtn.disabled = true;
    status.textContent = 'Enviando…';
    let savedName = '';
    try{ savedName = localStorage.getItem('sinal:lastName') || ''; }catch(e){}
    const payload = {
      description: document.getElementById('reportText').value,
      name: (discordUser && discordUser.name) || savedName,
      appVersion: (window.sinalElectron && window.sinalElectron.appVersion) || '',
      siteVersion: APP_VERSION,
      log: await loadReportLog()
    };
    try{
      const res = await fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if(res.ok){
        status.textContent = 'Enviado, valeu! Vou dar uma olhada.';
        setTimeout(closeReportDialog, 1800);
        return;
      }
      const texts = {
        503: 'O envio de relatórios ainda não foi ligado no servidor.',
        429: 'Muitos envios seguidos — tenta de novo daqui a alguns minutos.',
        413: 'O registro ficou grande demais pra enviar.'
      };
      status.textContent = texts[res.status] || 'Não consegui enviar agora — tenta de novo.';
    }catch(e){
      status.textContent = 'Sem conexão — tenta de novo quando a internet voltar.';
    }
    sendBtn.disabled = false;
  });
}

// Registro do app desktop (v0.3.13+, ver HANDOFF §37) — no navegador não faz nada.
function appLog(message){
  try{ if(window.sinalElectron && window.sinalElectron.log) window.sinalElectron.log(message); }catch(e){ /* nunca atrapalha */ }
}
// "janela 1920x1080@60" / "tela inteira …" — pra saber o que estava sendo
// capturado quando algo deu errado (queda com janela de jogo, 2026-10-02).
function describeCaptureSurface(videoTrack){
  try{
    const st = videoTrack.mediaStreamTrack.getSettings();
    const kind = { monitor: 'tela inteira', window: 'janela', browser: 'aba' }[st.displaySurface] || 'captura';
    return `${kind} ${st.width || '?'}x${st.height || '?'}@${Math.round(st.frameRate || 0)}`;
  }catch(e){ return 'captura'; }
}

// Resolução/fps da captura + dica de conteúdo pra uma qualidade. Só limites
// máximos: a captura é sempre pedida no teto (ver toggleShare), então trocar
// pra uma qualidade maior só afrouxa o limite.
async function applyCaptureQuality(videoTrack, q){
  const preset = SHARE_QUALITY_PRESETS[q];
  const res = preset.resolution;
  await videoTrack.mediaStreamTrack.applyConstraints({
    width: { max: res.width }, height: { max: res.height }, frameRate: { max: res.frameRate }
  }).catch((e) => console.warn('[sinal] não consegui ajustar a captura pra qualidade escolhida:', e));
  videoTrack.mediaStreamTrack.contentHint = preset.contentHint;
}

// Troca a qualidade NO MEIO da transmissão, sem republicar (sem piscar pra
// quem assiste): o codec é o da transmissão em andamento (ver
// canSwitchQualityLive — o Fluido usa outro codec, então não dá pra ENTRAR nele
// ao vivo), então basta ajustar captura e
// limites de envio. Atualiza também as cópias que o LiveKit guarda
// (track.encodings, que ele reaplica quando alguém começa/para de assistir,
// e track.publishOptions, de onde ele recalcula se a fonte for trocada) —
// senão a troca podia ser desfeita sozinha (ver HANDOFF §35).
async function changeActiveShareQuality(q){
  if(!room) return;
  const pub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.ScreenShare);
  const track = pub && pub.videoTrack;
  q = effectiveShareQuality(q);
  if(!track || !activeShareQuality || q === activeShareQuality) return;
  if(!canSwitchQualityLive(activeShareCodec, q, canSendH265())){
    // O Fluido usa outro codec que o da transmissão em andamento: só dá pra começar nele de novo. A escolha
    // já foi salva (vale na próxima transmissão); a atual segue como está.
    setRoomStatus('O Fluido usa outro codec: pare e comece a transmissão de novo pra usar.', true);
    return;
  }
  const preset = SHARE_QUALITY_PRESETS[q];
  const enc = shareEncodingFor(preset, activeShareCodec);

  await applyCaptureQuality(track, q);
  activeShareQuality = q;
  try{
    // Um passo de cada vez: o setDegradationPreference do LiveKit também faz
    // getParameters/setParameters nesse sender — rodando junto, invalidava a
    // leitura daqui ("getParameters() has never been called", achado no teste).
    if(track.sender){
      const applyEnc = async () => {
        const params = track.sender.getParameters();
        (params.encodings || []).forEach((e) => { e.maxBitrate = enc.maxBitrate; e.maxFramerate = enc.maxFramerate; });
        await track.sender.setParameters(params);
      };
      try{ await applyEnc(); }catch(e){ await applyEnc(); } // 1 nova tentativa com leitura fresca
    }
    if(typeof track.setDegradationPreference === 'function'){
      await track.setDegradationPreference(preset.contentHint === 'motion' ? 'maintain-framerate' : 'maintain-resolution');
    }
    (track.encodings || []).forEach((e) => { e.maxBitrate = enc.maxBitrate; e.maxFramerate = enc.maxFramerate; });
    if(track.publishOptions){
      track.publishOptions.screenShareEncoding = { ...enc };
      if(track.publishOptions.backupCodec && typeof track.publishOptions.backupCodec === 'object'){
        track.publishOptions.backupCodec.encoding = { ...preset.vp8 };
      }
    }
  }catch(e){
    console.warn('[sinal] troca de qualidade no meio da transmissão incompleta:', e);
  }
  capBackupCodec(track); // VP8 reserva segue o activeShareQuality novo
  sendStatsPrev = null;
  updateQualityBtn();
  appLog(`[sinal] qualidade trocada no meio da transmissão: ${q}`);
}

// Áudio da transmissão (aba no site / áudio isolado no app) como MÚSICA, não
// voz: o padrão do LiveKit era 48 kbps mono (ele só detecta estéreo sozinho
// no Safari) com DTX ligado — o DTX corta "silêncio", o que pode picotar
// trilha/música em volume baixo. Estéreo a 128 kbps é irrelevante pra VM
// (vídeo é na casa dos Mbps).
function screenAudioPublishOptions(extra){
  return {
    source: LivekitClient.Track.Source.ScreenShareAudio,
    audioPreset: LivekitClient.AudioPresets.musicHighQualityStereo,
    forceStereo: true,
    dtx: false,
    red: false,
    ...extra
  };
}

// Opções de publicação da tela pra uma qualidade: H.265 + reserva VP8 em
// simulcast de codec quando dá, VP8 puro quando não.
function screenPublishOptions(q){
  const { Track, BackupCodecPolicy } = LivekitClient;
  const preset = SHARE_QUALITY_PRESETS[q];
  const opts = {
    source: Track.Source.ScreenShare,
    // Sem simulcast de camadas: a camada baixa padrão do LiveKit pra tela é
    // metade da resolução a ~3fps, e o servidor escolhe camada pela altura
    // do tile com 10% de tolerância — um tile de ~577px de altura já
    // "cabia" na de 540px e recebia essa versão (medido numa call real:
    // 960×540 · 4fps, ver HANDOFF §28). Simulcast de CODEC (abaixo) é outra
    // coisa: mesma resolução, codecs diferentes.
    simulcast: false,
    // Fluido é pra jogo: segura os 60fps e reduz resolução se apertar.
    // Os outros seguram a resolução (texto legível) e reduzem fps.
    degradationPreference: preset.contentHint === 'motion' ? 'maintain-framerate' : 'maintain-resolution'
  };
  const codec = pickShareCodec(q, canSendH265());
  if(codec === 'h264'){
    opts.videoCodec = 'h264';
    opts.screenShareEncoding = preset.h264;
    opts.backupCodec = false; // todo navegador decodifica H.264: não precisa de reserva em VP8
  } else if(codec === 'h265'){
    opts.videoCodec = 'h265';
    opts.screenShareEncoding = preset.h265;
    opts.backupCodec = { codec: 'vp8', encoding: preset.vp8 };
    opts.backupCodecPolicy = BackupCodecPolicy.SIMULCAST;
  } else {
    opts.videoCodec = 'vp8';
    opts.screenShareEncoding = preset.vp8;
  }
  return opts;
}

// App desktop com instalador novo: a qualidade é escolhida no seletor de
// tela (picker.html) e fica no settings.json do Electron. Instalador antigo
// não tem esse campo — aí vale o menu do site, igual no navegador.
function electronPickerChoosesQuality(){
  return !!(window.sinalElectron && window.sinalElectron.isElectron && typeof electronSettings.shareQuality === 'string');
}

// Só existe dentro do app desktop (Electron) — botão fica escondido no site
// normal (ver #audioToggleBtn em style.css). Ligado por padrão: a causa raiz
// do isolamento foi achada e corrigida (HANDOFF §15.11-15.14), testada ao
// vivo numa call real e confirmada pelo grupo em produção — o padrão
// desligado era de quando o filtro ainda não funcionava de verdade, não faz
// mais sentido pedir pra ligar na mão toda vez.
let shareElectronAudio = true;

// Cache local das settings do app desktop (atalho global) — carregadas de
// verdade via IPC em setupSettingsPanel() (assíncrono); valor inicial aqui
// só cobre a janela de corrida entre o app abrir e essa carga terminar,
// com o mesmo padrão do main.js (ver DEFAULT_SETTINGS lá).
let electronSettings = { shortcutEnabled: true, shortcut: 'Control+Alt+S', quickShareWholeScreen: false };

function updateAudioToggleBtn(){
  const btn = document.getElementById('audioToggleBtn');
  if(!btn) return;
  btn.classList.toggle('audio-on', shareElectronAudio);
  if(shareElectronAudio){
    setBtnLabel(btn, 'Áudio: tentando incluir (ainda não isola de verdade — pode vazar a call do Discord ou outros sons do PC, ver HANDOFF). Clique pra desligar.');
  }else{
    setBtnLabel(btn, 'Áudio: desligado (só vídeo). Clique pra tentar incluir mesmo assim — ainda não isola de verdade, pode vazar outros sons.');
  }
}

function toggleElectronAudio(){
  shareElectronAudio = !shareElectronAudio;
  try{ localStorage.setItem('sinal:shareElectronAudio', shareElectronAudio ? '1' : '0'); }catch(e){ /* modo privado etc — sem problema */ }
  updateAudioToggleBtn();
}

// ---------------- CHECKLIST DE FONTES (modo "compartilhar tela inteira", só Electron) ----------------
// Só existe quando compartilhando a TELA INTEIRA (não uma janela específica)
// — main.js manda 'sinal:audio-sources' periodicamente nesse modo, nunca no
// modo janela (que já isola um app só sozinho, ver HANDOFF §15.12/§15.13).
// Construído via createElement/textContent (não innerHTML) porque exeName
// vem do nome de processos do Windows — nada garante que não tenha
// caractere estranho, mesma cautela de renderAvatars()/renderRosterPanel().
function renderAudioSourcesPanel(sources){
  const panel = document.getElementById('audioSourcesPanel');
  const list = document.getElementById('audioSourcesList');
  if(!panel || !list) return;
  list.innerHTML = '';
  if(!sources || sources.length === 0){
    panel.classList.remove('on');
    return;
  }
  panel.classList.add('on');
  sources.forEach((source) => {
    const item = document.createElement('div');
    item.className = 'audio-source-item';
    const checkboxId = 'audioSource_' + source.pid;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = checkboxId;
    checkbox.checked = source.enabled;
    checkbox.addEventListener('change', () => {
      if(window.sinalElectron) window.sinalElectron.toggleAudioSource(source.pid, source.exeName, checkbox.checked);
    });

    const label = document.createElement('label');
    label.setAttribute('for', checkboxId);
    label.textContent = source.exeName;

    item.appendChild(checkbox);
    item.appendChild(label);
    list.appendChild(item);
  });
}

function hideAudioSourcesPanel(){
  const panel = document.getElementById('audioSourcesPanel');
  const list = document.getElementById('audioSourcesList');
  if(panel) panel.classList.remove('on');
  if(list) list.innerHTML = '';
}

// ---------------- ÁUDIO ISOLADO (só dentro do app desktop/Electron) ----------------
// O navegador (e o getDisplayMedia padrão dentro do Electron) só oferece
// "áudio do sistema inteiro" ao compartilhar tela — o que inclui a voz da
// call do Discord, causando eco em quem assiste. Dentro do app desktop, o
// processo principal (main.js) captura áudio isolado por processo via um
// addon nativo (ver HANDOFF §15.2 — WASAPI process-loopback) e manda os
// pedaços de PCM aqui por IPC (window.sinalElectron, exposto pelo
// preload.js). Essa função monta uma MediaStreamTrack de verdade a partir
// desses pedaços, pra publicar como uma track de áudio extra no LiveKit.
//
// Só existe dentro do Electron — no site normal (navegador), toggleShare()
// nem chama isso, window.sinalElectron simplesmente não existe.
let electronAudioCtx = null; // guardado pra fechar quando parar de compartilhar

function createElectronIsolatedAudioTrack(){
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  const destination = audioCtx.createMediaStreamDestination();

  // ScriptProcessorNode é oficialmente descontinuado (substituído por
  // AudioWorkletNode), mas continua funcionando em todo Chromium/Electron
  // atual — escolhido de propósito aqui por não precisar de um arquivo de
  // worklet separado (que precisaria ser publicado em public/ e carregado
  // via audioWorklet.addModule). Roda na thread principal, não numa thread
  // de áudio dedicada — pra esse uso (áudio suplementar, não a voz
  // principal da call, que continua 100% pelo Discord) é aceitável; se um
  // dia der problema de qualidade perceptível, migrar pra AudioWorkletNode
  // é o caminho.
  //
  // 2 canais de ENTRADA (não 0) de propósito, mesmo sem usar o inputBuffer:
  // testado que um ScriptProcessorNode com 0 canais de entrada declarados
  // não é "puxado" de verdade pelo motor de áudio do Chromium, mesmo com
  // uma fonte conectada (ver electron/test/test-pcm-to-track.html).
  // 2048 frames (~43ms) em vez de 4096 (~85ms): corta metade da latência
  // fixa desse bloco. Contrapartida: roda na thread principal, então um
  // engasgo maior que ~43ms dela vira um estalo audível — se isso aparecer
  // com frequência, volta pra 4096 (e sobe TARGET_QUEUED_FRAMES junto).
  const processor = audioCtx.createScriptProcessor(2048, 2, 2);
  // Uma fila por PID de origem — no modo "compartilhar tela inteira" pode
  // ter várias fontes simultâneas (ver HANDOFF §15.13), cada uma mandando
  // seus próprios pedaços de PCM; a mistura acontece aqui, somando amostra
  // por amostra de cada fila ativa no momento de montar o buffer de saída.
  // No modo "compartilhar uma janela" é só uma fila mesmo (um PID só) — o
  // mesmo código atende os dois casos sem precisar de branch.
  //
  // Limite de fila: a reprodução consome exatamente em tempo real, então
  // qualquer sobra acumulada (engasgo da thread principal, IPC chegando em
  // rajada) nunca é recuperada sozinha — vira atraso permanente. O limite
  // antigo era 2s (e zerava tudo quando estourava), o que dava exatamente o
  // sintoma relatado: áudio atrasando cada vez mais, normalizando de repente
  // e recomeçando o ciclo. Agora, passou de ~250ms, corta só o excesso mais
  // antigo de volta pra ~100ms — atraso sempre limitado, ao custo de um
  // pulinho curto de vez em quando. O alvo precisa ficar acima do tamanho do
  // bloco do processor (2048), senão o próximo bloco depois de um corte sai
  // incompleto.
  const TARGET_QUEUED_FRAMES = 4800;  // ~100ms
  const MAX_QUEUED_FRAMES = 12000;    // ~250ms
  const sources = new Map(); // pid -> { queue: [{left,right}], readIndex, queuedFrames }

  function sourceState(pid){
    let s = sources.get(pid);
    if(!s){ s = { queue: [], readIndex: 0, queuedFrames: 0 }; sources.set(pid, s); }
    return s;
  }

  function trimToTarget(s){
    let excess = s.queuedFrames - TARGET_QUEUED_FRAMES;
    while(excess > 0 && s.queue.length){
      const remainingInChunk = s.queue[0].left.length - s.readIndex;
      if(remainingInChunk <= excess){
        s.queue.shift();
        s.readIndex = 0;
        s.queuedFrames -= remainingInChunk;
        excess -= remainingInChunk;
      }else{
        s.readIndex += excess;
        s.queuedFrames -= excess;
        excess = 0;
      }
    }
  }

  processor.onaudioprocess = (event) => {
    const left = event.outputBuffer.getChannelData(0);
    const right = event.outputBuffer.getChannelData(1);
    for(let i = 0; i < left.length; i++){
      let l = 0, r = 0;
      for(const s of sources.values()){
        if(s.queue.length === 0) continue;
        const chunk = s.queue[0];
        l += chunk.left[s.readIndex];
        r += chunk.right[s.readIndex];
        s.readIndex++;
        s.queuedFrames--;
        if(s.readIndex >= chunk.left.length){ s.queue.shift(); s.readIndex = 0; }
      }
      // Somar N fontes pode passar de ±1.0 — clampa em vez de deixar
      // estourar (distorção feia) ou normalizar (mudaria o volume toda
      // hora que uma fonte entra/sai, pior ainda).
      left[i] = Math.max(-1, Math.min(1, l));
      right[i] = Math.max(-1, Math.min(1, r));
    }
  };

  processor.connect(destination);
  // "Motor" mudo pra garantir que o processor seja puxado de verdade (ver
  // comentário acima sobre canais de entrada) — não produz som nenhum
  // (offset 0), só mantém o nó ativo no grafo.
  const silentSource = audioCtx.createConstantSource();
  silentSource.offset.value = 0;
  silentSource.connect(processor);
  silentSource.start();

  // window.sinalElectron.onAudioChunk: buf chega como Uint8Array de PCM
  // 16-bit LE intercalado estéreo, 48kHz — mesmo formato fixo que o addon
  // nativo sempre usa. `pid` identifica de qual fonte veio.
  window.sinalElectron.onAudioChunk((pid, buf) => {
    const s = sourceState(pid);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const frameCount = Math.floor(buf.length / 4); // 4 bytes por frame (2 canais × 16 bits)
    const left = new Float32Array(frameCount);
    const right = new Float32Array(frameCount);
    for(let i = 0; i < frameCount; i++){
      left[i] = view.getInt16(i * 4, true) / 32768;
      right[i] = view.getInt16(i * 4 + 2, true) / 32768;
    }
    s.queue.push({ left, right });
    s.queuedFrames += frameCount;
    // por fonte — as outras fontes não são afetadas
    if(s.queuedFrames > MAX_QUEUED_FRAMES) trimToTarget(s);
  });

  // Fonte parou de vez (app fechou, ver scanAudioSources em main.js) — some
  // com a fila dela em vez de deixar um resquício mudo pra sempre no Map.
  window.sinalElectron.onAudioSourceRemoved((pid) => {
    sources.delete(pid);
  });

  // Checklist de apps detectados (só chega evento aqui no modo "tela
  // inteira" — ver scanAudioSources em main.js; no modo janela nunca
  // dispara, o painel fica escondido o tempo todo).
  window.sinalElectron.onAudioSources(renderAudioSourcesPanel);

  electronAudioCtx = audioCtx;
  return destination.stream.getAudioTracks()[0];
}

function teardownElectronIsolatedAudio(){
  if(window.sinalElectron) window.sinalElectron.stopIsolatedAudio();
  hideAudioSourcesPanel();
  if(electronAudioCtx){
    electronAudioCtx.close().catch(() => {});
    electronAudioCtx = null;
  }
}

async function toggleShare(){
  if(!room) return;
  const { Track } = LivekitClient;
  const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  if(pub){
    // setScreenShareEnabled(false) só MUTA a track (ela continua publicada,
    // com o mesmo trackSid) — confirmado em log real (2026-08-24): isso
    // deixava getTrackPublication() sempre "verdadeiro", então o próximo
    // clique caía de novo aqui (desligar já-mutado) em vez de religar, e a
    // tela ficava "presa" aberta pros outros (nunca disparava
    // TrackUnsubscribed pra sumir o tile deles). unpublishTrack desliga de
    // verdade.
    const audioPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
    selfInitiatedUnpublish = true;
    try{
      if(pub.videoTrack) await room.localParticipant.unpublishTrack(pub.videoTrack);
      if(audioPub && audioPub.audioTrack) await room.localParticipant.unpublishTrack(audioPub.audioTrack);
    }catch(e){
      console.error('[sinal] unpublish da tela falhou:', e);
      setRoomStatus('Erro ao desligar a tela: ' + (e && e.message || e), true);
    }finally{
      selfInitiatedUnpublish = false;
    }
    if(window.sinalElectron) teardownElectronIsolatedAudio();
    resetShareButton();
    return;
  }
  // Captura e publicação separadas (antes era setScreenShareEnabled, que faz
  // as duas juntas): no app desktop a qualidade é escolhida no seletor de
  // tela, que só abre DEPOIS do pedido de captura — então captura no teto
  // possível, pergunta ao app o que foi escolhido, ajusta a track e só aí
  // publica. No site a escolha já veio do menu, antes do clique.
  const pickerChooses = electronPickerChoosesQuality();
  let quality = effectiveShareQuality(shareQuality);
  // Captura SEMPRE no teto possível (1080p60 com H.265, 1080p30 sem) e
  // reduz logo abaixo pra qualidade escolhida: só assim dá pra SUBIR de
  // qualidade no meio da transmissão depois (pedir mais do que foi
  // capturado no começo pode não funcionar). A redução é imediata, não
  // custa nada a mais.
  const capturePreset = SHARE_QUALITY_PRESETS[effectiveShareQuality('fluido')];
  let localTracks;
  try{
    localTracks = await room.localParticipant.createScreenTracks({
      audio: true, // só disponibiliza a opção; o navegador pergunta de verdade no seletor nativo
      resolution: capturePreset.resolution,
      // Mostra o botão nativo "Compartilhar esta guia" quando a pessoa troca
      // de aba durante o compartilhamento — dá pra trocar a fonte sem parar
      // e recomeçar. Chrome não garante isso por padrão (pode mudar com o
      // tempo), por isso precisa pedir de propósito.
      surfaceSwitching: 'include'
    });
  }catch(e){
    setRoomStatus('Permissão de tela negada ou cancelada.', true);
    return;
  }
  const videoTrack = localTracks.find((t) => t.kind === 'video');
  const tabAudioTrack = localTracks.find((t) => t.kind === 'audio');
  if(pickerChooses){
    try{
      const settings = await window.sinalElectron.getSettings();
      electronSettings = settings;
      quality = effectiveShareQuality(settings.shareQuality);
    }catch(e){ /* fica com o padrão */ }
  }
  await applyCaptureQuality(videoTrack, quality);
  activeShareQuality = quality;
  const publishOpts = screenPublishOptions(quality);
  activeShareCodec = publishOpts.videoCodec;
  try{
    await room.localParticipant.publishTrack(videoTrack, publishOpts);
    if(tabAudioTrack){
      await room.localParticipant.publishTrack(tabAudioTrack, screenAudioPublishOptions());
    }
  }catch(e){
    console.error('[sinal] publicar a tela falhou:', e);
    localTracks.forEach((t) => t.stop());
    setRoomStatus('Não consegui transmitir a tela: ' + (e && e.message || e), true);
    return;
  }

  const btn = document.getElementById('shareBtn');
  setBtnLabel(btn, 'Parar compartilhamento');
  btn.classList.add('active-share');
  appLog(`[sinal] transmissão iniciada: ${activeShareQuality} · ${activeShareCodec} · ${describeCaptureSurface(videoTrack)}`);
  // Botão de qualidade fica ativo: dá pra trocar no meio (changeActiveShareQuality).
  // body.sharing: no app, o botão (escondido fora da transmissão, já que lá
  // a escolha é no seletor) aparece enquanto transmite.
  document.body.classList.add('sharing');
  toggleQualityMenu(false);
  updateQualityBtn();
  document.getElementById('audioToggleBtn').disabled = true; // idem — decide no começo, não muda no meio

  // A captura já começou de verdade neste ponto. Se a publicação ainda não
  // estiver registrada (ou tiver sido interrompida no meio), sem essa guarda
  // isso estourava um TypeError DEPOIS da tela já estar sendo compartilhada:
  // a transmissão acontecia, mas a interface local não se atualizava — sem
  // preview, botão sem estado de "transmitindo". Confuso de diagnosticar.
  const screenPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  if(!screenPub || !screenPub.videoTrack){
    setRoomStatus('A captura começou mas a publicação falhou. Pare e tente de novo.', true);
    resetShareButton();
    return;
  }
  const selfStream = new MediaStream([screenPub.videoTrack.mediaStreamTrack]);
  const preview = document.getElementById('selfPreview');
  preview.srcObject = selfStream;
  preview.style.display = 'block';
  document.getElementById('selfStatus').textContent = 'Transmitindo';

  // Dentro do app desktop, publica o áudio isolado por processo (ver
  // HANDOFF §15.2) como uma track separada — resolve o eco/vazamento da
  // call do Discord que o navegador não tem como evitar. Não trava o
  // compartilhamento se isso falhar (ex: addon nativo não carregou): a
  // tela já está funcionando nesse ponto, só fica sem esse áudio extra.
  if(window.sinalElectron && window.sinalElectron.isElectron && shareElectronAudio){
    try{
      const audioTrack = createElectronIsolatedAudioTrack();
      await room.localParticipant.publishTrack(audioTrack, screenAudioPublishOptions({ name: 'sinal-isolated-audio' }));
    }catch(e){
      console.error('[sinal] publicar áudio isolado falhou (segue só com vídeo):', e);
    }
  }

  addTile(room.localParticipant.identity, myName + ' (você)', selfStream);
  const selfTile = tiles.get(room.localParticipant.identity);
  const selfTileVideo = selfTile && selfTile.querySelector('video');
  if(selfTileVideo) selfTileVideo.muted = true;
  renderAvatars();
}

function resetShareButton(){
  const btn = document.getElementById('shareBtn');
  setBtnLabel(btn, 'Compartilhar minha tela');
  btn.classList.remove('active-share');
  document.getElementById('qualityBtn').disabled = false;
  document.getElementById('audioToggleBtn').disabled = false;
  document.getElementById('selfPreview').style.display = 'none';
  document.getElementById('selfStatus').textContent = 'Assistindo';
  if(activeShareQuality) appLog('[sinal] transmissão encerrada');
  sendStatsPrev = null;
  activeShareQuality = null;
  activeShareCodec = null;
  document.body.classList.remove('sharing');
  toggleQualityMenu(false);
  updateQualityBtn();
  if(room) removeTile(room.localParticipant.identity);
  renderAvatars();
}

async function toggleCamera(){
  if(!room) return;
  const { Track } = LivekitClient;
  const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
  if(pub){
    // Mesmo motivo do toggleShare acima: setCameraEnabled(false) só muta,
    // não desliga de verdade. unpublishTrack desliga de verdade.
    selfInitiatedUnpublish = true;
    try{
      if(pub.videoTrack) await room.localParticipant.unpublishTrack(pub.videoTrack);
    }catch(e){
      console.error('[sinal] unpublish da câmera falhou:', e);
      setRoomStatus('Erro ao desligar a câmera: ' + (e && e.message || e), true);
    }finally{
      selfInitiatedUnpublish = false;
    }
    resetCameraButton();
    return;
  }
  try{
    await room.localParticipant.setCameraEnabled(true); // sem áudio — a voz já vai 100% pelo Discord
  }catch(e){
    setRoomStatus('Permissão de câmera negada ou cancelada.', true);
    return;
  }
  const btn = document.getElementById('cameraBtn');
  setBtnLabel(btn, 'Desligar câmera');
  btn.classList.add('active-share');

  // Mesma guarda do toggleShare() — ver o comentário lá.
  const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
  if(!camPub || !camPub.videoTrack){
    setRoomStatus('A câmera ligou mas a publicação falhou. Desligue e tente de novo.', true);
    resetCameraButton();
    return;
  }
  const camStream = new MediaStream([camPub.videoTrack.mediaStreamTrack]);
  addTile(room.localParticipant.identity + ':cam', myName + ' (câmera)', camStream);
  renderAvatars();
}

function resetCameraButton(){
  const btn = document.getElementById('cameraBtn');
  setBtnLabel(btn, 'Ligar câmera');
  btn.classList.remove('active-share');
  if(room) removeTile(room.localParticipant.identity + ':cam');
  renderAvatars();
}

// ---------------- QUALIDADE DE CONEXÃO ----------------
// A cor da bolinha vem do indicador nativo do LiveKit (ConnectionQualityChanged)
// — o servidor já calcula isso de sobra a partir de perda/latência/jitter,
// mais simples e confiável que medir na unha. O texto do tooltip é
// enriquecido à parte com números reais (perda %, jitter em ms), via
// track.getRTCStatsReport() amostrado periodicamente — só cosmético, não
// influencia a cor nem nada do envio/recebimento.
const qualityBaseLabel = new Map(); // tileId -> "Boa conexão" etc (do evento nativo)
const qualityDetails = new Map();   // tileId -> "perda: 0.5% · jitter: 12ms" (amostrado)

function renderQualityTooltip(tileId){
  const tile = tiles.get(tileId);
  const dot = tile && tile.querySelector('.quality-dot');
  if(!dot) return;
  const base = qualityBaseLabel.get(tileId) || 'Medindo conexão...';
  const detail = qualityDetails.get(tileId);
  dot.title = detail ? `${base} · ${detail}` : base;
}

// Qualidade é por participante, não por track — atualiza os dois tiles
// possíveis (tela e câmera) da mesma pessoa juntos.
function updateQualityDot(identity, quality){
  const { ConnectionQuality } = LivekitClient;
  // Unknown = servidor ainda não mandou dado nenhum — não afirma "boa" à
  // toa (antes caía no padrão verde, igual Lost, que é o oposto).
  let level = '', label = 'Medindo conexão...';
  if(quality === ConnectionQuality.Excellent){ level = 'good'; label = 'Boa conexão'; }
  else if(quality === ConnectionQuality.Good){ level = 'warn'; label = 'Conexão razoável'; }
  else if(quality === ConnectionQuality.Poor){ level = 'bad'; label = 'Conexão ruim'; }
  else if(quality === ConnectionQuality.Lost){ level = 'bad'; label = 'Conexão perdida'; }
  [identity, identity + ':cam'].forEach((tileId) => {
    const tile = tiles.get(tileId);
    const dot = tile && tile.querySelector('.quality-dot');
    if(dot) dot.className = 'quality-dot' + (level ? ' ' + level : '');
    qualityBaseLabel.set(tileId, label);
    renderQualityTooltip(tileId);
  });
}

// Extrai perda de pacote (delta desde a última amostra, não acumulado — um
// valor acumulado desde o início da chamada fica cada vez menos
// representativo do estado ATUAL) e jitter do inbound-rtp de vídeo.
const qualityStatsPrev = new Map(); // tileId -> { lost, received } acumulados na última amostra

// Selo "1080p60" / "720p" no rótulo do tile — do que está chegando (ou
// saindo, no próprio tile) DE VERDADE, pelas estatísticas: se a rede ou o PC
// de quem compartilha baixar a qualidade, o selo mostra isso.
function qualityBadgeText(height, fps){
  if(!height) return '';
  const res = height >= 1000 ? '1080p' : height >= 700 ? '720p' : `${height}p`;
  return fps >= 45 ? `${res}60` : res;
}
function renderQualityBadge(tileId, text){
  const tile = tiles.get(tileId);
  const label = tile && tile.querySelector('.label');
  if(!label) return;
  let badge = label.querySelector('.res-badge');
  if(!text){ if(badge) badge.remove(); return; }
  if(!badge){
    badge = document.createElement('span');
    badge.className = 'res-badge mono';
    // antes da bolinha de qualidade/envio, depois do nome
    const anchor = label.querySelector('.quality-dot, .send-dot, .viewers');
    label.insertBefore(badge, anchor);
  }
  badge.textContent = text;
  badge.classList.toggle('fps60', text.endsWith('60'));
}

// "video/H265" -> "H.265" (pros tooltips de quem envia e de quem assiste)
function codecLabel(report, codecId){
  let mime = '';
  report.forEach((stat) => { if(stat.type === 'codec' && stat.id === codecId) mime = stat.mimeType || ''; });
  const name = mime.split('/')[1] || '';
  return ({ H265: 'H.265', H264: 'H.264', VP8: 'VP8', VP9: 'VP9', AV1: 'AV1' })[name.toUpperCase()] || name;
}

async function sampleTileDetailedStats(tileId, track){
  if(!track || typeof track.getRTCStatsReport !== 'function') return;
  let report;
  try{ report = await track.getRTCStatsReport(); }catch(e){ return; }
  if(!report) return;
  let inbound = null;
  report.forEach((stat) => {
    if(stat.type === 'inbound-rtp' && stat.kind === 'video') inbound = stat;
  });
  if(!inbound) return;

  const prev = qualityStatsPrev.get(tileId) || { lost: 0, received: 0, bytes: null, ts: null };
  const deltaLost = Math.max(0, (inbound.packetsLost || 0) - prev.lost);
  const deltaReceived = Math.max(0, (inbound.packetsReceived || 0) - prev.received);
  qualityStatsPrev.set(tileId, {
    lost: inbound.packetsLost || 0,
    received: inbound.packetsReceived || 0,
    bytes: inbound.bytesReceived || 0,
    ts: inbound.timestamp
  });

  const total = deltaLost + deltaReceived;
  const lossPct = total > 0 ? (deltaLost / total) * 100 : 0;
  // jitter do WebRTC vem em segundos, por padrão — convertendo pra ms, que é
  // a unidade que faz sentido mostrar pra gente.
  const jitterMs = inbound.jitter != null ? Math.round(inbound.jitter * 1000) : null;

  // Resolução/fps/taxa que chegam de verdade — diagnóstico pra vídeo
  // "farinhado" (ver HANDOFF §28): 960×540 a ~3fps = camada baixa do
  // simulcast; 1920×1080 com kbps baixo = banda/servidor; resolução menor
  // com fps normal = o PC de quem compartilha reduzindo sozinho (CPU/upload).
  const parts = [];
  const inCodec = codecLabel(report, inbound.codecId);
  if(inCodec) parts.push(inCodec);
  if(inbound.frameWidth && inbound.frameHeight) parts.push(`${inbound.frameWidth}×${inbound.frameHeight}`);
  if(inbound.framesPerSecond != null) parts.push(`${Math.round(inbound.framesPerSecond)}fps`);
  if(prev.bytes != null && prev.ts != null && inbound.timestamp > prev.ts){
    // bytes → bits, dividido por ms = kbit/s
    const kbps = Math.round(((inbound.bytesReceived || 0) - prev.bytes) * 8 / (inbound.timestamp - prev.ts));
    parts.push(`${kbps} kbps`);
  }
  parts.push(`perda: ${lossPct.toFixed(1)}%`);
  renderQualityBadge(tileId, qualityBadgeText(inbound.frameHeight, inbound.framesPerSecond));
  if(jitterMs != null) parts.push(`jitter: ${jitterMs}ms`);
  qualityDetails.set(tileId, parts.join(' · '));
  renderQualityTooltip(tileId);
}

// Lado de quem compartilha: o navegador reduz resolução/fps/qualidade
// sozinho quando a CPU não dá conta de codificar ou o upload não aguenta,
// sem avisar ninguém — qualityLimitationReason (outbound-rtp) diz se tá
// fazendo isso e por quê. Com simulcast desligado na tela (ver HANDOFF §28),
// esse passou a ser o gargalo que sobra pra imagem ruim.
let sendStatsPrev = null; // { bytes, ts } da última amostra, pra calcular kbps

const SEND_LIMIT_TEXT = {
  cpu: { full: 'CPU do seu PC sobrecarregada', short: 'limitado pela CPU' },
  bandwidth: { full: 'upload insuficiente', short: 'limitado pelo upload' },
  other: { full: 'motivo não identificado', short: 'qualidade reduzida' }
};

// O LiveKit (2.22.3) ignora a configuração própria do codec reserva quando
// a fonte é tela: o VP8 de reserva sai com o mesmo teto do principal (medido:
// Fluido mandava VP8 a 60fps/6 Mbps — pesado pra CPU de quem compartilha,
// só pra atender quem não decodifica H.265). Corrige por fora, na mesma
// checagem de 4s das estatísticas: assim que o sender da reserva existe,
// aplica o teto do preset (`vp8` em SHARE_QUALITY_PRESETS).
async function capBackupCodec(track){
  if(!activeShareQuality || !track || !track.simulcastCodecs) return;
  const want = SHARE_QUALITY_PRESETS[activeShareQuality].vp8;
  for(const info of track.simulcastCodecs.values()){
    if(info.codec !== 'vp8' || !info.sender) continue;
    // o LiveKit reaplica essas encodings quando alguém começa/para de precisar da reserva
    (info.encodings || []).forEach((e) => { e.maxBitrate = want.maxBitrate; e.maxFramerate = want.maxFramerate; });
    const params = info.sender.getParameters();
    if(!params.encodings || !params.encodings.length) continue;
    if(params.encodings.every((e) => e.maxBitrate === want.maxBitrate && e.maxFramerate === want.maxFramerate)) continue;
    params.encodings.forEach((e) => { e.maxBitrate = want.maxBitrate; e.maxFramerate = want.maxFramerate; });
    await info.sender.setParameters(params).catch((e) => console.warn('[sinal] não consegui limitar o VP8 de reserva:', e));
  }
}

async function sampleOwnScreenStats(){
  if(!room) return;
  const { Track } = LivekitClient;
  const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  const track = pub && pub.videoTrack;
  if(!track || typeof track.getRTCStatsReport !== 'function'){ sendStatsPrev = null; return; }
  capBackupCodec(track);
  let report;
  try{ report = await track.getRTCStatsReport(); }catch(e){ return; }
  // parou de compartilhar enquanto esperava as estatísticas — não sobrescreve
  // o "Assistindo" que resetShareButton() acabou de colocar
  if(!room || room.localParticipant.getTrackPublication(Track.Source.ScreenShare) !== pub || !report) return;

  let outbound = null;
  report.forEach((stat) => {
    if(stat.type === 'outbound-rtp' && stat.kind === 'video'
      && (!outbound || (stat.bytesSent || 0) > (outbound.bytesSent || 0))) outbound = stat;
  });
  if(!outbound) return;

  const parts = [];
  if(activeShareQuality) parts.push(SHARE_QUALITY_PRESETS[activeShareQuality].name);
  // Codec que está saindo DE VERDADE — se o H.265 falhar e o navegador cair
  // pro VP8, aparece aqui.
  const outCodec = codecLabel(report, outbound.codecId);
  if(outCodec) parts.push(outCodec);
  if(outbound.frameWidth && outbound.frameHeight) parts.push(`${outbound.frameWidth}×${outbound.frameHeight}`);
  if(outbound.framesPerSecond != null) parts.push(`${Math.round(outbound.framesPerSecond)}fps`);
  if(sendStatsPrev && outbound.timestamp > sendStatsPrev.ts){
    const kbps = Math.round(((outbound.bytesSent || 0) - sendStatsPrev.bytes) * 8 / (outbound.timestamp - sendStatsPrev.ts));
    parts.push(`${kbps} kbps`);
  }
  sendStatsPrev = { bytes: outbound.bytesSent || 0, ts: outbound.timestamp };

  const reason = outbound.qualityLimitationReason;
  const limit = reason && reason !== 'none' ? (SEND_LIMIT_TEXT[reason] || SEND_LIMIT_TEXT.other) : null;

  renderQualityBadge(room.localParticipant.identity, qualityBadgeText(outbound.frameHeight, outbound.framesPerSecond));
  const tile = tiles.get(room.localParticipant.identity);
  const dot = tile && tile.querySelector('.send-dot');
  if(dot){
    dot.className = 'send-dot ' + (limit ? 'warn' : 'good');
    dot.title = `Enviando: ${parts.join(' · ')}` + (limit ? ` · reduzindo qualidade: ${limit.full}` : ' · sem redução de qualidade');
  }
  document.getElementById('selfStatus').textContent = 'Transmitindo' + (limit ? ` · ${limit.short}` : '');
}

setInterval(() => {
  tileVideoTracks.forEach((track, tileId) => sampleTileDetailedStats(tileId, track));
  sampleOwnScreenStats();
}, 4000);

// ---------------- UI: palco (destaque) + fileira (minimizados) ----------------
let tiles = new Map();     // id -> elemento .tile
let pinnedOrder = [];      // ids em destaque, no máximo 2, ordem de fixação

const ICON_VOLUME = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3,9 3,15 8,15 13,20 13,4 8,9"></polygon><path d="M16 8a5 5 0 010 8"></path></svg>';
const ICON_VOLUME_MUTED = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3,9 3,15 8,15 13,20 13,4 8,9"></polygon><line x1="16" y1="9" x2="22" y2="15"></line><line x1="22" y1="9" x2="16" y2="15"></line></svg>';
const ICON_EYE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0112 19c-7 0-11-7-11-7a21.86 21.86 0 015.06-6.06M9.9 4.24A10.94 10.94 0 0112 4c7 0 11 7 11 7a21.82 21.82 0 01-2.16 3.19M14.12 14.12a3 3 0 11-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
const ICON_KICK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="18" y1="8" x2="23" y2="13"></line><line x1="23" y1="8" x2="18" y2="13"></line></svg>';
const ICON_DOTS = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="12" cy="5" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="12" cy="19" r="1.8"></circle></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
const ICON_PIP = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor"></rect></svg>';
const ICON_EYE_SMALL = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>';

// ---------------- Quem está assistindo (👁 N no rótulo do tile) ----------------
// O servidor do LiveKit não conta pra ninguém quem se inscreveu em qual
// track, então cada um avisa a sala pelo canal de dados (mesmo do chat)
// quando começa/para de assistir. Todo mundo vê a contagem de toda
// transmissão (decisão do usuário, igual ao Discord), sem aviso sonoro.
// Quem assiste é sempre o `participant` que o LiveKit diz que mandou a
// mensagem — nunca um campo do payload — então ninguém se passa por outro.
const tileViewers = new Map(); // tileId -> Map(identity -> nome), quem tá assistindo aquela transmissão
const myWatching = new Set();  // tileIds remotos que EU tô assistindo agora

function ownerOfTile(tileId){ return tileId.endsWith(':cam') ? tileId.slice(0, -4) : tileId; }

// Só aceita alvo que é uma pessoa que existe na sala — mensagem de cliente
// modificado não consegue encher o Map com lixo.
function isKnownTile(tileId){
  if(!room || typeof tileId !== 'string' || tileId.length > 300) return false;
  const owner = ownerOfTile(tileId);
  return owner === room.localParticipant.identity || room.remoteParticipants.has(owner);
}

function setViewer(tileId, identity, name, on){
  let viewers = tileViewers.get(tileId);
  if(on){
    if(!viewers){ viewers = new Map(); tileViewers.set(tileId, viewers); }
    viewers.set(identity, name);
  } else if(viewers){
    viewers.delete(identity);
    if(viewers.size === 0) tileViewers.delete(tileId);
  }
  renderViewers(tileId);
}

function clearViewers(tileId){
  if(tileViewers.delete(tileId)) renderViewers(tileId);
}

function forgetViewer(identity){
  tileViewers.forEach((viewers, tileId) => {
    if(!viewers.delete(identity)) return;
    if(viewers.size === 0) tileViewers.delete(tileId);
    renderViewers(tileId);
  });
}

function renderViewers(tileId){
  const tile = tiles.get(tileId);
  const label = tile && tile.querySelector('.label');
  if(!label) return;
  let el = label.querySelector('.viewers');
  const viewers = tileViewers.get(tileId);
  if(!viewers || viewers.size === 0){
    if(el) el.remove();
    return;
  }
  if(!el){
    el = document.createElement('span');
    el.className = 'viewers';
    label.appendChild(el);
  }
  el.innerHTML = ICON_EYE_SMALL + '<span></span>';
  el.lastChild.textContent = String(viewers.size);
  el.title = 'Assistindo: ' + [...viewers.values()].join(', ');
}

function publishWatch(msg, destinationIdentities){
  if(!room || !room.localParticipant) return;
  const opts = { reliable: true, topic: 'watch' };
  if(destinationIdentities) opts.destinationIdentities = destinationIdentities;
  Promise.resolve(room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(msg)), opts))
    .catch((e) => console.warn('[sinal] aviso de "assistindo" não foi enviado:', e));
}

// Estado completo (e não só o último evento): quem recebe apaga o que sabia
// de mim e fica com essa lista — serve tanto pra quem acabou de entrar
// quanto pra reconciliar depois de uma reconexão.
function sendWatchSync(destinationIdentities){
  if(destinationIdentities && myWatching.size === 0) return; // quem chegou agora já parte do zero
  publishWatch({ type: 'watch-sync', targets: [...myWatching] }, destinationIdentities);
}

function setWatching(tileId, on){
  if(!room || on === myWatching.has(tileId)) return;
  if(on) myWatching.add(tileId); else myWatching.delete(tileId);
  setViewer(tileId, room.localParticipant.identity, 'Você', on);
  publishWatch({ type: 'watch', target: tileId, on });
}

function handleWatchMessage(msg, participant){
  const identity = participant.identity;
  const name = participant.name || identity;
  const valid = (t) => isKnownTile(t) && ownerOfTile(t) !== identity; // ninguém "assiste" a si mesmo
  if(msg.type === 'watch'){
    if(valid(msg.target)) setViewer(msg.target, identity, name, !!msg.on);
    return;
  }
  if(!Array.isArray(msg.targets)) return;
  forgetViewer(identity);
  msg.targets.slice(0, 20).forEach((t) => { if(valid(t)) setViewer(t, identity, name, true); });
}

// ---------------- "Clique pra assistir" (igual ao Discord — ver HANDOFF) ----------------
// Com autoSubscribe:false, uma transmissão publicada não chega sozinha pra
// mais ninguém — mostra esse card no lugar até a pessoa clicar. Reaproveita
// a mesma grade (spotlight/filmstrip) e o mesmo Map `tiles` que os tiles ao
// vivo usam, só com outro conteúdo/clique.
function addPendingTile(tileId, participant, isCamera){
  if(tiles.has(tileId)) return; // já existe (pendente ou ao vivo) — não duplica
  if(room && participant === room.localParticipant) return; // nunca pendente pra si mesmo
  const displayName = participant.name || participant.identity;
  const label = isCamera ? displayName + ' (câmera)' : displayName;

  const tile = document.createElement('div');
  tile.className = 'tile pending-tile';
  tile.dataset.id = tileId;
  tile.innerHTML = `
    <div class="pending-watch">
      ${ICON_PLAY}
      <span class="pending-hint mono">Clique pra assistir</span>
    </div>
    <div class="label"><span class="led"></span>${escapeHtml(label)}</div>
  `;
  tile.addEventListener('click', () => watchTile(tileId, isCamera));
  tiles.set(tileId, tile);

  if(pinnedOrder.length === 0){
    pinnedOrder.push(tileId);
    tile.classList.add('pinned');
    document.getElementById('spotlightGrid').appendChild(tile);
  } else {
    tile.classList.add('minimized');
    document.getElementById('filmstrip').appendChild(tile);
  }
  updateStageVisibility();
  renderViewers(tileId);
}

// Inscreve na(s) publicação(ões) daquela fonte — vídeo e, se existir, o
// áudio junto (ScreenShareAudio é uma publicação separada do vídeo da
// tela). TrackSubscribed dispara em seguida e handleTrackAdded troca o card
// pendente pelo tile ao vivo de verdade (addTile já remove o que existir
// nesse id antes de criar o novo).
function watchTile(tileId, isCamera){
  if(!room) return;
  const { Track } = LivekitClient;
  const identity = isCamera ? tileId.slice(0, -4) : tileId;
  const participant = room.remoteParticipants.get(identity);
  if(!participant) return;
  const videoPub = participant.getTrackPublication(isCamera ? Track.Source.Camera : Track.Source.ScreenShare);
  if(videoPub && !videoPub.isSubscribed) videoPub.setSubscribed(true);
  if(!isCamera){
    const audioPub = participant.getTrackPublication(Track.Source.ScreenShareAudio);
    if(audioPub && !audioPub.isSubscribed) audioPub.setSubscribed(true);
  }
}

// "Parar de assistir" — desinscreve de verdade (não só esconde/pausa
// localmente), economizando banda e decodificação de quem não quer mais ver
// aquela transmissão. handleTrackRemoved (disparado por TrackUnsubscribed)
// cuida de voltar pro card "clique pra assistir" já que a pessoa
// provavelmente continua compartilhando, só paramos de olhar.
function stopWatchingTile(tileId, isCamera){
  if(!room) return;
  const { Track } = LivekitClient;
  const identity = isCamera ? tileId.slice(0, -4) : tileId;
  const participant = room.remoteParticipants.get(identity);
  if(!participant) return;
  const videoPub = participant.getTrackPublication(isCamera ? Track.Source.Camera : Track.Source.ScreenShare);
  if(videoPub && videoPub.isSubscribed) videoPub.setSubscribed(false);
  if(!isCamera){
    const audioPub = participant.getTrackPublication(Track.Source.ScreenShareAudio);
    if(audioPub && audioPub.isSubscribed) audioPub.setSubscribed(false);
  }
}

function addTile(id, name, stream){
  removeTile(id);
  const isSelf = !!(room && room.localParticipant && (id === room.localParticipant.identity || id === room.localParticipant.identity + ':cam'));
  const isCamera = id.endsWith(':cam');
  const ownerIdentity = id.endsWith(':cam') ? id.slice(0, -4) : id;
  const owner = room && (ownerIdentity === room.localParticipant.identity ? room.localParticipant : room.remoteParticipants.get(ownerIdentity));
  const crown = owner && participantIsAdmin(owner) ? '<span class="admin-crown" title="Admin da sala">👑</span>' : '';
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.id = id;
  tile.innerHTML = `
    <video autoplay playsinline></video>
    <div class="tile-hidden-overlay"><span class="mono">Vídeo desativado</span></div>
    <div class="pip-overlay"><span class="mono">Em janela flutuante</span></div>
    <button class="fs-btn" title="Tela cheia">⛶</button>
    ${!isSelf && document.pictureInPictureEnabled ? `<button class="pip-btn" title="Janela flutuante">${ICON_PIP}</button>` : ''}
    ${isSelf ? '' : `
    <div class="tile-controls">
      <button type="button" class="ctl-btn mute-btn" title="Mutar/desmutar">${ICON_VOLUME}</button>
      <input type="range" class="vol-slider" min="0" max="100" value="100" title="Volume">
      <button type="button" class="ctl-btn hide-btn" title="Parar de assistir">${ICON_EYE_OFF}</button>
      ${owner && canModerateParticipant(owner) ? `
      <button type="button" class="ctl-btn mod-btn" title="Opções de moderação">${ICON_DOTS}</button>
      <div class="mod-menu">
        <button type="button" class="mod-menu-item">${id.endsWith(':cam') ? 'Desligar câmera' : 'Desligar tela'}</button>
      </div>` : ''}
    </div>`}
    <div class="label"><span class="led"></span>${crown}${escapeHtml(name)}${isSelf ? (isCamera ? '' : '<span class="send-dot" title="Medindo envio..."></span>') : '<span class="quality-dot" title="Medindo conexão..."></span>'}</div>
    <div class="pin-hint"></div>
  `;
  const video = tile.querySelector('video');
  video.srcObject = stream;
  tile.querySelector('.fs-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    video.requestFullscreen && video.requestFullscreen();
  });
  // Janela flutuante (picture-in-picture nativo do Chromium): o <video>
  // continua sendo esse mesmo elemento, só é desenhado numa janela por cima
  // de tudo — áudio, volume e mudo continuam no tile. Uma por vez (limite
  // do navegador): abrir outra devolve a anterior sozinha.
  const pipBtn = tile.querySelector('.pip-btn');
  if(pipBtn){
    pipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if(document.pictureInPictureElement === video){
        document.exitPictureInPicture().catch(() => {});
      } else {
        video.requestPictureInPicture().catch((err) => console.warn('[sinal] janela flutuante falhou:', err));
      }
    });
    video.addEventListener('enterpictureinpicture', () => tile.classList.add('in-pip'));
    video.addEventListener('leavepictureinpicture', () => {
      tile.classList.remove('in-pip');
      // Fechar no X da janelinha pausa o vídeo (comportamento do Chromium) —
      // de volta no tile, tem que continuar ao vivo.
      if(!tile.classList.contains('render-off')) video.play().catch(() => {});
    });
  }
  tile.addEventListener('click', () => togglePin(id));

  if(!isSelf){
    const muteBtn = tile.querySelector('.mute-btn');
    const volSlider = tile.querySelector('.vol-slider');
    const hideBtn = tile.querySelector('.hide-btn');

    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      video.muted = !video.muted;
      muteBtn.innerHTML = video.muted ? ICON_VOLUME_MUTED : ICON_VOLUME;
      muteBtn.classList.toggle('active', video.muted);
    });
    volSlider.addEventListener('click', (e) => e.stopPropagation());
    volSlider.addEventListener('input', () => {
      const linear = volSlider.value / 100;
      // Ouvido humano percebe volume em escala logarítmica, não linear —
      // um slider 1:1 com video.volume deixa a barra "sem fazer nada" até
      // quase o fim (relatado: "tem que botar lá pra baixo pra abaixar o
      // volume de fato"). Elevar ao quadrado é a curva de compensação mais
      // comum pra isso (audio taper) — a metade do slider já soa
      // perceptivelmente mais baixa, não só nos últimos 10-20%.
      video.volume = linear * linear;
      if(linear > 0 && video.muted){
        video.muted = false;
        muteBtn.innerHTML = ICON_VOLUME;
        muteBtn.classList.remove('active');
      }
    });
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Desinscreve de verdade (ver stopWatchingTile) — troca esse tile
      // pelo card "clique pra assistir" assim que TrackUnsubscribed chegar
      // (handleTrackRemoved cuida disso), então não precisa alternar estado
      // aqui: esse botão não existe mais depois desse clique.
      stopWatchingTile(id, isCamera);
    });

    const modBtn = tile.querySelector('.mod-btn');
    const modMenu = tile.querySelector('.mod-menu');
    if(modBtn && modMenu){
      modBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleModMenu(modMenu);
      });
      modMenu.querySelector('.mod-menu-item').addEventListener('click', (e) => {
        e.stopPropagation();
        modMenu.classList.remove('open');
        const identity = id.endsWith(':cam') ? id.slice(0, -4) : id;
        const track = tileVideoTracks.get(id);
        if(!track || !track.sid) return;
        moderateAction(id.endsWith(':cam') ? 'muteCamera' : 'muteScreen', identity, track.sid);
      });
    }
  }

  tiles.set(id, tile);

  if(pinnedOrder.length === 0){
    // a primeira transmissão a aparecer já entra em destaque
    pinnedOrder.push(id);
    tile.classList.add('pinned');
    document.getElementById('spotlightGrid').appendChild(tile);
  } else {
    tile.classList.add('minimized');
    document.getElementById('filmstrip').appendChild(tile);
  }
  updateStageVisibility();
  renderViewers(id);
}

function removeTile(id){
  const el = tiles.get(id);
  // Transmissão acabou ou parei de assistir — a janela flutuante não pode
  // ficar pra trás congelada no último quadro.
  if(el && document.pictureInPictureElement && el.contains(document.pictureInPictureElement)){
    document.exitPictureInPicture().catch(() => {});
  }
  if(el) el.remove();
  tiles.delete(id);
  const idx = pinnedOrder.indexOf(id);
  if(idx !== -1) pinnedOrder.splice(idx, 1);
  updateStageVisibility();
}

function pinTile(id){
  if(pinnedOrder.includes(id) || !tiles.has(id)) return;
  if(pinnedOrder.length >= 2){
    moveTileTo(pinnedOrder.shift(), 'filmstrip'); // tira o destaque mais antigo
  }
  pinnedOrder.push(id);
  moveTileTo(id, 'spotlight');
  updateStageVisibility();
}
function unpinTile(id){
  const idx = pinnedOrder.indexOf(id);
  if(idx === -1) return;
  pinnedOrder.splice(idx, 1);
  moveTileTo(id, 'filmstrip');
  updateStageVisibility();
}
function togglePin(id){
  pinnedOrder.includes(id) ? unpinTile(id) : pinTile(id);
}
function moveTileTo(id, where){
  const el = tiles.get(id);
  if(!el) return;
  el.classList.toggle('pinned', where === 'spotlight');
  el.classList.toggle('minimized', where === 'filmstrip');
  const container = document.getElementById(where === 'spotlight' ? 'spotlightGrid' : 'filmstrip');
  container.appendChild(el); // move sem recriar o <video>, o stream continua tocando
}
function updateStageVisibility(){
  const total = tiles.size;
  document.getElementById('emptyState').style.display = total === 0 ? 'flex' : 'none';
  document.getElementById('spotlightGrid').style.display = pinnedOrder.length > 0 ? 'grid' : 'none';
  document.getElementById('filmstrip').style.display = (total - pinnedOrder.length) > 0 ? 'flex' : 'none';
  document.getElementById('stageArea').classList.toggle('has-spotlight', pinnedOrder.length > 0);
  scheduleFitSpotlight();
}

// ---------------- ENCAIXE DOS DESTAQUES (HANDOFF §43) ----------------
// Os tiles em destaque (no máximo 2) são sempre 16:9. Antes a largura de cada um vinha de uma regra
// fixa de CSS e sobrava muito espaço vazio embaixo (duas transmissões numa tela de 1920x1060 ficavam
// com 712x400 e ~220px de vazio). Agora o tamanho vem de um cálculo: pra cada arrumação possível
// (1 coluna, 2 colunas…) vê qual o MAIOR tile 16:9 que cabe no espaço livre e usa a melhor.
const SPOTLIGHT_GAP = 16;
const SPOTLIGHT_MIN_WIDTH = 240;

// Maior largura de tile que cabe em (W x H) com n tiles 16:9 e o espaço entre eles. Pura (testada).
function bestSpotlightLayout(n, W, H, gap){
  let best = null;
  for(let cols = 1; cols <= n; cols++){
    const rows = Math.ceil(n / cols);
    const byWidth = (W - gap * (cols - 1)) / cols;
    const byHeight = ((H - gap * (rows - 1)) / rows) * 16 / 9;
    const w = Math.min(byWidth, byHeight);
    if(!best || w > best.width + 1) best = { cols, width: w }; // empate (±1px) fica com menos colunas
  }
  return { cols: best.cols, width: Math.max(SPOTLIGHT_MIN_WIDTH, Math.floor(best.width)) };
}

function fitSpotlight(){
  const grid = document.getElementById('spotlightGrid');
  const stage = document.getElementById('stageArea');
  const n = pinnedOrder.length;
  const props = ['--spot-cols', '--tile-w', '--tile-max', '--tile-max-w'];
  if(!n || grid.style.display === 'none' || !stage.offsetParent){
    props.forEach((p) => grid.style.removeProperty(p)); // sem destaque (ou sala fechada): volta ao padrão
    return;
  }
  // Espaço livre: o palco ocupa (flex:1) o que sobra entre a barra da sala e os controles. Mede com os
  // destaques recolhidos pra o tamanho deles não entrar na conta.
  const keep = grid.style.display;
  grid.style.display = 'none';
  const freeH = stage.clientHeight;
  const W = stage.clientWidth;
  grid.style.display = keep;
  const strip = document.getElementById('filmstrip');
  const stripH = strip.style.display === 'none' ? 0 : strip.offsetHeight + 14;
  const layout = bestSpotlightLayout(n, W, freeH - stripH, SPOTLIGHT_GAP);
  grid.style.setProperty('--spot-cols', `repeat(${layout.cols}, ${layout.width}px)`);
  grid.style.setProperty('--tile-w', `${layout.width}px`);
  grid.style.setProperty('--tile-max', 'none');
  grid.style.setProperty('--tile-max-w', 'none');
}

let fitQueued = false;
function scheduleFitSpotlight(){
  if(fitQueued) return;
  fitQueued = true;
  // O que vier primeiro: o quadro de animação (some em janela oculta/minimizada — o navegador
  // suspende requestAnimationFrame) ou um temporizador curto. Sem o temporizador, o aviso de
  // "recalcular" podia ficar preso até a janela voltar a ser visível.
  const run = () => { if(!fitQueued) return; fitQueued = false; fitSpotlight(); };
  requestAnimationFrame(run);
  setTimeout(run, 120);
}

// Refaz o encaixe quando a janela muda de tamanho, a coluna de salas abre/fecha ou aparece algo
// embaixo (painel de áudio, avisos) que muda o espaço livre.
function setupStageFit(){
  window.addEventListener('resize', scheduleFitSpotlight);
  if(window.ResizeObserver){
    const ro = new ResizeObserver(scheduleFitSpotlight);
    ro.observe(document.querySelector('.room-main'));
    ro.observe(document.getElementById('stageArea'));
  }
}

// ---------------- MODERAÇÃO (admin do Sinal e admins de servidor) ----------------
// A UI de moderação aparece pra quem é moderador pelo PRÓPRIO token do LiveKit
// (admin do Sinal = grant roomAdmin em qualquer sala; dono/administrador/"gerencia o
// servidor" = nível assinado no metadata, só nas salas do próprio servidor — ver
// api/get-token.js) e só nos participantes que estão ABAIXO dele
// na hierarquia (admin do Sinal > dono > administrador > gerencia). É só indicador local,
// cosmético: o poder de verdade é conferido de novo no servidor a cada ação
// (api/moderate.js: TokenVerifier + grant + hierarquia) — editar isso no navegador não dá
// poder nenhum a ninguém.

// Mesma regra de lib/rooms.js (duplicada de propósito: o site não tem build, não importa módulo).
function moderationRank(meta){
  if(!meta) return 9;
  if(meta.isAdmin) return 0;
  return ({ o: 1, a: 2, m: 3 })[meta.tier] || 9;
}
function canModerateTarget(callerMeta, targetMeta){
  const caller = moderationRank(callerMeta);
  if(caller === 0) return true;
  return caller < moderationRank(targetMeta);
}

// Lê o conteúdo (sem conferir assinatura — isso é do servidor) do token do LiveKit da sala atual.
function myTokenClaims(){
  try{
    const payload = myAccessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))));
  }catch(e){
    return null;
  }
}

function canModerateParticipant(p){
  if(!myAccessToken || !room || !p || p === room.localParticipant) return false;
  const claims = myTokenClaims();
  if(!claims || !claims.video) return false;
  let myMeta = null;
  try{ myMeta = JSON.parse(claims.metadata || ''); }catch(e){}
  // Mesma regra de isModeratorToken (lib/rooms.js): admin do Sinal (roomAdmin) ou nível de
  // servidor assinado no token, só na sala de servidor daquele mesmo guild.
  const staff = !!(myMeta && ['o', 'a', 'm'].includes(myMeta.tier) && myMeta.guild && myMeta.guild === currentRoomGuild());
  if(claims.video.roomAdmin !== true && !staff) return false;
  return canModerateTarget(myMeta, participantMeta(p));
}
function toggleModMenu(menu){
  const wasOpen = menu.classList.contains('open');
  document.querySelectorAll('.mod-menu.open').forEach((m) => m.classList.remove('open'));
  if(!wasOpen) menu.classList.add('open');
}
document.addEventListener('click', (e) => {
  if(e.target.closest('.mod-btn') || e.target.closest('.mod-menu')) return;
  document.querySelectorAll('.mod-menu.open').forEach((m) => m.classList.remove('open'));
});

async function moderateAction(action, targetIdentity, trackSid){
  if(!myAccessToken || !roomCode) return;
  try{
    const res = await fetch('/api/moderate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + myAccessToken },
      body: JSON.stringify({ action, room: roomCode, targetIdentity, trackSid })
    });
    const data = await res.json().catch(() => ({}));
    if(!res.ok){
      const texts = {
        'sem-permissao-sobre-alvo': 'Você não pode moderar essa pessoa.',
        'sem-permissao': 'Você não tem permissão pra isso nesta sala.',
        'participante-nao-encontrado': 'Essa pessoa já saiu da sala.'
      };
      setRoomStatus(texts[data.error] || 'Não foi possível concluir essa ação. Tente de novo.', true);
    }
  }catch(e){
    console.error('[sinal] moderateAction erro de rede:', e);
    setRoomStatus('Não foi possível falar com o servidor pra essa ação.', true);
  }
}

// Quem logou com Discord tem o avatar de verdade gravado no metadata do
// participante do LiveKit (ver api/get-token.js) — assim os OUTROS
// participantes também enxergam, não só quem logou. Sem isso, cai nas
// iniciais de sempre.
function participantMeta(p){
  if(!p.metadata) return null;
  try{ return JSON.parse(p.metadata); }catch(e){ return null; }
}
function participantAvatarUrl(p){
  const meta = participantMeta(p);
  // Defesa em camadas: o servidor já só grava URL do CDN do Discord no token e o CSP bloqueia
  // qualquer outra, mas valida aqui também antes de virar <img src>.
  return meta && isDiscordAvatarUrl(meta.avatarUrl) ? meta.avatarUrl : null;
}
function participantIsAdmin(p){
  const meta = participantMeta(p);
  return !!(meta && meta.isAdmin);
}

function renderAvatars(){
  if(!room) return;
  const { Track } = LivekitClient;
  const row = document.getElementById('avatarsRow');
  row.innerHTML = '';
  const all = [room.localParticipant, ...room.remoteParticipants.values()];
  all.forEach((p) => {
    const isSharing = !!(p.getTrackPublication(Track.Source.ScreenShare) || p.getTrackPublication(Track.Source.Camera));
    const displayName = p.name || p.identity;
    const av = document.createElement('div');
    av.className = 'avatar' + (isSharing ? ' sharing' : '');
    const isYou = p === room.localParticipant;
    const avatarUrl = participantAvatarUrl(p);
    // Montado via DOM de propósito: o avatarUrl e o nome vêm do metadata do
    // participante, ou seja, de outra pessoa. Atribuir em .src/.textContent
    // não tem como "escapar" pra virar marcação, diferente de interpolar numa
    // string de innerHTML (ver o comentário em escapeHtml()).
    if(avatarUrl){
      const img = document.createElement('img');
      img.src = avatarUrl;
      img.alt = '';
      av.appendChild(img);
    } else {
      av.appendChild(document.createTextNode(initials(displayName)));
    }
    const tip = document.createElement('span');
    tip.className = 'tip';
    tip.textContent = displayName + (isYou ? ' (você)' : '') + (participantIsAdmin(p) ? ' 👑' : '');
    av.appendChild(tip);
    row.appendChild(av);
  });
  if(rosterOpen) renderRosterPanel();
}

let rosterOpen = false;

function toggleRosterPanel(force){
  rosterOpen = typeof force === 'boolean' ? force : !rosterOpen;
  document.getElementById('rosterPanel').classList.toggle('open', rosterOpen);
  if(rosterOpen){
    toggleChatPanel(false);
    renderRosterPanel();
  }
}

function renderRosterPanel(){
  if(!room) return;
  const { Track } = LivekitClient;
  const list = document.getElementById('rosterList');
  const all = [room.localParticipant, ...room.remoteParticipants.values()];
  // Montado via DOM (e não por string de innerHTML) pelo mesmo motivo de
  // renderAvatars(): nome, identity e avatarUrl vêm de outros participantes.
  // De quebra, o botão de expulsar não precisa mais carregar data-identity/
  // data-name no HTML — o listener fecha em cima das variáveis daqui.
  list.innerHTML = '';
  all.forEach((p) => {
    const isSharing = !!(p.getTrackPublication(Track.Source.ScreenShare) || p.getTrackPublication(Track.Source.Camera));
    const isYou = p === room.localParticipant;
    const displayName = p.name || p.identity;
    const avatarUrl = participantAvatarUrl(p);

    const rowEl = document.createElement('div');
    rowEl.className = 'roster-row' + (isSharing ? ' sharing' : '');

    const avatarEl = document.createElement('div');
    avatarEl.className = 'roster-avatar';
    if(avatarUrl){
      const img = document.createElement('img');
      img.src = avatarUrl;
      img.alt = '';
      avatarEl.appendChild(img);
    } else {
      avatarEl.textContent = initials(displayName);
    }
    rowEl.appendChild(avatarEl);

    const info = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    if(participantIsAdmin(p)){
      const crown = document.createElement('span');
      crown.className = 'admin-crown';
      crown.title = 'Admin da sala';
      crown.textContent = '👑';
      nameEl.appendChild(crown);
    }
    nameEl.appendChild(document.createTextNode(displayName + (isYou ? ' (você)' : '')));
    info.appendChild(nameEl);
    if(isSharing){
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.textContent = 'Compartilhando';
      info.appendChild(tag);
    }
    rowEl.appendChild(info);

    if(canModerateParticipant(p)){
      const kickBtn = document.createElement('button');
      kickBtn.type = 'button';
      kickBtn.className = 'roster-kick-btn';
      kickBtn.title = 'Expulsar da sala';
      kickBtn.innerHTML = ICON_KICK; // SVG constante do próprio código, não vem de ninguém de fora
      kickBtn.addEventListener('click', () => {
        askConfirm({ title: 'Expulsar da sala', message: `Expulsar ${displayName} da sala?`, okText: 'Expulsar', danger: true })
          .then((yes) => { if(yes) moderateAction('kick', p.identity); });
      });
      rowEl.appendChild(kickBtn);
    }

    list.appendChild(rowEl);
  });
}

function leaveRoom(){
  if(window.sinalElectron && window.sinalElectron.setInRoom) window.sinalElectron.setInRoom(false);
  // Sair da sala compartilhando não passa pelo toggleShare() (que é quem
  // normalmente desliga isso) — sem isso aqui, a captura nativa de áudio
  // isolado ficava rodando pra sempre em segundo plano no processo
  // principal do Electron, mesmo depois de sair da sala.
  if(window.sinalElectron) teardownElectronIsolatedAudio();
  if(room){
    try{ room.disconnect(); }catch(e){}
    room = null;
  }
  myAccessToken = null;
  toggleRosterPanel(false);
  tileStreams.clear();
  tileVideoTracks.clear();
  qualityBaseLabel.clear();
  qualityDetails.clear();
  qualityStatsPrev.clear();
  tileViewers.clear();
  myWatching.clear();
  if(document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  tiles.forEach(el => el.remove());
  tiles.clear();
  pinnedOrder = [];
  document.getElementById('spotlightGrid').innerHTML = '';
  document.getElementById('filmstrip').innerHTML = '';
  document.getElementById('avatarsRow').innerHTML = '';
  updateStageVisibility();

  // Reseta os controles direto (sem depender de evento) — um disconnect()
  // completo pode não disparar LocalTrackUnpublished individual por track.
  const shareBtn = document.getElementById('shareBtn');
  setBtnLabel(shareBtn, 'Compartilhar minha tela');
  shareBtn.classList.remove('active-share');
  document.getElementById('qualityBtn').disabled = false;
  document.getElementById('audioToggleBtn').disabled = false;
  const cameraBtn = document.getElementById('cameraBtn');
  setBtnLabel(cameraBtn, 'Ligar câmera');
  cameraBtn.classList.remove('active-share');
  document.getElementById('selfPreview').style.display = 'none';
  document.getElementById('selfStatus').textContent = 'Assistindo';

  toggleChatPanel(false);
  document.getElementById('chatMessages').innerHTML = '';
  document.getElementById('chatInput').value = '';
  unreadChat = 0;
  updateChatBadge();
  if(titleFlashing){ titleFlashing = false; document.title = ORIGINAL_TITLE; }

  document.getElementById('roomScreen').style.display = 'none';
  document.getElementById('roomScreen').classList.remove('server-room');
  document.getElementById('entryScreen').style.display = 'block';
  document.body.classList.remove('in-room');
  setEntryStatus('');
  prefillJoinCode();
  renderServersUI();
  startLivesPolling();
}

// auto-preencher código: prioridade pro link de convite (?sala=CODE); sem
// isso, cai pro último código usado (localStorage), só por conveniência —
// não é obrigado a bater com uma sala que ainda existe. Chamado tanto no
// carregamento da página quanto ao sair de uma sala — como é um SPA, sair
// não recarrega a página, então sem essa segunda chamada o valor só
// apareceria depois de um F5 de verdade.
// O app desktop recarrega sozinho quando a página cai (v0.3.13, HANDOFF §37)
// e manda ?sala=CODIGO&retomar=1 — volta direto pra sala, sem clique, se o
// nome já estiver salvo. Só nessa situação: um ?sala= normal (convite)
// continua só preenchendo o código.
function resumeAfterAppRecovery(){
  const params = new URLSearchParams(window.location.search);
  if(params.get('retomar') !== '1') return;
  params.delete('retomar');
  const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
  history.replaceState(null, '', clean);
  const code = (params.get('sala') || '').trim();
  if(!code || !document.getElementById('nameInput').value.trim()) return;
  setEntryStatus('O app se recuperou de uma falha — voltando pra sala…');
  appLog('[sinal] voltando pra sala depois da recuperação');
  // Direto, sem passar pelo campo de código: sala de servidor não aparece mais ali (pickPrefillCode).
  getAudioCtx();
  const server = isServerRoomName(code);
  connectToRoom(server ? code : code.toUpperCase(), getName(), server ? 'server-join' : 'join');
}

// Qual código mostrar no campo "entrar em sala existente": SÓ código de sala por
// código (o "Início"). Sala de servidor tem um nome interno (s<id>-xxxxxx) que não é
// pra ninguém digitar nem lembrar — a entrada é pela lista do servidor — e o campo
// mostra tudo em maiúsculas, então ele parecia um "código" gigante e sem sentido.
// Vem de ?sala= (convite) ou do último código salvo (sinal:lastRoomCode, que antes
// podia guardar o nome de sala de servidor).
function pickPrefillCode(sala, lastCode){
  const looksLikeServerRoom = (v) => /^s\d{15,21}-/i.test(v || '');
  if(sala && !looksLikeServerRoom(sala)) return { code: sala.toUpperCase(), dropLast: false, dropSala: false };
  const dropSala = !!sala; // ?sala= de sala de servidor: sai da URL
  if(lastCode && !looksLikeServerRoom(lastCode)) return { code: lastCode, dropLast: false, dropSala };
  return { code: '', dropLast: !!lastCode, dropSala }; // último código era de servidor: esquece
}

function prefillJoinCode(){
  const params = new URLSearchParams(window.location.search);
  let lastCode = null;
  try{ lastCode = localStorage.getItem('sinal:lastRoomCode'); }catch(e){ /* localStorage indisponível — só não lembra */ }
  const pick = pickPrefillCode(params.get('sala'), lastCode);
  if(pick.dropLast){ try{ localStorage.removeItem('sinal:lastRoomCode'); }catch(e){} }
  // Na recuperação do app (?retomar=1) o resumeAfterAppRecovery() ainda precisa ler o ?sala= — não mexe.
  if(pick.dropSala && !params.has('retomar')){
    params.delete('sala');
    history.replaceState(null, '', window.location.pathname + (params.toString() ? '?' + params.toString() : ''));
  }
  document.getElementById('joinCodeInput').value = pick.code;
}

// Quem chegou via link de convite (?sala=) e ainda tá no navegador normal
// (dentro do Electron já tá no app, não faz sentido) — tenta abrir o
// protocolo sinal://. Se o app estiver instalado, o próprio navegador
// mostra um prompt nativo perguntando "Abrir Sinal?" (com opção de sempre
// permitir, embutida no navegador — não precisa duplicar isso aqui). Se
// não tiver instalado, essa tentativa só falha em silêncio e a pessoa
// segue direto pro formulário normal da página, sem nenhum aviso feio.
function setupOpenInApp(){
  if(window.sinalElectron?.isElectron) return;
  const params = new URLSearchParams(window.location.search);
  const sala = params.get('sala');
  if(!sala) return;
  window.location.href = 'sinal://join?sala=' + encodeURIComponent(sala);
}

// pré-preenche o nome com o último usado, salvo em getName() ao entrar numa
// sala. Só precisa rodar no carregamento inicial — diferente do código da
// sala, o campo de nome não é tocado em nenhum outro momento da sessão, então
// não some/precisa ser re-sincronizado ao sair de uma sala.
// Se a pessoa já logou com Discord antes (discordUser, carregado do
// localStorage), o nome dele tem prioridade — é assim que o login "fica
// salvo" sem precisar refazer o OAuth toda visita.
function prefillLastName(){
  if(discordUser && discordUser.name){
    document.getElementById('nameInput').value = discordUser.name;
    return;
  }
  try{
    const lastName = localStorage.getItem('sinal:lastName');
    if(lastName) document.getElementById('nameInput').value = lastName;
  }catch(e){ /* localStorage indisponível — sem problema, só não pré-preenche */ }
}

// ---------------- LOGIN OPCIONAL COM DISCORD ----------------
// Não guarda nada no servidor — o OAuth do Discord roda uma vez, o servidor
// assina o resultado (nome, avatar, se é admin do Sinal e os servers da
// pessoa com o nível dela em cada um — lib/session.js, HANDOFF §38) e ele fica
// aqui no navegador em sinal:session, válido por 7 dias. O navegador lê o
// conteúdo pra desenhar a interface, mas só o servidor decide permissões (a
// assinatura impede de alterar). Totalmente opcional: quem não usa isso
// continua com o fluxo de sempre (digitar o nome e usar códigos de sala).
let discordUser = null; // { name, avatar, admin, guilds, exp, session } ou null

// Lê o conteúdo (sem conferir a assinatura — isso é trabalho do servidor) de
// um token de sessão. Devolve null se estiver malformado ou vencido.
function decodeSession(token){
  try{
    const payload = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if(!data || data.v !== 1 || !data.id || typeof data.exp !== 'number' || data.exp <= Date.now()) return null;
    return {
      id: data.id,
      name: data.name,
      avatar: data.avatar || null,
      admin: !!data.admin,
      guilds: (data.guilds || []).map(([id, name, icon, tier]) => ({ id, name, icon, tier })),
      exp: data.exp,
      session: token
    };
  }catch(e){
    return null;
  }
}

function loadDiscordUser(){
  try{
    // v0.8.52: o formato antigo (nome/avatar/adminProof soltos) acabou — todo
    // mundo entra com o Discord de novo, agora pedindo também os servers.
    if(localStorage.getItem('sinal:discordUser') !== null){
      localStorage.removeItem('sinal:discordUser');
      legacyLoginDropped = true;
    }
    const raw = localStorage.getItem('sinal:session');
    if(raw){
      discordUser = decodeSession(raw);
      if(!discordUser) localStorage.removeItem('sinal:session'); // vencida ou corrompida
    }
  }catch(e){ /* localStorage indisponível ou dado corrompido — segue sem Discord */ }
}
let legacyLoginDropped = false;

function saveDiscordUser(user){
  discordUser = user;
  try{ localStorage.setItem('sinal:session', user.session); }catch(e){}
}

function clearDiscordUser(){
  discordUser = null;
  stopPresence();
  try{ localStorage.removeItem('sinal:session'); }catch(e){}
  document.getElementById('nameInput').value = '';
  renderDiscordStatus();
}

function renderDiscordStatus(){
  const el = document.getElementById('discordStatus');
  const btn = document.getElementById('discordLoginBtn');
  if(discordUser && discordUser.name){
    el.hidden = false;
    const adminTag = discordUser.admin ? ' 👑' : '';
    el.innerHTML = `Conectado como <b>${escapeHtml(discordUser.name)}</b> (Discord)${adminTag} — `;
    const swapBtn = document.createElement('button');
    swapBtn.type = 'button';
    swapBtn.className = 'ghost-btn';
    swapBtn.style.display = 'inline';
    swapBtn.style.marginTop = '0';
    swapBtn.textContent = 'trocar';
    swapBtn.onclick = clearDiscordUser;
    el.appendChild(swapBtn);
    btn.style.display = 'none';
  } else {
    el.hidden = true;
    btn.style.display = '';
  }
}

// Manda pra função serverless que redireciona pro Discord — leva junto o
// código de sala já digitado (se tiver algum), pra não se perder no
// vai-e-volta do login.
function loginWithDiscord(){
  // App desktop v0.3.14+: o login acontece no navegador padrão (onde a pessoa já
  // costuma estar logada no Discord) e volta pelo sinal://auth — ver "Login
  // pelo navegador" abaixo. No navegador comum (e no app antigo) segue na mesma aba.
  if(hasAppLogin()){ startAppLogin(); return; }
  const sala = document.getElementById('joinCodeInput').value.trim().toUpperCase();
  window.location.href = '/api/discord-login' + (sala ? ('?sala=' + encodeURIComponent(sala)) : '');
}

// ---------------- Login pelo navegador (app desktop, HANDOFF §39 fase 2c) ----------------
// O app gera um NONCE aleatório, guarda aqui e abre o navegador padrão no login do
// Discord levando só o nonce. A sessão volta por sinal://auth?session=…&nonce=… e só
// é aceita se o nonce for exatamente o que geramos (e ainda dentro de 10 minutos) —
// um link sinal://auth forjado por outra página não consegue logar ninguém numa
// conta alheia. A sessão em si é validada pelo servidor a cada uso (assinatura).
const LOGIN_NONCE_KEY = 'sinal:loginNonce';
const LOGIN_NONCE_TTL_MS = 10 * 60 * 1000;

function hasAppLogin(){
  return !!(window.sinalElectron && typeof window.sinalElectron.openLogin === 'function');
}

function newLoginNonce(){
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function startAppLogin(options){
  const nonce = newLoginNonce();
  try{ localStorage.setItem(LOGIN_NONCE_KEY, JSON.stringify({ nonce, at: Date.now() })); }catch(e){}
  setEntryStatus('Abrindo o navegador pra você entrar com o Discord…');
  let opened = false;
  try{ opened = await window.sinalElectron.openLogin(nonce, { refresh: !!(options && options.refresh) }); }catch(e){}
  setEntryStatus(opened
    ? 'Entre com o Discord no navegador que abriu — quando terminar, o Sinal te traz de volta sozinho.'
    : 'Não consegui abrir o navegador. Tente de novo.');
}

// Chegou a sessão pelo sinal://auth (ver main.js: sinal:auth / sinal:take-pending-auth).
function consumeAppAuth(auth){
  let saved = null;
  try{
    saved = JSON.parse(localStorage.getItem(LOGIN_NONCE_KEY) || 'null');
    localStorage.removeItem(LOGIN_NONCE_KEY); // uso único
  }catch(e){}
  if(!auth || !saved || saved.nonce !== auth.nonce || Date.now() - saved.at > LOGIN_NONCE_TTL_MS){
    setEntryStatus('Não reconheci esse login (ele vale por 10 minutos). Clique em "Entrar com Discord" de novo.');
    return;
  }
  const user = decodeSession(auth.session);
  if(!user){
    setEntryStatus('Não foi possível entrar com Discord. Tente de novo.');
    return;
  }
  applyNewLogin(user);
}

// Logou sem recarregar a página (o caminho normal recarrega e passa pela inicialização).
function applyNewLogin(user){
  saveDiscordUser(user);
  try{ localStorage.setItem('sinal:lastName', user.name); }catch(e){}
  document.getElementById('nameInput').value = user.name;
  renderDiscordStatus();
  loadServerPrefs();
  renderServersUI();
  setEntryStatus('');
  startPresence();
  startLivesPolling();
  fetchLives();
  let asked = true;
  try{ asked = localStorage.getItem(SERVERS_KEY) !== null; }catch(e){}
  if(myGuilds().length && !asked) openServersPicker();
}

function setupAppLogin(){
  if(!hasAppLogin() || typeof window.sinalElectron.onAuth !== 'function') return;
  window.sinalElectron.onAuth(consumeAppAuth);
  window.sinalElectron.takePendingAuth().then((auth) => { if(auth) consumeAppAuth(auth); }).catch(() => {});
}

// Roda no carregamento da página — detecta se acabamos de voltar do
// callback do Discord (api/discord-callback.js): a sessão assinada vem no
// fragmento (#session=…), que o navegador não manda pra servidor nenhum.
function handleDiscordCallback(){
  const params = new URLSearchParams(window.location.search);
  if(params.get('discord_error')){
    setEntryStatus('Não foi possível entrar com Discord. Tente de novo ou use seu nome normalmente.');
  }
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const sessionToken = hash.get('session');
  if(sessionToken){
    const user = decodeSession(sessionToken);
    if(user){
      saveDiscordUser(user);
      try{ localStorage.setItem('sinal:lastName', user.name); }catch(e){}
    } else {
      setEntryStatus('Não foi possível entrar com Discord. Tente de novo ou use seu nome normalmente.');
    }
  } else if(legacyLoginDropped){
    setEntryStatus('Atualizamos o login com o Discord — entre de novo pra liberar os servers.');
  }
  if(sessionToken || params.has('discord_error')){
    const clean = new URL(window.location.href);
    clean.searchParams.delete('discord_error');
    history.replaceState(null, '', clean.pathname + clean.search);
  }
}

// ---------------- SERVERS NO SINAL (HANDOFF §38/§39) ----------------
// Os servers do Discord da pessoa (vindos da sessão assinada do login) viram
// um trilho à esquerda, igual ao Discord: "Início" (sala rápida por código) +
// os servers que ela escolheu. Cada server tem uma coluna com as salas ao
// vivo — quem está dentro, quem está transmitindo — e dá pra criar sala nova.
// Quem é membro de qual server quem diz é o Discord (no login); o servidor
// confere de novo a cada pedido (api/get-token.js, api/lives.js).
const SERVER_ROOM_RE = /^s\d{15,21}-[a-z0-9]{6}$/;
const SERVERS_KEY = 'sinal:servers';       // ids dos servers escolhidos (por dispositivo)
const SERVER_VIEW_KEY = 'sinal:serverView'; // último lugar aberto: 'home' ou o id de um server
const MAX_CHOSEN_SERVERS = 15;
const LIVES_POLL_MS = 15000;               // consulta periódica SEM a conexão de presença
const LIVES_POLL_ROOM_MS = 120000;         // dentro da call
const LIVES_POLL_SAFETY_MS = 60000;        // com a presença conectada, a consulta é só rede de segurança
const TIER_LABEL = { o: 'dono do servidor', a: 'administrador', m: 'gerencia o servidor' };

let chosenServers = [];
let serverView = 'home';
let livesData = {};      // { idDoServer: [sala, ...] } — última foto vinda de api/lives
let livesError = false;
let livesTimer = null;
let livesBusy = false;

function isServerRoomName(name){ return SERVER_ROOM_RE.test(name || ''); }

// Ícone do server no CDN do Discord (o CSP já libera cdn.discordapp.com). Só
// monta a URL se id e hash tiverem o formato certo — vem da sessão, mas é
// barato não confiar.
function guildIconUrl(g){
  if(!g || !/^\d{15,21}$/.test(g.id || '') || !/^[a-z0-9_]{1,40}$/i.test(g.icon || '')) return '';
  return 'https://cdn.discordapp.com/icons/' + g.id + '/' + g.icon + '.png?size=64';
}

function guildInitials(name){
  // ignora ligações ("de", "e"…) pra "Estudos e Café" virar EC e não EE
  const words = String(name || '?').trim().split(/\s+/).filter((w) => w && !/^(de|do|da|dos|das|e|the|of|&)$/i.test(w));
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
  return letters.toUpperCase();
}

function isDiscordAvatarUrl(url){
  return typeof url === 'string' && /^https:\/\/cdn\.discordapp\.com\/[A-Za-z0-9/_.-]+(\?[A-Za-z0-9=&_-]*)?$/.test(url);
}

function myGuilds(){ return (discordUser && discordUser.guilds) || []; }
function guildById(id){ return myGuilds().find((g) => g.id === id) || null; }

function mk(tag, className, text){
  const node = document.createElement(tag);
  if(className) node.className = className;
  if(text !== undefined) node.textContent = text;
  return node;
}

// Bolinha redonda com o ícone do server (ou as iniciais, quando não tem).
function fillGuildIcon(container, g){
  container.innerHTML = '';
  const url = guildIconUrl(g);
  if(url){
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.addEventListener('error', () => { container.innerHTML = ''; container.textContent = guildInitials(g.name); });
    container.appendChild(img);
  } else {
    container.textContent = guildInitials(g && g.name);
  }
}

function loadServerPrefs(){
  let ids = [];
  let view = 'home';
  try{
    const raw = localStorage.getItem(SERVERS_KEY);
    if(raw) ids = JSON.parse(raw);
    view = localStorage.getItem(SERVER_VIEW_KEY) || 'home';
  }catch(e){ /* sem localStorage ou dado corrompido: começa vazio */ }
  chosenServers = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && guildById(id)) : [];
  serverView = chosenServers.includes(view) ? view : 'home';
}

function saveChosenServers(){
  try{ localStorage.setItem(SERVERS_KEY, JSON.stringify(chosenServers)); }catch(e){}
}
function saveServerView(){
  try{ localStorage.setItem(SERVER_VIEW_KEY, serverView); }catch(e){}
}

function guildHasLive(id){
  return (livesData[id] || []).some((r) => r.participants.length > 0);
}

function setServerView(view){
  serverView = view === 'home' || chosenServers.includes(view) ? view : 'home';
  saveServerView();
  renderServersUI();
  startLivesPolling();
}

function railButton(view, title, content, extraClass){
  const btn = mk('button', 'srv-rail-btn' + (extraClass ? ' ' + extraClass : '') + (serverView === view ? ' active' : ''));
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.dataset.view = view;
  btn.appendChild(content);
  if(view !== 'home' && view !== '+' && guildHasLive(view)) btn.appendChild(mk('span', 'srv-live-dot'));
  return btn;
}

function renderServersUI(){
  const layout = document.getElementById('srvLayout');
  const loggedIn = !!discordUser;
  const inServer = loggedIn && serverView !== 'home' && !!guildById(serverView);
  layout.classList.toggle('has-rail', loggedIn);
  layout.classList.toggle('view-server', inServer);
  const rail = document.getElementById('srvRail');
  rail.hidden = !loggedIn;
  document.getElementById('srvCol').hidden = !inServer;
  document.getElementById('serverPanel').hidden = !inServer;
  document.getElementById('homePanel').hidden = inServer;
  if(!loggedIn) return;

  rail.innerHTML = '';
  const home = mk('span', 'srv-icon srv-home-icon');
  home.appendChild(mk('span', 'srv-home-led'));
  rail.appendChild(railButton('home', 'Início', home));
  chosenServers.forEach((id) => {
    const g = guildById(id);
    if(!g) return;
    const icon = mk('span', 'srv-icon');
    fillGuildIcon(icon, g);
    rail.appendChild(railButton(id, g.name, icon));
  });
  rail.appendChild(railButton('+', 'Escolher servidores', mk('span', 'srv-icon srv-add-icon', '+'), 'srv-add'));

  if(inServer) renderServerView(guildById(serverView));
}

function renderServerView(g){
  fillGuildIcon(document.getElementById('srvColIcon'), g);
  fillGuildIcon(document.getElementById('srvHeroIcon'), g);
  document.getElementById('srvColName').textContent = g.name;
  document.getElementById('srvHeroName').textContent = g.name;
  document.getElementById('srvHeroRole').textContent = TIER_LABEL[g.tier] ? 'Você é ' + TIER_LABEL[g.tier] : 'Membro do servidor';

  const rooms = livesData[g.id] || [];
  document.getElementById('srvLiveCount').textContent = rooms.length ? '· ' + rooms.length + ' ao vivo' : '';
  const list = document.getElementById('srvRooms');
  list.innerHTML = '';
  if(!rooms.length){
    list.appendChild(mk('div', 'srv-empty', 'Nenhuma sala ao vivo agora. Que tal abrir a primeira?'));
  }
  rooms.forEach((r) => list.appendChild(renderRoomRow(r)));
  document.getElementById('srvFoot').textContent = livesError ? 'Sem conexão com o servidor — tentando de novo…' : '';
}

// Ícone de tela (é um app de transmissão de tela, não de voz): vermelho quando alguém da sala está transmitindo.
const ICON_SCREEN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';

function renderRoomRow(r, currentRoom){
  const row = mk('button', 'srv-room' + (r.room === currentRoom ? ' current' : ''));
  if(r.room === currentRoom) row.setAttribute('aria-current', 'true');
  row.type = 'button';
  row.dataset.room = r.room;
  const head = mk('span', 'srv-room-head');
  if(r.access === 'open'){
    const icon = mk('span', 'srv-room-icon' + (r.participants.some((p) => p.screen) ? ' live' : ''));
    icon.innerHTML = ICON_SCREEN_SVG; // constante estática acima — nenhum dado de fora entra aqui
    head.appendChild(icon);
  } else {
    head.appendChild(mk('span', 'srv-room-icon', '🔒'));
  }
  head.appendChild(mk('span', 'srv-room-title', r.title));
  head.appendChild(mk('span', 'srv-room-count mono', String(r.participants.length)));
  row.appendChild(head);
  if(r.participants.length){
    const people = mk('span', 'srv-people');
    r.participants.forEach((p) => {
      const line = mk('span', 'srv-person');
      const av = mk('span', 'srv-person-avatar');
      if(isDiscordAvatarUrl(p.avatar)){
        const img = document.createElement('img');
        img.src = p.avatar;
        img.alt = '';
        av.appendChild(img);
      } else {
        av.textContent = guildInitials(p.name);
      }
      line.appendChild(av);
      line.appendChild(mk('span', 'srv-person-name', p.name + (p.admin ? ' 👑' : '')));
      if(p.screen) line.appendChild(mk('span', 'srv-badge srv-badge-live', 'AO VIVO'));
      else if(p.camera) line.appendChild(mk('span', 'srv-badge', 'CÂMERA'));
      people.appendChild(line);
    });
    row.appendChild(people);
  }
  return row;
}

// ---- lista de salas ao vivo ----
// Ponto único de entrada dos dados: applyLives(). A consulta (api/lives) e,
// depois, o push em tempo real (§39) usam o mesmo caminho.
function applyLives(guilds){
  livesData = Object.assign({}, livesData, guilds || {});
  livesError = false;
  renderServersUI();
  renderCallSide();
}

async function fetchLives(){
  if(livesBusy || !discordUser || !chosenServers.length) return;
  livesBusy = true;
  try{
    const res = await fetch('/api/lives', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: discordUser.session, guilds: chosenServers })
    });
    if(res.status === 401){
      clearDiscordUser();
      renderServersUI();
      setEntryStatus('Sua sessão do Discord expirou. Entre com o Discord de novo.');
      return;
    }
    if(!res.ok) throw new Error('lives-' + res.status);
    const data = await res.json();
    // Servers pedidos que não vieram = sem sala; troca a foto inteira dos pedidos.
    const fresh = {};
    chosenServers.forEach((id) => { fresh[id] = (data.guilds && data.guilds[id]) || []; });
    applyLives(fresh);
  }catch(e){
    livesError = true;
    renderServersUI();
  }finally{
    livesBusy = false;
  }
}

function livesPollingAllowed(){
  return !!discordUser && chosenServers.length > 0 && document.visibilityState === 'visible';
}

async function pollLives(){
  clearTimeout(livesTimer);
  if(!livesPollingAllowed()) return;
  await fetchLives();
  clearTimeout(livesTimer);
  // Na call a lista vem pelo push; a consulta é só rede de segurança (e a bolinha dos outros servers).
  if(livesPollingAllowed()) livesTimer = setTimeout(pollLives, room ? LIVES_POLL_ROOM_MS : presenceConnected() ? LIVES_POLL_SAFETY_MS : LIVES_POLL_MS);
}

function startLivesPolling(){
  clearTimeout(livesTimer);
  if(livesPollingAllowed()) pollLives();
}

function stopLivesPolling(){ clearTimeout(livesTimer); }

// ---- coluna de salas dentro da call (fase 2b) ----
// Dentro da call, a mesma lista de salas fica numa coluna à esquerda (recolhível):
// dá pra ver quem está em cada sala do servidor e pular de uma pra outra sem
// passar pela tela inicial. Aberta por padrão em tela larga, fechada em estreita.
const CALL_SIDE_KEY = 'sinal:callSideOpen';
let callView = '';       // servidor cujas salas a coluna mostra
let callSideOpen = true;

function loadCallSidePref(){
  let v = null;
  try{ v = localStorage.getItem(CALL_SIDE_KEY); }catch(e){}
  callSideOpen = v === null ? window.matchMedia('(min-width: 1100px)').matches : v === '1';
}

function currentRoomGuild(){
  const m = /^s(\d+)-/.exec(roomCode || '');
  return m ? m[1] : '';
}

function renderCallSide(){
  const side = document.getElementById('callSide');
  const toggle = document.getElementById('sideToggleBtn');
  const available = !!room && !!discordUser && chosenServers.length > 0;
  const open = available && callSideOpen;
  toggle.hidden = !available;
  toggle.classList.toggle('active', open);
  side.hidden = !open;
  if(!open) return;

  if(!chosenServers.includes(callView)){
    const g = currentRoomGuild();
    callView = chosenServers.includes(g) ? g : (chosenServers.includes(serverView) ? serverView : chosenServers[0]);
  }
  const rail = document.getElementById('callRail');
  rail.innerHTML = '';
  chosenServers.forEach((id) => {
    const g = guildById(id);
    if(!g) return;
    const btn = mk('button', 'call-rail-btn' + (id === callView ? ' active' : ''));
    btn.type = 'button';
    btn.title = g.name;
    btn.setAttribute('aria-label', g.name);
    btn.dataset.view = id;
    const icon = mk('span', 'srv-icon');
    fillGuildIcon(icon, g);
    btn.appendChild(icon);
    if(guildHasLive(id)) btn.appendChild(mk('span', 'srv-live-dot'));
    rail.appendChild(btn);
  });
  const g = guildById(callView);
  document.getElementById('callSideName').textContent = g ? g.name : '';
  const list = document.getElementById('callRooms');
  list.innerHTML = '';
  const rooms = livesData[callView] || [];
  if(!rooms.length) list.appendChild(mk('div', 'srv-empty', 'Nenhuma sala ao vivo neste servidor.'));
  rooms.forEach((r) => list.appendChild(renderRoomRow(r, roomCode)));
}

function toggleCallSide(){
  callSideOpen = !callSideOpen;
  try{ localStorage.setItem(CALL_SIDE_KEY, callSideOpen ? '1' : '0'); }catch(e){}
  renderCallSide();
}

// Pular de sala sem passar pela tela inicial. Trocar de sala encerra a
// transmissão/câmera de quem está transmitindo — pergunta antes.
async function hopToRoom(name){
  if(!name || name === roomCode) return;
  const sharing = document.getElementById('shareBtn').classList.contains('active-share')
    || document.getElementById('cameraBtn').classList.contains('active-share');
  if(sharing && !(await askConfirm({ title: 'Trocar de sala?', message: 'Você está transmitindo. Trocar de sala vai parar a transmissão.', okText: 'Trocar de sala' }))) return;
  leaveRoom();
  joinServerRoom(name);
}

// ---- tempo real (HANDOFF §39) ----
// Uma conexão leve (só escuta) à sala "presence" do LiveKit. Quando alguém entra,
// sai, abre ou fecha sala, ou começa/para de transmitir num dos servers
// escolhidos, o servidor (api/lk-webhook.js) manda a foto nova daquele server
// por aqui — a lista muda na hora, sem consulta. Se a conexão cair, volta
// sozinha com espera crescente e a consulta periódica cobre o intervalo.
const PRESENCE_RETRY_MS = [2000, 5000, 10000, 30000];
let presenceRoom = null;
let presenceKey = '';
let presenceRetry = 0;
let presenceTimer = null;
let presenceConnecting = false;

function presenceConnected(){ return !!presenceRoom && presenceRoom.state === 'connected'; }

function handlePresenceData(payload, participant, kind, topic){
  if(topic !== 'lives') return;
  let msg;
  try{ msg = JSON.parse(new TextDecoder().decode(payload)); }catch(e){ return; }
  if(!msg || typeof msg.guild !== 'string' || !chosenServers.includes(msg.guild)) return;
  if(msg.refresh){ fetchLives(); return; } // foto grande demais pro pacote: busca inteira
  if(!Array.isArray(msg.rooms)) return;
  const rooms = msg.rooms.filter((r) => r && typeof r.room === 'string' && Array.isArray(r.participants));
  applyLives({ [msg.guild]: rooms });
}

function stopPresenceRoom(){
  const old = presenceRoom;
  presenceRoom = null;
  presenceKey = '';
  if(old){ try{ old.disconnect(); }catch(e){} }
}

function stopPresence(){
  clearTimeout(presenceTimer);
  presenceRetry = 0;
  stopPresenceRoom();
}

function schedulePresenceRetry(){
  clearTimeout(presenceTimer);
  if(!discordUser || !chosenServers.length) return;
  const wait = PRESENCE_RETRY_MS[Math.min(presenceRetry, PRESENCE_RETRY_MS.length - 1)];
  presenceRetry++;
  presenceTimer = setTimeout(startPresence, wait);
}

async function startPresence(){
  clearTimeout(presenceTimer);
  if(!discordUser || !chosenServers.length){ stopPresence(); return; }
  const key = chosenServers.slice().sort().join(',');
  if(presenceRoom && presenceKey === key) return;
  if(presenceConnecting) return;
  presenceConnecting = true;
  stopPresenceRoom(); // servers mudaram: fecha a anterior e abre com os novos
  try{
    const res = await fetch('/api/get-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'presence', guilds: chosenServers, session: discordUser.session })
    });
    if(res.status === 401){
      clearDiscordUser();
      renderServersUI();
      setEntryStatus('Sua sessão do Discord expirou. Entre com o Discord de novo.');
      return;
    }
    if(!res.ok) throw new Error('presence-token-' + res.status);
    const data = await res.json();
    const r = new LivekitClient.Room({ adaptiveStream: false, dynacast: false });
    r.on(LivekitClient.RoomEvent.DataReceived, handlePresenceData);
    r.on(LivekitClient.RoomEvent.Reconnected, () => { if(presenceRoom === r) fetchLives(); });
    r.on(LivekitClient.RoomEvent.Disconnected, () => {
      if(presenceRoom !== r) return; // fomos nós que fechamos
      presenceRoom = null;
      presenceKey = '';
      schedulePresenceRetry();
    });
    await r.connect(data.url, data.token, { autoSubscribe: false });
    presenceRoom = r;
    presenceKey = key;
    presenceRetry = 0;
    fetchLives(); // sincroniza o que mudou enquanto estava fora
  }catch(e){
    schedulePresenceRetry();
  }finally{
    presenceConnecting = false;
  }
}

// ---- entrar / criar ----
function joinServerRoom(roomName){
  getAudioCtx();
  connectToRoom(roomName, getName(), 'server-join');
}

function createServerRoom(){
  if(serverView === 'home' || !guildById(serverView)) return;
  getAudioCtx();
  const title = document.getElementById('srvRoomTitle').value;
  connectToRoom(null, getName(), 'server-create', { guild: serverView, title });
}

// ---- escolher servers ----
function renderServersPicker(){
  const list = document.getElementById('srvPickerList');
  const q = document.getElementById('srvPickerSearch').value.trim().toLowerCase();
  list.innerHTML = '';
  const guilds = myGuilds();
  if(!guilds.length){
    list.appendChild(mk('div', 'srv-empty', 'O Discord não devolveu nenhum servidor. Se você entrou em algum agora, use "Atualizar meus servidores".'));
    return;
  }
  const shown = guilds.filter((g) => !q || g.name.toLowerCase().includes(q));
  if(!shown.length) list.appendChild(mk('div', 'srv-empty', 'Nenhum servidor com esse nome.'));
  shown.forEach((g) => {
    const row = mk('label', 'srv-pick-row');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = chosenServers.includes(g.id);
    box.addEventListener('change', () => {
      if(box.checked){
        if(chosenServers.length >= MAX_CHOSEN_SERVERS){
          box.checked = false;
          document.getElementById('srvPickerMsg').textContent = 'Dá pra escolher até ' + MAX_CHOSEN_SERVERS + ' servidores.';
          return;
        }
        chosenServers.push(g.id);
      } else {
        chosenServers = chosenServers.filter((id) => id !== g.id);
        if(serverView === g.id){ serverView = 'home'; saveServerView(); }
      }
      document.getElementById('srvPickerMsg').textContent = '';
      saveChosenServers();
      renderServersUI();
      fetchLives();
    });
    const icon = mk('span', 'srv-icon srv-icon-sm');
    fillGuildIcon(icon, g);
    row.appendChild(box);
    row.appendChild(icon);
    row.appendChild(mk('span', 'srv-pick-name', g.name));
    if(TIER_LABEL[g.tier]) row.appendChild(mk('span', 'srv-pick-tier mono', g.tier === 'o' ? 'dono' : g.tier === 'a' ? 'admin' : 'gerencia'));
    list.appendChild(row);
  });
}

function openServersPicker(){
  document.getElementById('srvPickerSearch').value = '';
  renderServersPicker();
  document.getElementById('srvPickerOverlay').hidden = false;
  document.getElementById('srvPickerSearch').focus();
}

function closeServersPicker(){
  document.getElementById('srvPickerOverlay').hidden = true;
  saveChosenServers(); // fecha sem escolher nada = guarda "nenhum" e não pergunta de novo sozinho
  startLivesPolling();
  startPresence();
}

function setupServersUI(){
  loadServerPrefs();
  renderServersUI();

  document.getElementById('srvRail').addEventListener('click', (e) => {
    const btn = e.target.closest('.srv-rail-btn');
    if(!btn) return;
    if(btn.dataset.view === '+') openServersPicker();
    else setServerView(btn.dataset.view);
  });
  document.getElementById('srvRooms').addEventListener('click', (e) => {
    const row = e.target.closest('.srv-room');
    if(row) joinServerRoom(row.dataset.room);
  });
  document.getElementById('srvCreateBtn').addEventListener('click', createServerRoom);
  loadCallSidePref();
  document.getElementById('sideToggleBtn').addEventListener('click', toggleCallSide);
  document.getElementById('callRail').addEventListener('click', (e) => {
    const btn = e.target.closest('.call-rail-btn');
    if(btn){ callView = btn.dataset.view; renderCallSide(); }
  });
  document.getElementById('callRooms').addEventListener('click', (e) => {
    const row = e.target.closest('.srv-room');
    if(row) hopToRoom(row.dataset.room);
  });
  document.getElementById('srvRoomTitle').addEventListener('keydown', (e) => { if(e.key === 'Enter') createServerRoom(); });

  const overlay = document.getElementById('srvPickerOverlay');
  document.getElementById('srvPickerClose').addEventListener('click', closeServersPicker);
  document.getElementById('srvPickerDone').addEventListener('click', closeServersPicker);
  overlay.addEventListener('click', (e) => { if(e.target === overlay) closeServersPicker(); });
  document.addEventListener('keydown', (e) => { if(e.key === 'Escape' && !overlay.hidden) closeServersPicker(); });
  document.getElementById('srvPickerSearch').addEventListener('input', renderServersPicker);
  // Renova o login em silêncio (prompt=none no Discord) pra puxar a lista de servers de novo.
  document.getElementById('srvPickerRefresh').addEventListener('click', () => {
    if(hasAppLogin()) startAppLogin({ refresh: true });
    else window.location.href = '/api/discord-login?refresh=1';
  });

  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'visible'){ startLivesPolling(); startPresence(); } else stopLivesPolling();
  });

  // Primeira vez logado (nunca escolheu servers): já abre o seletor. Não
  // atrapalha quem chegou por convite ou voltou de uma recuperação.
  let asked = true;
  try{ asked = localStorage.getItem(SERVERS_KEY) !== null; }catch(e){}
  const params = new URLSearchParams(window.location.search);
  if(discordUser && myGuilds().length && !asked && !params.has('sala')) openServersPicker();
  else startLivesPolling();
  startPresence();
}

// ---------------- Novidades (patch notes / log de versões) ----------------
// Conteúdo em public/changelog.json (fonte única — a janela de atualização
// do app e as notas da release do GitHub saem dele também, ver HANDOFF §34).
// Abre sozinho UMA vez quando entra uma novidade que a pessoa ainda não viu
// — só na tela inicial, nunca dentro de uma sala, e nunca pra quem está
// abrindo o Sinal pela primeira vez (não tem "o que mudou" pra quem chegou agora).
const CHANGELOG_SEEN_KEY = 'sinal:changelogSeen';
let changelogEntries = null;

function formatChangelogDate(iso){
  const [y, m, d] = String(iso).split('-').map(Number);
  if(!y || !m || !d) return String(iso);
  return new Date(y, m - 1, d).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function renderChangelog(){
  const list = document.getElementById('changelogList');
  list.innerHTML = '';
  (changelogEntries || []).forEach((entry, i) => {
    const art = document.createElement('article');
    // "destaque": true no changelog.json = mudança grande (ganha moldura e selo); o resto fica mais discreto
    const major = entry.destaque === true;
    art.className = 'changelog-entry' + (i === 0 ? ' latest' : '') + (major ? ' major' : '');
    const meta = document.createElement('div');
    meta.className = 'changelog-meta mono';
    if(major){
      const big = document.createElement('span');
      big.className = 'changelog-major';
      big.textContent = 'Grande novidade';
      meta.appendChild(big);
    }
    if(i === 0){
      const isNew = document.createElement('span');
      isNew.className = 'changelog-new';
      isNew.textContent = 'Novo';
      meta.appendChild(isNew);
    }
    const date = document.createElement('span');
    date.textContent = formatChangelogDate(entry.date);
    meta.appendChild(date);
    [['site', 'Site'], ['app', 'App']].forEach(([key, label]) => {
      if(!entry[key]) return;
      const chip = document.createElement('span');
      chip.className = 'changelog-chip';
      chip.textContent = `${label} v${entry[key]}`;
      meta.appendChild(chip);
    });
    const title = document.createElement('h3');
    title.textContent = entry.title || '';
    const ul = document.createElement('ul');
    (entry.items || []).forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    });
    art.append(meta, title, ul);
    list.appendChild(art);
  });
}

function markChangelogSeen(){
  if(!changelogEntries || !changelogEntries.length) return;
  try{ localStorage.setItem(CHANGELOG_SEEN_KEY, changelogEntries[0].id); }catch(e){ /* sem localStorage: só não lembra */ }
  document.getElementById('changelogBtn').classList.remove('has-new');
}

function openChangelog(){
  if(!changelogEntries) return;
  renderChangelog();
  document.getElementById('changelogOverlay').hidden = false;
  document.getElementById('changelogList').scrollTop = 0;
  markChangelogSeen();
}

function closeChangelog(){ document.getElementById('changelogOverlay').hidden = true; }

async function setupChangelog(){
  const btn = document.getElementById('changelogBtn');
  const overlay = document.getElementById('changelogOverlay');
  btn.addEventListener('click', openChangelog);
  document.getElementById('changelogCloseBtn').addEventListener('click', closeChangelog);
  overlay.addEventListener('click', (e) => { if(e.target === overlay) closeChangelog(); });
  document.addEventListener('keydown', (e) => { if(e.key === 'Escape' && !overlay.hidden) closeChangelog(); });

  try{
    const res = await fetch('changelog.json', { cache: 'no-cache' });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if(!Array.isArray(data) || !data.length) throw new Error('vazio');
    changelogEntries = data;
  }catch(e){
    btn.hidden = true; // sem o arquivo, o botão não tem o que mostrar
    return;
  }

  const latest = changelogEntries[0].id;
  let seen = null;
  let returningUser = false;
  try{
    seen = localStorage.getItem(CHANGELOG_SEEN_KEY);
    returningUser = ['sinal:lastName', 'sinal:lastRoomCode', 'sinal:shareQuality', 'sinal:shareElectronAudio', 'sinal:session']
      .some((k) => localStorage.getItem(k) !== null);
  }catch(e){ /* sem localStorage: trata como primeira visita */ }
  if(seen === latest) return;
  if(seen === null && !returningUser){ markChangelogSeen(); return; }

  btn.classList.add('has-new');
  // Link de convite (?sala=) vai direto pra sala — não cobre a entrada com
  // a janela; a bolinha no botão fica avisando.
  const viaInvite = new URLSearchParams(location.search).has('sala');
  if(!viaInvite && !document.body.classList.contains('in-room')) openChangelog();
}

// pré-preenche a preferência de qualidade de compartilhamento salva (§
// SHARE_QUALITY_PRESETS) — mesma lógica de nome/código, lembrada entre visitas.
function prefillShareQuality(){
  try{
    const saved = localStorage.getItem('sinal:shareQuality');
    // 'high'/'low' = valores do antigo botão HD/720p (até a v0.8.47)
    const migrated = { high: 'nitido', low: 'leve' }[saved] || saved;
    if(SHARE_QUALITY_PRESETS[migrated]) shareQuality = effectiveShareQuality(migrated);
  }catch(e){ /* localStorage indisponível — sem problema, fica no padrão (Nítido) */ }
  updateQualityBtn();
}

// Mostra o botão de áudio isolado só dentro do Electron (ver #audioToggleBtn
// em style.css) e restaura a preferência lembrada — mesma lógica de
// prefillShareQuality().
function prefillShareElectronAudio(){
  if(!(window.sinalElectron && window.sinalElectron.isElectron)) return;
  document.getElementById('audioToggleBtn').classList.add('on');
  try{
    const saved = localStorage.getItem('sinal:shareElectronAudio');
    if(saved === '1' || saved === '0') shareElectronAudio = saved === '1';
  }catch(e){ /* localStorage indisponível — sem problema, fica no padrão (ligado) */ }
  updateAudioToggleBtn();
}

// Atalho global (registrado em main.js, configurável via settingsPanel
// abaixo, dispara mesmo com a janela minimizada) — chama a MESMA
// toggleShare() do botão. Ela já é um no-op fora de uma sala (`if(!room)
// return`), então não precisa checar sala nenhuma aqui.
function setupGlobalShareShortcut(){
  if(!(window.sinalElectron && window.sinalElectron.isElectron)) return;
  window.sinalElectron.onToggleShareShortcut(() => {
    // Se é pra COMEÇAR (não tem publicação de tela ainda) e a preferência
    // "tela inteira direto" tá ligada, avisa o processo principal ANTES de
    // chamar toggleShare() — ele vai pular o seletor na próxima chamada de
    // getDisplayMedia (ver skipPickerOnce em main.js).
    if(room){
      const { Track } = LivekitClient;
      const isSharing = !!room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
      if(!isSharing && electronSettings.quickShareWholeScreen){
        window.sinalElectron.requestQuickShare();
      }
    }
    toggleShare();
  });
}

// Formata o acelerador no formato do Electron ("Control+Alt+S") pro jeito
// que Windows costuma mostrar tecla de atalho ("Ctrl+Alt+S").
function formatShortcutForDisplay(accelerator){
  return (accelerator || '').replace(/Control/g, 'Ctrl').replace(/Super/g, 'Win');
}

// Painel de configurações do app desktop (ver HANDOFF §26/§29). Settings
// vivem num JSON próprio do Electron (não localStorage), lidas/gravadas via
// IPC (getSettings/setSettings em preload.js) — main.js precisa delas
// prontas antes da página existir (registrar o atalho, decidir se abre
// escondido) já no app.whenReady().
function setupSettingsPanel(){
  if(!(window.sinalElectron && window.sinalElectron.isElectron)) return;

  const overlay = document.getElementById('settingsOverlay');
  const btn = document.getElementById('settingsBtn');
  const closeBtn = document.getElementById('settingsCloseBtn');
  const shortcutEnabledCb = document.getElementById('settingsShortcutEnabled');
  const quickShareCb = document.getElementById('settingsQuickShare');
  const shortcutDisplay = document.getElementById('settingsShortcutDisplay');
  const rebindBtn = document.getElementById('settingsRebindBtn');
  const rebindHint = document.getElementById('settingsRebindHint');
  const errorEl = document.getElementById('settingsError');
  const startupSection = document.getElementById('settingsStartupSection');
  const startWithWindowsCb = document.getElementById('settingsStartWithWindows');
  const startMinimizedCb = document.getElementById('settingsStartMinimized');
  const audioSection = document.getElementById('settingsAudioSection');
  const excludedList = document.getElementById('settingsExcludedList');

  const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; };
  const clearError = () => { errorEl.hidden = true; };

  function renderExcludedList(apps){
    excludedList.innerHTML = '';
    if(!apps.length){
      const empty = document.createElement('span');
      empty.className = 'settings-excluded-empty';
      empty.textContent = 'Nenhum app excluído.';
      excludedList.appendChild(empty);
      return;
    }
    apps.forEach((exe) => {
      // nome vem do Windows (processo), monta via DOM em vez de innerHTML
      const item = document.createElement('span');
      item.className = 'settings-excluded-item';
      const name = document.createElement('span');
      name.textContent = exe;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = 'Voltar a incluir no áudio';
      remove.setAttribute('aria-label', `Voltar a incluir ${exe} no áudio`);
      remove.addEventListener('click', async () => {
        const res = await window.sinalElectron.setSettings({
          excludedAudioApps: (electronSettings.excludedAudioApps || []).filter((e) => e !== exe)
        });
        applySettingsToUI(res.settings);
      });
      item.append(name, remove);
      excludedList.appendChild(item);
    });
  }

  function applySettingsToUI(settings){
    electronSettings = settings;
    // Instalador novo escolhe a qualidade no seletor de tela — some o botão
    // de qualidade do site (instalador antigo não tem shareQuality: fica).
    document.body.classList.toggle('picker-quality', typeof settings.shareQuality === 'string');
    shortcutEnabledCb.checked = settings.shortcutEnabled;
    quickShareCb.checked = settings.quickShareWholeScreen;
    shortcutDisplay.textContent = formatShortcutForDisplay(settings.shortcut);

    // Sem o atalho ligado, rebind/tela-inteira-direto não fazem sentido —
    // desabilita visualmente em vez de deixar clicável sem efeito nenhum.
    const enabled = settings.shortcutEnabled;
    rebindBtn.disabled = !enabled;
    quickShareCb.disabled = !enabled;
    document.getElementById('settingsShortcutRow').classList.toggle('settings-row-disabled', !enabled);
    document.getElementById('settingsQuickShareRow').classList.toggle('settings-row-disabled', !enabled);

    // O site novo chega pelo Vercel antes do instalador novo: com um
    // main.js antigo essas chaves nem existem, e ligar a opção não faria
    // nada — então as seções só aparecem quando o main.js já as conhece.
    const supportsStartup = 'startWithWindows' in settings;
    startupSection.hidden = !supportsStartup;
    if(supportsStartup){
      startWithWindowsCb.checked = !!settings.startWithWindows;
      startMinimizedCb.checked = !!settings.startMinimized;
      // "minimizado" só vale ao abrir junto com o Windows — mesmo padrão
      // de dependência do atalho acima
      startMinimizedCb.disabled = !settings.startWithWindows;
      document.getElementById('settingsStartMinimizedRow').classList.toggle('settings-row-disabled', !settings.startWithWindows);
    }
    const supportsExcluded = Array.isArray(settings.excludedAudioApps);
    audioSection.hidden = !supportsExcluded;
    if(supportsExcluded) renderExcludedList(settings.excludedAudioApps);
  }

  window.sinalElectron.getSettings().then(applySettingsToUI);

  // Relatório de problema (instalador v0.3.13+, precisa do registro do app).
  if(typeof window.sinalElectron.getLogTail === 'function'){
    document.getElementById('settingsReportSection').hidden = false;
    document.getElementById('settingsReportBtn').addEventListener('click', openReportDialog);
  }

  // Atualizações (instalador v0.3.11+): status ao vivo + procurar na mão.
  // Instalador antigo não tem essas funções — a seção fica escondida.
  const updatesSection = document.getElementById('settingsUpdatesSection');
  if(typeof window.sinalElectron.checkForUpdates === 'function'){
    const updateStatus = document.getElementById('settingsUpdateStatus');
    const updateBtn = document.getElementById('settingsUpdateBtn');
    const current = 'v' + window.sinalElectron.appVersion;
    let updateReady = false;
    const renderUpdateState = (st) => {
      const v = st && st.version ? 'v' + st.version : 'nova versão';
      const texts = {
        checking: 'Procurando atualização…',
        latest: `Você já está na versão mais recente (${current}).`,
        downloading: `Baixando ${v}…` + (st && st.percent != null ? ` ${st.percent}%` : ''),
        ready: `${v} pronta — reinicie pra instalar (ou ela instala sozinha quando você fechar o app).`,
        error: 'Não consegui procurar agora — confira a internet e tente de novo.',
        dev: 'Modo de desenvolvimento — sem atualização automática.'
      };
      const status = st && st.status;
      updateStatus.textContent = texts[status] || `Você está na ${current}.`;
      updateReady = status === 'ready';
      updateBtn.textContent = updateReady ? 'Reiniciar e instalar' : 'Procurar atualização';
      updateBtn.disabled = status === 'checking' || status === 'downloading';
    };
    updatesSection.hidden = false;
    window.sinalElectron.onUpdateState(renderUpdateState);
    window.sinalElectron.getUpdateState().then(renderUpdateState);
    updateBtn.addEventListener('click', () => {
      if(updateReady) window.sinalElectron.installUpdate();
      else window.sinalElectron.checkForUpdates().then(renderUpdateState);
    });
    // Item "Procurar atualização" da bandeja abre direto aqui.
    window.sinalElectron.onOpenSettings(() => {
      if(overlay.hidden) btn.click();
      updatesSection.scrollIntoView({ block: 'nearest' });
    });
  }

  // Recarrega ao abrir: a lista de excluídos muda por fora do painel (quando
  // a pessoa desmarca um app no checklist de áudio durante o compartilhamento).
  btn.addEventListener('click', () => {
    overlay.hidden = false;
    clearError();
    window.sinalElectron.getSettings().then(applySettingsToUI);
  });
  const closeOverlay = () => { overlay.hidden = true; cancelRebind(); };
  closeBtn.addEventListener('click', closeOverlay);
  overlay.addEventListener('click', (e) => { if(e.target === overlay) closeOverlay(); });

  shortcutEnabledCb.addEventListener('change', async () => {
    clearError();
    const res = await window.sinalElectron.setSettings({ shortcutEnabled: shortcutEnabledCb.checked });
    applySettingsToUI(res.settings);
    if(shortcutEnabledCb.checked && !res.shortcutRegistered){
      showError('Não consegui ativar esse atalho — outro programa já deve estar usando essa combinação.');
    }
  });

  quickShareCb.addEventListener('change', async () => {
    const res = await window.sinalElectron.setSettings({ quickShareWholeScreen: quickShareCb.checked });
    applySettingsToUI(res.settings);
  });

  startWithWindowsCb.addEventListener('change', async () => {
    const res = await window.sinalElectron.setSettings({ startWithWindows: startWithWindowsCb.checked });
    applySettingsToUI(res.settings);
  });

  startMinimizedCb.addEventListener('change', async () => {
    const res = await window.sinalElectron.setSettings({ startMinimized: startMinimizedCb.checked });
    applySettingsToUI(res.settings);
  });

  // Gravação de nova combinação: espera o próximo keydown com pelo menos um
  // modificador (Ctrl/Alt/Win) + uma tecla final simples (letra/número/F1-F24).
  // Esc cancela sem mudar nada.
  let capturing = false;
  function cancelRebind(){
    if(!capturing) return;
    capturing = false;
    rebindHint.hidden = true;
    document.removeEventListener('keydown', onRebindKeydown, true);
  }

  function onRebindKeydown(e){
    e.preventDefault();
    if(e.key === 'Escape'){ cancelRebind(); return; }
    if(['Control','Alt','Shift','Meta'].includes(e.key)) return; // ainda só o modificador, espera a tecla final

    const parts = [];
    if(e.ctrlKey) parts.push('Control');
    if(e.altKey) parts.push('Alt');
    if(e.shiftKey) parts.push('Shift');
    if(e.metaKey) parts.push('Super');
    if(parts.length === 0){
      showError('Precisa de pelo menos uma tecla modificadora (Ctrl, Alt...) junto.');
      return;
    }

    let key;
    if(/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) key = e.key;
    else if(e.key.length === 1) key = e.key.toUpperCase();
    else { showError('Essa tecla não é suportada, tenta outra combinação.'); return; }

    parts.push(key);
    const accelerator = parts.join('+');
    cancelRebind();
    clearError();

    window.sinalElectron.setSettings({ shortcut: accelerator }).then((res) => {
      applySettingsToUI(res.settings);
      if(!res.shortcutRegistered && res.settings.shortcutEnabled){
        showError('Não consegui registrar essa combinação — outro programa já deve estar usando.');
      }
    });
  }

  rebindBtn.addEventListener('click', () => {
    if(capturing) return;
    capturing = true;
    clearError();
    rebindHint.hidden = false;
    document.addEventListener('keydown', onRebindKeydown, true);
  });
}

// Ligação dos botões da interface. Ficavam como onclick="..." direto no
// index.html, o que obrigava toda função a ser global no window e — o motivo
// de terem saído — é justamente o que a Content-Security-Policy bloqueia
// (ver vercel.json): com CSP ligada e handler inline, os botões simplesmente
// param de funcionar, sem erro visível na tela.
//
// O <script> do app tem defer, então o HTML já está todo parseado quando isso
// roda — não precisa esperar o DOMContentLoaded.
[
  ['discordLoginBtn', () => loginWithDiscord()],
  ['createRoomBtn',   () => createRoom()],
  ['joinRoomBtn',     () => joinRoom()],
  ['copyCodeBtn',     (btn) => copyRoomCode(btn)],   // recebiam o `this` do onclick — agora vem do próprio listener
  ['copyLinkBtn',     (btn) => copyRoomLink(btn)],
  ['rosterBtn',       () => toggleRosterPanel()],
  ['rosterCloseBtn',  () => toggleRosterPanel(false)],
  ['chatToggleBtn',   () => toggleChatPanel()],
  ['chatCloseBtn',    () => toggleChatPanel(false)],
  ['leaveBtn',        () => leaveRoom()],
  ['cameraBtn',       () => toggleCamera()],
  ['shareBtn',        () => toggleShare()],
  ['qualityBtn',      () => toggleQualityMenu()],
  ['audioToggleBtn',  () => toggleElectronAudio()]
].forEach(([id, handler]) => {
  const el = document.getElementById(id);
  if(!el){
    // Não deveria acontecer — mas se um id sumir do HTML numa mudança futura,
    // é melhor gritar no console do que o botão virar decoração em silêncio.
    console.error('Botão não encontrado no HTML:', id);
    return;
  }
  el.addEventListener('click', () => handler(el));
});

window.addEventListener('DOMContentLoaded', () => {
  // Marca pro CSS esconder coisa que só faz sentido no navegador normal
  // (descrição de "o que é isso"/compatibilidade, botão de instalar PWA) —
  // dentro do Electron isso só lembra que é um site, não um app de verdade.
  if(window.sinalElectron && window.sinalElectron.isElectron) document.body.classList.add('electron-app');
  if(MAINTENANCE_MODE){
    document.getElementById('entryScreen').style.display = 'none';
    document.getElementById('maintenanceScreen').classList.add('on');
    return;
  }
  loadDiscordUser();
  handleDiscordCallback();
  prefillJoinCode();
  prefillLastName();
  setupQualityMenu();
  setupChangelog();
  prefillShareQuality();
  prefillShareElectronAudio();
  renderDiscordStatus();
  setupOpenInApp();
  setupGlobalShareShortcut();
  setupSettingsPanel();
  setupReportDialog();
  setupServersUI();
  setupAppLogin();
  setupStageFit();
  resumeAfterAppRecovery();
});

// Tenta desconectar educadamente ao fechar/recarregar a aba, pra sumir na
// hora pros outros em vez de depender só da detecção de queda do LiveKit.
window.addEventListener('beforeunload', () => {
  if(room){ try{ room.disconnect(); }catch(e){} }
});

// PWA: versão, registro do service worker, detecção de atualização e botão de instalação
const APP_VERSION = '0.8.61'; // bump aqui (e no CACHE do sw.js) a cada publicação — semver: 0.1, 0.2 ... 1.0
// Dentro do Electron, mostra a versão do INSTALADOR (electron/package.json),
// não a do site — ver preload.js. Fora dele (navegador normal), continua a
// versão do deploy de sempre.
document.getElementById('versionLabel').textContent = 'v' + ((window.sinalElectron && window.sinalElectron.appVersion) || APP_VERSION);

if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // checa por atualização já ao abrir, sempre que a aba volta a ficar visível, e periodicamente
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if(document.visibilityState === 'visible') reg.update().catch(() => {});
      });
      setInterval(() => reg.update().catch(() => {}), 15 * 60 * 1000);

      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if(!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          // 'installed' + já existia um controller = isso é uma atualização, não a primeira instalação.
          if(newWorker.state === 'installed' && navigator.serviceWorker.controller){
            siteUpdateReady = true;
            renderUpdateBar();
          }
        });
      });
    }).catch(() => {});
  });
}

// ---- Janela de confirmação do Sinal (no lugar do confirm() do navegador, que não aceita estilo) ----
// Devolve uma Promise<boolean>: true = confirmou; false = cancelou, apertou Esc ou clicou fora.
// Em ações destrutivas (danger) o foco começa no "Cancelar", pra um Enter sem querer não confirmar.
let confirmFinish = null;
function askConfirm({ title, message, okText = 'Continuar', cancelText = 'Cancelar', danger = false }){
  const overlay = document.getElementById('confirmOverlay');
  const okBtn = document.getElementById('confirmOkBtn');
  const cancelBtn = document.getElementById('confirmCancelBtn');
  if(confirmFinish) confirmFinish(false); // já havia uma aberta: fecha como cancelada
  document.getElementById('confirmTitle').textContent = title || '';
  document.getElementById('confirmMessage').textContent = message || '';
  okBtn.textContent = okText;
  cancelBtn.textContent = cancelText;
  okBtn.classList.toggle('danger-fill', !!danger);
  const previousFocus = document.activeElement;
  return new Promise((resolve) => {
    const onKey = (e) => {
      if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); finish(false); }
      else if(e.key === 'Tab'){ // o foco fica preso nos dois botões enquanto a janela está aberta
        e.preventDefault();
        (document.activeElement === okBtn ? cancelBtn : okBtn).focus();
      }
    };
    const finish = (value) => {
      confirmFinish = null;
      overlay.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      okBtn.onclick = cancelBtn.onclick = overlay.onclick = null;
      try{ if(previousFocus && previousFocus.focus) previousFocus.focus(); }catch(e){ /* elemento sumiu */ }
      resolve(value);
    };
    confirmFinish = finish;
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    overlay.onclick = (e) => { if(e.target === overlay) finish(false); };
    document.addEventListener('keydown', onKey, true);
    overlay.hidden = false;
    (danger ? cancelBtn : okBtn).focus();
  });
}

// ---- Aviso de atualização (um só por vez) ----
// O site novo (service worker) e o instalador novo do app são duas atualizações diferentes. Dentro do app
// as duas podem existir ao mesmo tempo; mostrar os dois botões confundiria. Regra: se o app tem uma versão
// nova pronta, o aviso é o dela (reiniciar já abre o site novo, então o do site fica de fora); se o app
// está baixando, espera; senão, só o do site. Sem nada novo, a barra some. No navegador comum não há app.
let siteUpdateReady = false;
let appUpdateStatus = null;

function pickUpdateBar(siteReady, appStatus){
  if(appStatus === 'ready') return 'app';
  if(appStatus === 'downloading') return null;
  return siteReady ? 'site' : null;
}

function renderUpdateBar(){
  const mode = pickUpdateBar(siteUpdateReady, appUpdateStatus);
  const bar = document.getElementById('updateBar');
  bar.dataset.mode = mode || '';
  bar.style.display = mode ? 'flex' : 'none';
  if(!mode) return;
  document.getElementById('updateBarText').textContent = mode === 'app' ? 'Nova versão do app pronta' : 'Nova versão disponível';
  document.getElementById('updateBtn').textContent = mode === 'app' ? 'Reiniciar e instalar' : 'Atualizar';
}

// Atualizar (recarregar o site ou reiniciar o app) derruba a chamada: dentro de uma sala pede confirmação.
function updateLeaveWarning(inRoom, isSharing){
  if(!inRoom) return null;
  return 'Atualizar agora vai fazer você sair da sala' + (isSharing ? ' e parar a sua transmissão' : '') + '.';
}

document.getElementById('updateBtn').addEventListener('click', async () => {
  const isSharing = document.getElementById('shareBtn').classList.contains('active-share')
    || document.getElementById('cameraBtn').classList.contains('active-share');
  const warning = updateLeaveWarning(document.body.classList.contains('in-room'), isSharing);
  if(warning && !(await askConfirm({ title: 'Atualizar agora?', message: warning, okText: 'Atualizar' }))) return;
  if(document.getElementById('updateBar').dataset.mode === 'app') window.sinalElectron.installUpdate();
  else window.location.reload();
});

// Instalador 0.3.11+ avisa o estado da atualização do app; os mais antigos só mostram o aviso do site.
if(window.sinalElectron && typeof window.sinalElectron.onUpdateState === 'function' && typeof window.sinalElectron.getUpdateState === 'function'){
  const onAppUpdate = (st) => { appUpdateStatus = st && st.status; renderUpdateBar(); };
  window.sinalElectron.onUpdateState(onAppUpdate);
  window.sinalElectron.getUpdateState().then(onAppUpdate).catch(() => {});
}

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  // Dentro do Electron já é um app instalado — "instalar" de novo não faz
  // sentido (também escondido via CSS, isso aqui é só pra nem guardar o
  // prompt à toa).
  if(window.sinalElectron && window.sinalElectron.isElectron) return;
  deferredInstallPrompt = e;
  document.getElementById('installBtn').style.display = 'inline-flex';
});
document.getElementById('installBtn').addEventListener('click', async () => {
  if(!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  document.getElementById('installBtn').style.display = 'none';
});
window.addEventListener('appinstalled', () => { document.getElementById('installBtn').style.display = 'none'; });

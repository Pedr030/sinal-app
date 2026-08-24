// SINAL — sala de tela ao vivo, via LiveKit Cloud (SFU gerenciado).
//
// Migrado da malha P2P (PeerJS) pra um SFU depois de um relato real: alguém
// compartilhando Terraria via a versão em malha via CPU disparar, porque
// nessa arquitetura antiga quem compartilha recodifica o vídeo uma vez POR
// PESSOA assistindo. Com um SFU, a codificação é feita uma vez só — o
// servidor do LiveKit é quem retransmite pra todo mundo. Ver HANDOFF.md.

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
function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
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
const tileStreams = new Map(); // tileId -> MediaStream (junta vídeo+áudio da mesma fonte, ex: tela+áudio da guia)
const tileVideoTracks = new Map(); // tileId -> Track de vídeo do LiveKit (pra amostrar getRTCStatsReport())

function setEntryStatus(msg){ document.getElementById('entryStatus').textContent = msg || ''; }
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

// ---------------- ENTRY / CONEXÃO COM A SALA ----------------
function createRoom(){
  getAudioCtx();
  connectToRoom(genCode(), getName(), 'create');
}
function joinRoom(){
  getAudioCtx();
  const code = document.getElementById('joinCodeInput').value.trim().toUpperCase();
  if(!code){ setEntryStatus('Digite o código da sala.'); return; }
  connectToRoom(code, getName(), 'join');
}

// Pede um token de acesso pra função serverless (que fala com a API do
// LiveKit usando a API secret — nunca exposta aqui no navegador) e conecta.
// "mode" distingue criar de entrar do lado do servidor: entrar num código
// que não existe dá erro de verdade ("sala não encontrada") em vez de criar
// uma sala vazia silenciosa — sem isso, digitar o código errado deixava a
// pessoa sozinha numa sala fantasma sem nenhum aviso (relato real, ver
// HANDOFF §5).
async function connectToRoom(code, name, mode){
  myName = name;
  roomCode = code;
  setEntryStatus('Conectando...');

  let token, url;
  try{
    const res = await fetch(`/api/get-token?room=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}&mode=${encodeURIComponent(mode)}`);
    if(res.status === 404){
      setEntryStatus('Sala não encontrada. Confira o código.');
      return;
    }
    if(!res.ok) throw new Error('token-fetch-failed');
    const data = await res.json();
    token = data.token; url = data.url;
    if(!token || !url) throw new Error('token-fetch-empty');
  }catch(e){
    setEntryStatus('Não foi possível falar com o servidor. Confira sua internet e tente de novo.');
    return;
  }

  room = new LivekitClient.Room({ adaptiveStream: true, dynacast: true });
  wireRoomEvents(room);

  try{
    await Promise.race([
      room.connect(url, token),
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
  liveRoom.on(RoomEvent.ParticipantConnected, () => { if(isCurrent()) renderAvatars(); });
  liveRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
    if(!isCurrent()) return;
    removeTile(participant.identity);
    removeTile(participant.identity + ':cam');
    renderAvatars();
  });
  liveRoom.on(RoomEvent.TrackPublished, () => { if(isCurrent()) renderAvatars(); });
  liveRoom.on(RoomEvent.TrackUnpublished, () => { if(isCurrent()) renderAvatars(); });
  // Cobre parar de compartilhar pelo controle nativo do navegador ("Parar
  // apresentação"), não só pelo nosso próprio botão.
  liveRoom.on(RoomEvent.LocalTrackUnpublished, (publication) => {
    if(!isCurrent()) return;
    if(publication.source === Track.Source.ScreenShare) resetShareButton();
    if(publication.source === Track.Source.Camera) resetCameraButton();
  });
  liveRoom.on(RoomEvent.DataReceived, (payload, participant) => {
    if(!isCurrent()) return;
    try{
      const msg = JSON.parse(new TextDecoder().decode(payload));
      if(msg && msg.type === 'chat'){
        renderChatMessage({ name: (participant && (participant.name || participant.identity)) || 'Alguém', text: msg.text, ts: msg.ts }, false);
      }
    }catch(e){ /* payload em formato inesperado, ignora */ }
  });
  liveRoom.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
    if(!isCurrent()) return;
    if(participant) updateQualityDot(participant.identity, quality);
  });
  liveRoom.on(RoomEvent.Disconnected, () => {
    if(!isCurrent()) return;
    setRoomStatus('Desconectado da sala.', true);
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
  }
}

function handleTrackRemoved(track, publication, participant){
  const { Track } = LivekitClient;
  const source = publication.source;
  let tileId;
  if(source === Track.Source.Camera) tileId = participant.identity + ':cam';
  else if(source === Track.Source.ScreenShare || source === Track.Source.ScreenShareAudio) tileId = participant.identity;
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
  }
}

function enterRoomUI(){
  document.getElementById('entryScreen').style.display = 'none';
  document.getElementById('roomScreen').style.display = 'flex';
  document.getElementById('roomCodeChip').textContent = roomCode;
  document.getElementById('selfName').firstChild.textContent = myName + ' ';
  document.getElementById('chatMessages').innerHTML = '<div class="chat-empty mono">Sem mensagens ainda</div>';
  renderAvatars();
  try{ localStorage.setItem('sinal:lastRoomCode', roomCode); }catch(e){ /* modo privado etc — sem problema, só não vai lembrar da próxima vez */ }
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
// Dois presets de qualidade pra tela — 1080p virou padrão depois que o SFU
// resolveu o multiplicador de CPU por espectador (ver HANDOFF §6/§12), mas
// upload de 4.5 Mbps sustentado não é realidade pra todo mundo no grupo.
// "leve" existe pra quem precisar (upload fraco, ou só quer economizar).
const SHARE_QUALITY_PRESETS = {
  high: {
    resolution: { width: 1920, height: 1080, frameRate: 30 },
    encoding: { maxBitrate: 4_500_000, maxFramerate: 30 },
    label: 'HD',
    title: 'Qualidade: HD (1080p, ~4.5 Mbps de upload) — clique pra mudar pra leve (720p)'
  },
  low: {
    resolution: { width: 1280, height: 720, frameRate: 24 },
    encoding: { maxBitrate: 2_500_000, maxFramerate: 24 },
    label: '720p',
    title: 'Qualidade: leve (720p, ~2.5 Mbps de upload) — clique pra voltar pra HD (1080p)'
  }
};
let shareQuality = 'high';

function updateQualityBtn(){
  const btn = document.getElementById('qualityBtn');
  if(!btn) return;
  const preset = SHARE_QUALITY_PRESETS[shareQuality];
  btn.textContent = preset.label;
  setBtnLabel(btn, preset.title);
}

function toggleShareQuality(){
  shareQuality = shareQuality === 'high' ? 'low' : 'high';
  try{ localStorage.setItem('sinal:shareQuality', shareQuality); }catch(e){ /* modo privado etc — sem problema, só não vai lembrar da próxima vez */ }
  updateQualityBtn();
}

async function toggleShare(){
  if(!room) return;
  const { Track } = LivekitClient;
  const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  if(pub){
    await room.localParticipant.setScreenShareEnabled(false);
    resetShareButton();
    return;
  }
  // Aplica o preset escolhido no botão de qualidade (§ acima) — muda só na
  // PRÓXIMA vez que começar a compartilhar, não afeta uma sessão já ativa.
  const preset = SHARE_QUALITY_PRESETS[shareQuality];
  try{
    // screenShareEncoding (2º "publishOptions", separado das opções de
    // captura): sem isso, o LiveKit usa um bitrate automático pensado pra
    // vídeo de câmera parada, baixo demais pra jogo (muito movimento/detalhe)
    // em 1080p30 — dava pra ver pixelização/bloco em teste real.
    await room.localParticipant.setScreenShareEnabled(true, {
      audio: true, // só disponibiliza a opção; o navegador pergunta de verdade no seletor nativo
      resolution: preset.resolution
    }, {
      screenShareEncoding: preset.encoding
    });
  }catch(e){
    setRoomStatus('Permissão de tela negada ou cancelada.', true);
    return;
  }

  const btn = document.getElementById('shareBtn');
  setBtnLabel(btn, 'Parar compartilhamento');
  btn.classList.add('active-share');
  document.getElementById('qualityBtn').disabled = true; // só faz sentido trocar antes de começar

  const screenPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  const selfStream = new MediaStream([screenPub.videoTrack.mediaStreamTrack]);
  const preview = document.getElementById('selfPreview');
  preview.srcObject = selfStream;
  preview.style.display = 'block';
  document.getElementById('selfStatus').textContent = 'Transmitindo';

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
  document.getElementById('selfPreview').style.display = 'none';
  document.getElementById('selfStatus').textContent = 'Assistindo';
  if(room) removeTile(room.localParticipant.identity);
  renderAvatars();
}

async function toggleCamera(){
  if(!room) return;
  const { Track } = LivekitClient;
  const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
  if(pub){
    await room.localParticipant.setCameraEnabled(false);
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

  const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
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
  let level = 'good', label = 'Boa conexão';
  if(quality === ConnectionQuality.Poor){ level = 'bad'; label = 'Conexão ruim'; }
  else if(quality === ConnectionQuality.Good){ level = 'warn'; label = 'Conexão razoável'; }
  [identity, identity + ':cam'].forEach((tileId) => {
    const tile = tiles.get(tileId);
    const dot = tile && tile.querySelector('.quality-dot');
    if(dot) dot.className = 'quality-dot ' + level;
    qualityBaseLabel.set(tileId, label);
    renderQualityTooltip(tileId);
  });
}

// Extrai perda de pacote (delta desde a última amostra, não acumulado — um
// valor acumulado desde o início da chamada fica cada vez menos
// representativo do estado ATUAL) e jitter do inbound-rtp de vídeo.
const qualityStatsPrev = new Map(); // tileId -> { lost, received } acumulados na última amostra

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

  const prev = qualityStatsPrev.get(tileId) || { lost: 0, received: 0 };
  const deltaLost = Math.max(0, (inbound.packetsLost || 0) - prev.lost);
  const deltaReceived = Math.max(0, (inbound.packetsReceived || 0) - prev.received);
  qualityStatsPrev.set(tileId, { lost: inbound.packetsLost || 0, received: inbound.packetsReceived || 0 });

  const total = deltaLost + deltaReceived;
  const lossPct = total > 0 ? (deltaLost / total) * 100 : 0;
  // jitter do WebRTC vem em segundos, por padrão — convertendo pra ms, que é
  // a unidade que faz sentido mostrar pra gente.
  const jitterMs = inbound.jitter != null ? Math.round(inbound.jitter * 1000) : null;

  const parts = [`perda: ${lossPct.toFixed(1)}%`];
  if(jitterMs != null) parts.push(`jitter: ${jitterMs}ms`);
  qualityDetails.set(tileId, parts.join(' · '));
  renderQualityTooltip(tileId);
}

setInterval(() => {
  tileVideoTracks.forEach((track, tileId) => sampleTileDetailedStats(tileId, track));
}, 4000);

// ---------------- UI: palco (destaque) + fileira (minimizados) ----------------
let tiles = new Map();     // id -> elemento .tile
let pinnedOrder = [];      // ids em destaque, no máximo 2, ordem de fixação

const ICON_VOLUME = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3,9 3,15 8,15 13,20 13,4 8,9"></polygon><path d="M16 8a5 5 0 010 8"></path></svg>';
const ICON_VOLUME_MUTED = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3,9 3,15 8,15 13,20 13,4 8,9"></polygon><line x1="16" y1="9" x2="22" y2="15"></line><line x1="22" y1="9" x2="16" y2="15"></line></svg>';
const ICON_EYE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0112 19c-7 0-11-7-11-7a21.86 21.86 0 015.06-6.06M9.9 4.24A10.94 10.94 0 0112 4c7 0 11 7 11 7a21.82 21.82 0 01-2.16 3.19M14.12 14.12a3 3 0 11-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';

function addTile(id, name, stream){
  removeTile(id);
  const isSelf = !!(room && room.localParticipant && (id === room.localParticipant.identity || id === room.localParticipant.identity + ':cam'));
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.id = id;
  tile.innerHTML = `
    <video autoplay playsinline></video>
    <div class="tile-hidden-overlay"><span class="mono">Vídeo desativado</span></div>
    <button class="fs-btn" title="Tela cheia">⛶</button>
    ${isSelf ? '' : `
    <div class="tile-controls">
      <button type="button" class="ctl-btn mute-btn" title="Mutar/desmutar">${ICON_VOLUME}</button>
      <input type="range" class="vol-slider" min="0" max="100" value="100" title="Volume">
      <button type="button" class="ctl-btn hide-btn" title="Desativar vídeo (parar de exibir e decodificar)">${ICON_EYE}</button>
    </div>`}
    <div class="label"><span class="led"></span>${escapeHtml(name)}${isSelf ? '' : '<span class="quality-dot" title="Medindo conexão..."></span>'}</div>
    <div class="pin-hint"></div>
  `;
  const video = tile.querySelector('video');
  video.srcObject = stream;
  tile.querySelector('.fs-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    video.requestFullscreen && video.requestFullscreen();
  });
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
      video.volume = volSlider.value / 100;
      if(video.volume > 0 && video.muted){
        video.muted = false;
        muteBtn.innerHTML = ICON_VOLUME;
        muteBtn.classList.remove('active');
      }
    });
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = tile.classList.toggle('render-off');
      if(isHidden){ video.pause(); } else { video.play().catch(() => {}); }
      hideBtn.classList.toggle('active', isHidden);
      hideBtn.innerHTML = isHidden ? ICON_EYE_OFF : ICON_EYE;
      hideBtn.title = isHidden ? 'Reativar vídeo' : 'Desativar vídeo (parar de exibir e decodificar)';
    });
  }

  tiles.set(id, tile);
  if(!isSelf){ playNotifyChime(); flashTabTitle(); }

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
}

function removeTile(id){
  const el = tiles.get(id);
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
    av.innerHTML = `${escapeHtml(initials(displayName))}<span class="tip">${escapeHtml(displayName)}${isYou ? ' (você)':''}</span>`;
    row.appendChild(av);
  });
  if(rosterOpen) renderRosterPanel();
}

let rosterOpen = false;

function toggleRosterPanel(force){
  rosterOpen = typeof force === 'boolean' ? force : !rosterOpen;
  document.getElementById('rosterPanel').classList.toggle('open', rosterOpen);
  if(rosterOpen) renderRosterPanel();
}

function renderRosterPanel(){
  if(!room) return;
  const { Track } = LivekitClient;
  const panel = document.getElementById('rosterPanel');
  const all = [room.localParticipant, ...room.remoteParticipants.values()];
  const items = all.map((p) => {
    const isSharing = !!(p.getTrackPublication(Track.Source.ScreenShare) || p.getTrackPublication(Track.Source.Camera));
    const isYou = p === room.localParticipant;
    const displayName = p.name || p.identity;
    return `<div class="roster-item${isSharing ? ' sharing' : ''}"><span class="roster-dot"></span>${escapeHtml(displayName)}${isYou ? ' (você)' : ''}</div>`;
  }).join('');
  panel.innerHTML = `<div class="roster-header">${all.length} na sala</div>${items}`;
}

document.addEventListener('click', (e) => {
  if(!rosterOpen) return;
  if(e.target.closest('.roster-wrap')) return;
  toggleRosterPanel(false);
});

function leaveRoom(){
  if(room){
    try{ room.disconnect(); }catch(e){}
    room = null;
  }
  toggleRosterPanel(false);
  tileStreams.clear();
  tileVideoTracks.clear();
  qualityBaseLabel.clear();
  qualityDetails.clear();
  qualityStatsPrev.clear();
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
  document.getElementById('entryScreen').style.display = 'block';
  setEntryStatus('');
  prefillJoinCode();
}

// auto-preencher código: prioridade pro link de convite (?sala=CODE); sem
// isso, cai pro último código usado (localStorage), só por conveniência —
// não é obrigado a bater com uma sala que ainda existe. Chamado tanto no
// carregamento da página quanto ao sair de uma sala — como é um SPA, sair
// não recarrega a página, então sem essa segunda chamada o valor só
// apareceria depois de um F5 de verdade.
function prefillJoinCode(){
  const params = new URLSearchParams(window.location.search);
  const sala = params.get('sala');
  if(sala){
    document.getElementById('joinCodeInput').value = sala.toUpperCase();
    return;
  }
  try{
    const lastCode = localStorage.getItem('sinal:lastRoomCode');
    if(lastCode) document.getElementById('joinCodeInput').value = lastCode;
  }catch(e){ /* localStorage indisponível — sem problema, só não pré-preenche */ }
}

// pré-preenche o nome com o último usado, salvo em getName() ao entrar numa
// sala. Só precisa rodar no carregamento inicial — diferente do código da
// sala, o campo de nome não é tocado em nenhum outro momento da sessão, então
// não some/precisa ser re-sincronizado ao sair de uma sala.
function prefillLastName(){
  try{
    const lastName = localStorage.getItem('sinal:lastName');
    if(lastName) document.getElementById('nameInput').value = lastName;
  }catch(e){ /* localStorage indisponível — sem problema, só não pré-preenche */ }
}

// pré-preenche a preferência de qualidade de compartilhamento salva (§
// SHARE_QUALITY_PRESETS) — mesma lógica de nome/código, lembrada entre visitas.
function prefillShareQuality(){
  try{
    const saved = localStorage.getItem('sinal:shareQuality');
    if(saved === 'low' || saved === 'high') shareQuality = saved;
  }catch(e){ /* localStorage indisponível — sem problema, fica no padrão (HD) */ }
  updateQualityBtn();
}

window.addEventListener('DOMContentLoaded', () => {
  prefillJoinCode();
  prefillLastName();
  prefillShareQuality();
});

// Tenta desconectar educadamente ao fechar/recarregar a aba, pra sumir na
// hora pros outros em vez de depender só da detecção de queda do LiveKit.
window.addEventListener('beforeunload', () => {
  if(room){ try{ room.disconnect(); }catch(e){} }
});

// PWA: versão, registro do service worker, detecção de atualização e botão de instalação
const APP_VERSION = '0.8.6'; // bump aqui (e no CACHE do sw.js) a cada publicação — semver: 0.1, 0.2 ... 1.0
document.getElementById('versionLabel').textContent = 'v' + APP_VERSION;

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
          // 'installed' + já existia um controller = isso é uma atualização, não a primeira instalação
          if(newWorker.state === 'installed' && navigator.serviceWorker.controller){
            document.getElementById('updateBar').style.display = 'flex';
          }
        });
      });
    }).catch(() => {});
  });
}
document.getElementById('updateBtn').addEventListener('click', () => {
  window.location.reload();
});

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
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

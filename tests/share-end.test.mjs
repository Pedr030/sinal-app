// Fim da transmissão (HANDOFF §86): todo jeito de acabar passa por endShare(reason).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(join(ROOT, 'public/app.js'), 'utf8').replace(/\r\n/g, '\n');

function extractFunction(src, name){
  const m = src.match(new RegExp('(async )?function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}', 'm'));
  if(!m) throw new Error('não achei a função ' + name);
  return m[0];
}
// Carrega funções de app.js com as globais trocadas pelas de `env` (estado incluído: atribuições caem no env).
function load(env, ...names){
  const body = names.map((n) => extractFunction(appJs, n)).join('\n');
  return new Function('env', `with(env){ ${body}; return { ${names.join(', ')} }; }`)(env);
}

const SCREEN = 'screen_share', AUDIO = 'screen_share_audio', CAMERA = 'camera';

function fakeTrack(kind){
  return { kind, stopped: 0, stop(){ this.stopped++; } };
}
function fakeRoom(sources, opts){
  const o = opts || {};
  const pubs = new Map();
  sources.forEach((source, i) => {
    const track = fakeTrack(source === AUDIO ? 'audio' : 'video');
    pubs.set('TR_' + i, { source, track, trackSid: 'TR_' + i, videoTrack: track.kind === 'video' ? track : undefined });
  });
  const lp = {
    identity: 'eu',
    trackPublications: pubs,
    unpublished: [],
    guardDuringUnpublish: [],
    getTrackPublication(source){ return [...pubs.values()].find((p) => p.source === source); },
    async unpublishTrack(track){
      lp.guardDuringUnpublish.push(env0.current && env0.current.selfInitiatedUnpublish);
      if(o.failOn && track.kind === o.failOn) throw new Error('falha simulada');
      lp.unpublished.push(track.kind);
      for(const [sid, p] of pubs) if(p.track === track) pubs.delete(sid);
    }
  };
  return { localParticipant: lp };
}
const env0 = { current: null };

function fakeEnv(room){
  const calls = [];
  const classes = new Set(['sharing']);
  const el = (id) => ({ id, disabled: true, style: {}, textContent: '', classList: { remove(){ }, add(){ }, contains(){ return false; } } });
  const els = new Map();
  const env = {
    room,
    activeShareQuality: 'nitido', activeShareCodec: 'h264', shareWantsHighProfile: true,
    gamesDegradation: { step: 1 }, sendStatsPrev: {}, senderDetailPrev: {}, loggedEncoderFor: {},
    selfInitiatedUnpublish: false, shareBusy: false, roomReconnecting: false, shareSidAtReconnect: null,
    calls,
    LivekitClient: { Track: { Source: { ScreenShare: SCREEN, ScreenShareAudio: AUDIO, Camera: CAMERA } } },
    window: { sinalElectron: { isElectron: true } },
    document: {
      body: { classList: { remove: (c) => classes.delete(c), add: (c) => classes.add(c), contains: (c) => classes.has(c) } },
      getElementById(id){ if(!els.has(id)) els.set(id, el(id)); return els.get(id); }
    },
    console: { error(){}, warn(){}, log(){} },
    appLog: (l) => calls.push('log:' + l),
    flushSendSummary: () => calls.push('flush'),
    teardownElectronIsolatedAudio: () => calls.push('teardown'),
    setBtnLabel: (b, l) => { b.label = l; },
    toggleQualityMenu(){}, updateQualityBtn(){},
    removeTile: (id) => calls.push('removeTile:' + id),
    clearViewers: (id) => calls.push('clearViewers:' + id),
    renderAvatars: () => calls.push('renderAvatars'),
    setSharingMarker: (on) => calls.push('marker:' + on),
    setRoomStatus: (m) => calls.push('status:' + m),
    resetCameraButton: () => calls.push('resetCamera'),
    sendWatchSync: () => calls.push('watchSync'),
    classes
  };
  env0.current = env;
  return env;
}
function endShareEnv(room){
  const env = fakeEnv(room);
  Object.assign(env, load(env, 'shareEndPlan'));
  Object.assign(env, load(env, 'endShare'));
  return env;
}

// ---------- tabela: motivo -> o que decide ----------
const { shareEndPlan, shareEndReasonFor } = load({}, 'shareEndPlan', 'shareEndReasonFor');

test('só a queda mantém o marcador de retomar', () => {
  for(const r of ['parou', 'saiu', 'captura-fechada', 'moderador', 'removido', 'sala-encerrada', 'falha-ao-publicar']){
    assert.equal(shareEndPlan(r).keepMarker, false, r);
  }
  assert.equal(shareEndPlan('queda').keepMarker, true);
});

test('só o moderador gera mensagem nova', () => {
  assert.equal(shareEndPlan('moderador').message, 'Um moderador desligou a sua tela');
  for(const r of ['parou', 'saiu', 'captura-fechada', 'removido', 'sala-encerrada', 'falha-ao-publicar', 'queda']){
    assert.equal(shareEndPlan(r).message, '', r);
  }
});

test('queda: decisão de alguém nunca vira "queda"; o resto vira', () => {
  const R = { UNKNOWN_REASON: 0, CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, SERVER_SHUTDOWN: 3, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5, SIGNAL_CLOSE: 9, ROOM_CLOSED: 10 };
  assert.equal(shareEndReasonFor(R.ROOM_DELETED, R), 'sala-encerrada');
  assert.equal(shareEndReasonFor(R.ROOM_CLOSED, R), 'sala-encerrada');
  assert.equal(shareEndReasonFor(R.PARTICIPANT_REMOVED, R), 'removido');
  assert.equal(shareEndReasonFor(R.DUPLICATE_IDENTITY, R), 'removido');
  assert.equal(shareEndReasonFor(R.SERVER_SHUTDOWN, R), 'queda');
  assert.equal(shareEndReasonFor(R.SIGNAL_CLOSE, R), 'queda');
  assert.equal(shareEndReasonFor(R.UNKNOWN_REASON, R), 'queda');
  assert.equal(shareEndReasonFor(undefined, R), 'queda');   // o SDK desiste de reconectar sem motivo (observado)
  assert.equal(shareEndReasonFor(4, undefined), 'queda');   // sem a lista do LiveKit
});

// ---------- endShare com room falso ----------
test('endShare zera o estado, solta o áudio isolado e grava o último minuto', async () => {
  const env = endShareEnv(fakeRoom([SCREEN, AUDIO]));
  await env.endShare('parou');
  assert.equal(env.activeShareQuality, null);
  assert.equal(env.activeShareCodec, null);
  assert.equal(env.shareWantsHighProfile, false);
  assert.equal(env.gamesDegradation, null);
  assert.equal(env.sendStatsPrev, null);
  assert.equal(env.senderDetailPrev, null);
  assert.equal(env.loggedEncoderFor, null);
  assert.equal(env.classes.has('sharing'), false);
  assert.ok(env.calls.includes('flush'));
  assert.ok(env.calls.includes('teardown'));
  assert.ok(env.calls.includes('removeTile:eu'));
  assert.ok(env.calls.includes('clearViewers:eu'));
  assert.ok(env.calls.some((c) => c.startsWith('log:') && c.includes('parou')));
  assert.equal(env.document.getElementById('selfStatus').textContent, 'Assistindo');
  assert.equal(env.document.getElementById('qualityBtn').disabled, false);
});

test('endShare limpa antes de tirar do ar: eventos em cascata encontram tudo zerado', async () => {
  const room = fakeRoom([SCREEN]);
  const env = endShareEnv(room);
  let stateAtUnpublish = 'não chamou';
  const real = room.localParticipant.unpublishTrack;
  room.localParticipant.unpublishTrack = async (t) => { stateAtUnpublish = env.activeShareQuality; return real(t); };
  await env.endShare('parou');
  assert.equal(stateAtUnpublish, null);
});

test('endShare tira do ar o vídeo e TODO áudio de tela (aba e isolado) e para as faixas (B4)', async () => {
  const room = fakeRoom([SCREEN, AUDIO, AUDIO, CAMERA]);
  const tracks = [...room.localParticipant.trackPublications.values()].map((p) => p.track);
  const env = endShareEnv(room);
  await env.endShare('moderador');
  assert.deepEqual(room.localParticipant.unpublished.sort(), ['audio', 'audio', 'video']);
  assert.equal(tracks[0].stopped > 0 && tracks[1].stopped > 0 && tracks[2].stopped > 0, true);
  assert.equal(tracks[3].stopped, 0); // a câmera não é da transmissão
  assert.deepEqual([...room.localParticipant.trackPublications.values()].map((p) => p.source), [CAMERA]);
  assert.ok(env.calls.includes('status:Um moderador desligou a sua tela'));
});

test('endShare liga o guard só enquanto tira do ar', async () => {
  const room = fakeRoom([SCREEN, AUDIO]);
  const env = endShareEnv(room);
  await env.endShare('parou');
  assert.deepEqual(room.localParticipant.guardDuringUnpublish, [true, true]);
  assert.equal(env.selfInitiatedUnpublish, false);
});

test('endShare é idempotente: a segunda chamada não faz nada', async () => {
  const room = fakeRoom([SCREEN]);
  const env = endShareEnv(room);
  await Promise.all([env.endShare('parou'), env.endShare('captura-fechada')]);
  await env.endShare('saiu');
  assert.equal(env.calls.filter((c) => c === 'flush').length, 1);
  assert.equal(env.calls.filter((c) => c === 'teardown').length, 1);
  assert.equal(env.calls.filter((c) => c.startsWith('marker:')).length, 1);
  assert.equal(room.localParticipant.unpublished.length, 1);
});

test('endShare sem transmissão não mexe em nada, a não ser com force', async () => {
  const room = fakeRoom([SCREEN]);
  const env = endShareEnv(room);
  env.activeShareQuality = null;
  await env.endShare('saiu');
  assert.equal(env.calls.length, 0);
  await env.endShare('parou', { force: true }); // publicação existe mas o estado sumiu: o botão ainda precisa parar
  assert.equal(room.localParticipant.unpublished.length, 1);
});

test('marcador: queda mantém, o resto apaga', async () => {
  const env = endShareEnv(fakeRoom([SCREEN]));
  await env.endShare('queda', { skipUnpublish: true });
  assert.equal(env.calls.includes('marker:false'), false);
  const env2 = endShareEnv(fakeRoom([SCREEN]));
  await env2.endShare('saiu', { skipUnpublish: true });
  assert.equal(env2.calls.includes('marker:false'), true);
});

test('skipUnpublish limpa tudo sem esperar nada e deixa o disconnect soltar as faixas (leaveRoom é síncrono)', () => {
  const room = fakeRoom([SCREEN, AUDIO]);
  const env = endShareEnv(room);
  env.endShare('saiu', { skipUnpublish: true }); // sem await de propósito
  assert.equal(env.activeShareQuality, null);
  assert.ok(env.calls.includes('teardown'));
  assert.equal(room.localParticipant.unpublished.length, 0);
});

test('falha ao tirar do ar: avisa, tenta as outras faixas e não prende o guard', async () => {
  const room = fakeRoom([SCREEN, AUDIO], { failOn: 'video' });
  const env = endShareEnv(room);
  await env.endShare('parou');
  assert.deepEqual(room.localParticipant.unpublished, ['audio']);
  assert.equal(env.selfInitiatedUnpublish, false);
  assert.ok(env.calls.some((c) => c.startsWith('status:Não consegui desligar a tela')));
});

test('falha ao publicar: tira do ar o vídeo que já tinha entrado (B6)', async () => {
  const room = fakeRoom([SCREEN]);
  const env = endShareEnv(room);
  await env.endShare('falha-ao-publicar');
  assert.equal(room.localParticipant.unpublished.length, 1);
  assert.equal(env.activeShareQuality, null);
  assert.ok(env.calls.includes('teardown'));
});

// ---------- trava ----------
function toggleEnv(run){
  const env = fakeEnv(fakeRoom([]));
  env.toggleShareOnce = run;
  Object.assign(env, load(env, 'toggleShare'));
  return env;
}

test('trava: o segundo pedido com o primeiro em andamento é ignorado (B3)', async () => {
  let runs = 0, release;
  const env = toggleEnv(() => { runs++; return runs === 1 ? new Promise((r) => { release = r; }) : Promise.resolve(); });
  const first = env.toggleShare();
  await env.toggleShare();
  assert.equal(runs, 1);
  assert.ok(env.calls.some((c) => c.startsWith('log:') && c.includes('ignorado')));
  release();
  await first;
  await env.toggleShare();
  assert.equal(runs, 2);
});

test('trava: solta mesmo se a operação estourar', async () => {
  const env = toggleEnv(async () => { throw new Error('x'); });
  await assert.rejects(env.toggleShare());
  assert.equal(env.shareBusy, false);
});

test('trava: fora da sala não faz nada', async () => {
  let runs = 0;
  const env = toggleEnv(async () => { runs++; });
  env.room = null;
  await env.toggleShare();
  assert.equal(runs, 0);
});

// ---------- guard de reconexão ----------
function reconnectEnv(room){
  const env = endShareEnv(room);
  Object.assign(env, load(env, 'noteRoomReconnecting', 'reconcileAfterReconnect'));
  return env;
}

test('sinalizador: guarda a faixa de antes uma vez só, mesmo com os dois eventos', () => {
  const room = fakeRoom([SCREEN]);
  const env = reconnectEnv(room);
  env.noteRoomReconnecting();
  assert.equal(env.roomReconnecting, true);
  assert.equal(env.shareSidAtReconnect, 'TR_0');
  room.localParticipant.getTrackPublication(SCREEN).trackSid = 'TR_novo';
  env.noteRoomReconnecting();
  assert.equal(env.shareSidAtReconnect, 'TR_0');
});

test('reconexão: mesma faixa, nada muda', async () => {
  const env = reconnectEnv(fakeRoom([SCREEN]));
  env.noteRoomReconnecting();
  await env.reconcileAfterReconnect();
  assert.equal(env.activeShareQuality, 'nitido');
  assert.equal(env.calls.some((c) => c.startsWith('clearViewers')), false);
  assert.ok(env.sendStatsPrev);
});

test('reconexão: faixa republicada com ID novo segue transmitindo e só atualiza o que mudou', async () => {
  const room = fakeRoom([SCREEN]);
  const env = reconnectEnv(room);
  env.noteRoomReconnecting();
  room.localParticipant.getTrackPublication(SCREEN).trackSid = 'TR_novo';
  await env.reconcileAfterReconnect();
  assert.equal(env.activeShareQuality, 'nitido');
  assert.equal(env.shareWantsHighProfile, true);
  assert.equal(env.calls.includes('marker:false'), false);
  assert.equal(env.sendStatsPrev, null);
  assert.equal(env.senderDetailPrev, null);
  assert.ok(env.calls.includes('clearViewers:eu'));
});

test('reconexão: o sender novo nasce com a regra da publicação, então a da placa volta no próximo ciclo', async () => {
  const room = fakeRoom([SCREEN]);
  const env = reconnectEnv(room);
  Object.assign(env, { H264_QUALITIES: ['jogos', 'fluido', 'nitido'], MOTION_QUALITIES: ['jogos', 'fluido'], GAMES_FLOOR_SW: 720,
    SHARE_QUALITY_PRESETS: { nitido: { name: 'Nítido' } } });
  Object.assign(env, load(env, 'gamesDegradationFor', 'adjustGamesDegradation'));
  const applied = [];
  const track = { setDegradationPreference: async (p) => { applied.push(p); } };
  const placa = { frameHeight: 1080, powerEfficientEncoder: true };
  env.gamesDegradation = null;
  await env.adjustGamesDegradation(track, placa);
  await env.adjustGamesDegradation(track, placa);
  assert.deepEqual(applied, ['maintain-framerate-and-resolution']); // aplica uma vez só

  env.noteRoomReconnecting();
  room.localParticipant.getTrackPublication(SCREEN).trackSid = 'TR_novo';
  await env.reconcileAfterReconnect();
  await env.adjustGamesDegradation(track, placa);
  assert.deepEqual(applied, ['maintain-framerate-and-resolution', 'maintain-framerate-and-resolution']);
});

test('reconexão: publicação sumiu, encerra como queda e mantém o marcador', async () => {
  const room = fakeRoom([SCREEN]);
  const env = reconnectEnv(room);
  env.noteRoomReconnecting();
  room.localParticipant.trackPublications.clear();
  await env.reconcileAfterReconnect();
  assert.equal(env.activeShareQuality, null);
  assert.equal(env.calls.includes('marker:false'), false);
  assert.ok(env.calls.some((c) => c.startsWith('log:') && c.includes('queda')));
});

test('reconexão: sem transmissão não encerra nada', async () => {
  const env = reconnectEnv(fakeRoom([]));
  env.activeShareQuality = null;
  env.noteRoomReconnecting();
  await env.reconcileAfterReconnect();
  assert.equal(env.calls.includes('flush'), false);
});

test('reconexão: câmera ligada que não voltou desliga o botão; a que voltou fica', async () => {
  const env = reconnectEnv(fakeRoom([]));
  env.activeShareQuality = null;
  env.document.getElementById('cameraBtn').classList.contains = () => true;
  await env.reconcileAfterReconnect();
  assert.ok(env.calls.includes('resetCamera'));
  assert.ok(env.calls.includes('clearViewers:eu:cam'));
  const env2 = reconnectEnv(fakeRoom([CAMERA]));
  env2.activeShareQuality = null;
  env2.document.getElementById('cameraBtn').classList.contains = () => true;
  await env2.reconcileAfterReconnect();
  assert.equal(env2.calls.includes('resetCamera'), false);
});

// ---------- ligações no código ----------
test('todo caminho de fim passa por endShare, e só ele zera o estado', () => {
  assert.equal(/resetShareButton/.test(appJs), false);
  assert.equal((appJs.match(/^\s+activeShareQuality = null;/gm) || []).length, 1);
  assert.match(extractFunction(appJs, 'endShare'), /activeShareQuality = null;/);
  assert.equal((appJs.match(/setSharingMarker\(false\)/g) || []).length, 1);
  assert.match(extractFunction(appJs, 'endShare'), /setSharingMarker\(false\)/);
  assert.match(extractFunction(appJs, 'toggleShareOnce'), /endShare\('parou', \{ force: true \}\)/);
  assert.match(extractFunction(appJs, 'toggleShareOnce'), /endShare\('falha-ao-publicar'\)/);
  assert.match(extractFunction(appJs, 'leaveRoom'), /endShare\(shareEndReason \|\| 'saiu', \{ skipUnpublish: true \}\)/);
  assert.match(appJs, /leaveRoom\(shareEndReasonFor\(reason, LivekitClient\.DisconnectReason\)\);/);
  assert.match(appJs, /endShare\('captura-fechada'\)/);
  assert.match(appJs, /endShare\('moderador'\)/);
  assert.match(extractFunction(appJs, 'reconcileAfterReconnect'), /endShare\('queda'\)/);
});

test('leaveRoom encerra a transmissão antes de soltar a sala', () => {
  const fn = extractFunction(appJs, 'leaveRoom');
  assert.ok(fn.indexOf('endShare(') < fn.indexOf('room = null'));
});

test('captura fechada espera uma microtarefa: numa queda o Disconnected chega antes e decide o motivo', () => {
  assert.match(appJs, /queueMicrotask\(\(\) => \{ if\(isCurrent\(\)\) endShare\('captura-fechada'\); \}\)/);
});

test('reconectando: Unpublished e Muted locais são ignorados', () => {
  assert.match(appJs, /RoomEvent\.Reconnecting, \(\) => \{ if\(isCurrent\(\)\) noteRoomReconnecting\(\); \}/);
  assert.match(appJs, /RoomEvent\.SignalReconnecting, \(\) => \{ if\(isCurrent\(\)\) noteRoomReconnecting\(\); \}/);
  assert.match(appJs, /RoomEvent\.LocalTrackUnpublished, \(publication\) => \{\n\s+if\(!isCurrent\(\) \|\| roomReconnecting\) return;/);
  assert.match(appJs, /if\(selfInitiatedUnpublish \|\| roomReconnecting\) return;/);
  assert.match(appJs, /RoomEvent\.Reconnected, \(\) => \{\n\s+if\(!isCurrent\(\)\) return;\n\s+roomReconnecting = false;\n\s+reconcileAfterReconnect\(\);\n\s+sendWatchSync\(\);/);
  assert.match(appJs, /RoomEvent\.Disconnected, \(reason\) => \{\n\s+if\(!isCurrent\(\)\) return;\n\s+roomReconnecting = false;/);
  assert.match(extractFunction(appJs, 'leaveRoom'), /roomReconnecting = false;/);
});

test('sala trocada com o seletor aberto: não publica na sala errada', () => {
  const fn = extractFunction(appJs, 'toggleShareOnce');
  assert.match(fn, /const startRoom = room;/);
  const check = fn.indexOf('if(room !== startRoom)');
  assert.ok(check > fn.indexOf('applyCaptureQuality(videoTrack, quality)'));
  assert.ok(check < fn.indexOf('activeShareQuality = quality'));
  assert.match(fn, /if\(room !== startRoom \|\| !activeShareQuality\)/); // e depois de publicar
});

test('a troca de qualidade no meio sobrevive à republicação (degradationPreference)', () => {
  assert.match(appJs, /track\.publishOptions\.degradationPreference = /);
});

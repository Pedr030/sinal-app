// Reconexão (HANDOFF §87): faixa "Reconectando", quem assiste volta a ver sozinho e volta automática à sala.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(join(ROOT, 'public/app.js'), 'utf8').replace(/\r\n/g, '\n');
const indexHtml = readFileSync(join(ROOT, 'public/index.html'), 'utf8').replace(/\r\n/g, '\n');

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
function constant(name){
  const m = appJs.match(new RegExp('const ' + name + ' = ([0-9_]+);'));
  if(!m) throw new Error('não achei a constante ' + name);
  return Number(m[1].replace(/_/g, ''));
}

// Os números do LiveKit (DisconnectReason): só importa que cada nome seja diferente.
const R = {
  UNKNOWN_REASON: 0, CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, SERVER_SHUTDOWN: 3, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5,
  STATE_MISMATCH: 6, JOIN_FAILURE: 7, MIGRATION: 8, SIGNAL_CLOSE: 9, ROOM_CLOSED: 10, USER_UNAVAILABLE: 11, USER_REJECTED: 12,
  SIP_TRUNK_FAILURE: 13, CONNECTION_TIMEOUT: 14
};

// ---------- tabela: motivo da queda -> volta sozinho? ----------
const { autoRejoinDecision } = load({}, 'autoRejoinDecision');

test('volta sozinho só em servidor reiniciado e em queda sem motivo', () => {
  assert.equal(autoRejoinDecision(R.SERVER_SHUTDOWN, R), true);
  assert.equal(autoRejoinDecision(undefined, R), true);
  assert.equal(autoRejoinDecision(null, R), true);
});

test('decisão de alguém nunca volta sozinha', () => {
  for(const name of ['ROOM_DELETED', 'ROOM_CLOSED', 'PARTICIPANT_REMOVED', 'DUPLICATE_IDENTITY', 'CLIENT_INITIATED', 'USER_REJECTED']){
    assert.equal(autoRejoinDecision(R[name], R), false, name);
  }
});

test('qualquer outro motivo também não volta (lista curta e fixa)', () => {
  for(const name of ['UNKNOWN_REASON', 'STATE_MISMATCH', 'JOIN_FAILURE', 'MIGRATION', 'SIGNAL_CLOSE', 'USER_UNAVAILABLE', 'SIP_TRUNK_FAILURE', 'CONNECTION_TIMEOUT']){
    assert.equal(autoRejoinDecision(R[name], R), false, name);
  }
  assert.equal(autoRejoinDecision(R.SERVER_SHUTDOWN, undefined), false); // sem a lista do LiveKit: nada de chute
  assert.equal(autoRejoinDecision(3, {}), false);
});

test('o Disconnected passa pela tabela e só então liga a volta automática', () => {
  const handler = appJs.slice(appJs.indexOf('liveRoom.on(RoomEvent.Disconnected'), appJs.indexOf('function shareEndReasonFor'));
  assert.match(handler, /autoRejoinDecision\(reason, LivekitClient\.DisconnectReason\)/);
  assert.match(handler, /startAutoRejoin\(/);
  assert.ok(handler.indexOf('autoRejoinDecision') < handler.indexOf('startAutoRejoin('), 'decide antes de ligar');
  // Saiu por conta própria nunca chega aqui: leaveRoom zera `room` antes do evento e isCurrent() corta.
  assert.match(handler, /if\(!isCurrent\(\)\) return;/);
});

// ---------- o que cada tentativa decide ----------
const { rejoinModeFor, autoRejoinNextStep } = load({
  AUTO_REJOIN_EVERY_MS: constant('AUTO_REJOIN_EVERY_MS'),
  AUTO_REJOIN_MAX_MS: constant('AUTO_REJOIN_MAX_MS')
}, 'rejoinModeFor', 'autoRejoinNextStep');

test('voltar é sempre entrar numa sala que já existe, nunca criar', () => {
  assert.equal(rejoinModeFor('create'), 'join');
  assert.equal(rejoinModeFor('join'), 'join');
  assert.equal(rejoinModeFor('server-create'), 'server-join');
  assert.equal(rejoinModeFor('server-join'), 'server-join');
  assert.equal(rejoinModeFor(undefined), 'join');
});

test('tentativa: deu certo, sala sumiu, sem acesso, ou tenta de novo até o prazo', () => {
  const MAX = constant('AUTO_REJOIN_MAX_MS'), EVERY = constant('AUTO_REJOIN_EVERY_MS');
  assert.equal(MAX, 120000);
  assert.equal(autoRejoinNextStep('ok', 1000), 'done');
  assert.equal(autoRejoinNextStep('nao-achou', 1000), 'not-found');
  assert.equal(autoRejoinNextStep('negado', 1000), 'denied');
  assert.equal(autoRejoinNextStep('tentar-de-novo', 1000), 'retry');
  assert.equal(autoRejoinNextStep(undefined, 1000), 'retry');
  assert.equal(autoRejoinNextStep('tentar-de-novo', MAX - EVERY), 'retry');   // ainda cabe mais uma
  assert.equal(autoRejoinNextStep('tentar-de-novo', MAX - EVERY + 1), 'timeout'); // a próxima passaria dos 2 min
  assert.equal(autoRejoinNextStep('tentar-de-novo', MAX), 'timeout');
});

test('connectToRoomOnce diz o resultado e a tentativa automática nunca abre pergunta', () => {
  const body = appJs.slice(appJs.indexOf('async function connectToRoomOnce'), appJs.indexOf('function wireRoomEvents'));
  for(const outcome of ["'ok'", "'nao-achou'", "'negado'", "'tentar-de-novo'"]) assert.ok(body.includes(outcome), outcome);
  assert.match(body, /'sala-privada' && mode === 'server-join' && !auto/); // sala privada: sem pop-up de pedir entrada
  // cancelou enquanto pedia o token ou enquanto conectava: a entrada é desfeita, não aparece de surpresa
  assert.equal((body.match(/if\(auto && !autoRejoin\)/g) || []).length, 2);
});

test('quem escolhe outra coisa cancela a volta automática', () => {
  const body = extractFunction(appJs, 'connectToRoom');
  assert.match(body, /if\(!auto\) cancelAutoRejoin\(\)/);
  // criar, entrar por código, entrar por servidor e o voltar da recuperação do app passam todos por connectToRoom;
  // fora dele, só a nova tentativa depois de pedir aprovação chama connectToRoomOnce direto (e isso não é a automática).
  const outside = appJs.replace(extractFunction(appJs, 'connectToRoom'), '');
  const direct = outside.match(/connectToRoomOnce\(/g) || [];
  assert.equal(direct.length, 2); // a definição e a nova tentativa depois da aprovação
});

test('voltar à sala nunca retoma a transmissão sozinho: só oferece o botão', () => {
  const body = extractFunction(appJs, 'finishAutoRejoin');
  assert.match(body, /shouldOfferResumeShare\(/);
  assert.match(body, /showResumeShare\(\)/);
  assert.doesNotMatch(body, /toggleShare\(/);
});

// ---------- faixa "Reconectando…" ----------
test('a faixa espera um pouco (o signal-reconnect de ~2 s não pisca) e some em qualquer saída', () => {
  assert.equal(constant('RECONNECT_BANNER_DELAY_MS'), 3000);
  assert.match(indexHtml, /id="connBanner"/);
  const note = extractFunction(appJs, 'noteRoomReconnecting');
  assert.match(note, /setTimeout\(/);
  assert.match(note, /RECONNECT_BANNER_DELAY_MS/);
  const reconnected = appJs.slice(appJs.indexOf('liveRoom.on(RoomEvent.Reconnected'), appJs.indexOf('liveRoom.on(RoomEvent.Reconnecting'));
  assert.match(reconnected, /clearReconnectBanner\(\)/);
  assert.match(extractFunction(appJs, 'leaveRoom'), /clearReconnectBanner\(\)/);
});

// ---------- quem assiste volta a ver sozinho ----------
const SCREEN = 'screen_share', CAMERA = 'camera';
function remoteRoom(people){
  const remoteParticipants = new Map();
  for(const [identity, pubs] of Object.entries(people)){
    remoteParticipants.set(identity, {
      identity,
      getTrackPublication(source){ return pubs[source]; }
    });
  }
  return { remoteParticipants };
}
const REWATCH_ENV = { LivekitClient: { Track: { Source: { ScreenShare: SCREEN, Camera: CAMERA } } } };
const { tilesToRewatch } = load(REWATCH_ENV, 'tilesToRewatch');

test('reinscreve pela pessoa e pela fonte, não pelo ID da faixa', () => {
  const room = remoteRoom({
    ana: { [SCREEN]: { trackSid: 'TR_NOVO', isSubscribed: false } },          // ID mudou: não importa
    bia: { [CAMERA]: { trackSid: 'TR_2', isSubscribed: false } }
  });
  const lost = new Map([['ana', 5000], ['bia:cam', 5000]]);
  assert.deepEqual(tilesToRewatch(lost, room, 1000).sort(), ['ana', 'bia:cam']);
});

test('não reinscreve o que já voltou, o que venceu, quem saiu ou fonte que não existe mais', () => {
  const room = remoteRoom({
    ana: { [SCREEN]: { trackSid: 'a', isSubscribed: true } },                  // já voltou
    bia: { [SCREEN]: { trackSid: 'b', isSubscribed: false } },                 // venceu
    caio: {},                                                                  // parou de transmitir
    dani: { [CAMERA]: { trackSid: 'd', isSubscribed: false } }                 // tela não existe, só câmera
  });
  const lost = new Map([['ana', 5000], ['bia', 500], ['caio', 5000], ['edu', 5000], ['dani', 5000]]);
  assert.deepEqual(tilesToRewatch(lost, room, 1000), []);
});

test('câmera e tela da mesma pessoa são pedidos separados', () => {
  const room = remoteRoom({ ana: { [SCREEN]: { isSubscribed: false }, [CAMERA]: { isSubscribed: true } } });
  assert.deepEqual(tilesToRewatch(new Map([['ana', 5000], ['ana:cam', 5000]]), room, 1000), ['ana']);
});

function rewatchEnv(room, extra){
  const watched = [];
  const hints = new Map();
  const env = {
    room, roomReconnecting: false, lostWatch: new Map(), rewatchTimer: null, watched, hints,
    REWATCH_WINDOW_MS: constant('REWATCH_WINDOW_MS'),
    LivekitClient: REWATCH_ENV.LivekitClient,
    Date,
    tiles: new Map(),
    watchTile: (id, isCamera) => watched.push(id + (isCamera ? '*' : '')),
    appLog(){}, streamTag: (id) => id,
    setInterval: () => 1, clearInterval(){},
    ...extra
  };
  Object.assign(env, load(env, 'tilesToRewatch', 'noteLostWatch', 'rewatchLost'));
  return env;
}

test('depois da reconexão, o que eu assistia volta sozinho', () => {
  const room = remoteRoom({ ana: { [SCREEN]: { isSubscribed: false } }, bia: { [CAMERA]: { isSubscribed: false } } });
  const env = rewatchEnv(room);
  env.noteLostWatch('ana');
  env.noteLostWatch('bia:cam');
  env.rewatchLost();
  assert.deepEqual(env.watched.sort(), ['ana', 'bia:cam*']);
});

test('durante a reconexão não tenta (a inscrição se perderia de novo)', () => {
  const env = rewatchEnv(remoteRoom({ ana: { [SCREEN]: { isSubscribed: false } } }), { roomReconnecting: true });
  env.noteLostWatch('ana');
  env.rewatchLost();
  assert.deepEqual(env.watched, []);
  assert.equal(env.lostWatch.has('ana'), true); // continua valendo para quando voltar
});

test('passou da janela de 30 s, esquece e deixa o cartão normal', () => {
  const room = remoteRoom({ ana: { [SCREEN]: { isSubscribed: false } } });
  const tileClasses = new Set(['pending-tile']);
  const hint = { textContent: 'Voltando…' };
  const env = rewatchEnv(room, { tiles: new Map([['ana', { classList: { contains: (c) => tileClasses.has(c) }, querySelector: () => hint }]]) });
  env.lostWatch.set('ana', Date.now() - 1);
  env.rewatchLost();
  assert.deepEqual(env.watched, []);
  assert.equal(env.lostWatch.size, 0);
  assert.equal(hint.textContent, 'Clique pra assistir');
});

test('o que é meu (parar de assistir) não vira perda; o resto vira', () => {
  const removed = extractFunction(appJs, 'handleTrackRemoved');
  assert.match(removed, /noteLostWatch\(tileId\)/);
  assert.match(removed, /stoppedByMe\.delete\(tileId\)/);
  const stop = extractFunction(appJs, 'stopWatchingTile');
  assert.match(stop, /stoppedByMe\.add\(tileId\)/);
  // voltou a ver: não precisa mais tentar
  assert.match(extractFunction(appJs, 'handleTrackAdded'), /lostWatch\.delete\(tileId\)/);
  // sair da sala limpa tudo
  assert.match(extractFunction(appJs, 'leaveRoom'), /lostWatch\.clear\(\)/);
});

test('as três ocasiões de tentar: reconexão, publicação nova e sumiço com a publicação ainda lá', () => {
  const reconnected = appJs.slice(appJs.indexOf('liveRoom.on(RoomEvent.Reconnected'), appJs.indexOf('liveRoom.on(RoomEvent.Reconnecting'));
  assert.match(reconnected, /rewatchLost\(\)/);
  const published = appJs.slice(appJs.indexOf('liveRoom.on(RoomEvent.TrackPublished'), appJs.indexOf('liveRoom.on(RoomEvent.LocalTrackUnpublished'));
  assert.match(published, /rewatchLost\(\)/);
  assert.match(extractFunction(appJs, 'handleTrackRemoved'), /rewatchLost\(\)/);
  // o cartão avisa que está voltando
  assert.match(extractFunction(appJs, 'addPendingTile'), /Voltando…/);
});

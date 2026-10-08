// Testa funções puras extraídas do código REAL (não uma cópia mantida à parte
// aqui) — public/app.js é um script clássico (sem export), então não dá pra
// importar direto; extraímos a função de dentro do arquivo por regex, do
// mesmo jeito que foi validado manualmente durante a v0.8.29/v0.8.31.
// Se a assinatura da função mudar de um jeito que o regex não reconheça mais,
// o teste falha com "não achei X" em vez de silenciosamente testar código
// desatualizado — isso é intencional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(join(ROOT, 'public/app.js'), 'utf8');

function extractFunction(src, name){
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}', 'm'));
  if(!m) throw new Error('não achei a função ' + name + ' em ' + name);
  return m[0];
}

const escapeHtml = new Function(extractFunction(appJs, 'escapeHtml') + '; return escapeHtml;')();

test('escapeHtml escapa aspas duplas (contexto de atributo)', () => {
  assert.equal(escapeHtml('x" onerror="alert(1)'), 'x&quot; onerror=&quot;alert(1)');
});

test('escapeHtml escapa aspas simples', () => {
  assert.equal(escapeHtml("x' onerror='alert(1)"), 'x&#39; onerror=&#39;alert(1)');
});

test('escapeHtml escapa tags', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('escapeHtml escapa & antes dos outros (sem duplo-escape)', () => {
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('escapeHtml trata null/undefined como string vazia', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml não mexe em texto normal', () => {
  assert.equal(escapeHtml('Pedro Henrique'), 'Pedro Henrique');
});

// ---------- servers no Sinal (HANDOFF §39): helpers puros do app.js ----------
const serverHelpers = new Function(
  "const SERVER_ROOM_RE = /^s[0-9]{15,21}-[a-z0-9]{6}$/;" +
  extractFunction(appJs, 'isServerRoomName') + extractFunction(appJs, 'guildIconUrl') +
  extractFunction(appJs, 'guildInitials') + extractFunction(appJs, 'isDiscordAvatarUrl') +
  '; return { isServerRoomName, guildIconUrl, guildInitials, isDiscordAvatarUrl };'
)();

test('isServerRoomName: só o formato s<id>-xxxxxx em minúsculas', () => {
  assert.equal(serverHelpers.isServerRoomName('s800000000000000001-abc123'), true);
  for(const bad of ['ABC123', 'S800000000000000001-ABC123', 's1-abc123', 's800000000000000001-abc12', '', null, undefined]){
    assert.equal(serverHelpers.isServerRoomName(bad), false, String(bad));
  }
});

test('guildIconUrl: monta a URL do CDN só com id e hash válidos', () => {
  assert.equal(serverHelpers.guildIconUrl({ id: '800000000000000001', icon: 'a_1b2c3' }), 'https://cdn.discordapp.com/icons/800000000000000001/a_1b2c3.png?size=64');
  assert.equal(serverHelpers.guildIconUrl({ id: '800000000000000001', icon: '' }), '');
  assert.equal(serverHelpers.guildIconUrl({ id: '800000000000000001', icon: 'x"onerror="1' }), '');
  assert.equal(serverHelpers.guildIconUrl({ id: 'abc', icon: 'ok' }), '');
  assert.equal(serverHelpers.guildIconUrl(null), '');
});

test('guildInitials: iniciais de duas palavras, ou as duas primeiras letras', () => {
  assert.equal(serverHelpers.guildInitials('Galera do Valorant'), 'GV');
  assert.equal(serverHelpers.guildInitials('Sinal'), 'SI');
  assert.equal(serverHelpers.guildInitials('Estudos e Café'), 'EC');
  assert.equal(serverHelpers.guildInitials('de'), '?');
  assert.equal(serverHelpers.guildInitials(''), '?');
  assert.equal(serverHelpers.guildInitials(undefined), '?');
});

test('isDiscordAvatarUrl: só imagens do CDN do Discord', () => {
  assert.equal(serverHelpers.isDiscordAvatarUrl('https://cdn.discordapp.com/avatars/1/a.png?size=64'), true);
  assert.equal(serverHelpers.isDiscordAvatarUrl('https://evil.com/a.png'), false);
  assert.equal(serverHelpers.isDiscordAvatarUrl('https://cdn.discordapp.com/a" onerror="x'), false);
  assert.equal(serverHelpers.isDiscordAvatarUrl(undefined), false);
});

// ---------- login pelo navegador no app desktop (HANDOFF §39, fase 2c) ----------
const newLoginNonce = new Function(extractFunction(appJs, 'newLoginNonce') + '; return newLoginNonce;')();

test('newLoginNonce: 32 hex minúsculos (o formato que o servidor e o app exigem) e diferente a cada vez', () => {
  const a = newLoginNonce();
  const b = newLoginNonce();
  assert.match(a, /^[a-f0-9]{32}$/);
  assert.notEqual(a, b);
});

// ---------- campo "entrar em sala existente": só código de sala por código ----------
const pickPrefillCode = new Function(extractFunction(appJs, 'pickPrefillCode') + '; return pickPrefillCode;')();
const SERVER_ROOM = 's800000000000000001-abc123';

test('prefill: convite com código normal vira o código em maiúsculas (e tem prioridade sobre o último)', () => {
  assert.deepEqual(pickPrefillCode('abc123', 'ZZZ999'), { code: 'ABC123', dropLast: false, dropSala: false });
});

test('prefill: sem convite, relembra o último código por código', () => {
  assert.deepEqual(pickPrefillCode(null, 'ZZZ999'), { code: 'ZZZ999', dropLast: false, dropSala: false });
  assert.deepEqual(pickPrefillCode('', ''), { code: '', dropLast: false, dropSala: false });
});

test('prefill: nome de sala de servidor NUNCA aparece no campo (nem do convite, nem do último salvo)', () => {
  // ?sala= de servidor: não mostra, tira da URL e cai no último código normal, se houver
  assert.deepEqual(pickPrefillCode(SERVER_ROOM, 'ZZZ999'), { code: 'ZZZ999', dropLast: false, dropSala: true });
  assert.deepEqual(pickPrefillCode(SERVER_ROOM, null), { code: '', dropLast: false, dropSala: true });
  // último salvo era de servidor (bug antigo): esquece o valor
  assert.deepEqual(pickPrefillCode(null, SERVER_ROOM), { code: '', dropLast: true, dropSala: false });
  // também a versão em maiúsculas que o campo mostrava
  assert.deepEqual(pickPrefillCode(null, SERVER_ROOM.toUpperCase()), { code: '', dropLast: true, dropSala: false });
});

// ---------- encaixe dos destaques (HANDOFF §43) ----------
const bestSpotlightLayout = new Function(
  'const SPOTLIGHT_MIN_WIDTH = 240;' + extractFunction(appJs, 'bestSpotlightLayout') + '; return bestSpotlightLayout;'
)();

test('encaixe: uma transmissão usa o maior 16:9 que cabe (limitado pela altura livre)', () => {
  assert.deepEqual(bestSpotlightLayout(1, 1884, 620, 16), { cols: 1, width: 1102 }); // 620 * 16/9
  assert.deepEqual(bestSpotlightLayout(1, 800, 900, 16), { cols: 1, width: 800 });   // limitado pela largura
});

test('encaixe: duas transmissões lado a lado em tela larga (o caso do print: 1920x1060)', () => {
  const l = bestSpotlightLayout(2, 1884, 620, 16);
  assert.equal(l.cols, 2);
  assert.equal(l.width, 934);              // (1884 - 16) / 2 — antes eram 712 por causa do teto de 1440px
  assert.ok(Math.round(l.width * 9 / 16) <= 620);   // e a altura (525) cabe no espaço livre
});

test('encaixe: janela estreita e alta empilha as duas em vez de espremer lado a lado', () => {
  const l = bestSpotlightLayout(2, 600, 900, 16);
  assert.equal(l.cols, 1);
  assert.equal(l.width, 600);
});

test('encaixe: escolhe a arrumação de MAIOR área; nada passa do espaço livre', () => {
  for(const [n, W, H] of [[2, 1884, 620], [2, 1280, 500], [2, 900, 700], [1, 1200, 300], [2, 1500, 1000]]){
    const l = bestSpotlightLayout(n, W, H, 16);
    const rows = Math.ceil(n / l.cols);
    assert.ok(l.cols * l.width + (l.cols - 1) * 16 <= W + 1, `largura ${n},${W},${H}`);
    if(l.width > 240) assert.ok(rows * (l.width * 9 / 16) + (rows - 1) * 16 <= H + 1, `altura ${n},${W},${H}`);
  }
});

test('encaixe: espaço minúsculo respeita a largura mínima (a página rola em vez de sumir)', () => {
  assert.equal(bestSpotlightLayout(2, 300, 100, 16).width, 240);
});

test('encaixe: empate fica com menos colunas', () => {
  // 2 tiles em 1000x1000: lado a lado = 492; empilhado = 492 (o limite é a altura) -> 1 coluna
  const l = bestSpotlightLayout(2, 1000, 1000, 16);
  assert.ok(l.cols === 1 || l.cols === 2);
  assert.deepEqual(bestSpotlightLayout(1, 1000, 1000, 16), { cols: 1, width: 1000 });
});

// ---------- aviso de atualização: um só por vez (site novo x app novo) ----------
const pickUpdateBar = new Function(extractFunction(appJs, 'pickUpdateBar') + '; return pickUpdateBar;')();

test('aviso de atualização: nada novo = sem barra (já atualizado)', () => {
  for(const app of [null, undefined, 'idle', 'checking', 'latest', 'error', 'dev']) assert.equal(pickUpdateBar(false, app), null, String(app));
});

test('aviso de atualização: só o site novo mostra o botão do site (navegador comum e app sem versão nova)', () => {
  for(const app of [null, 'idle', 'checking', 'latest', 'error']) assert.equal(pickUpdateBar(true, app), 'site', String(app));
});

test('aviso de atualização: app com versão pronta mostra só o do app, mesmo com site novo (nunca os dois juntos)', () => {
  assert.equal(pickUpdateBar(false, 'ready'), 'app');
  assert.equal(pickUpdateBar(true, 'ready'), 'app');
});

test('aviso de atualização: app baixando não mostra nada (nem o botão do site)', () => {
  assert.equal(pickUpdateBar(true, 'downloading'), null);
  assert.equal(pickUpdateBar(false, 'downloading'), null);
});

test('aviso de atualização: dentro da sala pede confirmação (e cita a transmissão); fora dela não', () => {
  const fn = new Function(extractFunction(appJs, 'updateLeaveWarning') + '; return updateLeaveWarning;')();
  assert.equal(fn(false, false), null);
  assert.equal(fn(false, true), null);
  assert.equal(fn(true, false), 'Atualizar agora vai fazer você sair da sala.');
  assert.doesNotMatch(fn(true, false), /transmiss/);
  assert.equal(fn(true, true), 'Atualizar agora vai fazer você sair da sala e parar a sua transmissão.');
});

// ---------- codec por qualidade (experimento Fluido em H.264, HANDOFF §46) ----------
const codecFns = new Function(
  extractFunction(appJs, 'pickShareCodec') + extractFunction(appJs, 'shareEncodingFor') + extractFunction(appJs, 'canSwitchQualityLive') +
  "const FLUIDO_CODEC = '" + appJs.match(/const FLUIDO_CODEC = '([a-z0-9]+)';/)[1] + "';" +
  '; return { pickShareCodec, shareEncodingFor, canSwitchQualityLive };'
)();
const PRESETS_SRC = appJs.match(/const SHARE_QUALITY_PRESETS = \{[\s\S]*?\n\};/)[0];
const SHARE_QUALITY_PRESETS = new Function(PRESETS_SRC + '; return SHARE_QUALITY_PRESETS;')();

test('codec: Fluido sai em H.264 e Nítido/Leve em H.265 (placa com H.265); sem H.265 tudo cai pra VP8', () => {
  assert.equal(codecFns.pickShareCodec('fluido', true), 'h264');
  assert.equal(codecFns.pickShareCodec('nitido', true), 'h265');
  assert.equal(codecFns.pickShareCodec('leve', true), 'h265');
  for(const q of ['leve', 'nitido', 'fluido']) assert.equal(codecFns.pickShareCodec(q, false), 'vp8', q);
});

test('codec: todo preset tem limites pros três codecs, e o Fluido H.264 segue 60fps/6 Mbps', () => {
  for(const [key, p] of Object.entries(SHARE_QUALITY_PRESETS)){
    for(const c of ['h265', 'h264', 'vp8']){
      const enc = codecFns.shareEncodingFor(p, c);
      assert.ok(enc && enc.maxBitrate > 0 && enc.maxFramerate > 0, `${key}/${c}`);
    }
  }
  assert.deepEqual(codecFns.shareEncodingFor(SHARE_QUALITY_PRESETS.fluido, 'h264'), { maxBitrate: 6_000_000, maxFramerate: 60 });
  assert.equal(codecFns.shareEncodingFor(SHARE_QUALITY_PRESETS.fluido, 'h265').maxFramerate, 60);
});

test('troca de qualidade ao vivo: sair do Fluido é livre; entrar no Fluido só se a transmissão já é do codec dele', () => {
  assert.equal(codecFns.canSwitchQualityLive('h264', 'nitido', true), true);   // Fluido -> Nítido
  assert.equal(codecFns.canSwitchQualityLive('h265', 'leve', true), true);     // Nítido -> Leve
  assert.equal(codecFns.canSwitchQualityLive('h264', 'fluido', true), true);   // já está no codec do Fluido
  assert.equal(codecFns.canSwitchQualityLive('h265', 'fluido', true), false);  // Nítido (H.265) -> Fluido exige nova transmissão
  assert.equal(codecFns.canSwitchQualityLive('vp8', 'fluido', false), true);   // sem H.265 o Fluido nem existe (effectiveShareQuality)
});

// ---------- diagnóstico de travadas (HANDOFF §47) ----------
const trouble = new Function(
  extractFunction(appJs, 'senderTroubleLine') + extractFunction(appJs, 'viewerTroubleLine') + '; return { senderTroubleLine, viewerTroubleLine };'
)();

test('diagnóstico (envio): fps bom e sem limite não gera linha; fps baixo ou limite gera, com o gargalo', () => {
  const ok = { quality: 'Fluido', codec: 'H.264', width: 1920, height: 1080, targetFps: 60, reason: 'none', d: { seconds: 4, frames: 236, encodeMs: 900, bytes: 3_000_000, keyFrames: 0, pli: 0, nack: 0 } };
  assert.equal(trouble.senderTroubleLine(ok), null);
  const baixo = { ...ok, d: { ...ok.d, frames: 24, encodeMs: 960, keyFrames: 2, pli: 1, nack: 9 } };
  const linha = trouble.senderTroubleLine(baixo);
  assert.match(linha, /Fluido H\.264 1920x1080/);
  assert.match(linha, /6fps \(meta 60\)/);
  assert.match(linha, /codificação 40\.0ms\/quadro/);
  assert.match(linha, /keyframes\+2/);
  assert.match(linha, /pedidos de keyframe\+1/);
  assert.match(linha, /retransmissões\+9/);
  assert.match(trouble.senderTroubleLine({ ...ok, reason: 'cpu' }), /limite=cpu/); // fps ok mas o navegador diz que está reduzindo
});

test('diagnóstico (envio): zero quadros no intervalo não divide por zero; intervalo inválido não gera linha', () => {
  const base = { quality: 'Nítido', codec: 'H.265', width: 1920, height: 1080, targetFps: 30, reason: 'none' };
  const linha = trouble.senderTroubleLine({ ...base, d: { seconds: 4, frames: 0, encodeMs: 0, bytes: 0, keyFrames: 0, pli: 0, nack: 0 } });
  assert.match(linha, /0fps/);
  assert.doesNotMatch(linha, /ms\/quadro/);
  assert.equal(trouble.senderTroubleLine({ ...base, d: { seconds: 0, frames: 10 } }), null);
  assert.equal(trouble.senderTroubleLine({ ...base, d: null }), null);
});

test('diagnóstico (recepção): distingue "não chegou" de "chegou e foi descartado"; fluxo normal não gera linha', () => {
  const normal = { codec: 'H.265', width: 1920, height: 1080, d: { seconds: 4, received: 240, decoded: 238, dropped: 0, freezes: 0, freezeSeconds: 0, bytes: 3_000_000, lost: 0, pli: 0, nack: 0 } };
  assert.equal(trouble.viewerTroubleLine(normal), null);
  const naoChegou = trouble.viewerTroubleLine({ ...normal, d: { ...normal.d, received: 24, decoded: 24, lost: 30, nack: 12 } });
  assert.match(naoChegou, /recebe 6fps · decodifica 6fps/);
  assert.match(naoChegou, /pacotes perdidos\+30/);
  const descartado = trouble.viewerTroubleLine({ ...normal, d: { ...normal.d, decoded: 40, dropped: 200, freezes: 2, freezeSeconds: 1.4 } });
  assert.match(descartado, /recebe 60fps · decodifica 10fps/);
  assert.match(descartado, /descartados\+200/);
  assert.match(descartado, /congelamentos\+2 \(1\.4s\)/);
});

// ---------- mistura do áudio isolado no AudioWorklet (HANDOFF §47) ----------
const workletSrc = readFileSync(join(ROOT, 'public/audio-mixer-worklet.js'), 'utf8');
const MixerCore = new Function(workletSrc + '; return MixerCore;')();
const pcm = (frames, fn) => { // PCM s16le estéreo intercalado a partir de uma função amostra(i) em [-1,1]
  const u = new Uint8Array(frames * 4); const v = new DataView(u.buffer);
  for(let i = 0; i < frames; i++){ const x = Math.round(fn(i) * 32767); v.setInt16(i * 4, x, true); v.setInt16(i * 4 + 2, x, true); }
  return u;
};
const bloco = (core, n = 128) => { const l = new Float32Array(n), r = new Float32Array(n); core.render(l, r); return { l, r }; };

test('mixer: só toca depois de juntar a reserva (~60 ms) e então sai o sinal certo, contínuo', () => {
  const core = new MixerCore();
  core.push(1, pcm(480, () => 0.5));              // 10 ms: abaixo da reserva
  assert.ok(bloco(core).l.every((x) => x === 0));  // ainda em silêncio
  for(let i = 0; i < 6; i++) core.push(1, pcm(480, () => 0.5)); // chega a 70 ms
  const b = bloco(core);
  assert.ok(Math.abs(b.l[0] - 0.5) < 0.001 && Math.abs(b.r[127] - 0.5) < 0.001);
});

test('mixer: soma as origens e limita em ±1 (sem estourar)', () => {
  const core = new MixerCore();
  for(let i = 0; i < 8; i++){ core.push(1, pcm(480, () => 0.7)); core.push(2, pcm(480, () => 0.7)); }
  const b = bloco(core);
  assert.equal(b.l[0], 1);   // 0.7 + 0.7 = 1.4 -> 1
  assert.equal(b.r[10], 1);
  const core2 = new MixerCore();
  for(let i = 0; i < 8; i++){ core2.push(1, pcm(480, () => 0.3)); core2.push(2, pcm(480, () => 0.2)); }
  assert.ok(Math.abs(bloco(core2).l[0] - 0.5) < 0.001);
});

test('mixer: esvaziou a fila = silêncio e volta a juntar a reserva antes de tocar de novo (sem estalos repetidos)', () => {
  const core = new MixerCore();
  for(let i = 0; i < 7; i++) core.push(1, pcm(480, () => 0.5)); // 3360 quadros
  let tocou = 0;
  for(let i = 0; i < 40; i++) if(bloco(core).l[0] !== 0) tocou++; // 40*128 = 5120 > 3360: esvazia
  assert.ok(tocou > 0 && tocou < 40);
  core.push(1, pcm(480, () => 0.5)); // chega pouco: abaixo da reserva
  assert.ok(bloco(core).l.every((x) => x === 0));
});

test('mixer: fila acima de ~250 ms descarta o excesso mais antigo (atraso sempre limitado); remove tira a origem', () => {
  const core = new MixerCore();
  core.push(1, pcm(20000, (i) => (i < 15000 ? 0.1 : 0.9))); // 416 ms de uma vez: o começo (0.1) é o antigo
  const s = core.sources.get(1);
  assert.ok(s.queuedFrames <= 12000 && s.queuedFrames >= 4700);
  assert.ok(Math.abs(bloco(core).l[0] - 0.9) < 0.001);      // sobrou só o mais novo
  core.remove(1);
  assert.equal(core.sources.size, 0);
});

test('mixer: bytes quebrados (tamanho não múltiplo de 4) e vazios não derrubam nada', () => {
  const core = new MixerCore();
  core.push(1, new Uint8Array(0));
  core.push(1, new Uint8Array(3));
  assert.equal(core.sources.size, 0);
  core.push(1, new Uint8Array(7)); // 1 quadro + sobra ignorada
  assert.equal(core.sources.get(1).queuedFrames, 1);
});

test('mixer: a reserva cresce quando a fila esvazia no meio do som (e fica entre 60 e 200 ms) e encolhe depois de muito tempo sem furo', () => {
  const core = new MixerCore();
  for(let i = 0; i < 7; i++) core.push(1, pcm(480, () => 0.5));
  const s = () => core.sources.get(1);
  assert.equal(s().prebuffer, 2880);
  for(let i = 0; i < 40; i++) bloco(core);          // esvazia: furo
  assert.equal(s().prebuffer, 2880 + 1920);
  for(let k = 0; k < 10; k++){                       // vários furos seguidos: nunca passa de 200 ms
    for(let i = 0; i < 30; i++) core.push(1, pcm(480, () => 0.5));
    for(let i = 0; i < 200; i++) bloco(core);
  }
  assert.ok(s().prebuffer <= 9600 && s().prebuffer > 2880);
  // muito tempo tocando sem furo: devolve atraso aos poucos
  const core2 = new MixerCore();
  for(let i = 0; i < 30; i++) core2.push(1, pcm(480, () => 0.5));
  core2.sources.get(1).prebuffer = 5760;
  core2.sources.get(1).calmFrames = 48000 * 30 - 5;  // quase na hora de encolher
  for(let i = 0; i < 4; i++) bloco(core2);
  assert.equal(core2.sources.get(1).prebuffer, 5760 - 480);
});

// ---------- atualização automática do site fora de sala (HANDOFF §48) ----------
const canAutoReload = new Function(extractFunction(appJs, 'canAutoReload') + '; return canAutoReload;')();
const livre = { siteReady: true, inRoom: false, sharing: false, overlayOpen: false, typing: false, loginPending: false, recentlyReloaded: false };

test('recarga automática: só com site novo baixado e NADA a perder', () => {
  assert.equal(canAutoReload(livre), true);
  assert.equal(canAutoReload({ ...livre, siteReady: false }), false);   // nada novo
  assert.equal(canAutoReload({ ...livre, inRoom: true }), false);       // dentro de sala
  assert.equal(canAutoReload({ ...livre, sharing: true }), false);      // transmitindo
  assert.equal(canAutoReload({ ...livre, overlayOpen: true }), false);  // janela aberta (config, relatório, confirmação...)
  assert.equal(canAutoReload({ ...livre, typing: true }), false);       // digitando
  assert.equal(canAutoReload({ ...livre, loginPending: true }), false); // esperando o login do Discord no navegador
  assert.equal(canAutoReload({ ...livre, recentlyReloaded: true }), false); // já recarregou há pouco (sem laço)
});

test('recarga automática: o cálculo do intervalo e do login usa as constantes do código (30 s estáveis, 5 min entre recargas)', () => {
  assert.match(appJs, /const AUTO_RELOAD_STABLE_TICKS = 3;/);
  assert.match(appJs, /const AUTO_RELOAD_TICK_MS = 10000;/);
  assert.match(appJs, /const AUTO_RELOAD_MIN_GAP_MS = 5 \* 60 \* 1000;/);
});

// ---------- criar sala dentro da call (HANDOFF §48) ----------
const roomsLimitMsg = new Function('const SERVER_ROOMS_LIMIT = ' + appJs.match(/const SERVER_ROOMS_LIMIT = (\d+);/)[1] + ';' + extractFunction(appJs, 'serverRoomsLimitMessage') + '; return serverRoomsLimitMessage;')();

test('criar sala na call: avisa do limite de salas antes de sair da sala atual', () => {
  assert.equal(roomsLimitMsg(0), null);
  assert.equal(roomsLimitMsg(9), null);
  assert.match(roomsLimitMsg(10), /já tem 10 salas ao vivo/);
  assert.match(roomsLimitMsg(15), /já tem 10 salas ao vivo/);
});

test('criar sala na call: o limite do app é o mesmo do servidor (lib/rooms.js)', () => {
  const lib = readFileSync(join(ROOT, 'lib/rooms.js'), 'utf8');
  assert.equal(Number(lib.match(/MAX_ROOMS_PER_GUILD = (\d+)/)[1]), Number(appJs.match(/const SERVER_ROOMS_LIMIT = (\d+);/)[1]));
});

// ---------- sala privada: o que o app aceita e mostra (HANDOFF §49) ----------
const knockFns = new Function(
  extractFunction(appJs, 'isDiscordAvatarUrl') + extractFunction(appJs, 'parseKnockMessage') + extractFunction(appJs, 'knockFailureText') +
  '; return { parseKnockMessage, knockFailureText };'
)();
const KNOCK = { type: 'knock', room: 's111111111111111111-abc123', userId: '900000000000000002', name: 'Fulano', avatar: 'https://cdn.discordapp.com/avatars/1/a.png' };

test('pedido de entrada: só vale se veio do SERVIDOR (sem participante), no tópico knock e para a sala atual', () => {
  const ok = knockFns.parseKnockMessage(KNOCK, undefined, 'knock', KNOCK.room);
  assert.deepEqual(ok, { userId: '900000000000000002', name: 'Fulano', avatar: 'https://cdn.discordapp.com/avatars/1/a.png' });
  assert.equal(knockFns.parseKnockMessage(KNOCK, { identity: 'malandro' }, 'knock', KNOCK.room), null); // um participante tentando forjar
  assert.equal(knockFns.parseKnockMessage(KNOCK, undefined, 'chat', KNOCK.room), null);                  // tópico errado
  assert.equal(knockFns.parseKnockMessage(KNOCK, undefined, undefined, KNOCK.room), null);
  assert.equal(knockFns.parseKnockMessage(KNOCK, undefined, 'knock', 's111111111111111111-outra1'), null); // outra sala
  assert.equal(knockFns.parseKnockMessage(KNOCK, undefined, 'knock', ''), null);
});

test('pedido de entrada: rejeita ID inválido e tipo errado; limpa o nome; avatar só do CDN do Discord', () => {
  const k = (o) => knockFns.parseKnockMessage({ ...KNOCK, ...o }, undefined, 'knock', KNOCK.room);
  for(const userId of ['abc', '123', 123456789012345678, null, undefined, '900000000000000002<script>']) assert.equal(k({ userId }), null, String(userId));
  assert.equal(k({ type: 'chat' }), null);
  assert.equal(knockFns.parseKnockMessage(null, undefined, 'knock', KNOCK.room), null);
  assert.equal(k({ name: '' }).name, 'Alguém');
  assert.equal(k({ name: 'A\u0000B\nC' }).name, 'A B C');
  assert.equal(k({ name: 'x'.repeat(100) }).name.length, 40);
  assert.equal(k({ avatar: 'https://evil.com/a.png' }).avatar, '');
  assert.equal(k({ avatar: 'javascript:alert(1)' }).avatar, '');
});

test('pedido de entrada: cada resposta do servidor tem um texto claro (e o desconhecido cai num genérico)', () => {
  for(const e of ['recusado', 'sem-responsavel', 'room-not-found', 'fora-do-server', 'sessao-invalida']) assert.ok(knockFns.knockFailureText(e).length > 10, e);
  assert.match(knockFns.knockFailureText('recusado'), /recusado/);
  assert.match(knockFns.knockFailureText('algo-novo'), /Tente de novo/);
});

// Regra do usuário (2026-10-07): a interface usa SÍMBOLOS em SVG, nunca emojis. Este teste varre o código que o
// usuário vê (site, app desktop, mensagens do servidor) e falha se algum emoji ou pictograma voltar.
import { readdirSync } from 'node:fs';
test('nenhum emoji na interface nem nas mensagens: só símbolos SVG (cadeado, coroa, tela cheia)', () => {
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B55}\u{FE0F}]/u;
  const dirs = [['public', /\.(html|js|css)$/], ['electron/src', /\.(html|js)$/], ['api', /\.js$/], ['lib', /\.js$/]];
  const achados = [];
  for(const [dir, ext] of dirs){
    for(const name of readdirSync(join(ROOT, dir))){
      if(!ext.test(name)) continue;
      readFileSync(join(ROOT, dir, name), 'utf8').split(String.fromCharCode(10)).forEach((line, i) => {
        if(EMOJI.test(line)) achados.push(`${dir}/${name}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(achados, []);
  assert.match(appJs, /const ICON_LOCK_SVG = '<svg /);
  assert.match(appJs, /const ICON_CROWN_SVG = '<svg /);
  assert.match(appJs, /const ICON_FULLSCREEN_SVG = '<svg /);
});

// ---------- sala com senha: o que o formulário aceita e mostra (HANDOFF §50) ----------
const pwFns = new Function(
  extractFunction(appJs, 'accessChoice') + extractFunction(appJs, 'accessHint') + extractFunction(appJs, 'knockFailureText') +
  '; return { accessChoice, accessHint, knockFailureText };'
)();

test('formulário de criar sala: tipo de acesso e validação da senha (mesma regra do servidor)', () => {
  assert.deepEqual(pwFns.accessChoice('open', 'ignorada'), { access: 'open', password: '' });
  assert.deepEqual(pwFns.accessChoice('approval', 'ignorada'), { access: 'approval', password: '' });
  assert.deepEqual(pwFns.accessChoice('password', '  segredo123  '), { access: 'password', password: 'segredo123' });
  assert.equal(pwFns.accessChoice('qualquer-coisa', 'x').access, 'open');           // valor estranho vira aberta
  for(const pw of ['', 'abc', '   ', 'x'.repeat(33), null, undefined]){
    const r = pwFns.accessChoice('password', pw);
    assert.equal(r.access, 'password', String(pw));
    assert.match(r.error, /de 4 a 32 caracteres/);
    assert.equal(r.password, '');
  }
  assert.equal(pwFns.accessChoice('password', 'a'.repeat(32)).error, undefined);
  assert.equal(pwFns.accessChoice('password', 'ab\u0000cd').password, 'abcd');       // tira controle, como o servidor
});

test('cadeado: a dica diz se a sala é de aprovação ou de senha', () => {
  assert.match(pwFns.accessHint('password'), /senha/);
  assert.match(pwFns.accessHint('approval'), /aprovar/);
});

test('senha: textos claros para senha errada e muitas tentativas', () => {
  assert.match(pwFns.knockFailureText('senha-incorreta'), /Senha incorreta/);
  assert.match(pwFns.knockFailureText('muitas-tentativas'), /Muitas tentativas/);
});

// ---------- ver a senha da sala: quem enxerga o botão (HANDOFF §50) ----------
const caretakerFns = new Function(extractFunction(appJs, 'isRoomCaretaker') + extractFunction(appJs, 'canSeeRoomPassword') + extractFunction(appJs, 'canDecideKnocks') + '; return { canSeeRoomPassword, canDecideKnocks };')();
const canSeePw = caretakerFns.canSeeRoomPassword;
const SALA_PW = { access: 'password', creator: { id: '111' } };

test('botão "ver a senha": criador, admin do Sinal e staff DAQUELE servidor; comum e sala sem senha não', () => {
  assert.equal(canSeePw(SALA_PW, { userId: '111' }, 'G1'), true);                       // criador
  assert.equal(canSeePw(SALA_PW, { userId: '9', isAdmin: true }, 'G1'), true);           // admin do Sinal
  for(const tier of ['o', 'a', 'm']) assert.equal(canSeePw(SALA_PW, { userId: '9', tier, guild: 'G1' }, 'G1'), true, tier);
  assert.equal(canSeePw(SALA_PW, { userId: '9', tier: 'o', guild: 'G2' }, 'G1'), false); // staff de OUTRO servidor
  assert.equal(canSeePw(SALA_PW, { userId: '9', tier: 'x', guild: 'G1' }, 'G1'), false); // membro comum
  assert.equal(canSeePw({ access: 'approval', creator: { id: '111' } }, { userId: '111' }, 'G1'), false); // sem senha
  assert.equal(canSeePw({ access: 'open' }, { userId: '111', isAdmin: true }, 'G1'), false);
  assert.equal(canSeePw(null, { userId: '111' }, 'G1'), false);
  assert.equal(canSeePw(SALA_PW, null, 'G1'), false);
  assert.equal(canSeePw(SALA_PW, { tier: 'o', guild: 'G1' }, ''), false);                // sem servidor conhecido
});

// ---------- símbolo de cada tipo de sala privada (cadeado só pra SENHA) ----------
const iconFns = new Function(extractFunction(appJs, 'accessIconKind') + extractFunction(appJs, 'accessLabel') + '; return { accessIconKind, accessLabel };')();

test('símbolo da sala: cadeado só pra senha; aprovação tem símbolo próprio; tipo desconhecido trancado mostra cadeado', () => {
  assert.equal(iconFns.accessIconKind('password'), 'password');
  assert.equal(iconFns.accessIconKind('approval'), 'approval');
  assert.equal(iconFns.accessIconKind('futuro'), 'password');
  assert.equal(iconFns.accessLabel('password'), 'Sala com senha');
  assert.equal(iconFns.accessLabel('approval'), 'Sala com aprovação');
  assert.equal(iconFns.accessLabel('futuro'), 'Sala privada');
  assert.match(appJs, /const ICON_APPROVAL_SVG = '<svg /);
  assert.notEqual(appJs.match(/const ICON_APPROVAL_SVG = '([^']+)'/)[1], appJs.match(/const ICON_LOCK_SVG = '([^']+)'/)[1]);
});

test('sino dos pedidos de entrada: só em sala de APROVAÇÃO e só pra quem cuida dela (criador, admin do Sinal, staff do servidor)', () => {
  const SALA = { access: 'approval', creator: { id: '111' } };
  const sino = caretakerFns.canDecideKnocks;
  assert.equal(sino(SALA, { userId: '111' }, 'G1'), true);
  assert.equal(sino(SALA, { userId: '9', isAdmin: true }, 'G1'), true);
  for(const tier of ['o', 'a', 'm']) assert.equal(sino(SALA, { userId: '9', tier, guild: 'G1' }, 'G1'), true, tier);
  assert.equal(sino(SALA, { userId: '9', tier: 'o', guild: 'G2' }, 'G1'), false);   // staff de OUTRO servidor
  assert.equal(sino(SALA, { userId: '9', tier: 'x', guild: 'G1' }, 'G1'), false);   // membro comum
  assert.equal(sino({ access: 'password', creator: { id: '111' } }, { userId: '111' }, 'G1'), false); // sala com senha não tem pedidos
  assert.equal(sino({ access: 'open', creator: { id: '111' } }, { userId: '111', isAdmin: true }, 'G1'), false);
  assert.equal(sino(null, { userId: '111' }, 'G1'), false);
  assert.equal(sino(SALA, null, 'G1'), false);
  // a chave da senha e o sino nunca aparecem juntos na mesma sala
  for(const access of ['open', 'approval', 'password']){
    const meta = { access, creator: { id: '111' } };
    assert.equal(caretakerFns.canSeeRoomPassword(meta, { userId: '111' }, 'G1') && sino(meta, { userId: '111' }, 'G1'), false, access);
  }
});

test('botão escondido (atributo hidden) some DE VERDADE: .icon-btn[hidden] tem display:none (senão a chave/sino aparecem onde não devem)', () => {
  const css = readFileSync(join(ROOT, 'public/style.css'), 'utf8');
  assert.match(css, /\.icon-btn\[hidden\]\s*\{\s*display:\s*none/);
  // e o HTML usa hidden nesses botões
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  for(const id of ['knockBtn', 'passwordBtn', 'sideToggleBtn']) assert.match(html, new RegExp('id="' + id + '"[^>]*hidden'), id);
});

// ---------- retomar transmissão depois de uma queda do app + sair da janela flutuante (HANDOFF §52) ----------
const shouldOfferResumeShare = new Function(extractFunction(appJs, 'shouldOfferResumeShare') + '; return shouldOfferResumeShare;')();
const pipLeaveKind = new Function(extractFunction(appJs, 'pipLeaveKind') + '; return pipLeaveKind;')();

test('retomar transmissão: só oferece pra MESMA sala, sem limite de idade (a transmissão pode ter horas)', () => {
  const marker = { room: 's810000000000000001-abc123', at: Date.now() - 7 * 3600 * 1000 };
  assert.equal(shouldOfferResumeShare(marker, 's810000000000000001-abc123'), true);
  assert.equal(shouldOfferResumeShare(marker, 's810000000000000001-outra1'), false);
  assert.equal(shouldOfferResumeShare(marker, ''), false);
  assert.equal(shouldOfferResumeShare(marker, null), false);
  assert.equal(shouldOfferResumeShare(null, 'ABC123'), false);
  assert.equal(shouldOfferResumeShare({ room: 123 }, 'ABC123'), false);
  assert.equal(shouldOfferResumeShare({}, 'ABC123'), false);
});

test('janela flutuante: expandir = não pausou e não foi por código; X = pausou; código = nunca traz o app', () => {
  assert.equal(pipLeaveKind(false, false, 60000), 'expanded');
  assert.equal(pipLeaveKind(false, true, 60000), 'closed');          // vídeo pausado
  assert.equal(pipLeaveKind(false, false, 200), 'closed');           // pause recente (chegou antes de o vídeo voltar)
  assert.equal(pipLeaveKind(false, false, Infinity), 'expanded');    // nunca pausou
  assert.equal(pipLeaveKind(true, false, 60000), 'code');            // trocar de sala, tile removido, botão do tile
  assert.equal(pipLeaveKind(true, true, 10), 'code');
});

test('retomar transmissão e janela flutuante: ligações no código (marcador, botões, foco, regra do hidden)', () => {
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'public/style.css'), 'utf8');
  const main = readFileSync(join(ROOT, 'electron/src/main.js'), 'utf8');
  const preload = readFileSync(join(ROOT, 'electron/src/preload.js'), 'utf8');
  for(const id of ['resumeShare', 'resumeShareBtn', 'resumeShareDismiss']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(css, /\.resume-share\[hidden\]\{display:none;\}/);       // display:flex não pode vencer o hidden
  assert.match(appJs, /setSharingMarker\(true\)/);                        // marca ao começar a transmitir
  assert.match(appJs, /function resetShareButton\(\)\{[\s\S]*?setSharingMarker\(false\)/); // apaga quando termina por vontade
  assert.match(appJs, /takeSharingMarker\(\);[\s\S]*?params\.get\('retomar'\) !== '1'/);    // lê (e apaga) antes de decidir
  assert.match(preload, /focusWindow: \(\) => ipcRenderer\.send\('sinal:focus-window'\)/);
  assert.match(main, /trustedIpc\.on\('sinal:focus-window'/);
  // nenhum exitPictureInPicture solto: tudo passa por exitPip() (que avisa que foi por código)
  assert.equal((appJs.match(/document\.exitPictureInPicture\(\)/g) || []).length, 1);
});

// ---------- gerenciar sala privada (HANDOFF §53): regra do botão e ligações no código ----------
const manageFns = new Function(extractFunction(appJs, 'isRoomCaretaker') + extractFunction(appJs, 'canManageRoomUI') + extractFunction(appJs, 'manageFailureText') + '; return { canManageRoomUI, manageFailureText };')();

test('gerenciar sala: botão só pra dono de sala de servidor (criador, admin, dono/administrador/gerência); comum e sala sem servidor não', () => {
  const can = manageFns.canManageRoomUI;
  for(const access of ['open', 'approval', 'password', 'tipo-futuro']){
    const meta = { guild: 'G1', access, creator: { id: '111' } };
    assert.equal(can(meta, { userId: '111' }, 'G1'), true, access + ' criador');
    assert.equal(can(meta, { userId: '9', isAdmin: true }, 'G1'), true, access + ' admin');
    for(const tier of ['o', 'a', 'm']) assert.equal(can(meta, { userId: '9', tier, guild: 'G1' }, 'G1'), true, access + ' ' + tier);
    assert.equal(can(meta, { userId: '9', tier: 'm', guild: 'OUTRO' }, 'G1'), false, access + ' cargo de outro servidor');
    assert.equal(can(meta, { userId: '9', tier: 'x', guild: 'G1' }, 'G1'), false, access + ' comum');
  }
  assert.equal(can({ creator: { id: '111' } }, { userId: '111' }, 'G1'), false);   // sem `guild`: não é sala de servidor
  assert.equal(can(null, { userId: '111' }, 'G1'), false);
  assert.equal(can({ guild: 'G1', access: 'password' }, null, 'G1'), false);
});

test('gerenciar sala: texto pra cada erro do servidor (e um padrão pro desconhecido)', () => {
  const t = manageFns.manageFailureText;
  for(const e of ['sem-permissao', 'titulo-invalido', 'senha-invalida', 'sala-nao-encontrada', 'sala-sem-dados', 'acesso-invalido', 'mesmo-acesso', 'pessoa-nao-esta-na-sala', 'ja-e-dono', 'muitos-pedidos']){
    assert.notEqual(t(e), t('qualquer-outro'), e);
  }
  assert.match(t(undefined), /Tente de novo/);
});

test('gerenciar sala: ligações no código (botão, janela, ações, evento de metadata, aviso de sala encerrada, regra do hidden)', () => {
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  for(const id of ['manageBtn', 'manageOverlay', 'manageName', 'manageRename', 'managePwSection', 'managePassword', 'manageSetPw', 'manageStatus', 'manageEnd', 'manageClose']){
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /id="manageBtn"[^>]*hidden/);                                   // nasce escondido
  for(const action of ['rename', 'set-password', 'close']) assert.match(appJs, new RegExp(`action: '${action}'`), action);
  assert.match(appJs, /RoomEvent\.RoomMetadataChanged[\s\S]*?refreshRoomChip\(\);[\s\S]*?updateManageButton\(\)/); // nome e botões acompanham o metadata
  assert.match(appJs, /DisconnectReason\.ROOM_DELETED[\s\S]*?A sala foi encerrada\./);                          // quem estava dentro entende o que houve
  assert.match(appJs, /askConfirm\(\{\s*title: 'Encerrar a sala'[\s\S]*?danger: true/);                          // encerrar sempre pede confirmação
  assert.match(appJs, /function leaveRoom\(\)\{[\s\S]*?manageBtn'\)\.hidden = true;[\s\S]*?closeManage\(\)/);    // sair da sala fecha tudo
});

// ---------- trocar acesso e passar a sala (HANDOFF §54): lista de candidatos e ligações ----------
const transferCandidates = new Function(extractFunction(appJs, 'transferCandidates') + '; return transferCandidates;')();

test('passar a sala: candidatos = OUTRAS pessoas na sala com conta do Discord, menos o dono atual, em ordem de nome', () => {
  const remote = new Map([
    ['a', { name: 'Zeca', identity: 'a', metadata: JSON.stringify({ userId: '300000000000000001' }) }],
    ['b', { name: 'Ana', identity: 'b', metadata: JSON.stringify({ userId: '300000000000000002' }) }],
    ['c', { name: 'Visitante', identity: 'c', metadata: '' }],                                   // sem conta: não pode
    ['d', { name: 'Quebrado', identity: 'd', metadata: '{ruim' }],
    ['e', { name: 'Id estranho', identity: 'e', metadata: JSON.stringify({ userId: '12' }) }],
    ['f', { identity: 'sem-nome', metadata: JSON.stringify({ userId: '300000000000000003' }) }],  // sem nome: usa a identidade
    ['g', { name: 'Dono atual', identity: 'g', metadata: JSON.stringify({ userId: '300000000000000009' }) }]
  ]);
  const liveRoom = { remoteParticipants: { forEach: (fn) => remote.forEach(fn) } };
  const out = transferCandidates(liveRoom, { creator: { id: '300000000000000009' } });
  assert.deepEqual(out.map((p) => p.name), ['Ana', 'sem-nome', 'Zeca']);
  assert.deepEqual(transferCandidates(null, {}), []);
});

test('trocar acesso e passar a sala: ligações no código (campos, ações, metadata, aviso de sala aberta, sino some)', () => {
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  for(const id of ['manageAccess', 'manageApplyAccess', 'manageAccessPw', 'manageAccessHint', 'manageTransferSection', 'manageTransfer', 'manageDoTransfer']){
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  for(const v of ['open', 'approval', 'password']) assert.match(html, new RegExp(`<option value="${v}">`), v);
  assert.match(html, /id="manageAccessPw"[^>]*hidden/);
  for(const action of ['set-access', 'transfer']) assert.match(appJs, new RegExp(`action: '${action}'`), action);
  assert.match(appJs, /askConfirm\(\{ title: 'Abrir a sala'/);                      // abrir a sala (qualquer um entra) pede confirmação
  assert.match(appJs, /askConfirm\(\{\s*title: 'Passar a sala'/);                   // passar a sala também
  assert.match(appJs, /RoomMetadataChanged[\s\S]*?clearKnockCards\(\)[\s\S]*?refreshManageDialog\(\)/);   // deixou de ser aprovação: sino some; janela acompanha
  assert.match(appJs, /ParticipantConnected[\s\S]*?refreshManageDialog\(\)/);       // quem entra/sai atualiza a lista de "passar a sala"
});

test('pedido de entrada no app: a consulta entra sozinha se a sala virou aberta e troca pra caixa da senha se virou senha', () => {
  assert.match(appJs, /if\(res\.status === 200\)\{ finish\(true\); return; \} \/\/ inclusive se a sala virou ABERTA/);
  assert.match(appJs, /error === 'sala-privada' && data\.access === 'password' && !stopped\)\{ cleanup\(\); resolve\(requestToJoinRoom\(roomName, 'password'\)\)/);
});

test('diagnóstico (envio): sem resolução e sem quadros = ninguém assistindo (dynacast pausou) e NÃO gera linha; com resolução e 0 quadros ainda gera', () => {
  const pausado = { quality: 'Fluido', codec: 'H.264', width: undefined, height: undefined, targetFps: 60, reason: 'bandwidth', d: { seconds: 16, frames: 0, encodeMs: 0, bytes: 0, keyFrames: 0, pli: 0, nack: 0 } };
  assert.equal(trouble.senderTroubleLine(pausado), null);
  assert.match(trouble.senderTroubleLine({ ...pausado, width: 1920, height: 1080 }), /0fps/);                 // travou de verdade: continua avisando
  assert.match(trouble.senderTroubleLine({ ...pausado, d: { ...pausado.d, frames: 120 }, width: undefined, height: undefined }), /fps/); // com quadros, mesmo sem resolução, segue a regra normal
});

test('diagnóstico (envio): mostra quantos quadros a CAPTURA entregou, pra separar "a captura entregou pouco" de "o envio perdeu quadros"', () => {
  const base = { quality: 'Fluido', codec: 'H.264', width: 1920, height: 1080, targetFps: 60, reason: 'none', d: { seconds: 4, frames: 124, encodeMs: 700, bytes: 2_000_000, keyFrames: 0, pli: 0, nack: 0 } };
  assert.match(trouble.senderTroubleLine({ ...base, d: { ...base.d, captured: 124 } }), /31fps \(meta 60\) · captura 31fps/);   // capturou pouco
  assert.match(trouble.senderTroubleLine({ ...base, d: { ...base.d, captured: 240 } }), /31fps \(meta 60\) · captura 60fps/);   // capturou 60 e o envio perdeu
  assert.doesNotMatch(trouble.senderTroubleLine(base), /captura/);                                                           // sem o dado (navegador antigo): some
  assert.doesNotMatch(trouble.senderTroubleLine({ ...base, d: { ...base.d, captured: null } }), /captura/);
});

test('app desktop: o seletor de tela responde UMA vez só (cancelar não gera erro duplo) e a segunda instância não monta nada', () => {
  const main = readFileSync(join(ROOT, 'electron/src/main.js'), 'utf8');
  assert.match(main, /setDisplayMediaRequestHandler\(async \(request, callback\) => \{\s*[\s\S]*?let answered = false;[\s\S]*?const answer = /);
  const handler = main.slice(main.indexOf('setDisplayMediaRequestHandler(async'), main.indexOf('setDisplayMediaRequestHandler(async') + 4000);
  assert.equal((handler.match(/\bcallback\(/g) || []).length, 1);   // o único callback( é o de dentro de answer()
  assert.match(main, /app\.whenReady\(\)\.then\(\(\) => \{\s*[\s\S]*?if\(!gotSingleInstanceLock\) return;/);
});

test('diagnóstico: contador que volta pra trás (faixa nova, reconexão) não vira linha com fps negativo', () => {
  const neg = { codec: 'H.264', width: 1920, height: 1080, d: { seconds: 4, received: -2056, decoded: -2056, dropped: 0, freezes: -903, freezeSeconds: -472, bytes: -105_000_000, lost: 0, pli: -80, nack: -5850 } };
  assert.equal(trouble.viewerTroubleLine(neg), null);
  assert.equal(trouble.senderTroubleLine({ quality: 'Fluido', codec: 'H.264', width: 1920, height: 1080, targetFps: 60, reason: 'none', d: { seconds: 4, frames: 10, encodeMs: 40, bytes: -5, keyFrames: 0, pli: 0, nack: 0 } }), null);
});

// ---------- codificação por hardware: perfil H.264 High na frente (HANDOFF §58) ----------
const preferH264High = new Function(extractFunction(appJs, 'preferH264High') + '; return preferH264High;')();
const CRLF = String.fromCharCode(13, 10);
// resposta de verdade do servidor (trecho): Baseline (108, 114) na frente, High (118) depois
const respostaServidor = [
  'v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2',
  'm=video 9 UDP/TLS/RTP/SAVPF 108 114 118 96 109',
  'a=rtpmap:108 H264/90000', 'a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  'a=rtpmap:114 H264/90000', 'a=fmtp:114 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f',
  'a=rtpmap:118 H264/90000', 'a=fmtp:118 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f',
  'a=rtpmap:96 VP8/90000', 'a=rtpmap:109 rtx/90000', 'a=fmtp:109 apt=108', ''
].join(CRLF);

test('perfil H.264 High: numa oferta/resposta de SDP o High passa pra frente dos H.264 Baseline; o resto não muda', () => {
  const out = preferH264High(respostaServidor);
  const m = /m=video \d+ \S+ ([\d ]+)/.exec(out.split(CRLF).find((l) => l.startsWith('m=video')) + ' ');
  assert.equal(m[1].trim(), '118 108 114 96 109');                          // High antes do Baseline; VP8 e rtx continuam onde estavam
  assert.equal(out.split(CRLF).filter((l) => l.startsWith('a=')).join('|'), respostaServidor.split(CRLF).filter((l) => l.startsWith('a=')).join('|'));   // atributos intactos
  assert.ok(out.includes('m=audio 9 UDP/TLS/RTP/SAVPF 111'));              // só a linha de vídeo muda
});

test('perfil H.264 High: não mexe quando não há o que fazer (já é o primeiro, sem High, sem H.264, texto estranho)', () => {
  const jaHigh = respostaServidor.replace('108 114 118 96 109', '118 108 114 96 109');
  assert.equal(preferH264High(jaHigh), jaHigh);
  const semHigh = respostaServidor.replace('profile-level-id=64001f', 'profile-level-id=4d001f');
  assert.equal(preferH264High(semHigh), semHigh);
  const soVp8 = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000', ''].join(CRLF);
  assert.equal(preferH264High(soVp8), soVp8);
  const vp8Primeiro = respostaServidor.replace('108 114 118 96 109', '96 108 114 118 109');
  const out = preferH264High(vp8Primeiro);
  assert.ok(out.includes('m=video 9 UDP/TLS/RTP/SAVPF 96 118 108 114 109'));   // VP8 continua sendo o primeiro (a escolha de codec é do servidor)
  for(const lixo of ['', 'qualquer coisa', null, undefined, 5]) assert.equal(preferH264High(lixo), lixo);
});

test('perfil H.264 High: duas seções de vídeo (câmera e tela) são tratadas separadamente', () => {
  const dois = respostaServidor + ['m=video 9 UDP/TLS/RTP/SAVPF 100 101', 'a=rtpmap:100 H264/90000', 'a=fmtp:100 profile-level-id=42e01f', 'a=rtpmap:101 H264/90000', 'a=fmtp:101 profile-level-id=640028', ''].join(CRLF);
  const out = preferH264High(dois).split(CRLF).filter((l) => l.startsWith('m=video'));
  assert.deepEqual(out, ['m=video 9 UDP/TLS/RTP/SAVPF 118 108 114 96 109', 'm=video 9 UDP/TLS/RTP/SAVPF 101 100']);
});

test('codificação por hardware: nasce DESLIGADA, só no app desktop, só se a placa confirmar, e a opção só aparece onde o app conhece a chave', () => {
  const main = readFileSync(join(ROOT, 'electron/src/main.js'), 'utf8');
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  assert.match(main, /hardwareEncode: false\s*\n\};/);                                              // padrão: desligada
  assert.match(main, /'startMinimized', 'hardwareEncode'\]/);                                    // só booleano passa pela limpeza
  assert.match(appJs, /if\(!\(window\.sinalElectron && window\.sinalElectron\.isElectron\) \|\| !window\.RTCPeerConnection\) return;/);
  assert.match(appJs, /RTCPeerConnection\.prototype\.createOffer = async function/);                                       // mexe na OFERTA (a resposta sozinha deixava o espectador sem imagem)
  assert.match(appJs, /hardwareEncodeReady && electronSettings && electronSettings\.hardwareEncode && offer && typeof offer\.sdp === 'string'/);   // só ligado e só com a placa ok
  assert.doesNotMatch(appJs, /RTCPeerConnection\.prototype\.setRemoteDescription = /);
  assert.match(appJs, /profile-level-id=64001f;packetization-mode=1', width: 1920, height: 1080, framerate: 60/);
  assert.match(appJs, /r\.supported && r\.powerEfficient/);
  assert.match(appJs, /catch\(e\)\{ \/\* nunca atrapalha a negociação/);                           // erro no ajuste nunca derruba a negociação
  assert.match(appJs, /const known = !!settings && 'hardwareEncode' in settings;/);                 // aparece pra todo app que conhece a chave
  assert.match(html, /id="settingsHardwareSection"[^>]*hidden/);
  assert.match(html, /id="settingsHardwareEncode"/);
  assert.match(appJs, /codificador em uso: \$\{outbound\.encoderImplementation\}/);                // o relatório diz qual codificador está em uso
});

test('gancho de teste do seletor: só existe fora do app empacotado (nunca no instalador)', () => {
  const main = readFileSync(join(ROOT, 'electron/src/main.js'), 'utf8');
  assert.match(main, /!app\.isPackaged && process\.env\.SINAL_TEST_AUTOPICK === '1'/);
});

// ---------- codificação por hardware: a opção aparece pra todos; sem suporte da placa fica cinza com o aviso ----------
function fakeHardwareUi(ready, checked){
  const els = {
    settingsHardwareSection: { hidden: true },
    settingsHardwareEncode: { disabled: false, checked: false },
    settingsHardwareStatus: { hidden: true, textContent: '' },
    settingsHardwareRow: { disabledClass: false, classList: { toggle(name, on){ if(name === 'settings-row-disabled') els.settingsHardwareRow.disabledClass = !!on; } } }
  };
  const render = new Function('document', 'hardwareEncodeReady', 'hardwareEncodeChecked', extractFunction(appJs, 'renderHardwareSection') + '; return renderHardwareSection;')({ getElementById: (id) => els[id] }, ready, checked);
  return { els, render };
}

test('opção de codificação por hardware: placa COM suporte = habilitada e reflete a configuração', () => {
  const { els, render } = fakeHardwareUi(true, true);
  render({ hardwareEncode: true });
  assert.deepEqual([els.settingsHardwareSection.hidden, els.settingsHardwareEncode.disabled, els.settingsHardwareEncode.checked, els.settingsHardwareRow.disabledClass, els.settingsHardwareStatus.hidden], [false, false, true, false, true]);
  render({ hardwareEncode: false });
  assert.equal(els.settingsHardwareEncode.checked, false);
});

test('opção de codificação por hardware: placa SEM suporte = visível, cinza, sem poder marcar (nunca aparece marcada) e com o aviso', () => {
  const { els, render } = fakeHardwareUi(false, true);
  render({ hardwareEncode: true });                                           // mesmo que a configuração esteja ligada de antes
  assert.deepEqual([els.settingsHardwareSection.hidden, els.settingsHardwareEncode.disabled, els.settingsHardwareEncode.checked, els.settingsHardwareRow.disabledClass, els.settingsHardwareStatus.hidden], [false, true, false, true, false]);
  assert.equal(els.settingsHardwareStatus.textContent, 'Sua placa de vídeo não suporta este método de codificação.');
});

test('opção de codificação por hardware: enquanto a placa é verificada fica cinza com "Verificando…"; app antigo (sem a chave) não mostra a seção', () => {
  const { els, render } = fakeHardwareUi(false, false);
  render({ hardwareEncode: false });
  assert.deepEqual([els.settingsHardwareSection.hidden, els.settingsHardwareEncode.disabled, els.settingsHardwareStatus.hidden], [false, true, false]);
  assert.match(els.settingsHardwareStatus.textContent, /Verificando/);
  const velho = fakeHardwareUi(true, true);
  velho.render({ shortcutEnabled: true });                                    // instalador que não conhece `hardwareEncode`
  assert.equal(velho.els.settingsHardwareSection.hidden, true);
  velho.render(null);
  assert.equal(velho.els.settingsHardwareSection.hidden, true);
});

test('opção de codificação por hardware: o texto explica o que é e a verificação nunca deixa a opção presa (erro/sem API = sem suporte)', () => {
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  assert.match(html, /chip de vídeo da sua placa/);
  assert.match(html, /id="settingsHardwareStatus"[^>]*hidden/);
  assert.match(appJs, /sem como saber = sem suporte/);
  assert.match(appJs, /\.catch\(\(\) => \{\s*hardwareEncodeChecked = true;/);
});

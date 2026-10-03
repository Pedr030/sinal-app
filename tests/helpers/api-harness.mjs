// Monta uma cópia temporária de api/ + lib/ com um livekit-server-sdk FALSO e
// importa a função de verdade de lá. A cópia é necessária porque os arquivos
// reais importam 'livekit-server-sdk' por specifier nu — pra trocar isso por um
// fake sem mexer no código de produção nem depender de flag experimental de
// mock de módulo do Node, a gente monta uma pasta com a mesma estrutura
// relativa (api/, lib/, node_modules/livekit-server-sdk) e importa de lá.
//
// O fake guarda o estado em globalThis.__fakeLivekit, que os testes preenchem:
//   rooms         — o que listRooms() devolve (objetos { name, numParticipants, metadata, creationTime })
//   participants  — { [sala]: [{ identity, name, metadata, tracks, joinedAt }] }
//   created       — última chamada de createRoom
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const TEST_SECRET = 'segredo-de-teste-do-discord';

export async function loadApi(apiFile){
  const dir = mkdtempSync(join(tmpdir(), 'sinal-api-test-'));
  mkdirSync(join(dir, 'api'));
  mkdirSync(join(dir, 'lib'));
  mkdirSync(join(dir, 'node_modules', 'livekit-server-sdk'), { recursive: true });

  copyFileSync(join(ROOT, 'api', apiFile), join(dir, 'api', apiFile));
  for(const f of readdirSync(join(ROOT, 'lib'))) copyFileSync(join(ROOT, 'lib', f), join(dir, 'lib', f));

  writeFileSync(
    join(dir, 'node_modules/livekit-server-sdk/package.json'),
    JSON.stringify({ name: 'livekit-server-sdk', version: '0.0.0-fake', type: 'module', main: 'index.js' })
  );
  writeFileSync(
    join(dir, 'node_modules/livekit-server-sdk/index.js'),
    `
const st = () => (globalThis.__fakeLivekit = globalThis.__fakeLivekit || { rooms: [], participants: {}, created: null, sent: [] });
export class AccessToken {
  constructor(key, secret, opts){ this.opts = opts; this.grant = null; }
  addGrant(g){ this.grant = g; }
  async toJwt(){ if(globalThis.__failToken) throw new Error('detalhe interno SECRETO do livekit em https://interno.invalid'); return 'FAKE_JWT.' + JSON.stringify({ identity: this.opts.identity, name: this.opts.name, metadata: this.opts.metadata, attributes: this.opts.attributes, grant: this.grant }); }
}
export class RoomServiceClient {
  constructor(url, key, secret){ this.url = url; }
  async listRooms(names){
    const all = st().rooms;
    return names ? all.filter((r) => names.includes(r.name)) : all;
  }
  async listParticipants(room){ return st().participants[room] || []; }
  async createRoom(opts){ st().created = opts; return { name: opts.name }; }
  async sendData(room, data, kind, options){ st().sent.push({ room, text: new TextDecoder().decode(data), kind, options }); }
  async removeParticipant(room, identity, options){ (st().actions = st().actions || []).push({ type: 'kick', room, identity, options }); }
  async mutePublishedTrack(room, identity, sid, muted){ (st().actions = st().actions || []).push({ type: 'mute', room, identity, sid, muted }); }
}
export class TokenVerifier {
  constructor(key, secret){}
  async verify(token){
    if(!String(token).startsWith('FAKE_JWT.')) throw new Error('invalid');
    const d = JSON.parse(String(token).slice(9));
    return { video: d.grant, metadata: d.metadata, identity: d.identity };
  }
}
export const DataPacket_Kind = { RELIABLE: 0, LOSSY: 1 };
export class WebhookReceiver {
  constructor(key, secret){}
  async receive(body, auth){
    if(auth !== 'assinatura-valida') throw new Error('invalid');
    return JSON.parse(body);
  }
}
`
  );

  process.env.LIVEKIT_API_KEY = 'fake-key';
  process.env.LIVEKIT_API_SECRET = 'fake-secret';
  process.env.LIVEKIT_URL = 'wss://fake.example.com';
  process.env.DISCORD_CLIENT_SECRET = TEST_SECRET;

  const mod = await import(pathToFileURL(join(dir, 'api', apiFile)).href);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function resetFake(){
  globalThis.__fakeLivekit = { rooms: [], participants: {}, created: null, sent: [], actions: [] };
  return globalThis.__fakeLivekit;
}

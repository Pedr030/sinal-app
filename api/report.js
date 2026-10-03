// "Enviar relatório de problema" (configurações do app desktop) — recebe o
// texto da pessoa + o final do registro do app e repassa pra um canal
// PRIVADO do Discord via webhook. A URL do webhook só existe aqui no servidor
// (variável DISCORD_REPORT_WEBHOOK_URL na Vercel), nunca no app — quem
// abrisse o código do app não conseguiria postar no canal. Ver HANDOFF §37.
//
// Sem banco, então o limite de envios é "melhor esforço": guardado na memória
// desta instância da função (some quando a Vercel recicla a instância). Junto
// com os limites de tamanho e o próprio limite do Discord (~30 msg/min por
// webhook), segura uso errado; se um dia virar spam, é só trocar o webhook.

const MAX_DESCRIPTION = 1500;
const MAX_LOG_BYTES = 80 * 1024;
const MAX_PER_IP = 3;               // envios por IP…
const WINDOW_MS = 10 * 60 * 1000;   // …a cada 10 minutos
const recentByIp = new Map();

function json(status, data){
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

// Texto livre de quem reporta vai pra mensagem do Discord: tira crases (não
// quebrar a formatação) e limita tamanho. Menções já ficam desligadas pelo
// allowed_mentions abaixo.
function clean(value, max){
  return (typeof value === 'string' ? value : '').replace(/`/g, "'").trim().slice(0, max);
}

export async function POST(request){
  const webhookUrl = process.env.DISCORD_REPORT_WEBHOOK_URL;
  if(!webhookUrl) return json(503, { error: 'relatorio-desligado' });

  const ip = (request.headers.get('x-forwarded-for') || 'desconhecido').split(',')[0].trim();
  const now = Date.now();
  const recent = (recentByIp.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if(recent.length >= MAX_PER_IP) return json(429, { error: 'muitos-envios' });

  let body;
  try{ body = await request.json(); }catch(e){ return json(400, { error: 'corpo-invalido' }); }

  const description = clean(body.description, MAX_DESCRIPTION);
  const name = clean(body.name, 40) || 'anônimo';
  const appVersion = clean(body.appVersion, 20) || '?';
  const siteVersion = clean(body.siteVersion, 20) || '?';
  const log = typeof body.log === 'string' ? body.log : '';
  if(!description && !log) return json(400, { error: 'vazio' });
  if(Buffer.byteLength(log, 'utf8') > MAX_LOG_BYTES) return json(413, { error: 'registro-grande-demais' });

  recent.push(now);
  recentByIp.set(ip, recent);

  const content = [
    `🐞 **Relatório de problema** — ${name} · app v${appVersion} · site v${siteVersion}`,
    description ? '> ' + description.replace(/\n/g, '\n> ') : '> (sem descrição)'
  ].join('\n').slice(0, 1990);

  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content, allowed_mentions: { parse: [] } }));
  if(log) form.append('files[0]', new Blob([log], { type: 'text/plain' }), `sinal-registro-${now}.txt`);

  try{
    const res = await fetch(webhookUrl, { method: 'POST', body: form });
    if(!res.ok){
      console.error('Webhook de relatório respondeu', res.status);
      return json(502, { error: 'discord-recusou' });
    }
  }catch(e){
    console.error('Webhook de relatório falhou:', e && e.message);
    return json(502, { error: 'discord-falhou' });
  }
  return json(200, { ok: true });
}

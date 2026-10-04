// Primeiro passo do login opcional com Discord: monta a URL de autorização
// oficial do Discord e redireciona o navegador pra lá. A pessoa loga direto
// no site do Discord — a senha dela nunca passa por aqui. client_id não é
// segredo, mas fica em variável de ambiente (não hardcoded no app.js) pra
// ficar fácil de trocar sem precisar mexer em código, igual as chaves do
// LiveKit.
//
// Escopos: `identify` (nome + avatar) e `guilds` (lista de servers do Discord
// da pessoa, com as permissões dela em cada um — é o que alimenta os "servers
// no Sinal", HANDOFF §38). Nada além disso: não lê mensagens, não vê membros.
import { randomBytes } from 'node:crypto';

export async function GET(request){
  const clientId = process.env.DISCORD_CLIENT_ID;
  if(!clientId){
    return new Response('Login com Discord não está configurado neste servidor (DISCORD_CLIENT_ID ausente).', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }

  const url = new URL(request.url);
  // Deriva o redirect_uri da própria origem da requisição em vez de fixar
  // um domínio — assim funciona igual em produção e no preview da branch
  // development, contanto que os dois estejam cadastrados no painel do
  // Discord (ver HANDOFF.md).
  const redirectUri = `${url.origin}/api/discord-callback`;
  // "state" carrega o código de sala em andamento (se a pessoa já tinha
  // digitado um antes de clicar em "Entrar com Discord"), pra não se perder
  // no vai-e-volta com o Discord.
  const sala = (url.searchParams.get('sala') || '').trim().toUpperCase().slice(0, 32);
  // Login pedido pelo APP DESKTOP (HANDOFF §39, fase 2c): o app abre o navegador
  // padrão aqui com um nonce que ele mesmo gerou; ele vai no `state` e volta no
  // callback, que devolve a sessão pro app por sinal://auth. Sem nonce válido, 400.
  const fromApp = url.searchParams.get('client') === 'app';
  const nonce = (url.searchParams.get('nonce') || '').toLowerCase();
  if(fromApp && !/^[a-f0-9]{32}$/.test(nonce)){
    return new Response('Pedido de login do app inválido.', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  const authorizeUrl = new URL('https://discord.com/oauth2/authorize');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'identify guilds');
  // Login pelo navegador (não o do app): o `state` leva um nonce aleatório que TAMBÉM vai num
  // cookie (HttpOnly, SameSite=Lax) e o callback exige que os dois batam. Sem isso, um atacante
  // poderia iniciar o login na conta DELE e mandar o link do callback pra vítima, que ficaria
  // logada como o atacante sem perceber ("login CSRF"). O login do app já é protegido pelo
  // nonce guardado no próprio app.
  let setCookie = null;
  if(fromApp){
    authorizeUrl.searchParams.set('state', 'app.' + nonce);
  } else {
    const csrf = randomBytes(16).toString('hex');
    authorizeUrl.searchParams.set('state', csrf + (sala ? '.' + sala : ''));
    setCookie = `sinal_oauth=${csrf}; Max-Age=600; Path=/api/discord-callback; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}`;
  }
  // "Atualizar meus servidores": renova o login sem tela de consentimento
  // (se a pessoa já autorizou, o Discord devolve o code direto).
  if(url.searchParams.get('refresh') === '1') authorizeUrl.searchParams.set('prompt', 'none');

  const headers = { location: authorizeUrl.toString() };
  if(setCookie) headers['set-cookie'] = setCookie;
  return new Response(null, { status: 302, headers });
}

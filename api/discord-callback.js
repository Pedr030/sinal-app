// Segundo passo do login com Discord: o Discord manda a pessoa de volta pra
// cá com um "code" de uso único. Trocamos esse code pelo perfil e pela lista
// de servers dela usando o Client Secret — que só existe aqui, no servidor,
// nunca no navegador (mesma cautela da LIVEKIT_API_SECRET em get-token.js).
//
// O resultado vira uma SESSÃO ASSINADA (lib/session.js, HANDOFF §38): nome,
// avatar, se é admin do Sinal e os servers com o nível dela em cada um. Ela
// volta pro navegador no fragmento da URL (#session=…), que o navegador não
// manda pra servidor nenhum — não vai pra log, histórico de requisição nem
// cabeçalho Referer. O token do Discord em si é descartado aqui.
//
// Se o Discord ID bater com ADMIN_DISCORD_IDS, só aqui (via OAuth real) é
// possível confirmar isso — a assinatura leva essa informação adiante.
import { buildSession } from '../lib/session.js';

export async function GET(request){
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const url = new URL(request.url);
  const redirectTo = (extra) => Response.redirect(url.origin + '/' + (extra || ''), 302);

  if(!clientId || !clientSecret){
    return new Response('Login com Discord não está configurado neste servidor.', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }

  const code = url.searchParams.get('code');
  if(!code) return redirectTo('?discord_error=1');

  const redirectUri = `${url.origin}/api/discord-callback`;
  // "state" veio do discord-login.js — é o código de sala que a pessoa já
  // tinha digitado antes de clicar em "Entrar com Discord", se tinha.
  const sala = (url.searchParams.get('state') || '').trim().toUpperCase().slice(0, 32);

  try{
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      })
    });
    if(!tokenRes.ok) throw new Error('token-exchange-failed: ' + tokenRes.status);
    const tokenData = await tokenRes.json();
    const auth = { authorization: `Bearer ${tokenData.access_token}` };

    const profileRes = await fetch('https://discord.com/api/users/@me', { headers: auth });
    if(!profileRes.ok) throw new Error('profile-fetch-failed: ' + profileRes.status);
    const profile = await profileRes.json();

    // A lista de servers é o que alimenta os "servers no Sinal", mas o login em
    // si não depende dela: se falhar, a pessoa entra do mesmo jeito (só sem
    // servers) em vez de ficar sem conseguir usar o Sinal.
    let guilds = [];
    try{
      const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', { headers: auth });
      if(guildsRes.ok) guilds = await guildsRes.json();
      else console.error('Lista de servers do Discord recusada:', guildsRes.status);
    }catch(e){
      console.error('Lista de servers do Discord falhou:', e && e.message);
    }

    const adminIds = (process.env.ADMIN_DISCORD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const session = buildSession({ profile, guilds, adminIds, secret: clientSecret });

    const dest = new URL(url.origin + '/');
    if(sala) dest.searchParams.set('sala', sala);
    dest.hash = 'session=' + session;
    return Response.redirect(dest.toString(), 302);
  }catch(e){
    console.error('Login com Discord falhou:', e && e.message, e);
    return redirectTo('?discord_error=1');
  }
}

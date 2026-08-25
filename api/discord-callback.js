// Segundo passo do login com Discord: o Discord manda a pessoa de volta pra
// cá com um "code" de uso único. Trocamos esse code pelo perfil dela (nome +
// avatar) usando o Client Secret — que só existe aqui, no servidor, nunca no
// navegador (mesma cautela da LIVEKIT_API_SECRET em get-token.js).
//
// Importante: não precisamos assinar nem guardar sessão nenhuma depois disso.
// O nome/avatar que devolvemos pro navegador só controlam o que a PRÓPRIA
// pessoa vê como identidade dela no Sinal — exatamente como o campo de nome
// livre já funciona hoje. Não é um token de acesso a nada, então não tem
// como alguém "forjar" isso pra ganhar permissão de outra pessoa.
//
// Exceção: se o Discord ID bater com ADMIN_DISCORD_IDS, aqui é o único lugar
// que pode confirmar isso de verdade (via OAuth real) — por isso assinamos
// um comprovante (ver lib/adminProof.js) pra get-token.js poder confiar
// nisso depois, sem precisar repetir o login do Discord a cada sala.
import { signAdminProof } from '../lib/adminProof.js';

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

    const profileRes = await fetch('https://discord.com/api/users/@me', {
      headers: { authorization: `Bearer ${tokenData.access_token}` }
    });
    if(!profileRes.ok) throw new Error('profile-fetch-failed: ' + profileRes.status);
    const profile = await profileRes.json();

    const displayName = (profile.global_name || profile.username || 'Convidado').slice(0, 40);
    const avatarUrl = profile.avatar
      ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=64`
      : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(profile.id) >> 22n) % 6n)}.png`;

    const dest = new URL(url.origin + '/');
    dest.searchParams.set('discord_name', displayName);
    dest.searchParams.set('discord_avatar', avatarUrl);
    if(sala) dest.searchParams.set('sala', sala);

    const adminIds = (process.env.ADMIN_DISCORD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if(adminIds.includes(profile.id) && clientSecret){
      dest.searchParams.set('discord_admin_proof', signAdminProof(profile.id, clientSecret));
    }

    return Response.redirect(dest.toString(), 302);
  }catch(e){
    console.error('Login com Discord falhou:', e && e.message, e);
    return redirectTo('?discord_error=1');
  }
}

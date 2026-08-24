// Primeiro passo do login opcional com Discord: monta a URL de autorização
// oficial do Discord e redireciona o navegador pra lá. A pessoa loga direto
// no site do Discord — a senha dela nunca passa por aqui. client_id não é
// segredo, mas fica em variável de ambiente (não hardcoded no app.js) pra
// ficar fácil de trocar sem precisar mexer em código, igual as chaves do
// LiveKit.
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

  const authorizeUrl = new URL('https://discord.com/oauth2/authorize');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'identify');
  if(sala) authorizeUrl.searchParams.set('state', sala);

  return Response.redirect(authorizeUrl.toString(), 302);
}

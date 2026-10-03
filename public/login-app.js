// Entrega a sessão do Discord pro app desktop (HANDOFF §39, fase 2c).
// Chegou aqui vindo de api/discord-callback.js com #session=…&nonce=… (ou
// #error=1). Monta o link sinal://auth?session=…&nonce=… e abre. O nonce foi
// gerado pelo próprio app antes de abrir o navegador — o app só aceita a
// sessão se ele bater, então um link sinal://auth forjado por outra página não
// consegue "logar" ninguém numa conta alheia.
(function(){
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const session = params.get('session') || '';
  const nonce = params.get('nonce') || '';
  const title = document.getElementById('laTitle');
  const text = document.getElementById('laText');
  const open = document.getElementById('laOpen');
  // O fragmento não precisa ficar no histórico do navegador.
  history.replaceState(null, '', window.location.pathname);

  // Formato estrito: só entra o que o servidor realmente gera (base64url + ponto; nonce hex).
  const valid = /^[A-Za-z0-9_.-]{20,10000}$/.test(session) && /^[a-f0-9]{32}$/.test(nonce);
  if(!valid){
    title.textContent = 'Não deu pra entrar';
    text.textContent = 'O Discord não confirmou o login (ou o link está incompleto). Volte pro Sinal e clique em "Entrar com Discord" de novo.';
    return;
  }

  const link = 'sinal://auth?session=' + session + '&nonce=' + nonce;
  open.href = link;
  open.hidden = false;
  window.location.href = link; // o navegador pode perguntar se deixa abrir o Sinal
  setTimeout(() => {
    title.textContent = 'Pronto — pode voltar pro Sinal';
    text.textContent = 'Se o app não abriu sozinho, clique no botão abaixo. Depois pode fechar esta aba.';
  }, 1500);
})();

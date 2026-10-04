// Limite de pedidos "melhor esforço" (HANDOFF §42), em memória da instância da function.
//
// As rotas de api/ são públicas e baratas de chamar, mas cada uma faz trabalho de verdade (fala
// com o LiveKit, gasta invocação e CPU do plano gratuito da Vercel). Sem nenhum limite, uma
// pessoa com um loop poderia esgotar a cota do mês — e tirar o Sinal do ar pra todo mundo — ou
// criar salas e conexões em massa na VM. Este limitador segura o uso abusivo mais óbvio.
//
// É "melhor esforço" de propósito: cada instância da function tem a própria memória (a Vercel
// pode manter várias, e recicla), então não é um limite exato — só encarece muito o abuso
// simples sem precisar de banco de dados. O freio de verdade pra ataque distribuído é o
// Firewall da própria Vercel (ver HANDOFF §42).

export function createLimiter({ max, windowMs, maxKeys = 5000 }){
  const hits = new Map(); // chave -> [timestamps dentro da janela]

  function prune(now){
    for(const [key, list] of hits){
      if(!list.length || now - list[list.length - 1] >= windowMs) hits.delete(key);
    }
    if(hits.size > maxKeys) hits.clear(); // muitas chaves de uma vez: reinicia (falha aberta, sem estourar a memória)
  }

  return {
    // true = pode passar; false = estourou o limite desta chave na janela.
    allow(key, now = Date.now()){
      if(hits.size > maxKeys) prune(now);
      const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if(list.length >= max){
        hits.set(key, list);
        return false;
      }
      list.push(now);
      hits.set(key, list);
      return true;
    }
  };
}

// IP do cliente. Na Vercel o x-forwarded-for é sobrescrito pela plataforma (não dá pra forjar
// mandando o cabeçalho). Fora dela cai no x-real-ip ou num valor fixo.
export function clientIp(request){
  const xff = request.headers.get('x-forwarded-for');
  const ip = xff ? xff.split(',')[0] : (request.headers.get('x-real-ip') || 'desconhecido');
  return ip.trim().slice(0, 64) || 'desconhecido';
}

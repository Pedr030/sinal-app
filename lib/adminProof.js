// "Comprovante" pequeno e assinado de que um Discord ID específico é admin —
// usado pra ligar dois momentos que não têm sessão nenhuma entre eles
// (login via Discord em api/discord-callback.js, e entrada numa sala em
// api/get-token.js). Sem isso, get-token.js não teria como confiar que quem
// está pedindo o token realmente é o Discord ID esperado, sem reautenticar
// via OAuth de novo a cada sala.
//
// Assinado com HMAC-SHA256 usando o DISCORD_CLIENT_SECRET como chave — já é
// um segredo só-de-servidor que existe pra outra finalidade (trocar o code
// do OAuth), reaproveitado aqui pra não precisar de mais uma variável de
// ambiente. Validade de 30 dias: longa o bastante pra não pedir login toda
// hora (mesmo espírito do sinal:discordUser guardado no navegador), curta o
// bastante pra não ser um segredo "pra sempre" se algum dia vazar.
import { createHmac, timingSafeEqual } from 'node:crypto';

const PROOF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function signAdminProof(discordId, secret){
  const payload = Buffer.from(JSON.stringify({ id: discordId, exp: Date.now() + PROOF_TTL_MS })).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyAdminProof(proof, secret){
  if(!proof || typeof proof !== 'string') return false;
  const parts = proof.split('.');
  if(parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expectedSig = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if(a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try{
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof data.exp === 'number' && data.exp > Date.now();
  }catch(e){
    return false;
  }
}

# Sinal

Sala de tela compartilhada pra assistir jogo/vídeo com a galera — sem conta, sem instalar nada, só abrir um link. Feito pra rodar **em paralelo** com uma call de voz no Discord (Sinal cuida só da parte visual).

Qualquer pessoa na sala pode compartilhar tela e/ou câmera a qualquer momento, junto com todo mundo assistindo ao vivo. Não tem "anfitrião" — quem cria a sala e quem entra depois têm exatamente os mesmos privilégios.

## Como funciona

- **Frontend**: HTML + CSS + JS puro (`public/`), sem framework, sem build step.
- **Vídeo/áudio**: [LiveKit Cloud](https://livekit.io/cloud), um SFU (Selective Forwarding Unit) gerenciado — quem compartilha manda uma única cópia codificada pro servidor, que retransmite pra todo mundo, sem recodificar.
- **Backend**: uma única função serverless (`api/get-token.js`) que gera o token de acesso do LiveKit. É a única peça que roda em servidor — o resto é tudo estático.
- **Hospedagem**: [Vercel](https://vercel.com), deploy automático a cada `git push`.

## Rodando localmente

Precisa de uma conta grátis no [LiveKit Cloud](https://cloud.livekit.io) e da [Vercel CLI](https://vercel.com/docs/cli) instalada.

```bash
npm install
```

Crie um `.env` na raiz com as credenciais do seu projeto LiveKit:

```
LIVEKIT_URL=wss://seu-projeto.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

Depois:

```bash
vercel dev
```

Isso sobe o site e a função juntos, lendo o `.env` local.

## Licença

[MIT](LICENSE).

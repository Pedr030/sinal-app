# Sinal

**Sala de tela compartilhada, ao vivo, sem fricção.** Qualquer pessoa entra com um link, compartilha a tela quando quiser, e todo mundo assiste junto — sem conta, sem instalar nada, sem "anfitrião".

[**➜ Testar agora**](https://sinal-app-stream.vercel.app) · [Licença MIT](LICENSE)

![License](https://img.shields.io/badge/license-MIT-blue.svg) ![Vercel](https://img.shields.io/badge/deploy-Vercel-black.svg) ![LiveKit](https://img.shields.io/badge/media-LiveKit%20Cloud-1E1E2E.svg)

## Por que existe

Em agosto de 2026, a ANPD (autoridade de proteção de dados do Brasil) determinou a suspensão do compartilhamento de tela e vídeo do Discord no território nacional — voz e texto continuaram funcionando normalmente. Eu jogo com um grupo de amigos e a gente usava exatamente esse recurso pra assistir jogo/vídeo junto enquanto conversa na call de voz.

Em vez de esperar uma solução alheia, construí o Sinal: uma ferramenta pontual, feita pra rodar **em paralelo** com a call de voz do Discord (que continua sendo usada normalmente) — o Sinal cuida só da parte visual.

Não é (e não pretende virar) um clone do Discord. É deliberadamente pequeno: sem conta de usuário obrigatória, sem persistência de mensagens/histórico, sem features que esse grupo específico não precisa.

## Funcionalidades

- **Sem hierarquia, por padrão** — quem cria a sala e quem entra depois têm exatamente os mesmos privilégios; qualquer um pode compartilhar tela e/ou câmera a qualquer momento. Existe uma exceção opcional: um admin fixo (configurável) pode moderar (ver abaixo).
- **Múltiplas transmissões simultâneas**, com destaque (spotlight) e fileira minimizada — dá pra fixar até 2 telas ao mesmo tempo.
- **Chat de texto** integrado, sem histórico persistido (some ao sair da sala, por design).
- **Indicador de qualidade de conexão em tempo real** — nível (Excelente/Boa/Ruim) calculado pelo próprio LiveKit, com detalhamento de perda de pacote e jitter amostrado via `getRTCStatsReport()`.
- **Controle manual de qualidade de transmissão** (HD 1080p vs. modo leve 720p), pra quem tem upload mais fraco.
- **Painel "quem está na sala"** — barra lateral com avatar, nome e indicador de quem está compartilhando.
- **Login opcional com Discord** (OAuth2) — puxa nome e avatar reais em vez de digitar o nome à mão; totalmente opcional, sem senha passando pelo Sinal, sem sessão guardada no servidor (ver [Segurança](#segurança)).
- **Aviso automático no Discord** (opcional, via Webhook) quando alguém cria uma sala — sem precisar de bot, sem OAuth, só uma URL de webhook do canal.
- **Moderação básica pra um admin fixo** (opcional, via Discord ID) — expulsar alguém da sala ou desligar a tela/câmera dela remotamente de verdade (não só esconder — encerra a captura do lado de quem foi mutado), sem precisar de banco de dados pra validar quem tem esse poder (ver [Segurança](#segurança)).
- **PWA instalável** — funciona como app nativo (ícone próprio, sem barra de navegador), com aviso automático de atualização.
- **Sem fila de espera nem cadastro**: código de 6 caracteres ou link direto, e já tá dentro.

## Arquitetura

O maior problema técnico do projeto foi de escala: a primeira versão usava WebRTC ponto-a-ponto (malha completa via [PeerJS](https://peerjs.com/)), onde quem compartilha a tela precisa **recodificar o vídeo uma vez para cada pessoa assistindo**. Com um jogo pesado rodando e mais de 2-3 espectadores, o CPU de quem compartilha disparava — relato real de um teste com o grupo.

A solução foi migrar pra um **SFU (Selective Forwarding Unit)** gerenciado — [LiveKit Cloud](https://livekit.io/cloud). Nesse modelo, quem compartilha manda **uma única cópia** codificada pro servidor, que se encarrega de retransmitir pra todo mundo. O custo de CPU de quem compartilha deixa de escalar com o número de espectadores.

```
 quem compartilha  ──── 1 upload ────▶  LiveKit Cloud (SFU)  ──── 1 download cada ────▶  espectador 1
                                                              ──── 1 download cada ────▶  espectador 2
                                                              ──── 1 download cada ────▶  espectador N
```

**Zero backend com estado.** O Sinal não tem banco de dados — salas não são persistidas, não existe conta de usuário, nada fica guardado em servidor entre sessões. As únicas peças de servidor são funções serverless sem estado (Vercel Functions):

- `api/get-token.js` — gera o token de acesso assinado do LiveKit. É a única forma segura de autorizar alguém a entrar numa sala sem expor a API secret no navegador.
- `api/discord-login.js` / `api/discord-callback.js` — fluxo OAuth2 do login opcional com Discord. Não mantêm sessão nenhuma; só traduzem "code" em "nome + avatar" e devolvem isso pro navegador guardar localmente.
- `api/moderate.js` — ações de admin (expulsar, desligar tela/câmera), autorizadas via o próprio token do LiveKit (grant `roomAdmin`), sem sessão própria.

O frontend (`public/`) é HTML + CSS + JS puro — sem framework, sem bundler, sem build step. A única dependência de verdade do projeto inteiro é `livekit-server-sdk`, usada só pelas funções de servidor.

## Segurança

- **Nenhuma senha passa pelo Sinal.** O login com Discord usa OAuth2 padrão — quem loga digita a senha no próprio site do Discord, nunca aqui.
- **Escopo mínimo no Discord**: só `identify` (nome, avatar, ID) — sem acesso a mensagens, servidores ou permissão de agir em nome de ninguém.
- **Segredos só no servidor.** `LIVEKIT_API_SECRET` e `DISCORD_CLIENT_SECRET` vivem exclusivamente em variáveis de ambiente das funções serverless; nunca chegam ao navegador.
- **Isolamento estrutural do `.env`**: o diretório publicado (`public/`) é fisicamente separado da raiz do projeto onde o `.env` local vive — não depende só de `.gitignore` pra não vazar segredo em produção.
- **Sanitização de entrada do usuário**: nomes de participantes passam por `escapeHtml()` antes de ir pro DOM — evita injeção de HTML/script via nome.
- **Checagem real de existência de sala** antes de gerar token de entrada — evita salas fantasma criadas por código digitado errado.
- **Moderação sem sessão/banco de dados**: o poder de admin é provado por dois níveis de assinatura criptográfica (um comprovante HMAC gerado só depois de um login real via Discord OAuth, depois traduzido no grant nativo `roomAdmin` do próprio token do LiveKit) — nenhuma ação de moderação é aceita sem essa cadeia de verificação passar no servidor a cada chamada.

## Stack

| Camada | Tecnologia |
|---|---|
| Frontend | HTML/CSS/JS puro, sem framework |
| Vídeo/áudio | [LiveKit Cloud](https://livekit.io/cloud) (SFU gerenciado) + [LiveKit JS Client SDK](https://github.com/livekit/client-sdk-js) |
| Backend | [Vercel Functions](https://vercel.com/docs/functions) (Node, Web Handlers) |
| Autenticação de sala | [`livekit-server-sdk`](https://github.com/livekit/node-sdks) |
| Login opcional | Discord OAuth2 |
| Hospedagem | [Vercel](https://vercel.com), deploy automático via GitHub |
| PWA | Service Worker + Web App Manifest |

## Estrutura do projeto

```
sinal-app/
├── public/                 # tudo que é servido publicamente
│   ├── index.html
│   ├── style.css
│   ├── app.js               # toda a lógica do cliente
│   ├── manifest.json
│   ├── sw.js                 # service worker (cache + versionamento)
│   └── icons/
├── api/                     # funções serverless (Vercel)
│   ├── get-token.js          # gera token de acesso do LiveKit
│   ├── discord-login.js      # inicia o OAuth2 com Discord
│   ├── discord-callback.js   # troca o code por perfil (nome + avatar)
│   └── moderate.js           # ações de admin (expulsar, desligar tela/câmera)
├── lib/
│   └── adminProof.js         # assina/verifica o comprovante de admin (HMAC)
├── vercel.json
├── package.json
└── .env                      # local, nunca commitado
```

## Rodando localmente

Precisa de uma conta grátis no [LiveKit Cloud](https://cloud.livekit.io). Pro Vercel CLI, não precisa instalar nada global — dá pra usar via `npx` (próximo passo já mostra isso); se preferir ter o comando `vercel` direto disponível, `npm install -g vercel`.

```bash
npm install
```

Crie um `.env` na raiz com as credenciais do seu projeto LiveKit:

```
LIVEKIT_URL=wss://seu-projeto.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

Opcional, só se quiser o login com Discord (crie uma aplicação em [discord.com/developers/applications](https://discord.com/developers/applications) e registre `<sua-url>/api/discord-callback` como redirect):

```
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
```

Também opcional — dá poder de moderação (expulsar, desligar tela/câmera de alguém) a Discord IDs específicos, separados por vírgula:

```
ADMIN_DISCORD_IDS=123456789012345678
```

Também opcional — avisa automaticamente num canal do Discord toda vez que alguém cria uma sala (crie um Webhook em Editar Canal → Integrações → Webhooks, no canal desejado):

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

Depois:

```bash
npx vercel dev
```

Isso sobe o site e as funções juntos, lendo o `.env` local.

## Licença

[MIT](LICENSE).

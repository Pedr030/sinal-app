# Arquitetura

Como o Sinal é montado hoje. Histórico e motivos: [historico.md](historico.md) (§2–§14, §36–§42, §49–§55).

## Visão geral

```
Quem transmite (site ou app) --1 upload--> LiveKit (SFU, VM própria) --1 download cada--> quem assiste
          |                                        ^       |
          +--- token/sala ---> Funções Vercel -----+       +-- webhooks --> Funções Vercel
                                (api/)  <--- OAuth2 ---> Discord
```

- **Frontend sem build**: `public/index.html`, `public/style.css`, `public/app.js` (HTML/CSS/JS puros, sem framework, sem bundler). Só `public/` é publicado (`vercel.json: outputDirectory`), o que mantém o `.env` fisicamente fora do site.
- **SFU**: LiveKit self-hosted (ver [servidor.md](servidor.md)). Cliente `livekit-client@2.22.3`, carregado do jsDelivr com versão exata e SRI.
- **Funções da Vercel** (`api/`, Node, formato `export async function POST(request)`): sem estado entre chamadas.
- **Sem banco de dados**: o estado durável de uma sala de servidor (tipo de acesso, aprovados, recusados, criador, título, senha cifrada) fica no **metadata da sala no LiveKit**; a sessão do Discord é um token assinado (`lib/session.js`, 7 dias) guardado no navegador.

## Arquivos

| Caminho | Papel |
|---|---|
| `public/app.js` | Toda a lógica do cliente (salas, tiles, transmissão, diagnóstico, servidores do Discord, configurações do app) |
| `public/index.html`, `style.css` | Marcação e estilo (tema escuro, identidade "SEM SINAL") |
| `public/sw.js`, `manifest.json` | PWA; `CACHE` do `sw.js` sobe junto com `APP_VERSION` |
| `public/changelog.json` | Novidades (site e notas do instalador do app) |
| `public/login-app.*` | Retorno do login do Discord para o app desktop |
| `public/audio-mixer-worklet.js` | Mistura as faixas de áudio isolado no app |
| `api/get-token.js` | Autoriza a entrada: sessão, regras de acesso, limites, cria sala, emite o token do LiveKit (e o token "presença") |
| `api/room-admin.js` | Aprovar/recusar pedidos, revelar senha, renomear, trocar senha/acesso, passar e encerrar sala |
| `api/moderate.js` | Expulsar e desligar tela/câmera de alguém |
| `api/discord-login.js`, `discord-callback.js` | OAuth2 com o Discord (escopo `identify guilds`) |
| `api/lives.js` | Lista as salas ao vivo dos servidores de quem pergunta |
| `api/lk-webhook.js` | Webhooks do LiveKit → presença em tempo real |
| `api/report.js` | "Enviar relatório" → webhook privado do Discord (`DISCORD_REPORT_WEBHOOK_URL`) |
| `lib/rooms.js` | Regras puras de sala: nomes, títulos ("Sala N"), acesso, senha (AES-256-GCM), moderação, metadata |
| `lib/session.js`, `lib/lives.js`, `lib/ratelimit.js` | Sessão assinada, lista ao vivo, limites por IP/pessoa |
| `electron/` | App desktop (projeto e `package.json` próprios) — ver [app-desktop.md](app-desktop.md) |
| `tools/vm-dashboard/` | Painel local de consumo da VM (`npm run vm`), não vai para a Vercel |
| `tests/` | `node --test` — ver [testes.md](testes.md) |

## Salas

- **Sala por código**: 6 letras maiúsculas (`genCode()`), qualquer um com o código entra. `mode: 'create'` cria a sala com `emptyTimeout`/`departureTimeout` de 60 s; `mode: 'join'` confere se ela existe (senão 404, para não criar sala fantasma com código errado).
- **Sala de servidor do Discord**: nome `s<guildId>-<6 letras minúsculas>`, só quem é do servidor vê e entra. Até **10 salas ao vivo por servidor** e **25 pessoas por sala**. Título até 40 caracteres; sem título vira **"Sala N"** (o menor número livre entre as salas ao vivo daquele servidor, `nextDefaultTitle`).
- **Acesso**: aberta, **com aprovação** (quem pede espera a decisão de quem está na sala) ou **com senha** (guardada só cifrada, limite de tentativas). "Gerenciar sala" permite renomear, trocar senha/tipo, passar a sala e encerrar.
- **Identidade**: cada conexão tem identidade nova (`nome-xxxxxx` ou `d<idDiscord>-xxxxxx`). Por isso o cliente só abre **uma conexão por vez** (`connectInFlight` em `connectToRoom`): cliques repetidos ao entrar criavam a mesma pessoa duplicada na sala (§71).
- **Eventos**: todo handler em `wireRoomEvents()` só age se a instância de `Room` ainda for a atual (`isCurrent()`), para eventos atrasados de uma sala antiga não pisarem na nova.
- **Assistir é opt-in**: `autoSubscribe: false`; cada transmissão aparece como card "clique para assistir" até a pessoa clicar.
- **Dados entre participantes** (`publishData`): `chat` (confiável, sem histórico), `watch`/`watch-sync` (quem está assistindo), `send-stats` (números de quem transmite, não confiável, ver [video.md](video.md)).

## Servidores do Discord e presença

- Login opcional com Discord: nome, avatar e lista de servidores na sessão assinada. Quem entra só com nome continua usando salas por código.
- **Presença**: o cliente entra numa sala especial `presence` com token **oculto** (`hidden: true`, sem publicar) só para receber os avisos de "fulano começou a transmitir"; o servidor manda esses avisos a partir dos webhooks do LiveKit.
- **Moderação por hierarquia**: dono do servidor, administradores e "Gerenciar Servidor" moderam as salas do próprio servidor; o admin do Sinal (`ADMIN_DISCORD_IDS`) modera em qualquer servidor de que faça parte. Só se modera quem está estritamente abaixo. Desligar a tela de alguém encerra a captura de verdade do lado dele (`unpublishTrack`).

## Segurança

- Segredos só em variáveis de ambiente das funções (`LIVEKIT_*`, `DISCORD_*`, `ADMIN_DISCORD_IDS`, `DISCORD_REPORT_WEBHOOK_URL`).
- **CSP estrita** (`vercel.json`): sem `unsafe-inline`; nada de `onclick=` ou `style=` no HTML (tudo por `addEventListener` e classes). **Antes de adicionar qualquer recurso externo, ler §14 do histórico** e incluir o domínio na CSP.
- **Texto de terceiros nunca vira HTML**: nomes, títulos, números recebidos são montados via DOM (`textContent`). Avatar só é aceito do CDN do Discord.
- Toda ação de gerência/moderação é revalidada no servidor (token do LiveKit + metadata da sala), sem confiar no cliente. Limites por IP em todas as funções sensíveis.
- Repositório público: nada de caminho, chave ou IP em arquivo commitado.

## PWA e versões

- `sw.js` é network-first; a barra "Nova versão disponível" aparece quando muda o `CACHE`. **`APP_VERSION` (`app.js`) e `CACHE` (`sw.js`) sobem juntos** a cada publicação do site.
- Fora de uma sala, o site se atualiza sozinho; dentro, espera a pessoa sair (§48).
- O app desktop tem versão própria (`electron/package.json`) e mostra a versão do app no rodapé.

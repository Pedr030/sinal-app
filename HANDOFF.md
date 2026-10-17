# Sinal — handoff

Ponto de partida para quem for mexer no projeto (pessoa ou outra instância de IA). Este arquivo diz **como o Sinal é hoje** e **como trabalhar com o dono**; os detalhes de cada área ficam nos documentos de [`docs/`](docs/), e o histórico completo de decisões (o antigo HANDOFF, seções §1–§77) está em [`docs/historico.md`](docs/historico.md).

> Comentários no código que citam **"HANDOFF §NN"** apontam para a seção de mesmo número em `docs/historico.md`.

Atualizado em 2026-10-16 · site **0.8.82** · app desktop **0.3.24**.

## O que é

Compartilhamento de tela ao vivo para um grupo de amigos, usado **ao lado** da call de voz do Discord (que continua sendo onde se conversa). Nasceu em agosto de 2026, quando a ANPD mandou o Discord suspender o compartilhamento de tela e vídeo no Brasil. É pequeno de propósito: **não é e não deve virar um clone do Discord**.

- Site: `https://sinal-app-stream.vercel.app` (PWA instalável).
- App para Windows (Electron): mesmo site dentro de uma janela própria, com áudio isolado por programa, captura e codificação pela placa de vídeo, atalho global e atualização automática.
- Mídia por **SFU próprio** (LiveKit numa VM Oracle Always Free): quem transmite manda uma cópia só; o servidor repassa sem recodificar.
- Sem banco de dados: o estado de cada sala mora no metadata da sala no LiveKit; a sessão do Discord é um token assinado guardado no navegador.

## Mapa da documentação

| Documento | O que tem |
|---|---|
| [docs/arquitetura.md](docs/arquitetura.md) | Arquivos, funções da Vercel, salas e servidores do Discord, acesso privado, moderação, segurança (CSP), PWA |
| [docs/video.md](docs/video.md) | Qualidades (Leve/Nítido/Fluido/Jogos), codecs, captura pela placa, regras de adaptação, diagnóstico (registro, painel de estatísticas, gargalo), recuperação de travadas e tela preta |
| [docs/app-desktop.md](docs/app-desktop.md) | Electron: configurações, seletor de tela, áudio isolado (addon Rust), atualização, recuperação de queda, avisos, build |
| [docs/servidor.md](docs/servidor.md) | VM do LiveKit, painel de consumo, **capacidade medida** (quantas transmissões cabem) |
| [docs/testes.md](docs/testes.md) | Testes automáticos, testes no app real (CDP), testes pelo navegador interno e as regras de quando pedir permissão |
| [docs/publicacao.md](docs/publicacao.md) | Passo a passo de publicar site e app (versões, Novidades, PR, instalador, release) |
| [docs/historico.md](docs/historico.md) | Histórico completo §1–§77 (o "porquê" de tudo, inclusive o que foi descartado) |
| [README.md](README.md) | Apresentação pública do projeto |

## Estado atual em uma página

**Qualidades de transmissão** (detalhe em [docs/video.md](docs/video.md)):

| Qualidade | Resolução | Codec | Teto | Para quê |
|---|---|---|---|---|
| Leve | 720p · 30 fps | H.265 (reserva VP8) | 2 Mbps | upload fraco |
| Nítido (padrão) | 1080p · 30 fps | H.264 | 5,5 Mbps | texto e vídeo |
| Fluido | 1080p · 60 fps | H.264 | 6 Mbps | vídeos e sites (só aparece com H.265 na placa, por herança) |
| Jogos | 720p · 60 fps | H.264 | 8 Mbps | jogos |

- No app, as qualidades em H.264 pedem o **perfil High** (que a placa codifica por hardware) e, codificando pela placa, ficam **sem corte automático** de quadros/resolução.
- **Captura pela placa de vídeo** vem ligada por padrão no app (Windows 11 24H2 ou mais novo); quem desligar nas Configurações continua desligado.
- O site registra um **resumo por minuto** do que envia e do que recebe, e quem transmite manda seus números a quem assiste (`send-stats`): dá para diagnosticar o PC dos amigos sem pedir nada a eles.

**Funcionalidades de sala:** código de 6 letras ou salas por servidor do Discord (até 10 por servidor, 25 pessoas por sala; sem nome viram "Sala 1, 2…"), acesso aberto/com aprovação/com senha, gerenciar sala, moderação por hierarquia, chat sem histórico, até 4 destaques + fileira de miniaturas, volume por pessoa, transmissões ocultas, estatísticas no tile, janela flutuante, "quem está assistindo".

## Como trabalhar com o dono (regras permanentes)

- **Nunca sugerir nada pago** para o projeto, nem de passagem.
- **Repositório público**: nada de caminho de pasta, chave, IP, fingerprint ou segredo em arquivo commitado. Auditar o diff antes de cada commit.
- **Git**: trabalho em `development` → PR para `main` com merge automático quando o CI passa. **Perguntar antes de commitar e antes de publicar** ("pode commitar" / "pode publicar"). **Acumular** várias mudanças numa versão em vez de publicar a cada ajuste. Commits em Conventional Commits, em português, **sem linha de coautoria/IA**.
- **Antes de construir algo não trivial, propor e discutir** o comportamento; o dono não gosta de código sem conversa.
- **Testes que abrem janela na tela dele** (Electron/e2e) precisam do "pode" dele **a cada vez**; liberar um teste não libera o próximo. Ele usa o PC enquanto trabalhamos. Testes automáticos e no navegador interno escondido não precisam.
- **Amigos não são testadores**: diagnóstico se faz no PC do dono e pelo registro dele; dos amigos só dá para pedir o "Enviar relatório".
- **Validar com carga real** antes de construir correção grande (um teste sintético já enganou: a captura nativa foi descartada por isso).
- **Mudanças visuais**: mandar prints reais (antes/depois).
- **Interface**: sem emojis, só ícones SVG no estilo do app. Textos de Novidades/notas de versão: curtos (uma frase por item), humanos, sem detalhe interno.
- Comunicação: português informal, direto, honesto ("não sei", "não testei" quando for o caso).

## O que acompanhar agora

1. **Leve ainda em H.265**: se a tela preta aparecer no Leve e a recuperação automática (recarregar e voltar para a sala) incomodar, passar o Leve para H.264 também (`pickShareCodec`).
2. **Jogos a 8 Mbps**: o painel agora diz se a perda é do upload de quem transmite. Se for frequente, baixar o Jogos para 6 Mbps (`SHARE_QUALITY_PRESETS.jogos.h264`). Também ajuda o servidor (ver [docs/servidor.md](docs/servidor.md)).
3. **Piso de 720p no Jogos pelo processador** (decisão do dono: "se não prestar, descemos"): se alguém pelo processador ficar sem fluidez, descer `GAMES_FLOOR_SW` para 540.
4. **Captura em luta pesada (Marcelo/Tchelou, GTX 1650)**: a captura ainda cai quando a placa satura com o jogo. Não há alavanca no app; a saída é limitar o fps do jogo no PC dele.
5. **Tela preta**: a recuperação foi provada derrubando a GPU pelo CDP, não com atualização de driver de verdade. Se acontecer de novo, o registro de quem assiste deve mostrar "o processo de vídeo do Chromium reiniciou" → "religando o vídeo" → "recarregando a página pra recuperar o vídeo".

Nada pendente de publicação em 2026-10-16 (a última leva, site 0.8.82 e app 0.3.24, trouxe o seletor de tela com as 4 qualidades numa linha e o texto da sala próprio do app — §77 do histórico).

## Decidido e não reabrir sem o dono pedir

- Captura de tela nativa (DXGI) — descartada (§57, §59): teste sintético enganou.
- Botão de layout dos tiles e duplo clique para tela cheia — descartados de propósito.
- O seletor lembrar a qualidade por programa — não faz sentido (a qualidade é escolhida antes da janela).
- Aviso para limitar o fps do jogo, vigia do codificador que reinicia a transmissão sozinho, perfil High no navegador sem o app — recusados em 2026-10-16.
- VB-Cable para áudio — recusado (amigos não devem instalar nada).
- Tamanho do tile em destaque — já explorado a fundo; a versão fixa simples é a escolhida (§7).

## Primeiros passos para quem chega

1. Ler este arquivo e o documento do tema que vai mexer.
2. `npm test` (raiz) roda a suíte inteira com `node --test tests/*.test.mjs`.
3. Site local: `npx vercel dev` (lê o `.env` da raiz). App apontando para o local: `SINAL_DEV_URL=http://localhost:3050` antes de `npm start` em `electron/`.
4. Antes de publicar, seguir [docs/publicacao.md](docs/publicacao.md) à risca (versões que precisam subir juntas, Novidades, instalador fora da pasta do projeto).

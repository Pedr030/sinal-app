# Vídeo: qualidades, codecs, captura e diagnóstico

Estado em 2026-10-16. Histórico e testes de cada decisão: [historico.md](historico.md) §32, §35, §46–§47, §56–§59, §66–§75.

## Qualidades (`SHARE_QUALITY_PRESETS` em `public/app.js`)

| Qualidade | Resolução/fps | Codec principal | Teto H.264 | Teto H.265 | Quando aperta |
|---|---|---|---|---|---|
| Leve | 1280×720 · 30 | **H.265** (reserva VP8 2,5 Mbps) | 3 Mbps | 2 Mbps | segura a resolução, corta quadros |
| Nítido | 1920×1080 · 30 | **H.264** | 5,5 Mbps | — | pela placa: sem corte; pelo processador: segura a resolução |
| Fluido | 1920×1080 · 60 | **H.264** | 6 Mbps | — | pela placa: sem corte; pelo processador: baixa a resolução até 720p e depois corta quadros |
| Jogos | 1280×720 · 60 | **H.264** | 8 Mbps | — | igual ao Fluido |

- **Codec** (`pickShareCodec`): Nítido, Fluido e Jogos sempre H.264 (todo navegador decodifica, sem reserva VP8; o H.264 volta sozinho quando a GPU do Chromium reinicia). O Leve segue em H.265 quando a placa codifica H.265 (economia de banda para upload fraco); sem H.265, VP8. O Fluido em H.265 a 60 fps derrubava o app (§46).
- **Fluido** só fica disponível com H.265 na placa (`requiresH265`, herança de quando era H.265); sem isso fica cinza.
- **Captura** sempre pedida no teto (`CAPTURE_MAX` = 1080p60) e reduzida logo em seguida (`applyCaptureQuality`), para dar para subir de qualidade no meio.
- **Troca ao vivo** (`changeActiveShareQuality`) sem republicar: o codec não muda. Entre Nítido, Fluido e Jogos (todos H.264) é livre; para o Leve (H.265) ou a partir dele, só começando de novo.

## Codificação pela placa (app)

- O servidor negocia o H.264 **Baseline** primeiro, e o Chromium codifica Baseline pelo processador (OpenH264). O **High** a placa codifica por hardware. No app, a oferta põe o High na frente (`preferH264High` dentro de `setupHardwareEncode`) quando:
  - a qualidade em andamento é H.264 (`H264_QUALITIES`, fixo do começo ao fim da transmissão, `shareWantsHighProfile`), **ou**
  - a opção antiga "Codificar o vídeo pela placa" está ligada (e a captura pela placa não).
- Só reordena os H.264 entre si; a escolha de codec não muda. Só vale se a placa confirmou High 1080p60 por hardware (`mediaCapabilities`, "a placa suporta" no registro).
- **Regra de adaptação** (`adjustGamesDegradation`, no ciclo de 4 s das estatísticas): codificando pela placa (`powerEfficientEncoder`) → `maintain-framerate-and-resolution` (sem corte automático). Motivo: o WebRTC mede o tempo de cada quadro e, com a placa ocupada pelo jogo, achava o PC sobrecarregado e cortava quadros em degraus (29 → 18 → 12 → 9, "limite cpu"). Pelo processador: Nítido segura a resolução; Fluido/Jogos baixam a resolução até `GAMES_FLOOR_SW` (720) e abaixo disso passam a cortar quadros até o fim da transmissão.

## Captura pela placa de vídeo (app, Windows 11 24H2+)

- No Chromium 152, a captura WGC copia cada quadro da placa para a memória e espera a placa terminar o trabalho do jogo (`Map` síncrono); a próxima captura só vem depois de 2× o tempo da anterior. Com o jogo enchendo a placa, a captura cai para ~1/3 do fps do jogo.
- A opção liga, antes do app ficar pronto, `WebRtcAllowWgcUsingTexture` (quadro como textura da placa, sem cópia nem espera) e `PlatformH264CbpEncoding`. **Ligada por padrão desde o app 0.3.23** (`gpuCapture: true`, `gpuCaptureChosen` marca quem mexeu na opção). Resultado real: Marcelo (GTX 1650) foi de 6 para ~52 fps de captura. Ainda cai em luta pesada quando a placa satura.
- Mudar a opção exige reiniciar o app (modal "Reiniciar o app?"). Sem suporte no Windows, fica cinza com os requisitos mínimos.
- **Sugestão automática** (§69): se a captura de quem transmite passa fome por 2 minutos e a opção está desligada, aparece uma faixa no Sinal e, se a pessoa está no jogo, um aviso discreto no canto superior da tela (janela própria sem foco, nunca por cima de jogo em tela cheia exclusiva).

## Diagnóstico

Tudo isso vai para o registro do app (`appLog`) e aparece no "Enviar relatório".

- **Resumo do envio** (1 por minuto): qualidade, codec, resolução, envio e captura (média e mínimo), kbps, **perda no envio** e ida e volta (do relatório que o servidor devolve, `remote-inbound-rtp`), tempo de codificação por quadro, limite do WebRTC em % do tempo, pausado/sem quadros, codificador.
- **`send-stats`**: a cada 12 s quem transmite manda esses números (só números e nome do codificador) pelo canal de dados; quem assiste valida (`parseSendStats`, só aceita da própria tela de quem mandou) e junta ao seu resumo.
- **Resumo da recepção** (1 por minuto, por transmissão `#tag`): recebe/decodifica (média e mínimo), kbps, perda, congelamentos, os números de quem transmite **do mesmo minuto** (`mergeSendStats`) e o **gargalo provável** (`streamBottleneck`): captura no PC de quem transmite · corte automático (placa ocupada com o jogo) · CPU de quem transmite · upload de quem transmite (perdendo pacotes) · internet entre o servidor e você · decodificação no seu PC · rede ou servidor.
- **Linhas de travada** ("envio/recepção abaixo do esperado") a cada ~15 s quando cai.
- **Painel de estatísticas no tile** (botão de barras): "Recebendo agora" (3 s), números de quem transmite (média de 12 s), codificação pela placa ou processador e o gargalo comparando os mesmos ~12 s ("Queda rápida agora" quando só os 3 s caíram).

## Travadas e recuperação

- **Congelamento de ~3 s** depois de perda pequena: `rtx-time=500` na descrição local de quem recebe (a espera máxima por quadro cai para 1,5 s). Com o LiveKit 2.22 numa conexão só, quem assiste faz a oferta (§67).
- **Tela preta quando a GPU do Chromium reinicia** (atualização de driver com o app aberto, §72): um canvas WebGL invisível percebe a perda de contexto e a checagem "chegam quadros e nenhum é decodificado" percebe o travamento → religa o vídeo (resolve H.264); se continuar (H.265), recarrega a página, volta para a sala e reabre as mesmas transmissões. Quem está transmitindo não recarrega sozinho (só recebe aviso).
- **Queda do app** (página do Chromium morreu): o app recarrega e volta para a sala (`?retomar=1`), oferecendo retomar a transmissão.

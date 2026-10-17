# App desktop (Electron, Windows)

O app é o **mesmo site** (o de produção, ou `SINAL_DEV_URL` em desenvolvimento) dentro de uma janela do Electron, com recursos nativos por cima. Mudanças no site chegam ao app só de recarregar; mudanças em `electron/` precisam de instalador novo. Histórico: [historico.md](historico.md) §15–§29, §34, §37, §45, §52, §58, §66–§75.

Versão atual: **0.3.23** · Electron 44.5.1 · Chromium 152.0.7977.130.

## Peças

| Arquivo (`electron/src/`) | Papel |
|---|---|
| `main.js` | Processo principal: janela, bandeja, atalho global, configurações, seletor de tela, áudio isolado, atualização, recuperação de queda, registro, aviso no canto |
| `preload.js` | Ponte `window.sinalElectron` para o site (só mensagens de origem confiável: `trustedIpc`) |
| `picker.html` + `picker-preload.js` | Seletor de tela/janela com a qualidade (Leve/Nítido/Fluido/Jogos), em janela própria |
| `update.html` + `update-preload.js` | Janela "atualização pronta" com o que muda (lido do `changelog.json`) |
| `hint.html` + `hint-preload.js` | Aviso no canto superior da tela (sugestão da captura pela placa) |
| `splash.html`, `offline.html` | Abertura e tela sem conexão (com nova tentativa automática) |
| `auth-url.js` | Valida o retorno do login do Discord pelo navegador |
| `native/sinal-audio-loopback/` | Addon Rust (N-API) de áudio isolado por processo |

## Configurações (`settings.json` na pasta de dados do app)

`shortcutEnabled`, `shortcut` (padrão `Ctrl+Alt+S`), `quickShareWholeScreen`, `startWithWindows`, `startMinimized`, `excludedAudioApps`, `shareQuality` (`leve`/`nitido`/`fluido`/`jogos`; sua presença avisa o site que quem escolhe a qualidade é o seletor do app), `hardwareEncode` (opção antiga "Codificar o vídeo pela placa"), `gpuCapture` + `gpuCaptureChosen` (captura pela placa, ligada por padrão desde a 0.3.23; só vale o valor salvo se a pessoa mexeu na opção). O site lê com `getSettings()` e grava com `setSettings()`; o main só aceita chaves e valores conhecidos (`sanitizeSettingsPatch`). As opções do Chromium da captura pela placa só valem na próxima abertura (`sinal:relaunch`).

## Transmitir

1. O site pede a captura; o main abre o seletor (`picker.html`) com as telas/janelas e a qualidade salva.
2. A escolha é gravada **antes** de devolver a fonte; o site lê a qualidade e ajusta a captura.
3. Com áudio isolado ligado (padrão): numa **janela**, só o som do processo dela; na **tela inteira**, cada programa que está tocando som, menos o Discord e o próprio Sinal (reavaliado a cada 2 s), misturados no site (`audio-mixer-worklet.js`).
4. O botão de qualidade do site aparece só durante a transmissão (troca ao vivo).

**Addon de áudio** (`sinal_audio_loopback.node`): o `cargo build --release` gera `sinal_audio_loopback.dll`, mas **nada copia para o `.node` sozinho** — depois de cada build, copiar `target/release/sinal_audio_loopback.dll` para `target/release/sinal_audio_loopback.node`, senão o app roda o binário antigo sem avisar. Além do áudio, o addon expõe `userNotificationState()` (o Windows diz se há jogo em tela cheia exclusiva) e `foregroundWindowRect()` (monitor do jogo), usados pelo aviso no canto.

## Atualização

`electron-updater` procura a cada 30 minutos (e por "Procurar atualização" na bandeja/Configurações), baixa em segundo plano e **só pergunta depois que a pessoa sai da sala** (o site avisa com `setInRoom`). A janela mostra os itens de Novidades com `"app": "<versão>"` no `changelog.json`. Releases no GitHub com tag `desktop-vX.Y.Z` (ver [publicacao.md](publicacao.md)).

## Recuperação e registro

- **Página caiu** (`render-process-gone`): recarrega e volta para a sala com `?retomar=1`; duas quedas em 5 minutos recarregam só a tela inicial. O site oferece retomar a transmissão.
- **Processo da GPU caiu** (`child-process-gone`): anotado no registro; o site se recupera sozinho da tela preta (ver [video.md](video.md)).
- **Registro**: `sinal.log` na pasta `logs` dos dados do app (gira em 1 MB para `sinal.old.log`). O site escreve nele com `appLog`. "Enviar relatório" manda o final do registro + o texto da pessoa para o webhook privado.
- Instância única: abrir de novo (ou um link `sinal://join?sala=...`) foca o app que já está aberto.

## Aviso no canto da tela

Janela transparente sem foco (`focusable:false`, `showInactive`, cliques passam fora do cartão), canto superior direito do monitor do jogo, some em 8 s, uma vez por abertura. Antes de mostrar, consulta o Windows: em tela cheia exclusiva, tela bloqueada ou apresentação, espera e tenta a cada 5 s por até 10 minutos. Sem o addon, usa a notificação do Windows. O app instalado usa o id `app.sinal.desktop`; em desenvolvimento usa `app.sinal.desktop.dev` (o Electron de desenvolvimento cria um atalho "Electron" no Menu Iniciar com o id usado; com o mesmo id do instalado, o ícone do Sinal virava o do Electron — §69).

## Build do instalador

- Precisa de Rust (`cargo`), Build Tools do Visual Studio e o `.node` atualizado.
- **Gerar fora da pasta do projeto**: dentro de `electron/dist` o build falha com EPERM ao renomear `win-unpacked.tmp` (provável vigia de arquivos). Use `npx electron-builder --publish never --config.directories.output=<pasta temporária>`.
- Fuses ligados (`runAsNode` desligado, só carrega do asar). Instalador NSIS escuro com a cara do Sinal; não é assinado (SmartScreen avisa "Editor desconhecido").

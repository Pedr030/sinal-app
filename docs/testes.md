# Testes

## Regra de ouro com o dono

- **Teste que abre janela na tela dele** (app Electron de teste, scripts com CDP): avisar o que é e quanto dura e **esperar o "pode" a cada vez**. Liberar um teste não libera o próximo.
- Testes automáticos, renderização fora da tela (`show:false` + `offscreen`) e testes pelo navegador interno escondido não ocupam a tela dele e não precisam de permissão.
- **Amigos não testam nada.** O diagnóstico do PC deles vem do registro do dono (resumos por minuto e `send-stats`) e, no máximo, do "Enviar relatório".
- **Validar com carga real** antes de construir correção grande. Teste sintético já enganou (a captura nativa foi descartada depois de parecer boa num jogo sintético).
- Mudança visual: mandar print real (antes/depois).

## Testes automáticos

```bash
npm test          # = node --test tests/*.test.mjs
```

- **Precisa ficar nesse glob**: `node --test` sem argumento varre o repositório inteiro, inclusive scripts de diagnóstico em `electron/**/test/` que não são testes e podem travar.
- `tests/helpers/api-harness.mjs` carrega as funções reais de `api/` contra um LiveKit falso (`fake.rooms`, `fake.created`…).
- `tests/pure-logic.test.mjs` extrai funções reais de `public/app.js` pelo nome (`extractFunction`) e testa a lógica pura (qualidades, codecs, diagnóstico, gargalo, painel…). Também confere trechos do código com regex quando a lógica depende do navegador.
- O CI (`.github/workflows/tests.yml`) roda `npm ci` + `npm test` em todo PR e push para `main`/`development`; o CodeQL também analisa.

## Site local e navegador interno

- `npx vercel dev` sobe site + funções lendo o `.env` (no app do Claude, existe a configuração `vercel-dev` na porta 3050).
- No navegador interno dá para criar sala, entrar com outra aba e simular quem transmite **sem tela**: `MediaStreamTrackGenerator` + `OffscreenCanvas` publicados com `new LivekitClient.LocalVideoTrack(gen)` e `publishTrack(..., { source: ScreenShare, videoCodec })`. `canvas.captureStream` não gera quadros com o painel escondido.
- Funções de `app.js` são globais (script clássico): `createRoom()`, `joinRoom()`, `leaveRoom()`, `tileVideoTracks`, `room`…
- Aba escondida tem timers estrangulados (~1 fps no gerador): bom para lógica, não para medir fps.

## App real (Electron + CDP)

Padrão usado nos scripts de teste (ficam fora do repositório, numa pasta temporária):

- Abrir `electron/node_modules/electron/dist/electron.exe .` com `--user-data-dir=<pasta temporária>` (nunca o perfil do dono), `--remote-debugging-port=<porta>` e `SINAL_DEV_URL=http://localhost:3050`. `SINAL_TEST_AUTOPICK=1` escolhe a tela sozinho no seletor.
- Um `settings.json` escrito antes na pasta temporária define o cenário (ex.: `gpuCapture`, `shareQuality`).
- Pelo CDP: `Runtime.evaluate` na página do site; `Page.captureScreenshot` para prints; `/json/version` + `Browser.crashGpuProcess` para simular a GPU do Chromium caindo (atualização de driver).
- Log do Chromium: `--enable-logging=file --log-file=... --vmodule=*wgc*=2` (ex.: confirmar "WGC capture session is outputing GPU texture").
- Encerrar com `taskkill /PID <pid> /T /F` e apagar a pasta temporária.
- Animações de teste numa janela coberta por outras rendem menos quadros (a captura só entrega quando a tela muda), então fps de teste sintético não é número de jogo real.

## Prints sem abrir janela

Renderizar a página real fora da tela: `new BrowserWindow({ show:false, webPreferences:{ offscreen:true, preload } })`, `loadFile`/`loadURL`, `webContents.capturePage()`. Usado para o seletor de tela (`picker.html` com fontes falsas) e para prévias de avisos.

## Registros

- Registro do app do dono: `%APPDATA%\sinal-desktop\logs\sinal.log` (e `sinal.old.log`). É de onde saem os diagnósticos das sessões reais (`resumo da recepção`, `gargalo provável`).
- No terminal do Claude (pacote MSIX), um teste antigo criou uma cópia virtual desse registro em `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\...`; ela foi renomeada e não deve ser confundida com o real.

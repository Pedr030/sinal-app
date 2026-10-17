# Publicação

Sempre com o "pode publicar" do dono, e de preferência com várias mudanças acumuladas numa versão.

## Antes do commit

1. `npm test` passando.
2. **Auditoria do diff** (repositório público): nada de caminho de pasta, chave, IP, fingerprint, e-mail ou segredo.
3. Versões:
   - **Site**: `APP_VERSION` em `public/app.js` **e** `CACHE` em `public/sw.js`, sempre juntos (sem o `CACHE`, ninguém recebe a versão nova).
   - **App**: `version` em `electron/package.json` (só quando mudou algo em `electron/`).
4. **Novidades** (`public/changelog.json`): entrada nova no topo com `id`, `date`, `title`, `site` e/ou `app`, `items`. Itens curtos (uma frase cada), na voz do dono, sem detalhe interno. `"destaque": true` só nas grandes (abre sozinha para todo mundo). Os itens com `app` também aparecem na janela de atualização do app.
5. Atualizar o [HANDOFF](../HANDOFF.md) e, se for o caso, o documento do tema e uma seção nova no [histórico](historico.md).

## Commit e PR

- Em `development`, Conventional Commits em português, **sem linha de coautoria/IA**. Costume: um commit com a mudança (`feat:`/`fix:`) e outro com versões e Novidades (`release: site X e desktop Y (...)`).
- `git push` e `gh pr create --base main --head development`. Ligar o merge automático (quando o CI passa); se o GitHub recusar por causa de checagem pendente, mesclar com `gh pr merge <n> --merge` depois de tudo verde.
- Depois do merge: `git fetch` + `git merge --ff-only origin/main` em `development` e `push`.
- A Vercel publica o site a partir de `main`. Conferir que `https://sinal-app-stream.vercel.app/app.js` já mostra o `APP_VERSION` novo.

## Instalador do app

1. Se mexeu no addon Rust: `cargo build --release` e copiar o `.dll` para `.node` (ver [app-desktop.md](app-desktop.md)).
2. `cd electron` e `npx electron-builder --publish never --config.directories.output=<pasta fora do projeto>` (dentro de `electron/dist` dá EPERM).
3. Conferir dentro do `app.asar` que a mudança está lá (`@electron/asar`).
4. `gh release create desktop-vX.Y.Z --target <SHA completo do commit de release> --title "Sinal Desktop vX.Y.Z" --notes-file <notas> <exe> <exe.blockmap> <latest.yml>`.
   - O `--target` precisa do SHA **completo** (o curto dá "target_commitish is invalid").
   - Notas: começam por "## O que baixar" + a explicação do SmartScreen (copiar da release anterior trocando a versão) e terminam em "## Mudanças" com os itens.
5. Quem tem o app recebe a atualização sozinho (procura a cada 30 min e pergunta depois que a pessoa sai da sala).

## Ordem site x app

Quando o contrato entre site e app muda (mensagens novas do `preload.js`), o site novo precisa funcionar com o app antigo e vice-versa: o site sempre testa se a função existe (`window.sinalElectron.xxx`) antes de usar.

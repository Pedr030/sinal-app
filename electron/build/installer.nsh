; Página de boas-vindas customizada — por padrão o electron-builder NÃO
; mostra essa página (ver HANDOFF.md seção 21/22), o instalador ia direto
; pra escolha de "todos os usuários vs só eu", pulando a saudação. Sem isso
; aqui a tela de boas-vindas simplesmente não existe, não tem como só trocar
; o texto dela via config normal do nsis. Título/texto combinando com o
; resto da identidade (ver installerSidebar.bmp/installerHeader.bmp, mesma
; seção do HANDOFF).
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Bem-vindo ao Instalador do Sinal"
  !define MUI_WELCOMEPAGE_TEXT "Este assistente vai te guiar pela instalação do Sinal na sua máquina.$\r$\n$\r$\nRecomendamos fechar os outros programas antes de continuar."
  !insertmacro MUI_PAGE_WELCOME
!macroend

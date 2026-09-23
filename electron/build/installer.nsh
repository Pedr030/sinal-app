!include "WinMessages.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; Tema escuro do instalador, versão certa: MUI_BGCOLOR/MUI_TEXTCOLOR são
; defines OFICIAIS do próprio MUI2 (Contrib\Modern UI 2\Interface.nsh e
; Pages\Welcome.nsh na fonte do NSIS) — a página de boas-vindas/finalização
; e o cabeçalho de toda página já chamam SetCtlColors com eles na criação
; dos controles. Nada de repintar por cima na marra com timer feito à mão
; (essa era a tentativa anterior — instável, chegou a piorar o resultado, e
; foi revertida). Isso aqui é o mecanismo pronto do NSIS pra exatamente essa
; finalidade, só precisa ser definido antes de qualquer !insertmacro MUI_PAGE_*.
!define MUI_BGCOLOR "0B0C0E"          ; --void
!define MUI_TEXTCOLOR "EEF1F0"        ; --ink
!define MUI_DIRECTORYPAGE_BGCOLOR "17191C"  ; --panel, caixa de pasta de destino
!define MUI_DIRECTORYPAGE_TEXTCOLOR "EEF1F0"  ; sem isso o texto fica preto (padrão do sistema) em cima do fundo escuro
!define MUI_INSTFILESPAGE_COLORS "EEF1F0 0B0C0E"  ; log de instalação: --ink sobre --void

; Checkbox "Executar o Sinal" (página de finalização) ficava com texto preto
; mesmo com MUI_TEXTCOLOR definido — bug conhecido do próprio NSIS
; (Pages\Finish.nsh, comentário deles: "SetCtlColors does not change the
; check/radio text color, bug #443"). O fix (SetWindowTheme no checkbox) já
; existe pronto lá, só que vem condicionado a "só aplica em modo de alto
; contraste do Windows" — esse define força aplicar sempre.
!define MUI_FORCECLASSICCONTROLS

; Cobertura disso: boas-vindas e finalização ficam 100% no tema (é onde o
; MUI2 recolore a própria página, não só o cabeçalho), e o cabeçalho escuro
; aparece em toda página que tiver um.
;
; A página de "todos os usuários vs só eu" (a que mais incomodava) é
; diferente: ela vem do multiUserUi.nsh do próprio electron-builder e
; expõe um hook de verdade pra isso — customInstallMode roda dentro da
; função PRE dela, antes dos controles serem criados, e dá pra usar esse
; momento pra registrar uma função MUI_PAGE_CUSTOMFUNCTION_SHOW (chamada
; logo depois de criar os controles e antes de nsDialogs::Show, mesmo
; instante em que a própria Welcome.nsh pinta a dela). Isso colore na
; criação, não por cima de algo já desenhado — é o mesmo tipo de mecanismo
; seguro da Welcome, não a repintura por timer que regrediu antes.
; Esse hook também dispara na compilação do desinstalador (mesma macro
; compartilhada), onde Call só aceita função prefixada com "un." — e eu não
; defino uma versão un. disso (não vale a pena tematizar a telinha de
; "qual instalação remover" também), então limito ao instalador mesmo.
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW SinalInstallModeShow
  !endif
!macroend

; A função em si não pode ficar aqui em cima: esse arquivo entra no topo do
; script inteiro, antes até da declaração das vars ($MultiUser.InstallModePage
; etc, feitas por PAGE_INSTALL_MODE no multiUserUi.nsh) existir na stream — e
; NSIS não deixa referenciar var antes dela ser declarada (testei: também não
; deixa redeclarar a mesma var duas vezes, isso quebrou o build). A solução é
; o hook customPageAfterChangeDir, que o electron-builder chama bem mais
; adiante no mesmo assistedInstaller.nsh (depois da tela de pasta) — ali as
; vars já existem, e como NSIS resolve chamada de função por nome (não
; importa se a Function está definida antes ou depois de quem chama), o Call
; que o MUI2 já fez lá em cima encontra essa definição normalmente.
!macro customPageAfterChangeDir
  Function SinalInstallModeShow
    SetCtlColors $MultiUser.InstallModePage "" "${MUI_BGCOLOR}"
    SetCtlColors $MultiUser.InstallModePage.Text "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"

    ; radiobutton (classe BUTTON) sob visual style do Windows ignora
    ; SetCtlColors completamente — o tema desenha o texto por cima com a
    ; cor dele mesmo, independente do que eu mandar. Tirando o tema do
    ; controle (mesma chamada que já uso na barra de progresso) ele volta
    ; a desenhar do jeito clássico, que aí sim respeita SetCtlColors.
    System::Call 'uxtheme::SetWindowTheme(p $MultiUser.InstallModePage.AllUsers, w " ", w " ")'
    System::Call 'uxtheme::SetWindowTheme(p $MultiUser.InstallModePage.CurrentUser, w " ", w " ")'
    SetCtlColors $MultiUser.InstallModePage.AllUsers "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
    SetCtlColors $MultiUser.InstallModePage.CurrentUser "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
    SetCtlColors $RadioButtonLabel1 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  FunctionEnd
!macroend

; Página "Escolha o Local da Instalação" (Directory): diferente da de
; boas-vindas/instalação, essa é um dialog NATIVO do NSIS (Contrib\Modern
; UI 2\Pages\Directory.nsh usa PageEx/DirText, não nsDialogs::Create) — os
; controles já existem quando a página aparece, não dá pra colorir "na
; criação" como nas outras. E não tem nenhum hook custom posicionado antes
; do !insertmacro MUI_PAGE_DIRECTORY no template do electron-builder pra
; interceptar isso. MUI_DIRECTORYPAGE_BGCOLOR (lá em cima) já cobre a
; caixa de destino oficialmente; o resto (label de instrução, espaço
; necessário/disponível, fundo do dialog) só dá pra pegar repintando por
; cima. A tentativa anterior disso tinha IDs de controle errados (copiados
; de outro projeto, não conferidos) — por isso não fazia efeito. Esses aqui
; (1006, 1019, 1023, 1024) são os reais, direto da fonte do
; MUI_FUNCTION_DIRECTORYPAGE. Ainda é repintura por timer (menos garantida
; que os mecanismos oficiais acima), mas agora mirando os controles certos.
!macro SINAL_PAINT_DIRECTORY
  Push $0
  Push $1
  FindWindow $1 "#32770" "" $HWNDPARENT
  ${If} $1 <> 0
    GetDlgItem $0 $1 1006
    SetCtlColors $0 ${SINAL_FG2} ${SINAL_BG}
    ; As duas áreas ao redor de "Pasta de Destino" e "Espaço necessário/
    ; disponível" continuam claras mesmo com a página toda escura — não é
    ; um controle individual (tentei SetCtlColors e SetWindowTheme em 1020,
    ; nenhum dos dois teve efeito ou piorou), provavelmente é um agrupamento
    ; visual que o próprio Windows 11 desenha, sem handle painterizável.
    ; Aceito como limite conhecido — resto da página já cobre o essencial.
    GetDlgItem $0 $1 1023
    SetCtlColors $0 ${SINAL_FG2} ${SINAL_BG}
    GetDlgItem $0 $1 1024
    SetCtlColors $0 ${SINAL_FG2} ${SINAL_BG}
    SetCtlColors $1 ${SINAL_FG} ${SINAL_BG}
    System::Call 'user32::RedrawWindow(p $1, p 0, p 0, i 0x0185)'
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!define SINAL_FG  "EEF1F0"
!define SINAL_FG2 "C7CCD1"
!define SINAL_BG  "0B0C0E"

!ifndef BUILD_UNINSTALLER
  Function SinalPaintDirectory
    !insertmacro SINAL_PAINT_DIRECTORY
  FunctionEnd

  Function SinalDirectoryGuiInit
    ; a faixa onde ficam os botões Voltar/Próximo/Cancelar é fundo da
    ; janela externa ($HWNDPARENT), não faz parte de nenhuma página — não
    ; é recriada ao trocar de página, então basta setar uma vez aqui,
    ; sem precisar do timer (diferente do corpo da página de pasta).
    SetCtlColors $HWNDPARENT ${SINAL_FG} ${SINAL_BG}

    ; "Sinal 0.3.3" no rodapé (controle 1256, marca/branding) usa o modo
    ; especial /BRANDING por padrão (SetCtlColors $mui.Branding.Text
    ; /BRANDING no Interface.nsh do próprio NSIS), que ignora MUI_TEXTCOLOR
    ; — preciso sobrescrever com cor explícita. Controle fixo, existe desde
    ; o início, também só precisa ser setado uma vez.
    Push $0
    GetDlgItem $0 $HWNDPARENT 1256
    SetCtlColors $0 ${SINAL_FG2} ${SINAL_BG}
    Pop $0

    ${NSD_CreateTimer} SinalPaintDirectory 100
  FunctionEnd

  !define MUI_CUSTOMFUNCTION_GUIINIT SinalDirectoryGuiInit
!endif

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

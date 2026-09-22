# Mockup aproximado de como a pagina de boas-vindas do NSIS fica com o
# installerSidebar.bmp -- NAO e um screenshot de verdade (decidimos nao
# automatizar clique no instalador real depois de um print pegar conteudo
# errado da tela por engano), e sim uma reconstrucao da pagina "Welcome"
# padrao do MUI2 (mesmo layout que o electron-builder usa por baixo:
# sidebar de 164x314 a esquerda, titulo+texto a direita, botoes embaixo).
# So pra visualizar o encaixe antes de rodar o instalador de verdade.
from PIL import Image, ImageDraw, ImageFont

VOID = (11, 12, 14)
PANEL = (23, 25, 28)
LINE = (43, 46, 51)
INK = (238, 241, 240)
FOG = (136, 141, 144)
TUNE = (255, 176, 32)
FONT_PATH = "C:/Windows/Fonts/segoeui.ttf"
FONT_PATH_B = "C:/Windows/Fonts/segoeuib.ttf"

W, H = 503, 390
img = Image.new('RGB', (W, H), PANEL)
draw = ImageDraw.Draw(img)

# Barra de titulo falsa (so pra dar contexto de janela)
draw.rectangle([0, 0, W, 30], fill=VOID)
draw.text((10, 7), "Instalação do Sinal", font=ImageFont.truetype(FONT_PATH, 13), fill=INK)

# Sidebar de verdade, encostada na borda esquerda (mesma posição que o NSIS usa)
sidebar = Image.open("../build/installerSidebar.bmp")
img.paste(sidebar, (0, 30))

# Área de conteúdo à direita
content_x = 164 + 24
draw.text((content_x, 50), "Bem-vindo ao Instalador do Sinal", font=ImageFont.truetype(FONT_PATH_B, 15), fill=INK)
body_lines = [
    "Este assistente vai te guiar pela instalação do",
    "Sinal na sua máquina.",
    "",
    "Recomendamos fechar os outros programas antes",
    "de continuar.",
]
y = 84
for line in body_lines:
    draw.text((content_x, y), line, font=ImageFont.truetype(FONT_PATH, 12), fill=FOG)
    y += 20

# Linha separadora + botões (posição típica do NSIS: canto inferior direito)
draw.line([0, H - 48, W, H - 48], fill=LINE, width=1)
def button(x, y, w, h, label, primary=False):
    bg = TUNE if primary else VOID
    fg = (26, 18, 0) if primary else INK
    draw.rectangle([x, y, x + w, y + h], fill=bg, outline=LINE if not primary else TUNE)
    f = ImageFont.truetype(FONT_PATH, 12)
    tw = draw.textlength(label, font=f)
    draw.text((x + (w - tw) / 2, y + (h - 14) / 2), label, font=f, fill=fg)

button(W - 220, H - 36, 90, 26, "< Voltar")
button(W - 120, H - 36, 90, 26, "Avançar >", primary=True)

img.save("../build/_mockup_wizard_welcome.png")
print("salvo")

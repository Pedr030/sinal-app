# Gera installerSidebar.bmp (164x314) e installerHeader.bmp (150x57) pro
# instalador NSIS (ver package.json build.nsis) -- mesma paleta/identidade
# do site (public/style.css: --void #0b0c0e, --tune #ffb020, --rec #ff4438)
# e o ícone real do app (icon.png), não um placeholder genérico. Fica em
# electron/tools/ (não em build/) de propósito -- build/**/* vai pro pacote
# do app (ver package.json "files", o app lê build/icon.png em tempo de
# execução pro ícone da bandeja) e nem esse script nem os .bmp do NSIS
# deveriam ir junto, são recurso só de build do instalador.
from PIL import Image, ImageDraw, ImageFont
import os

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD_DIR = os.path.join(HERE, '..', 'build')
VOID = (11, 12, 14)
GLOW = (26, 21, 18)
INK = (238, 241, 240)
TUNE = (255, 176, 32)

FONT_PATH = "C:/Windows/Fonts/segoeuib.ttf"

def radial_glow(size, center, radius, color, bg):
    """Aproxima o radial-gradient sutil do fundo do site (bem mais barato
    que um gradiente de verdade -- só uma mancha suave, ninguém repara)."""
    img = Image.new('RGB', size, bg)
    overlay = Image.new('L', size, 0)
    od = ImageDraw.Draw(overlay)
    od.ellipse([center[0]-radius, center[1]-radius, center[0]+radius, center[1]+radius], fill=60)
    overlay = overlay.filter(__import__('PIL.ImageFilter', fromlist=['GaussianBlur']).GaussianBlur(radius/2))
    glow_layer = Image.new('RGB', size, color)
    img = Image.composite(glow_layer, img, overlay)
    return img

def draw_wordmark(draw, xy, text, font, fill, letter_spacing=2):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        w = draw.textlength(ch, font=font)
        x += w + letter_spacing
    return x  # posição final X, pra quem quiser saber a largura total

def make_sidebar():
    W, H = 164, 314
    img = radial_glow((W, H), (int(W*0.5), 0), 160, GLOW, VOID)
    draw = ImageDraw.Draw(img)

    icon = Image.open(os.path.join(BUILD_DIR, 'icon.png')).convert('RGBA')
    icon_size = 92
    icon_resized = icon.resize((icon_size, icon_size), Image.LANCZOS)
    icon_x = (W - icon_size) // 2
    icon_y = 44
    img.paste(icon_resized, (icon_x, icon_y), icon_resized)

    font_word = ImageFont.truetype(FONT_PATH, 26)
    word = "SINAL"
    # Centraliza o wordmark manualmente (draw_wordmark desenha da esquerda
    # pra direita) -- calcula a largura total primeiro com um draw "seco".
    total_w = sum(draw.textlength(c, font=font_word) for c in word) + 2 * (len(word) - 1)
    start_x = (W - total_w) / 2
    draw_wordmark(draw, (start_x, icon_y + icon_size + 18), word, font_word, INK, letter_spacing=2)

    font_tag = ImageFont.truetype(FONT_PATH, 11)
    tagline = ["TRANSMISSÃO", "DE TELA", "AO VIVO"]
    ty = icon_y + icon_size + 60
    for line in tagline:
        lw = draw.textlength(line, font=font_tag)
        draw.text(((W - lw) / 2, ty), line, font=font_tag, fill=(136, 141, 144))
        ty += 16

    img.save(os.path.join(BUILD_DIR, 'installerSidebar.bmp'), 'BMP')
    print('installerSidebar.bmp salvo:', img.size)

def make_header():
    W, H = 150, 57
    img = Image.new('RGB', (W, H), VOID)
    draw = ImageDraw.Draw(img)

    icon = Image.open(os.path.join(BUILD_DIR, 'icon.png')).convert('RGBA')
    icon_size = 34
    icon_resized = icon.resize((icon_size, icon_size), Image.LANCZOS)
    icon_y = (H - icon_size) // 2
    icon_x = 10
    img.paste(icon_resized, (icon_x, icon_y), icon_resized)

    font_word = ImageFont.truetype(FONT_PATH, 17)
    word = "SINAL"
    text_x = icon_x + icon_size + 10
    total_w = sum(draw.textlength(c, font=font_word) for c in word) + 1.5 * (len(word) - 1)
    text_y = (H - font_word.size) // 2 - 2
    draw_wordmark(draw, (text_x, text_y), word, font_word, INK, letter_spacing=1.5)

    img.save(os.path.join(BUILD_DIR, 'installerHeader.bmp'), 'BMP')
    print('installerHeader.bmp salvo:', img.size)

if __name__ == '__main__':
    make_sidebar()
    make_header()

#!/usr/bin/env python3
"""Makes every app icon from icon.png (the artwork, on its chiffon background) as a squircle.

Run from the repo root after changing icon.png: python3 scripts/make-icons.py (needs Pillow).
Writes the web favicons (client/public), the desktop icons (desktop/assets, .png and .icns) and the Android
launcher icons (android/app/src/main/res).
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BACKGROUND = (250, 240, 202, 255)  # lemon chiffon, as in icon.png
SUPERELLIPSE = 5  # the exponent: 2 is a circle; ~5 is the soft "squircle" of app icons


def artwork() -> Image.Image:
    """icon.png made square (centered on its own background)."""
    source = Image.open(ROOT / 'icon.png').convert('RGBA')
    side = max(source.size)
    square = Image.new('RGBA', (side, side), BACKGROUND)
    square.paste(source, ((side - source.width) // 2, (side - source.height) // 2))
    return square


def squircle_mask(size: int, supersample: int = 4) -> Image.Image:
    """An antialiased superellipse filling a size x size square."""
    big = size * supersample
    r = big / 2
    mask = Image.new('L', (big, big), 0)
    pixels = mask.load()
    for y in range(big):
        ny = abs((y + 0.5 - r) / r) ** SUPERELLIPSE
        if ny >= 1:
            continue
        half = (1 - ny) ** (1 / SUPERELLIPSE) * r
        for x in range(int(r - half), int(r + half) + 1):
            if 0 <= x < big:
                pixels[x, y] = 255
    return mask.resize((size, size), Image.LANCZOS)


def squircle(size: int, art_scale: float = 0.9, inset: float = 0.0) -> Image.Image:
    """The icon at size x size: a squircle (inset by `inset` of the size on each side) of chiffon with the
    artwork scaled to `art_scale` of it, and transparent corners."""
    body = round(size * (1 - 2 * inset))
    tile = Image.new('RGBA', (body, body), BACKGROUND)
    art_side = round(body * art_scale)
    art = artwork().resize((art_side, art_side), Image.LANCZOS)
    tile.paste(art, ((body - art_side) // 2, (body - art_side) // 2))
    tile.putalpha(squircle_mask(body))
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(tile, ((size - body) // 2, (size - body) // 2), tile)
    return out


def save(image: Image.Image, path: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, optimize=True)
    print(path, image.size)


def main() -> None:
    # Web: a squircle favicon; iOS masks its home-screen icon itself, so that one stays square.
    save(squircle(32), 'client/public/favicon-32.png')
    save(squircle(192), 'client/public/icon-192.png')
    save(squircle(512), 'client/public/icon-512.png')
    square = Image.new('RGBA', (180, 180), BACKGROUND)
    art = artwork().resize((162, 162), Image.LANCZOS)
    square.paste(art, (9, 9))
    save(square.convert('RGB'), 'client/public/apple-touch-icon.png')

    # Desktop: macOS's icon grid, an 824 px squircle in a 1024 px canvas (other platforms use it as is).
    mac = squircle(1024, inset=100 / 1024)
    save(mac, 'desktop/assets/icon.png')
    # The macOS bundle icon, for the renamed Electron that `npm start -w desktop` runs.
    mac.save(ROOT / 'desktop/assets/icon.icns', sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])
    print('desktop/assets/icon.icns')

    # Android: a squircle for launchers that show legacy icons as they are, and an adaptive icon's
    # foreground (the artwork within the 66 dp safe zone of 108 dp) for launchers that apply their own mask.
    for density, scale in {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}.items():
        save(squircle(round(48 * scale), inset=2 / 48), f'android/app/src/main/res/mipmap-{density}/ic_launcher.png')
        side = round(108 * scale)
        foreground = Image.new('RGBA', (side, side), (0, 0, 0, 0))
        art_side = round(side * 66 / 108)
        art = artwork().resize((art_side, art_side), Image.LANCZOS)
        foreground.paste(art, ((side - art_side) // 2, (side - art_side) // 2))
        save(foreground, f'android/app/src/main/res/mipmap-{density}/ic_launcher_foreground.png')
        # Themed icons (Android 13+) tint this: the artwork's ink as the shape, the background transparent.
        flat = Image.alpha_composite(Image.new('RGBA', (side, side), BACKGROUND), foreground)
        ink = flat.convert('L').point(lambda v: 255 - v)
        ink = ink.point(lambda v: min(255, max(0, (v - 40) * 255 // 120)))
        monochrome = Image.new('RGBA', (side, side), (0, 0, 0, 255))
        monochrome.putalpha(ink)
        save(monochrome, f'android/app/src/main/res/mipmap-{density}/ic_launcher_monochrome.png')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Render every Odin icon from the one master: src/resources/build/icons/icon.png.

Edit the master, then run `python3 apps/desktop/scripts/render-icons.py`
(macOS, needs Pillow: `pip3 install pillow`). Never hand-edit the outputs:

  build/icons/icon.icns             app bundle icon (electron-builder, dev launcher)
  build/icons/icon.ico              Windows exe, installer and window icon
  odin/icon.png                     dock icon set at startup
  tray/iconTemplate{,@2x}.png       menu-bar template (black + alpha)
  packages/ui/.../preset-icons/odin.png   preset icon in the renderer
  apps/mobile/.../AppIcon-512@2x.png      iOS app icon (opaque, full bleed)
  apps/mobile/.../splash-2732x2732*.png   iOS launch screen
"""

import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

DESKTOP = Path(__file__).resolve().parents[1]
RES = DESKTOP / "src/resources"
MASTER = RES / "build/icons/icon.png"
PRESET = DESKTOP.parents[1] / "packages/ui/src/assets/icons/preset-icons/odin.png"
IOS_ASSETS = DESKTOP.parents[1] / "apps/mobile/ios/App/App/Assets.xcassets"
# The app background (--background in globals.css).
IOS_BACKGROUND = (14, 14, 17)

# Square box around the mark (horns to beard tip), inside the rounded square.
FACE_BOX = (96, 96, 928, 928)


def icns(src: Image.Image) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                name = f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"
                px = size * scale
                src.resize((px, px), Image.LANCZOS).save(iconset / name)
        subprocess.run(
            ["iconutil", "-c", "icns", "-o", str(RES / "build/icons/icon.icns"), str(iconset)],
            check=True,
        )


def ico(src: Image.Image) -> None:
    # One frame per size Windows asks for, so it never shrinks a 1024px PNG itself.
    sizes = [(px, px) for px in (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)]
    src.save(RES / "build/icons/icon.ico", sizes=sizes)


def tray(src: Image.Image) -> None:
    # A template image is black with the shape in alpha; macOS tints it per theme.
    lum = src.convert("L").crop(FACE_BOX)
    bg, fg = 60, 245  # background ~35, line white ~253
    alpha = lum.point(lambda v: max(0, min(255, (v - bg) * 255 // (fg - bg))))
    for px, name in ((18, "iconTemplate.png"), (36, "iconTemplate@2x.png")):
        out = Image.new("RGBA", (px, px), (0, 0, 0, 0))
        # Downscaling thins the lines to grey; double the alpha so they read at 18px.
        out.putalpha(alpha.resize((px, px), Image.LANCZOS).point(lambda v: min(255, v * 2)))
        out.save(RES / "tray" / name)


def ios(src: Image.Image) -> None:
    """iOS masks its own corners and refuses alpha: the rounded square, nearly
    filling the canvas, on its own background colour. The margin keeps the horn
    tips clear of the corner mask."""
    square = src.crop((40, 40, 984, 984)).resize((1024, 1024), Image.LANCZOS)
    out = Image.new("RGB", square.size, src.getpixel((140, 512))[:3])
    out.paste(square, mask=square)
    out.save(IOS_ASSETS / "AppIcon.appiconset/AppIcon-512@2x.png")
    # Launch screen: the icon at the middle of Odin's background. Xcode's
    # template lists the same image three times, one per scale.
    splash = Image.new("RGB", (2732, 2732), IOS_BACKGROUND)
    mark = src.resize((480, 480), Image.LANCZOS)
    splash.paste(mark, (1126, 1126), mask=mark)
    for suffix in ("", "-1", "-2"):
        splash.save(IOS_ASSETS / f"Splash.imageset/splash-2732x2732{suffix}.png")


def main() -> None:
    src = Image.open(MASTER).convert("RGBA")
    icns(src)
    ico(src)
    shutil.copyfile(MASTER, RES / "odin/icon.png")
    tray(src)
    src.resize((128, 128), Image.LANCZOS).save(PRESET)
    ios(src)


if __name__ == "__main__":
    main()

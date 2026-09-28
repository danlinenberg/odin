#!/usr/bin/env python3
"""Render every Odin icon from the one master: src/resources/build/icons/icon.png.

Edit the master, then run `python3 apps/desktop/scripts/render-icons.py`
(macOS, needs Pillow: `pip3 install pillow`). Never hand-edit the outputs:

  build/icons/icon.icns             app bundle icon (electron-builder, dev launcher)
  odin/icon.png                     dock icon set at startup
  tray/iconTemplate{,@2x}.png       menu-bar template (black + alpha)
  packages/ui/.../preset-icons/odin.png   preset icon in the renderer
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


def main() -> None:
    src = Image.open(MASTER).convert("RGBA")
    icns(src)
    shutil.copyfile(MASTER, RES / "odin/icon.png")
    tray(src)
    src.resize((128, 128), Image.LANCZOS).save(PRESET)


if __name__ == "__main__":
    main()

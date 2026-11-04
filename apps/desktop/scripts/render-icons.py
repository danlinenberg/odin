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
  apps/mobile/android/.../mipmap-*, splash Android launcher icon and launch screen
  site/icon.png, site/favicon.png         website brand mark and favicon
"""

import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

DESKTOP = Path(__file__).resolve().parents[1]
RES = DESKTOP / "src/resources"
MASTER = RES / "build/icons/icon.png"
PRESET = DESKTOP.parents[1] / "packages/ui/src/assets/icons/preset-icons/odin.png"
IOS_ASSETS = DESKTOP.parents[1] / "apps/mobile/ios/App/App/Assets.xcassets"
SITE = DESKTOP.parents[1] / "site"
# The app background (--background in globals.css).
IOS_BACKGROUND = (14, 14, 17)

# Square box around the mark (horns to beard tip), inside the rounded square.
FACE_BOX = (96, 96, 928, 928)


def icns(src: Image.Image) -> None:
    if not shutil.which("iconutil"):
        # Off macOS, Pillow writes the same sizes.
        src.save(RES / "build/icons/icon.icns", format="ICNS")
        return
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
        out.putalpha(alpha.resize((px, px), Image.LANCZOS))
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


ANDROID_RES = DESKTOP.parents[1] / "apps/mobile/android/app/src/main/res"
# Launcher icon size per density, in px (48dp each).
ANDROID_DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def android(src: Image.Image) -> None:
    """Android's launcher draws an adaptive icon: a 108dp foreground over a
    plain colour, masked to the phone's own shape, with only the middle 66dp
    sure to show. The mark goes in that middle on the icon's own colour;
    older launchers get the rounded square as it is, and a round copy."""
    background = src.getpixel((140, 512))[:3]
    (ANDROID_RES / "values/ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        f'    <color name="ic_launcher_background">#{"%02X%02X%02X" % background}</color>\n'
        "</resources>\n"
    )
    # The mark alone (white, and its dark outline at blue ~63), without the
    # long shadow (blue ~86-98) that would end in a hard edge on the plain
    # colour around it.
    face = src.crop(FACE_BOX)
    red, _, blue, _ = face.split()
    alpha = ImageChops.lighter(
        red.point(lambda v: max(0, min(255, (v - 70) * 255 // 150))),
        blue.point(lambda v: max(0, min(255, (82 - v) * 255 // 16))),
    )
    face.putalpha(alpha)
    for density, scale in ANDROID_DENSITIES.items():
        folder = ANDROID_RES / f"mipmap-{density}"
        side = round(48 * scale)
        src.resize((side, side), Image.LANCZOS).save(folder / "ic_launcher.png")
        circle = Image.new("L", (side * 4, side * 4), 0)
        ImageDraw.Draw(circle).ellipse((0, 0, side * 4 - 1, side * 4 - 1), fill=255)
        square = src.crop((40, 40, 984, 984)).resize((side, side), Image.LANCZOS)
        round_icon = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        round_icon.paste(square, mask=circle.resize((side, side), Image.LANCZOS))
        round_icon.save(folder / "ic_launcher_round.png")
        canvas = round(108 * scale)
        inner = round(66 * scale)
        foreground = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        mark = face.resize((inner, inner), Image.LANCZOS)
        foreground.paste(mark, ((canvas - inner) // 2,) * 2, mask=mark)
        foreground.save(folder / "ic_launcher_foreground.png")
        # Launch screen (Android 11 and older): the icon at the middle of
        # Odin's background, one per orientation.
        for orientation, size in (
            ("port", (round(320 * scale), round(480 * scale))),
            ("land", (round(480 * scale), round(320 * scale))),
        ):
            splash = Image.new("RGB", size, IOS_BACKGROUND)
            px = round(96 * scale)
            icon = src.resize((px, px), Image.LANCZOS)
            splash.paste(icon, ((size[0] - px) // 2, (size[1] - px) // 2), mask=icon)
            splash.save(ANDROID_RES / f"drawable-{orientation}-{density}/splash.png")
    splash = Image.new("RGB", (480, 480), IOS_BACKGROUND)
    icon = src.resize((144, 144), Image.LANCZOS)
    splash.paste(icon, (168, 168), mask=icon)
    splash.save(ANDROID_RES / "drawable/splash.png")


def main() -> None:
    src = Image.open(MASTER).convert("RGBA")
    icns(src)
    ico(src)
    shutil.copyfile(MASTER, RES / "odin/icon.png")
    tray(src)
    src.resize((128, 128), Image.LANCZOS).save(PRESET)
    ios(src)
    android(src)
    src.resize((256, 256), Image.LANCZOS).save(SITE / "icon.png")
    src.resize((64, 64), Image.LANCZOS).save(SITE / "favicon.png")


if __name__ == "__main__":
    main()

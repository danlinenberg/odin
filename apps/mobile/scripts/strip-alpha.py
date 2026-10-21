#!/usr/bin/env python3
"""
Drops the alpha channel from PNG screenshots, in place.

App Store Connect refuses a screenshot whose file has an alpha channel, even
when every pixel is opaque, and `xcrun simctl io screenshot` always writes
one. Standard library only, so it runs with the python3 that comes with
Xcode's command line tools:

    python3 scripts/strip-alpha.py store/screenshots/iphone-6.9/*.png

PNG filters predict each byte from the same channel of the pixel to the left,
above, or both, so the alpha bytes can be dropped from the filtered rows as
they are: the red, green and blue bytes decode to exactly what they were.
"""

import struct
import sys
import zlib

SIGNATURE = b"\x89PNG\r\n\x1a\n"


def chunks(data: bytes):
    pos = len(SIGNATURE)
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos : pos + 8])
        yield kind, data[pos + 8 : pos + 8 + length]
        pos += 12 + length


def chunk(kind: bytes, body: bytes) -> bytes:
    crc = zlib.crc32(kind + body) & 0xFFFFFFFF
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", crc)


def strip(path: str) -> str:
    with open(path, "rb") as f:
        data = f.read()
    if not data.startswith(SIGNATURE):
        raise ValueError("not a PNG")
    out = [SIGNATURE]
    idat = []
    header = None
    for kind, body in chunks(data):
        if kind == b"IHDR":
            header = body
            width, height, depth, color, _, _, interlace = struct.unpack(
                ">IIBBBBB", body
            )
            if color == 2:
                return "already RGB"
            if color != 6 or depth != 8 or interlace != 0:
                raise ValueError(
                    f"expected 8-bit RGBA without interlace, got "
                    f"color type {color}, depth {depth}, interlace {interlace}"
                )
            out.append(chunk(kind, body[:9] + b"\x02" + body[10:]))
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            break
        else:
            out.append(chunk(kind, body))
    if header is None or not idat:
        raise ValueError("no image data")

    raw = zlib.decompress(b"".join(idat))
    in_stride = 1 + width * 4
    out_stride = 1 + width * 3
    rows = bytearray(out_stride * height)
    for y in range(height):
        src = raw[y * in_stride : (y + 1) * in_stride]
        dst = y * out_stride
        rows[dst] = src[0]
        pixels = src[1:]
        rgb = rows[dst + 1 : dst + out_stride]
        rgb[0::3] = pixels[0::4]
        rgb[1::3] = pixels[1::4]
        rgb[2::3] = pixels[2::4]
        rows[dst + 1 : dst + out_stride] = rgb

    out.append(chunk(b"IDAT", zlib.compress(bytes(rows), 9)))
    out.append(chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(b"".join(out))
    return f"RGBA to RGB, {width}x{height}"


def main(paths: list[str]) -> int:
    if not paths:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    failed = False
    for path in paths:
        try:
            print(f"{path}: {strip(path)}")
        except (OSError, ValueError, zlib.error) as error:
            print(f"{path}: {error}", file=sys.stderr)
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

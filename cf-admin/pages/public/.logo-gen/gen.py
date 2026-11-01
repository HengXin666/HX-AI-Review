#!/usr/bin/env python3
"""Generate hx-context-review console favicons from the HXLoLi badge (logo.png).

Usage: python3 gen.py [REFERENCE_PNG] [OUT_DIR]
Defaults: reference = HXLoLi/static/img/logo.png, out = the pages/public dir (parent of .logo-gen).

Large sizes (512/192/180): the full badge (girl, cat, clouds, star) resized with
a circular alpha mask so everything outside the ring is truly transparent.
32px: a dedicated close-up crop of the character's head + ahoge + raised hand,
framed by a thick #3573C7 ring with a #1F4E8C outline, so the character still
reads as a face at favicon size instead of a blob.
Deterministic: same input -> byte-identical output.
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance

HERE = os.path.dirname(os.path.abspath(__file__))
REF = sys.argv[1] if len(sys.argv) > 1 else "/home/hx/Loli/code/HXLoLis/HXLoLi/static/img/logo.png"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(HERE)

MAIN_BLUE = (0x35, 0x73, 0xC7, 255)
DEEP_BLUE = (0x1F, 0x4E, 0x8C, 255)
LIGHT_BLUE = (0xD6, 0xE9, 0xFA, 255)
SS = 4  # supersampling for masks


def circle_mask(size, inset=0.0):
    big = size * SS
    m = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(m)
    p = inset * SS
    d.ellipse((p, p, big - 1 - p, big - 1 - p), fill=255)
    return m.resize((size, size), Image.LANCZOS)


def apply_mask(im, mask):
    r, g, b, a = im.split()
    a = Image.composite(a, Image.new("L", im.size, 0), mask)
    a = Image.fromarray_like = None  # placeholder removed below
    return None


def masked(im, mask):
    r, g, b, a = im.split()
    from PIL import ImageChops
    a = ImageChops.multiply(a, mask)
    return Image.merge("RGBA", (r, g, b, a))


def zero_corners(im):
    # Guarantee true transparency in the four corners.
    px = im.load()
    w, h = im.size
    for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        px[x, y] = (0, 0, 0, 0)
    return im


def shrink_colors(im, colors=256):
    # Quantize RGB to cut file size, keep full 8-bit alpha, return RGBA.
    rgb = im.convert("RGB").quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG).convert("RGB")
    r, g, b = rgb.split()
    return Image.merge("RGBA", (r, g, b, im.getchannel("A")))


def full_badge(ref, size):
    # Ref badge spans roughly x 21..997, y 9..1015 -> centre crop square.
    box = (12, 12, 1012, 1012)
    im = ref.crop(box).resize((size, size), Image.LANCZOS)
    im = masked(im, circle_mask(size, inset=0.5))
    if size >= 256:
        im = shrink_colors(im)
    return zero_corners(im)


def tiny_face(ref, size=32):
    # Close-up of head (ahoge to chin) with a bit of the raised hand.
    W = 256
    crop = ref.crop((300, 110, 800, 610)).resize((W, W), Image.LANCZOS)
    crop = ImageEnhance.Contrast(crop).enhance(1.15)
    crop = ImageEnhance.Color(crop).enhance(1.2)
    canvas = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    inner = circle_mask(W, inset=W * 0.13)
    canvas.paste(crop, (0, 0), inner)
    # thick blue ring + deep-blue outline
    ring = Image.new("RGBA", (W * SS, W * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(ring)
    d.ellipse((0, 0, W * SS - 1, W * SS - 1), fill=DEEP_BLUE)
    o = int(W * SS * 0.03)
    d.ellipse((o, o, W * SS - 1 - o, W * SS - 1 - o), fill=MAIN_BLUE)
    i = int(W * SS * 0.13)
    d.ellipse((i, i, W * SS - 1 - i, W * SS - 1 - i), fill=(0, 0, 0, 0))
    ring = ring.resize((W, W), Image.LANCZOS)
    canvas = Image.alpha_composite(canvas, ring)
    im = canvas.resize((size, size), Image.LANCZOS)
    im = im.filter(ImageFilter.UnsharpMask(radius=1, percent=60, threshold=2))
    im = masked(im, circle_mask(size, inset=0.3))
    return zero_corners(im)


def main():
    ref = Image.open(REF).convert("RGBA")
    outs = {
        "favicon-512.png": full_badge(ref, 512),
        "favicon-192.png": full_badge(ref, 192),
        "apple-touch-icon.png": full_badge(ref, 180),
        "favicon-32.png": tiny_face(ref, 32),
    }
    for name, im in outs.items():
        path = os.path.join(OUT, name)
        im.save(path, "PNG", optimize=True)
        print(name, im.size, os.path.getsize(path))


if __name__ == "__main__":
    main()

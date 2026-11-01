#!/usr/bin/env python3
"""hx-context-review console favicons: mascot + AI Code Review magnifier.

Usage:
    python3 gen.py [REFERENCE_PNG] [OUT_DIR]
Defaults: REFERENCE_PNG = HXLoLi/static/img/logo.png on the caller machine,
          OUT_DIR = parent of this .logo-gen directory (pages/public).

Design (all sizes):
  * Purple badge: deep-purple outline ring (#4A2E8C), main-purple ring (#6D4AC7),
    inside a purple sky (the reference's blue sky/ring hue-shifted to purple).
  * Mascot: head + shoulders of the reference girl (brown short hair, ahoge),
    skin and hair untouched; only blue pixels are shifted to purple.
  * AI CR element: a magnifying glass in the lower-right, white lens with a bold
    purple check mark (= "reviewed / passed"), deep-purple rim and handle.
    512/192/180 also show "</>" code brackets inside the lens above the check.
  * 32px: tighter head crop (ahoge to chin) + oversized magnifier with a thick
    check, no brackets, so both still read at favicon size.
Only depends on Pillow. Deterministic output.
"""
import os
import sys
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
REF = sys.argv[1] if len(sys.argv) > 1 else "/home/hx/Loli/code/HXLoLis/HXLoLi/static/img/logo.png"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(HERE)

PURPLE = (0x6D, 0x4A, 0xC7, 255)
DEEP = (0x4A, 0x2E, 0x8C, 255)
LIGHT = (0xD9, 0xD0, 0xF5, 255)
WHITE = (255, 255, 255, 255)
SS = 4


def blue_to_purple(im):
    """Shift blue hues (sky, ring, polka shirt) to purple; skin/hair untouched."""
    rgb = im.convert("RGB")
    h, s, v = rgb.convert("HSV").split()
    # PIL hue 0..255. Blue ~ 135..170, target purple #6D4AC7 ~ 182.
    hue_mask = h.point(lambda x: 255 if 120 <= x <= 175 else 0)
    sat_mask = s.point(lambda x: 255 if x >= 35 else 0)
    mask = ImageChops.multiply(hue_mask, sat_mask).filter(ImageFilter.GaussianBlur(1))
    h2 = h.point(lambda x: min(255, x + 28) if 120 <= x <= 175 else x)
    s2 = s.point(lambda x: min(255, int(x * 0.92)))
    shifted = Image.merge("HSV", (h2, s2, v)).convert("RGB")
    out = Image.composite(shifted, rgb, mask)
    r, g, b = out.split()
    return Image.merge("RGBA", (r, g, b, im.getchannel("A")))


def disc_mask(size, inset):
    big = size * SS
    m = Image.new("L", (big, big), 0)
    p = inset * SS
    ImageDraw.Draw(m).ellipse((p, p, big - 1 - p, big - 1 - p), fill=255)
    return m.resize((size, size), Image.LANCZOS)


def draw_magnifier(d, cx, cy, r, rim, handle_len, handle_w, brackets, check_w):
    """Draw on a supersampled canvas. Coordinates already scaled."""
    # handle (towards lower-right)
    import math
    ang = math.radians(45)
    x0 = cx + (r + rim * 0.3) * math.cos(ang)
    y0 = cy + (r + rim * 0.3) * math.sin(ang)
    x1 = x0 + handle_len * math.cos(ang)
    y1 = y0 + handle_len * math.sin(ang)
    d.line((x0, y0, x1, y1), fill=DEEP, width=int(handle_w))
    d.ellipse((x1 - handle_w / 2, y1 - handle_w / 2, x1 + handle_w / 2, y1 + handle_w / 2), fill=DEEP)
    # rim + lens
    d.ellipse((cx - r - rim, cy - r - rim, cx + r + rim, cy + r + rim), fill=DEEP)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=WHITE)
    # lens highlight
    hr = r * 0.78
    d.arc((cx - hr, cy - hr, cx + hr, cy + hr), 200, 250, fill=LIGHT, width=max(2, int(r * 0.09)))
    if brackets:
        # "</>" in upper half of lens
        by = cy - r * 0.38
        bh = r * 0.26
        bw = r * 0.16
        lw = max(2, int(r * 0.09))
        lx = cx - r * 0.42
        d.line((lx + bw, by - bh, lx, by, lx + bw, by + bh), fill=PURPLE, width=lw, joint="curve")
        rx = cx + r * 0.42
        d.line((rx - bw, by - bh, rx, by, rx - bw, by + bh), fill=PURPLE, width=lw, joint="curve")
        d.line((cx + bw * 0.6, by - bh * 1.05, cx - bw * 0.6, by + bh * 1.05), fill=PURPLE, width=lw)
        ck = (cx - r * 0.45, cy + r * 0.22, cx - r * 0.12, cy + r * 0.52, cx + r * 0.50, cy - r * 0.05)
    else:
        ck = (cx - r * 0.52, cy + r * 0.02, cx - r * 0.12, cy + r * 0.42, cx + r * 0.55, cy - r * 0.35)
    d.line(ck, fill=PURPLE, width=int(check_w), joint="curve")
    for i in (0, 4):
        x, y = ck[i], ck[i + 1]
        d.ellipse((x - check_w / 2, y - check_w / 2, x + check_w / 2, y + check_w / 2), fill=PURPLE)


def build(ref_p, size, tiny):
    W = 512 * SS  # work canvas
    canvas = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    # rings + purple sky
    d.ellipse((0, 0, W - 1, W - 1), fill=DEEP)
    o = W * (0.035 if not tiny else 0.05)
    d.ellipse((o, o, W - 1 - o, W - 1 - o), fill=PURPLE)
    i = W * (0.10 if not tiny else 0.12)
    inner_box = (i, i, W - 1 - i, W - 1 - i)
    # character
    if tiny:
        box = (335, 105, 815, 585)   # ahoge .. chin, face fills the disc
    else:
        box = (300, 95, 860, 720)    # head + shoulders + bit of waving arm
    crop = ref_p.crop(box)
    inner = int(W - 2 * i)
    scale = inner / min(crop.size)
    crop = crop.resize((int(crop.size[0] * scale), int(crop.size[1] * scale)), Image.LANCZOS)
    # anchor: centre horizontally, top-aligned
    ox = int(i - (crop.size[0] - inner) / 2)
    oy = int(i)
    layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    layer.paste(crop, (ox, oy))
    # sky fill behind (in case crop has transparent bits)
    sky = Image.new("RGBA", (W, W), (0x8E, 0x6C, 0xE0, 255))
    sky = Image.alpha_composite(sky, layer)
    m = Image.new("L", (W, W), 0)
    ImageDraw.Draw(m).ellipse(inner_box, fill=255)
    canvas.paste(sky, (0, 0), m)
    # white separator ring between purple ring and sky (as in reference)
    d = ImageDraw.Draw(canvas)
    d.ellipse(inner_box, outline=WHITE, width=int(W * (0.012 if not tiny else 0.03)))
    # magnifier
    if tiny:
        draw_magnifier(d, cx=W * 0.75, cy=W * 0.75, r=W * 0.14, rim=W * 0.05,
                       handle_len=W * 0.08, handle_w=W * 0.10, brackets=False, check_w=W * 0.075)
    else:
        draw_magnifier(d, cx=W * 0.72, cy=W * 0.71, r=W * 0.15, rim=W * 0.03,
                       handle_len=W * 0.10, handle_w=W * 0.055, brackets=True, check_w=W * 0.035)
    # outer clip
    m = Image.new("L", (W, W), 0)
    ImageDraw.Draw(m).ellipse((0, 0, W - 1, W - 1), fill=255)
    r, g, b, a = canvas.split()
    canvas = Image.merge("RGBA", (r, g, b, ImageChops.multiply(a, m)))
    im = canvas.resize((size, size), Image.LANCZOS)
    if tiny:
        im = ImageEnhance.Contrast(im).enhance(1.1)
        im = im.filter(ImageFilter.UnsharpMask(radius=1, percent=50, threshold=2))
    px = im.load()
    for x, y in ((0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1)):
        px[x, y] = (0, 0, 0, 0)
    if size >= 256:
        rgb = im.convert("RGB").quantize(colors=256, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG).convert("RGB")
        r, g, b = rgb.split()
        im = Image.merge("RGBA", (r, g, b, im.getchannel("A")))
    return im


def main():
    ref = Image.open(REF).convert("RGBA")
    ref_p = blue_to_purple(ref)
    outs = {
        "favicon-512.png": build(ref_p, 512, False),
        "favicon-192.png": build(ref_p, 192, False),
        "apple-touch-icon.png": build(ref_p, 180, False),
        "favicon-32.png": build(ref_p, 32, True),
    }
    for name, im in outs.items():
        p = os.path.join(OUT, name)
        im.save(p, "PNG", optimize=True)
        print(name, im.size, os.path.getsize(p))


if __name__ == "__main__":
    main()

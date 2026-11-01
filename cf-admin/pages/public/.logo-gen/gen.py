#!/usr/bin/env python3
"""hx-context-review icon generator.
Circle badge + white check whose last stroke ends in a sharp "code pointer" tip.
Flat, no gradients/shadows. Rendered at 2048px then downsampled (LANCZOS) for clean AA.
Usage: python3 gen_logo.py [outdir]   (default: parent dir of this script, i.e. public/)
Edit COLORS / geometry below and re-run.
"""
import os, sys, math
from PIL import Image, ImageDraw

COLORS = {
    "primary": "#3573C7",  # circle fill
    "dark":    "#1F4E8C",  # outer ring
    "light":   "#D6E9FA",  # thin inner ring (only drawn at >=128px)
    "fg":      "#FFFFFF",  # check
}
OUTPUTS = [("favicon-32.png", 32), ("favicon-192.png", 192),
           ("favicon-512.png", 512), ("apple-touch-icon.png", 180)]
S = 2048  # supersample canvas

# geometry in unit coords (0..1)
MARGIN = 0.02          # transparent padding around the badge
RING = 0.075           # dark ring thickness
LIGHT_RING = 0.018     # light hairline ring inside the dark ring (large sizes only)
CHECK = [(0.275, 0.525), (0.435, 0.680), (0.665, 0.400)]  # A (start), B (elbow), C (tip base)
STROKE = 0.125         # check stroke width
TIP = 2.4             # pointer length as a multiple of half stroke

def _offset_line(p, q, h):
    dx, dy = q[0]-p[0], q[1]-p[1]; L = math.hypot(dx, dy)
    nx, ny = -dy/L*h, dx/L*h
    return (p[0]+nx, p[1]+ny), (q[0]+nx, q[1]+ny), (dx/L, dy/L), (nx, ny)

def _intersect(p1, p2, p3, p4):
    x1,y1=p1; x2,y2=p2; x3,y3=p3; x4,y4=p4
    d=(x1-x2)*(y3-y4)-(y1-y2)*(x3-x4)
    t=((x1-x3)*(y3-y4)-(y1-y3)*(x3-x4))/d
    return (x1+t*(x2-x1), y1+t*(y2-y1))

def check_polygon():
    A, B, C = CHECK; h = STROKE/2
    l1a, l1b, d1, n1 = _offset_line(A, B, h)
    l2a, l2b, d2, n2 = _offset_line(B, C, h)
    r1a, r1b, _, _ = _offset_line(A, B, -h)
    r2a, r2b, _, _ = _offset_line(B, C, -h)
    BL = _intersect(l1a, l1b, l2a, l2b)
    BR = _intersect(r1a, r1b, r2a, r2b)
    tip = (C[0]+d2[0]*h*TIP, C[1]+d2[1]*h*TIP)
    return [l1a, BL, l2b, tip, r2b, BR, r1a]

def render(size):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = lambda v: v*S
    m = MARGIN
    d.ellipse([u(m), u(m), u(1-m), u(1-m)], fill=COLORS["dark"])
    r = m + RING
    if size >= 128:
        d.ellipse([u(r), u(r), u(1-r), u(1-r)], fill=COLORS["light"])
        r += LIGHT_RING
    d.ellipse([u(r), u(r), u(1-r), u(1-r)], fill=COLORS["primary"])
    d.polygon([(u(x), u(y)) for x, y in check_polygon()], fill=COLORS["fg"])
    out = img.resize((size, size), Image.LANCZOS)
    assert out.mode == "RGBA"
    return out

def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.makedirs(outdir, exist_ok=True)
    for name, size in OUTPUTS:
        p = os.path.join(outdir, name)
        render(size).save(p, "PNG", optimize=True)
        print(name, size, os.path.getsize(p), "bytes")

if __name__ == "__main__":
    main()

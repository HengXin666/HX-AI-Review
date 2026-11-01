# hx-context-review favicon report

Source: HXLoLi/static/img/logo.png (1024x1024 RGBA badge, untouched).
Method: Pillow crop/resize of the reference; circular alpha mask outside the ring.
32px uses a dedicated close-up of the girl's head (ahoge, brown hair, eyes, open mouth) inside a #3573C7 ring with #1F4E8C outline.

## Checks
    ('favicon-32.png', (32, 32), 'RGBA', 0, [0, 0, 0, 0], 3064, 'ec35ee337d', True)
    ('favicon-192.png', (192, 192), 'RGBA', 0, [0, 0, 0, 0], 62083, 'e522481e87', True)
    ('favicon-512.png', (512, 512), 'RGBA', 0, [0, 0, 0, 0], 278979, 'f0a81a0b92', True)
    ('apple-touch-icon.png', (180, 180), 'RGBA', 0, [0, 0, 0, 0], 56085, '34be1dbe29', True)
    ALL_OK True

1. Four files exist, sizes 32/192/512/180, all open in Pillow, mode RGBA: PASS
2. Alpha min 0 (<255) and all four corner alphas 0: PASS
3. favicon-32 upscaled to 256 (nearest) and inspected: clearly a brown-haired anime girl's face with ahoge in a blue ring, not a blob: PASS
4. Every file < 300 KB (largest 512px = 278979 B): PASS
5. .logo-gen/gen.py re-run (python3 gen.py <logo.png> <out>) produced byte-identical files: PASS

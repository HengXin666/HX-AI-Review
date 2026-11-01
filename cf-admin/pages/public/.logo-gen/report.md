# hx-context-review favicon report (v3: mascot + AI CR)

Run: `python3 .logo-gen/gen.py <logo.png> <out_dir>` (defaults: HXLoLi/static/img/logo.png, pages/public). Pillow only.

Design: purple badge (outer ring #4A2E8C, ring #6D4AC7, white separator, purple sky = reference blue hue-shifted to purple). Mascot = head + shoulders of the reference girl (brown short hair #A8785A-ish, ahoge, natural skin; only blue pixels recoloured). Waving arm, cat and clouds dropped.

AI CR element: magnifying glass, lower-right (lens centre ~72%/71% of width/height on 512, handle pointing to bottom-right edge). White lens, deep-purple rim/handle, inside: "</>" code brackets (upper half) + bold purple check (lower half) = "code reviewed / passed".
32px: tighter head crop (ahoge to chin, face centred-left) + enlarged magnifier at ~75%/75% with a single thick check, no brackets.

## Checks
    ('favicon-32.png', (32, 32), 'RGBA', 0, [0, 0, 0, 0], 2978, '6a34aaea9f', True)
    ('favicon-192.png', (192, 192), 'RGBA', 0, [0, 0, 0, 0], 54816, '27cebf94a1', True)
    ('favicon-512.png', (512, 512), 'RGBA', 0, [0, 0, 0, 0], 214811, 'befd04f64a', True)
    ('apple-touch-icon.png', (180, 180), 'RGBA', 0, [0, 0, 0, 0], 49875, 'fe77e9c69c', True)
    ALL_OK True

1. Four files, 32/192/512/180, open in Pillow, RGBA: PASS
2. Alpha min 0, four corners alpha 0: PASS
3. 512 shows anime character (face, brown hair, ahoge) + magnifier with </> and check at lower-right: PASS (visually inspected)
4. favicon-32 upscaled x8 (nearest) to 256: brown-haired head with ahoge, eyes and open mouth visible; purple-rimmed magnifier with white lens and check at lower-right: PASS
5. All < 300 KB (largest 512 = 214811 B): PASS
6. Re-run produced byte-identical files: PASS

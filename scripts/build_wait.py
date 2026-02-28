#!/usr/bin/env python3
"""Extract sprite crops from tex_010.png and pack into a compact atlas for the 1PModeWarning animation."""

import os
from PIL import Image

BASE = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.join(BASE, '..', 'surfboard', 'MM_UI_Common', 'tex_010.png')
OUT = os.path.join(BASE, 'atlas.png')

# Only the character panel sprites (no text bars)
CROPS = [
    (0,  3,  1505, 635, 1735, 873, 'Character info BG'),
    (1,  4,  1736, 635, 1776, 677, 'Musical note'),
    (2,  6,  1818, 635, 1858, 677, 'Surprise mark'),
    (3,  7,  1505, 874, 1583, 974, 'Chiffon'),
    (4,  8,  1584, 874, 1658, 958, 'Salt'),
    (5,  9,  1659, 874, 1739, 986, 'Ras'),
    (6,  41, 1859, 635, 1899, 677, 'Sweat drop'),
    (7,  42, 1505, 987, 1567, 1135, 'Balloon R'),
    (8,  43, 1568, 987, 1630, 1147, 'Balloon C'),
    (9,  44, 1631, 987, 1711, 1127, 'Balloon S'),
    (10, 45, 1900, 635, 1940, 677, 'Heart'),
]

PAD = 1

def main():
    tex = Image.open(TEX).convert('RGBA')
    print(f'Source: {tex.width}x{tex.height}')

    parts = []
    for new_idx, orig_idx, x1, y1, x2, y2, desc in CROPS:
        w, h = x2 - x1, y2 - y1
        part = tex.crop((x1, y1, x2, y2))
        parts.append((new_idx, part, w, h, desc))

    # Sort by height descending for shelf packing
    order = sorted(range(len(parts)), key=lambda i: -parts[i][3])

    placements = {}
    cx, cy, rh = 0, 0, 0
    max_w = 512

    for ni in order:
        idx, part, w, h, desc = parts[ni]
        if cx + w + PAD > max_w:
            cy += rh + PAD
            cx = 0
            rh = 0
        placements[ni] = (cx, cy, w, h)
        cx += w + PAD
        rh = max(rh, h)

    aw = max(x + w for x, y, w, h in placements.values())
    ah = max(y + h for x, y, w, h in placements.values())

    atlas = Image.new('RGBA', (aw, ah), (0, 0, 0, 0))
    crop_rects = [None] * len(CROPS)

    for ni in range(len(CROPS)):
        idx, part, w, h, desc = parts[ni]
        ax, ay, aw2, ah2 = placements[ni]
        atlas.paste(part, (ax, ay))
        crop_rects[ni] = [ax, ay, ax + aw2, ay + ah2]
        print(f'  [{ni}] {desc}: {aw2}x{ah2} at ({ax},{ay})')

    atlas.save(OUT, optimize=True)
    fsize = os.path.getsize(OUT)
    print(f'\nAtlas: {aw}x{ah} ({fsize:,} bytes) -> {OUT}')

    print('\nCrop rects for scene data:')
    for i, r in enumerate(crop_rects):
        print(f'  [{r[0]},{r[1]},{r[2]},{r[3]}],  // {i}: {CROPS[i][6]}')


if __name__ == '__main__':
    main()

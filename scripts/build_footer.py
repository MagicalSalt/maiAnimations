#!/usr/bin/env python3
"""Build HD atlas from high-resolution character textures for the Advertise SD animation.

Uses pre-composited HD sprites where available (Salt, Chiffon, Ras, Shama), and
manually composites Otohime (minus eyes) and Milk (minus face/smile) from HD parts.
Keeps animated overlays and SD effects as separate atlas crops.

Usage: python build_hd_atlas.py
Output: web/sd_hd_atlas.png, web/sd_data_hd.json
"""

import json, math, os
from PIL import Image

BASE = os.path.dirname(os.path.abspath(__file__))

TEX_010 = os.path.join(BASE, 'surfboard', 'MM_UI_GameInfo', 'tex_010.png')
TEX_023 = os.path.join(BASE, 'surfboard', 'MM_UI_GameInfo', 'tex_023.png')
TEX_SD  = os.path.join(BASE, 'surfboard', 'MM_UI_Background', 'tex_004.png')

SD_DATA = os.path.join(BASE, 'web', 'sd_data.json')
OUT_ATLAS = os.path.join(BASE, 'web', 'sd_hd_atlas.png')
OUT_JSON  = os.path.join(BASE, 'web', 'sd_data_hd.json')

# CROP[10] rects from MM_CH_SD (tex_010.png 1024x512) - [left, top, right, bottom) exclusive
C10 = [
    (1,1,159,87),(1,88,159,164),(1,166,159,330),(1,331,159,495),       # 0-3
    (160,1,200,44),(201,1,303,47),(304,1,352,47),(353,1,401,47),       # 4-7
    (402,1,450,47),(160,49,209,133),(210,49,259,126),(261,49,369,111), # 8-11
    (370,49,524,103),(161,166,242,202),(161,204,218,286),              # 12-14
    (219,204,267,289),(161,330,255,391),(161,392,201,453),             # 15-17
    (202,392,251,456),(161,458,213,488),                               # 18-19
    (571,1,721,191),(722,1,872,191),(873,1,1023,201),(873,202,1023,402), # 20-23 precomps
    (268,112,384,274),(438,137,454,153),(268,275,396,439),             # 24-26
    (385,129,437,193),(385,194,437,256),(397,257,443,301),             # 27-29
    (385,104,431,128),(438,104,470,136),(455,137,469,151),             # 30-32
    (397,302,443,336),(438,154,472,190),                               # 33-34
    (438,191,500,217),(438,218,500,244),                               # 35-36 eye 0/1
    (471,135,489,153),(444,245,506,271),                               # 37 mouse, 38 eye 2
]
# CROP[23] rects from ver199_MM_CH_SD_0001 (tex_023.png 512x512)
C23 = [
    (1,1,119,139),(120,1,150,33),(151,1,181,33),(120,34,181,80),       # 0-3
    (120,81,181,127),(182,1,236,75),(182,76,214,118),(215,76,237,106), # 4-7
    (182,119,224,141),(237,1,276,43),(182,174,236,248),(1,249,31,281), # 8-11
    (63,249,93,281),(120,175,181,221),(120,222,181,268),               # 12-14
    (139,269,181,291),(182,249,214,291),(255,249,277,279),             # 15-17
    (215,249,253,291),(1,143,119,249),                                 # 18-19
    (274,349,392,511),(393,349,511,511),                               # 20-21 precomps
]


def crop_img(img, rect):
    return img.crop(rect)


def bams_deg(bams):
    return -bams * 360.0 / 65536.0


# ---------------------------------------------------------------------------
# Tree-based compositor (used only for Otohime and Milk)
# ---------------------------------------------------------------------------

class Node:
    __slots__ = ('x', 'y', 'rot', 'sx', 'sy',
                 'tex', 'crop', 'w', 'h', 'px', 'py', 'flip', 'children')
    def __init__(self, x=0, y=0, rot=0, sx=1, sy=1,
                 tex=None, crop=None, w=0, h=0, px=0, py=0, flip=False,
                 children=None):
        self.x, self.y = x, y
        self.rot = rot
        self.sx, self.sy = sx, sy
        self.tex, self.crop = tex, crop
        self.w, self.h = w, h
        self.px, self.py = px, py
        self.flip = flip
        self.children = children or []


def _sp(crop_idx, tex_crops):
    r = tex_crops[crop_idx]
    return dict(crop=r, w=r[2]-r[0], h=r[3]-r[1])


def render_tree(root, textures):
    draws = []

    def walk(node, px, py, psx, psy, prot):
        rad = math.radians(prot)
        c, s = math.cos(rad), math.sin(rad)
        wx = px + psx * (node.x * c - node.y * s)
        wy = py + psy * (node.x * s + node.y * c)
        wr = prot + node.rot
        wsx, wsy = psx * node.sx, psy * node.sy

        if node.crop is not None:
            tex = textures[node.tex]
            part = crop_img(tex, node.crop)
            if node.flip:
                part = part.transpose(Image.FLIP_LEFT_RIGHT)

            dw = max(1, round(node.w * abs(wsx)))
            dh = max(1, round(node.h * abs(wsy)))
            if (dw, dh) != part.size:
                part = part.resize((dw, dh), Image.LANCZOS)

            dpx = node.px * abs(wsx)
            dpy = node.py * abs(wsy)

            if abs(wr) > 0.01:
                pw, ph = dw, dh
                part = part.rotate(-wr, resample=Image.BICUBIC, expand=True)
                nw, nh = part.size
                rdx, rdy = pw / 2 - dpx, ph / 2 - dpy
                rr = math.radians(wr)
                rc, rs = math.cos(rr), math.sin(rr)
                dx = wx + (rdx * rc - rdy * rs) - nw / 2
                dy = wy + (rdx * rs + rdy * rc) - nh / 2
            else:
                dx = wx - dpx
                dy = wy - dpy
            draws.append((part, dx, dy))

        for ch in node.children:
            walk(ch, wx, wy, wsx, wsy, wr)

    walk(root, 0, 0, 1, 1, 0)
    if not draws:
        return Image.new('RGBA', (1, 1)), 0, 0

    x0 = min(d[1] for d in draws)
    y0 = min(d[2] for d in draws)
    x1 = max(d[1] + d[0].width for d in draws)
    y1 = max(d[2] + d[0].height for d in draws)
    cw, ch = math.ceil(x1 - x0), math.ceil(y1 - y0)
    canvas = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
    for part, dx, dy in draws:
        canvas.paste(part, (round(dx - x0), round(dy - y0)), part)
    return canvas, -x0, -y0


# Otohime composite: all parts EXCEPT eye (crops 35/36/38)
def build_otohime(tex):
    T = C10
    sp = lambda ci, **kw: dict(tex='t10', **_sp(ci, T), **kw)
    return Node(children=[
        # Hair (drawn first = behind)
        Node(x=0, y=-141, children=[
            Node(x=22, y=60, px=64, py=82, **sp(26))]),
        # HairR
        Node(x=0, y=-141, children=[
            Node(x=26, y=-16, px=26, py=32, **sp(27))]),
        # HairL
        Node(x=0, y=-141, children=[
            Node(x=-17, y=-17, px=26, py=31, **sp(28))]),
        # Ahoge
        Node(x=0, y=-141, children=[
            Node(x=11, y=-18, px=23, py=22, **sp(29))]),
        # ArmR (rotated -30 deg screen CW)
        Node(x=7, y=-60, rot=bams_deg(-5461), children=[
            Node(x=11, y=12, px=23, py=17, **sp(33)),
            Node(x=30, y=17, children=[
                Node(x=0, y=13, px=16, py=16, **sp(31))]),
            Node(x=27, y=16, px=7, py=7, **sp(32)),
        ]),
        # ArmL (rotated +30 deg screen CCW)
        Node(x=-10, y=-59, rot=bams_deg(5461), children=[
            Node(x=-8, y=7, px=23, py=12, **sp(30), children=[
                Node(x=-17, y=-10, children=[
                    Node(x=-4, y=16, px=17, py=18, **sp(34))])]),
        ]),
        # Body (+ Star + Mouse, NO eye)
        Node(x=1, y=5, px=58, py=162, **sp(24), children=[
            Node(x=16, y=-74, px=8, py=8, **sp(25)),
            Node(x=-3, y=-73, px=9, py=9, **sp(37)),
        ]),
    ])


# Milk composite: all parts EXCEPT face/smile (crops 13/14)
def build_milk(tex):
    T = C23
    sp = lambda ci, **kw: dict(tex='t23', **_sp(ci, T), **kw)
    return Node(children=[
        Node(x=-4, y=-95, px=59, py=53, **sp(19)),
        Node(x=-35, y=-132, px=15, py=16, **sp(11)),
        Node(x=28, y=-133, px=15, py=16, **sp(12)),
        Node(x=-10, y=-44, px=0, py=0, **sp(18)),
        Node(x=-7, y=-58, px=42, py=11, **sp(15), children=[
            Node(x=-36, y=-10, px=11, py=15, **sp(17))]),
        Node(x=-5, y=-68, px=0, py=0, **sp(16)),
        Node(x=0, y=-29, px=27, py=37, **sp(10)),
    ])


# ---------------------------------------------------------------------------
# SD effect crops from tex_004.png
# ---------------------------------------------------------------------------

SD_EFFECTS = {
    'Ring':           (1,92,61,152),
    'Note_0':         (62,92,100,130),
    'Note_1':         (101,92,139,130),
    'Note_2':         (140,92,178,130),
    'Note_3':         (179,92,217,130),
    'Heart':          (62,131,100,169),
    'Unused':         (101,131,139,169),
    'Dash':           (140,131,178,169),
    'Surprise':       (179,131,217,169),
    'Present_Top':    (293,31,311,47),
    'Present_Center': (293,48,311,64),
    'Present_Under':  (293,65,311,79),
    'Cheese':         (322,1,350,21),
}


# ---------------------------------------------------------------------------
# Atlas packing
# ---------------------------------------------------------------------------

def pack(items, max_w=1024):
    PAD = 1
    items = sorted(items, key=lambda x: -x[1].height)
    cx, cy, rh = PAD, PAD, 0
    rects = {}
    for name, img in items:
        if cx + img.width + PAD > max_w:
            cy += rh + PAD
            cx = PAD
            rh = 0
        rects[name] = [cx, cy, cx + img.width, cy + img.height]
        cx += img.width + PAD
        rh = max(rh, img.height)
    H = cy + rh + PAD
    H = 1 << (H - 1).bit_length()
    atlas = Image.new('RGBA', (max_w, H), (0, 0, 0, 0))
    for name, img in items:
        r = rects[name]
        atlas.paste(img, (r[0], r[1]), img)
    return atlas, rects


# ---------------------------------------------------------------------------
# SD crop index → HD atlas name mapping
# ---------------------------------------------------------------------------

SD_TO_HD = {
    0:  'Salt',              # pre-composite
    1:  'Ras',               # pre-composite
    2:  'Chiffon',           # pre-composite
    12: 'Otohime',           # tree composite (no eye)
    26: 'Shama',             # pre-composite
    27: 'Milk',              # tree composite (no face)
    3:  'SD_Ring',
    4:  'SD_Note_0',  5:  'SD_Note_1',  6:  'SD_Note_2',  7:  'SD_Note_3',
    8:  'SD_Heart',   9:  'SD_Unused',  10: 'SD_Dash',    11: 'SD_Surprise',
    13: 'Otohime_Eye_0',   14: 'Otohime_Eye_1',
    15: 'SD_Present_Top',  16: 'SD_Present_Center',  17: 'SD_Present_Under',
    18: 'SD_Cheese',
    28: 'Milk_Smile',  29: 'Milk_Face',
}


def main():
    print('Loading textures...')
    t10 = Image.open(TEX_010).convert('RGBA')
    t23 = Image.open(TEX_023).convert('RGBA')
    tsd = Image.open(TEX_SD).convert('RGBA')
    textures = {'t10': t10, 't23': t23}

    items = []

    # Pre-composited HD characters (directly cropped from source textures)
    precomps = [
        ('Salt',    t10, C10[21]),   # 150x190
        ('Chiffon', t10, C10[20]),   # 150x190
        ('Ras',     t10, C10[22]),   # 150x200
        ('Shama',   t23, C23[21]),   # 118x162
    ]
    for name, tex, rect in precomps:
        img = crop_img(tex, rect)
        items.append((name, img))
        print(f'  {name}: {img.width}x{img.height} (pre-composite)')

    # Tree-composited characters (excluding animated overlays)
    for name, builder in [('Otohime', build_otohime), ('Milk', build_milk)]:
        img, px, py = render_tree(builder(textures), textures)
        if name == 'Otohime':
            img = img.transpose(Image.FLIP_LEFT_RIGHT)
            px = img.width - px
        items.append((name, img))
        print(f'  {name}: {img.width}x{img.height} (composite, origin=({px:.0f},{py:.0f}))')

    # HD overlay crops (Otohime eyes flipped to match body)
    items.append(('Otohime_Eye_0', crop_img(t10, C10[35]).transpose(Image.FLIP_LEFT_RIGHT)))
    items.append(('Otohime_Eye_1', crop_img(t10, C10[36]).transpose(Image.FLIP_LEFT_RIGHT)))
    items.append(('Milk_Face',     crop_img(t23, C23[13])))    # 61x46
    items.append(('Milk_Smile',    crop_img(t23, C23[14])))    # 61x46

    # SD effect crops (kept at original resolution from tex_004)
    for ename, erect in SD_EFFECTS.items():
        items.append(('SD_' + ename, crop_img(tsd, erect)))

    # Pack atlas
    print('Packing...')
    atlas, rects = pack(items)
    atlas.save(OUT_ATLAS, optimize=True)
    print(f'Atlas: {atlas.width}x{atlas.height} -> {OUT_ATLAS}')

    # Build HD crop list (ordered by first appearance in SD_TO_HD values)
    hd_crops = []
    name_to_ci = {}
    for name in dict.fromkeys(SD_TO_HD.values()):
        name_to_ci[name] = len(hd_crops)
        hd_crops.append(rects[name])
    sd_ci_map = {sd: name_to_ci[hd] for sd, hd in SD_TO_HD.items()}

    # Patch SD data → HD data
    with open(SD_DATA, 'r') as f:
        data = json.load(f)

    for node in data['nodes']:
        if 's' not in node:
            continue
        s = node['s']
        if s['ci'] in sd_ci_map:
            s['ci'] = sd_ci_map[s['ci']]

    data['texture'] = {'w': atlas.width, 'h': atlas.height, 'crops': hd_crops}
    data['texFile'] = 'sd_hd_atlas.png'

    with open(OUT_JSON, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    print(f'JSON: {OUT_JSON} ({os.path.getsize(OUT_JSON)} bytes)')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Extract SD character animation from Advertise_common scene for web playback."""

import json
import os

BASE = os.path.dirname(os.path.abspath(__file__))


def tag(tags, tid, default=None):
    for t in tags:
        if t['id'] == tid:
            return t.get('value', default)
    return default


def tags_all(tags, tid):
    return [t.get('value') for t in tags if t['id'] == tid]


def split_records(tags):
    recs, cur = [], []
    for t in tags:
        if t['id'] in (252, 253, 254):
            if cur:
                recs.append(cur)
            cur = []
        else:
            cur.append(t)
    if cur:
        recs.append(cur)
    return recs


def rf(v):
    if isinstance(v, float):
        r = round(v, 4)
        return int(r) if r == int(r) else r
    return v


def main():
    path = os.path.join(BASE, 'data_out', 'scenes',
                        'MM_UI_Background__Advertise_common.json')
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    chunks = data['chunks']
    by_type = {}
    for i, c in enumerate(chunks):
        by_type.setdefault(c['type'].strip(), []).append(i)

    # Textures
    textures = []
    for i in by_type.get('TEX', []):
        tc = chunks[i]
        cc = chunks[i + 1]
        textures.append({
            'name': tag(tc['tags'], 97, ''),
            'w': tag(tc['tags'], 64, 0),
            'h': tag(tc['tags'], 65, 0),
            'crops': tags_all(cc['tags'], 101),
        })

    # Nodes + TRS2
    nrecs = split_records(chunks[by_type['NODE'][0]]['tags'])
    trecs = split_records(chunks[by_type['TRS2'][0]]['tags'])

    nodes = []
    for i, nr in enumerate(nrecs):
        tr = trecs[i] if i < len(trecs) else []
        pos = tag(tr, 49, [0, 0])
        sc = tag(tr, 51, [1, 1])
        color = tag(tr, 55, 0xFFFFFFFF)
        if isinstance(color, int) and color < 0:
            color = color & 0xFFFFFFFF
        rot = tag(tr, 50, 0)
        if isinstance(rot, int) and rot > 0x7FFFFFFF:
            rot = rot - 0x100000000

        nodes.append({
            'name': tag(nr, 3, ''),
            'fc': tag(nr, 59, 65535),
            'ns': tag(nr, 60, 65535),
            'flags': tag(nr, 48, 0),
            'x': rf(pos[0]) if isinstance(pos, list) else rf(pos),
            'y': rf(pos[1]) if isinstance(pos, list) else 0,
            'r': rot,
            'sx': rf(sc[0]) if isinstance(sc, list) else rf(sc),
            'sy': rf(sc[1]) if isinstance(sc, list) else rf(sc),
            'vis': 1 if tag(tr, 58, 1) else 0,
            'color': color,
        })

    # Build children lists
    for i, n in enumerate(nodes):
        ch = []
        c = n['fc'] if n['fc'] != 65535 else -1
        while 0 <= c < len(nodes):
            ch.append(c)
            ns = nodes[c]['ns']
            c = ns if ns != 65535 else -1
        n['ch'] = ch

    # CIMG -> node sprite mapping
    sprites = {}
    for i in by_type.get('CIMG', []):
        ci = chunks[i]
        ni = tag(ci['tags'], 81)
        if ni is None:
            continue
        # Read all CREFs under this CIMG
        sub = ci.get('sub_chunks', 1)
        layers = []
        for j in range(1, sub + 1):
            cr = chunks[i + j]
            if cr['type'].strip() == 'CREF':
                ref = tag(cr['tags'], 73, [0, 0, 0])
                layers.append({
                    'ti': ref[1] if isinstance(ref, list) and len(ref) > 1 else 0,
                    'ci': ref[2] if isinstance(ref, list) and len(ref) > 2 else 0,
                })
        if not layers:
            continue
        tex_ref = tag(ci['tags'], 72, 0)
        sprites[ni] = {
            'w': rf(tag(ci['tags'], 64, 0)),
            'h': rf(tag(ci['tags'], 65, 0)),
            'px': rf(tag(ci['tags'], 66, 0)),
            'py': rf(tag(ci['tags'], 67, 0)),
            'flip': 1 if (tex_ref & 0x10) else 0,
            'layers': layers,
        }

    # Find SD_ALL_NUL
    sd_idx = None
    for i, n in enumerate(nodes):
        if n['name'] == 'SD_ALL_NUL':
            sd_idx = i
            break
    if sd_idx is None:
        raise ValueError('SD_ALL_NUL not found')

    # Collect all SD subtree indices
    sd_set = set()
    def collect(idx):
        sd_set.add(idx)
        for c in nodes[idx]['ch']:
            collect(c)
    collect(sd_idx)

    # Build remap: old index -> new index
    sd_list = sorted(sd_set)
    remap = {old: new for new, old in enumerate(sd_list)}

    # Export nodes (remapped)
    out_nodes = []
    for old_idx in sd_list:
        n = nodes[old_idx]
        alpha = ((n['color'] >> 24) & 0xFF) / 255.0
        on = {
            'n': n['name'],
            'x': n['x'],
            'y': n['y'],
            'r': n['r'],
            'sx': n['sx'],
            'sy': n['sy'],
            'v': n['vis'],
            'a': rf(alpha),
            'ch': [remap[c] for c in n['ch'] if c in remap],
        }
        if old_idx in sprites:
            s = sprites[old_idx]
            on['s'] = {
                'w': s['w'],
                'h': s['h'],
                'px': s['px'],
                'py': s['py'],
                'ti': s['layers'][0]['ti'],
                'ci': s['layers'][0]['ci'],
                'fx': s['flip'],
            }
            if len(s['layers']) > 1:
                on['s']['layers'] = s['layers']
        out_nodes.append(on)

    # Export tex[4] crops
    tex4 = textures[4]
    out_tex = {
        'w': tex4['w'],
        'h': tex4['h'],
        'crops': tex4['crops'],
    }

    # Parse animations
    anim_names = ['AdvertiseLoop', 'AdvertiseTouch', 'AdvertiseTouch_R']
    out_anims = {}

    for ai in by_type.get('ANIM', []):
        ac = chunks[ai]
        name = tag(ac['tags'], 3, '')
        if name not in anim_names:
            continue
        dur = tag(ac['tags'], 86, 0)
        loop = tag(ac['tags'], 95, 0)
        mcnt = tag(ac['tags'], 80, 0)

        motions = []
        idx = ai + 1
        for _ in range(mcnt):
            if idx >= len(chunks) or chunks[idx]['type'].strip() != 'MOT':
                break
            mc = chunks[idx]
            tn = tag(mc['tags'], 81, -1)
            tc = tag(mc['tags'], 82, 0)
            idx += 1

            tracks = []
            for _ in range(tc):
                if idx >= len(chunks) or chunks[idx]['type'].strip() != 'TRK':
                    break
                trk = chunks[idx]
                prop = tag(trk['tags'], 83, 0)
                ttype = tag(trk['tags'], 84, 19)
                idx += 1

                keys = []
                if idx < len(chunks) and chunks[idx]['type'].strip() == 'KEY':
                    kt = chunks[idx]['tags']
                    j = 0
                    while j + 4 < len(kt):
                        if kt[j]['id'] == 90:
                            frame = kt[j]['value']
                            val = kt[j + 1]['value']
                            vtype = kt[j + 1].get('type', 0)
                            interp = kt[j + 2].get('value', 0)
                            in_t = rf(kt[j + 3].get('value', 0))
                            out_t = rf(kt[j + 4].get('value', 0))

                            if vtype == 11 and isinstance(val, (int, float)):
                                if val > 0x7FFFFFFF:
                                    val = int(val) - 0x100000000

                            k = [frame, rf(val)]
                            if in_t != 0 or out_t != 0:
                                k.extend([interp, in_t, out_t])
                            keys.append(k)
                            j += 5
                        else:
                            j += 1
                    idx += 1

                tracks.append({'p': prop, 't': ttype, 'k': keys})

            if tn in sd_set:
                new_tn = remap[tn]
                motions.append({'n': new_tn, 'tr': tracks})

        out_anims[name] = {'d': dur, 'l': loop, 'm': motions}

    result = {
        'texture': out_tex,
        'texFile': 'surfboard/MM_UI_Background/tex_004.png',
        'nodes': out_nodes,
        'animations': out_anims,
    }

    op = os.path.join(BASE, 'web', 'sd_data.json')
    os.makedirs(os.path.dirname(op), exist_ok=True)
    with open(op, 'w', encoding='utf-8') as f:
        json.dump(result, f, separators=(',', ':'))

    sz = os.path.getsize(op)
    print(f'Nodes: {len(out_nodes)}')
    print(f'Animations: {list(out_anims.keys())}')
    for an, ad in out_anims.items():
        print(f'  {an}: dur={ad["d"]}, motions={len(ad["m"])}')
    print(f'Tex: {out_tex["w"]}x{out_tex["h"]}, {len(out_tex["crops"])} crops')
    print(f'Saved: {op} ({sz} bytes)')


if __name__ == '__main__':
    main()

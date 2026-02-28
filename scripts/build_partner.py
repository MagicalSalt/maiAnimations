#!/usr/bin/env python3
"""Build partner selection and character display assets for the web implementation.

Reads pre-parsed scene JSONs from data_out/scenes/ and texture PNGs from surfboard/,
outputs web-ready JSON scene files, texture copies, and character icon images to assets/.
"""

import json
import os
import re
import shutil
from typing import Any

from PIL import Image

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BASE)
SCENE_DIR = os.path.join(ROOT, 'data_out', 'scenes')
SURFBOARD_DIR = os.path.join(ROOT, 'surfboard')
ASSETS_DIR = os.path.join(BASE, 'assets')

ICON_CROP_INDICES = [3, 4, 5, 6, 7, 8]

ICON_ORDER = ['ras', 'chiffon', 'salt', 'otohime', 'shama', 'milk']

SCENES = {
    'select': {
        'json': os.path.join(SCENE_DIR, 'MM_UI_CharacterSelect__MM_UI_CharacterSelect.json'),
        'tex_dir': os.path.join(SURFBOARD_DIR, 'MM_UI_CharacterSelect'),
    },
    'select_icon': {
        'json': os.path.join(SCENE_DIR, 'MM_UI_CharacterSelect__Reference_Character_Icon.json'),
        'tex_dir': os.path.join(SURFBOARD_DIR, 'MM_UI_CharacterSelect'),
    },
    'select_char': {
        'json': os.path.join(SCENE_DIR, 'MM_UI_CharacterSelect__Reference_Character.json'),
        'tex_dir': os.path.join(SURFBOARD_DIR, 'MM_UI_CharacterSelect'),
    },
    'chiffon': {
        'json': os.path.join(SCENE_DIR, 'MM_CH_Chiffon__Chiffon_00.json'),
        'tex_dir': os.path.join(SURFBOARD_DIR, 'MM_CH_Chiffon'),
    },
    'milk': {
        'json': os.path.join(SCENE_DIR, 'MM_CH_Milk__Milk_00.json'),
        'tex_dir': os.path.join(SURFBOARD_DIR, 'MM_CH_Milk'),
    },
    'otohime': {
        'json': os.path.join(SCENE_DIR, 'MM_CH_Otohime__Otohime_00.json'),
        'tex_dir': os.path.join(SURFBOARD_DIR, 'MM_CH_Otohime'),
    },
    'ras': {
        'json': os.path.join(SCENE_DIR, 'MM_CH_Ras__Ras_00.json'),
        'tex_dir': os.path.join(SURFBOARD_DIR, 'MM_CH_Ras'),
    },
    'salt': {
        'json': os.path.join(SCENE_DIR, 'MM_CH_Salt__Salt_00.json'),
        'tex_dir': os.path.join(SURFBOARD_DIR, 'MM_CH_Salt'),
    },
    'shama': {
        'json': os.path.join(SCENE_DIR, 'MM_CH_Shama__Shama_00.json'),
        'tex_dir': os.path.join(SURFBOARD_DIR, 'MM_CH_Shama'),
    },
}


def tag(tags: list[dict[str, Any]], tid: int, default=None):
    for t in tags:
        if t['id'] == tid:
            return t.get('value', default)
    return default


def tags_all(tags: list[dict[str, Any]], tid: int):
    return [t.get('value') for t in tags if t['id'] == tid]


def split_records(tags: list[dict[str, Any]]):
    records: list[list[dict[str, Any]]] = []
    cur: list[dict[str, Any]] = []
    for t in tags:
        if t['id'] in (252, 253, 254):
            if cur:
                records.append(cur)
            cur = []
        else:
            cur.append(t)
    if cur:
        records.append(cur)
    return records


def rf(value: Any):
    if isinstance(value, float):
        rounded = round(value, 4)
        if rounded == int(rounded):
            return int(rounded)
        return rounded
    return value


def parse_scene(path: str) -> dict[str, Any]:
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    chunks = data['chunks']
    by_type: dict[str, list[int]] = {}
    for i, chunk in enumerate(chunks):
        by_type.setdefault(chunk['type'].strip(), []).append(i)

    textures: list[dict[str, Any]] = []
    for i in by_type.get('TEX', []):
        tex_chunk = chunks[i]
        crop_chunk = chunks[i + 1]
        textures.append({
            'name': tag(tex_chunk['tags'], 97, ''),
            'w': tag(tex_chunk['tags'], 64, 0),
            'h': tag(tex_chunk['tags'], 65, 0),
            'crops': tags_all(crop_chunk['tags'], 101),
        })

    node_records = split_records(chunks[by_type['NODE'][0]]['tags'])
    trs_records = split_records(chunks[by_type['TRS2'][0]]['tags'])

    nodes: list[dict[str, Any]] = []
    for i, node_record in enumerate(node_records):
        trs_record = trs_records[i] if i < len(trs_records) else []
        pos = tag(trs_record, 49, [0, 0])
        scale = tag(trs_record, 51, [1, 1])
        color = tag(trs_record, 55, 0xFFFFFFFF)
        if color is None:
            color = 0xFFFFFFFF
        if isinstance(color, int) and color < 0:
            color = color & 0xFFFFFFFF
        rot = tag(trs_record, 50, 0)
        if isinstance(rot, int) and rot > 0x7FFFFFFF:
            rot -= 0x100000000

        nodes.append({
            'name': tag(node_record, 3, ''),
            'fc': tag(node_record, 59, 65535),
            'ns': tag(node_record, 60, 65535),
            'x': rf(pos[0]) if isinstance(pos, list) else rf(pos),
            'y': rf(pos[1]) if isinstance(pos, list) else 0,
            'r': rot,
            'sx': rf(scale[0]) if isinstance(scale, list) else rf(scale),
            'sy': rf(scale[1]) if isinstance(scale, list) else rf(scale),
            'v': 1 if tag(trs_record, 58, 1) else 0,
            'a': rf(((color >> 24) & 0xFF) / 255.0),
            'ch': [],
        })

    for node in nodes:
        child_indices = []
        child = node['fc'] if node['fc'] != 65535 else -1
        while 0 <= child < len(nodes):
            child_indices.append(child)
            next_sibling = nodes[child]['ns']
            child = next_sibling if next_sibling != 65535 else -1
        node['ch'] = child_indices
        del node['fc']
        del node['ns']

    sprites: dict[int, dict[str, Any]] = {}
    for i in by_type.get('CIMG', []):
        cimg = chunks[i]
        node_index = tag(cimg['tags'], 81)
        if node_index is None:
            continue

        layers = []
        for j in range(1, cimg.get('sub_chunks', 1) + 1):
            if i + j >= len(chunks):
                break
            sub = chunks[i + j]
            if sub['type'].strip() != 'CREF':
                break
            refs = tags_all(sub['tags'], 73)
            for ref in refs:
                if isinstance(ref, list) and len(ref) >= 3:
                    layers.append({'ti': int(ref[1]), 'ci': int(ref[2])})

        if not layers:
            continue

        tex_ref = tag(cimg['tags'], 72, 0)
        if tex_ref is None:
            tex_ref = 0
        sprites[node_index] = {
            'w': rf(tag(cimg['tags'], 64, 0)),
            'h': rf(tag(cimg['tags'], 65, 0)),
            'px': rf(tag(cimg['tags'], 66, 0)),
            'py': rf(tag(cimg['tags'], 67, 0)),
            'fx': 1 if (tex_ref & 0x10) else 0,
            'layers': layers,
        }

    for index, sprite in sprites.items():
        if 0 <= index < len(nodes):
            nodes[index]['s'] = sprite

    crfd_mounts: list[dict[str, Any]] = []
    for i in by_type.get('CRFD', []):
        crfd = chunks[i]
        node_idx = tag(crfd['tags'], 81)
        scene_ref = tag(crfd['tags'], 100)
        if node_idx is not None:
            crfd_mounts.append({
                'node': node_idx,
                'scene': scene_ref,
                'name': nodes[node_idx]['name'] if node_idx < len(nodes) else '',
            })

    animations: dict[str, Any] = {}
    for anim_index in by_type.get('ANIM', []):
        anim_chunk = chunks[anim_index]
        name = tag(anim_chunk['tags'], 3, '')
        if not isinstance(name, str) or not name:
            continue
        duration = tag(anim_chunk['tags'], 86, 0)
        loop = tag(anim_chunk['tags'], 95, 0)
        motion_count = int(tag(anim_chunk['tags'], 80, 0) or 0)

        motions = []
        idx = anim_index + 1
        for _ in range(motion_count):
            if idx >= len(chunks) or chunks[idx]['type'].strip() != 'MOT':
                break
            mot_chunk = chunks[idx]
            target_node = tag(mot_chunk['tags'], 81, -1)
            track_count = int(tag(mot_chunk['tags'], 82, 0) or 0)
            idx += 1

            tracks = []
            for _ in range(track_count):
                if idx >= len(chunks) or chunks[idx]['type'].strip() != 'TRK':
                    break
                trk_chunk = chunks[idx]
                prop = tag(trk_chunk['tags'], 83, 0)
                ttype = tag(trk_chunk['tags'], 84, 19)
                idx += 1

                keys = []
                if idx < len(chunks) and chunks[idx]['type'].strip() == 'KEY':
                    key_tags = chunks[idx]['tags']
                    j = 0
                    while j + 4 < len(key_tags):
                        if key_tags[j]['id'] == 90:
                            frame = key_tags[j]['value']
                            value = key_tags[j + 1]['value']
                            vtype = key_tags[j + 1].get('type', 0)
                            in_t = rf(key_tags[j + 3].get('value', 0))
                            out_t = rf(key_tags[j + 4].get('value', 0))

                            if vtype == 11 and isinstance(value, (int, float)) and value > 0x7FFFFFFF:
                                value = int(value) - 0x100000000

                            key = [frame, rf(value)]
                            if in_t != 0 or out_t != 0:
                                key.extend([key_tags[j + 2].get('value', 0), in_t, out_t])
                            keys.append(key)
                            j += 5
                        else:
                            j += 1
                    idx += 1

                tracks.append({'p': prop, 't': ttype, 'k': keys})

            motions.append({'n': target_node, 'tr': tracks})

        animations[name] = {'d': duration, 'l': loop, 'm': motions}

    scene_name = os.path.splitext(os.path.basename(path))[0]
    return {
        'scene_name': scene_name,
        'textures': textures,
        'nodes': nodes,
        'animations': animations,
        'mounts': crfd_mounts,
    }


NAME_CROP_INDICES = list(range(13, 19))
NAME_TEX_INDEX = 2


def fix_name_crops(tex_path: str, crops: list[list[int]]):
    """Fix name text overflow and centre within crop boundaries.

    Phase 1 – detect overflow on the UNMODIFIED atlas so adjacent crops
    don't interfere.  Phase 2 – shift overflowing content into its crop.
    Phase 3 – horizontally centre each name inside its crop rectangle.
    """
    img = Image.open(tex_path).convert('RGBA')
    name_crops = [(ci, crops[ci]) for ci in NAME_CROP_INDICES]

    scan_results = []
    for ci, crop in name_crops:
        x1, y1, x2, y2 = crop
        content_left = x1
        gap = 0
        for x in range(x1 - 1, max(0, x1 - 200) - 1, -1):
            has_pixel = False
            for y in range(y1, y2):
                if img.getpixel((x, y))[3] > 10:
                    has_pixel = True
                    break
            if has_pixel:
                content_left = x
                gap = 0
            else:
                gap += 1
                if gap >= 3:
                    break
        scan_results.append(content_left)

    regions = []
    for (ci, crop), content_left in zip(name_crops, scan_results):
        x1, y1, x2, y2 = crop
        overflow = x1 - content_left
        if overflow <= 0:
            regions.append(None)
            continue
        crop_w = x2 - x1
        region = img.crop((content_left, y1, x2, y2))
        if region.width > crop_w:
            region = region.crop((0, 0, crop_w, region.height))
        regions.append(region)

    empty = (0, 0, 0, 0)
    modified = False
    for (ci, crop), content_left, region in zip(name_crops, scan_results, regions):
        if region is None:
            continue
        x1, y1, x2, y2 = crop
        for x in range(content_left, x2):
            for y in range(y1, y2):
                img.putpixel((x, y), empty)
        img.paste(region, (x1, y1))
        modified = True

    for ci, crop in name_crops:
        x1, y1, x2, y2 = crop
        crop_w = x2 - x1
        region = img.crop((x1, y1, x2, y2))
        bbox = region.getbbox()
        if bbox is None:
            continue
        first_col, _, last_col_excl, _ = bbox
        text_w = last_col_excl - first_col
        offset = (crop_w - text_w) // 2 - first_col
        if offset <= 0:
            continue
        content = region.crop(bbox)
        blank = Image.new('RGBA', (crop_w, y2 - y1), (0, 0, 0, 0))
        blank.paste(content, (first_col + offset, bbox[1]))
        img.paste(blank, (x1, y1))
        modified = True

    if modified:
        img.save(tex_path)


def ensure_dirs():
    for d in ('scenes', 'textures', 'icons'):
        os.makedirs(os.path.join(ASSETS_DIR, d), exist_ok=True)


def copy_scene_textures(scene_key: str, tex_dir: str, textures: list[dict[str, Any]]):
    texture_group = 'select' if scene_key in ('select', 'select_icon', 'select_char') else scene_key
    out_dir = os.path.join(ASSETS_DIR, 'textures', texture_group)
    os.makedirs(out_dir, exist_ok=True)

    mapping = {}
    for tex_idx, tex_info in enumerate(textures):
        file_name = f'tex_{tex_idx:03d}.png'
        src = os.path.join(tex_dir, file_name)
        if not os.path.isfile(src):
            raise FileNotFoundError(f'Missing texture: {src}')
        dst = os.path.join(out_dir, file_name)
        shutil.copy2(src, dst)
        mapping[tex_idx] = f'assets/textures/{texture_group}/{file_name}'
    return mapping


def extract_icons(select_data: dict[str, Any], tex_dir: str):
    tex_idx = 2
    texture = select_data['textures'][tex_idx]
    src_path = os.path.join(tex_dir, f'tex_{tex_idx:03d}.png')
    tex_img = Image.open(src_path).convert('RGBA')

    out_dir = os.path.join(ASSETS_DIR, 'icons')
    os.makedirs(out_dir, exist_ok=True)

    icon_files = {}
    for slot, (crop_idx, char_name) in enumerate(zip(ICON_CROP_INDICES, ICON_ORDER)):
        crop = texture['crops'][crop_idx]
        part = tex_img.crop((crop[0], crop[1], crop[2], crop[3]))
        out_name = f'{char_name}.png'
        out_path = os.path.join(out_dir, out_name)
        part.save(out_path, optimize=True)
        icon_files[char_name] = f'assets/icons/{out_name}'

    shadow_crop_idx = 9
    shadow_crop = texture['crops'][shadow_crop_idx]
    shadow = tex_img.crop((shadow_crop[0], shadow_crop[1], shadow_crop[2], shadow_crop[3]))
    shadow.save(os.path.join(out_dir, 'shadow.png'), optimize=True)
    icon_files['_shadow'] = 'assets/icons/shadow.png'

    ef_crops = {
        'ef_b': (12, 258, 258),
        'ef_s': (11, 198, 198),
        'ef_sq': (10, 168, 168),
    }
    for name, (ci, w, h) in ef_crops.items():
        crop = texture['crops'][ci]
        part = tex_img.crop((crop[0], crop[1], crop[2], crop[3]))
        part.save(os.path.join(out_dir, f'{name}.png'), optimize=True)
        icon_files[f'_{name}'] = f'assets/icons/{name}.png'

    return icon_files


def build_scene(scene_key: str, scene_cfg: dict[str, str]):
    parsed = parse_scene(scene_cfg['json'])
    tex_map = copy_scene_textures(scene_key, scene_cfg['tex_dir'], parsed['textures'])

    for n in parsed['nodes']:
        if 'name' in n:
            del n['name']

    scene_out = {
        'textures': [
            {
                'w': tex.get('w', 0),
                'h': tex.get('h', 0),
                'file': tex_map.get(i, ''),
                'crops': tex.get('crops', []),
            }
            for i, tex in enumerate(parsed['textures'])
        ],
        'nodes': parsed['nodes'],
        'animations': parsed['animations'],
    }

    if parsed.get('mounts'):
        scene_out['mounts'] = parsed['mounts']

    out_path = os.path.join(ASSETS_DIR, 'scenes', f'{scene_key}.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(scene_out, f, separators=(',', ':'))

    return {
        'key': scene_key,
        'nodes': len(parsed['nodes']),
        'anims': len(parsed['animations']),
        'textures': len(parsed['textures']),
    }


def main():
    ensure_dirs()

    select_parsed = parse_scene(SCENES['select']['json'])

    icon_files = extract_icons(select_parsed, SCENES['select']['tex_dir'])
    print(f'Extracted {len(ICON_ORDER)} character icons + effects')

    icon_nodes = {}
    for n in select_parsed['nodes']:
        if n['name'].startswith('Reference_Character_Icon_'):
            slot = int(n['name'].split('_')[-1])
            icon_nodes[slot] = {
                'x': rf(n['x']),
                'y': rf(n['y']),
                'sx': rf(n['sx']),
                'sy': rf(n['sy']),
            }

    under_nul = next((n for n in select_parsed['nodes'] if n['name'] == 'Character_Under_NUL'), None)
    under_pos = [rf(under_nul['x']), rf(under_nul['y'])] if under_nul else [0, 134]

    char_nul = next((n for n in select_parsed['nodes'] if n['name'] == 'Reference_Character'), None)
    char_pos = [rf(char_nul['x']), rf(char_nul['y'])] if char_nul else [-15, -136]

    summary = []
    for key, cfg in SCENES.items():
        info = build_scene(key, cfg)
        summary.append(info)
        print(f'  {key}: {info["nodes"]} nodes, {info["anims"]} anims, {info["textures"]} textures')

    name_tex_path = os.path.join(ASSETS_DIR, 'textures', 'select', f'tex_{NAME_TEX_INDEX:03d}.png')
    fix_name_crops(name_tex_path, select_parsed['textures'][NAME_TEX_INDEX]['crops'])
    print('Fixed name text crop alignment')

    manifest = {
        'partners': ICON_ORDER,
        'scenes': {item['key']: f"assets/scenes/{item['key']}.json" for item in summary},
        'icons': icon_files,
        'layout': {
            'sceneSize': 1080,
            'topPos': [540, 540],
            'underNulPos': under_pos,
            'charViewportPos': char_pos,
            'iconSlots': [
                {
                    'partner': ICON_ORDER[slot],
                    'x': icon_nodes[slot]['x'],
                    'y': icon_nodes[slot]['y'],
                    'sx': icon_nodes[slot]['sx'],
                    'sy': icon_nodes[slot]['sy'],
                }
                for slot in sorted(icon_nodes.keys())
            ],
            'iconSize': 148,
        },
    }

    manifest_path = os.path.join(ASSETS_DIR, 'manifest.json')
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2)

    print(f'\nManifest: {manifest_path}')
    print(f'Partners (L→R): {", ".join(ICON_ORDER)}')


if __name__ == '__main__':
    main()

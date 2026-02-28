import struct, os, subprocess, json

SOUND_DIR = './sound'
OUT_DIR = './partner/assets/voice'

XSBS = {
    'raz':     os.path.join(SOUND_DIR, 'Voice_raz.xsb'),
    'chiffon': os.path.join(SOUND_DIR, 'Voice_Chiffon.xsb'),
    'salt':    os.path.join(SOUND_DIR, 'Voice_Salt.xsb'),
    'otohime': os.path.join(SOUND_DIR, 'Voice_otohime.xsb'),
    'shama':   os.path.join(SOUND_DIR, 'Voice_shama.xsb'),
    'milk':    os.path.join(SOUND_DIR, 'Voice_milk.xsb'),
}

WAV_DIRS = {
    'raz':     os.path.join(SOUND_DIR, 'raz'),
    'chiffon': os.path.join(SOUND_DIR, 'chiffon'),
    'salt':    os.path.join(SOUND_DIR, 'salt'),
    'otohime': os.path.join(SOUND_DIR, 'otohime'),
    'shama':   os.path.join(SOUND_DIR, 'shama'),
    'milk':    os.path.join(SOUND_DIR, 'milk'),
}

# Level-based voices from decompiled code analysis
# sub_5D3CB0: high mood (level 5-13)
# sub_5D3E00: low mood (level 0-4)
LEVEL_VOICES = {
    0: 133,   # Sad (very disappointed)
    1: 132,   # Sad
    2: 131,   # Sad
    3: 130,   # Determination
    4: 129,   # Determination
    5: 99,    # Joy (slight)
    6: 98,    # Joy
    7: 97,    # Joy
    8: 96,    # Happy
    9: 95,    # Happy
    10: 94,   # Happy (big)
    11: 93,   # Happy (big)
    12: 92,   # Excited
    13: 91,   # Excited (max)
}

# SE reaction voices (sub_5D3B30) - played additionally at high moods
SE_VOICES = {
    5: [111],
    6: [111],
    7: [111],
    8: [108, 109, 110],
    9: [108, 109, 110],
    10: [105, 106, 107],
    11: [105, 106, 107],
    12: [102, 103, 104],
    13: [100, 101],
}

# Sad level 0 alternatives
SAD_ALT = [119, 120]

# Result rank voices
RANK_VOICES = {81: 'rank_splus', 82: 'rank_a', 83: 'rank_e'}

# Core voices
CORE_VOICES = {
    'meeting': [170, 171, 172],
    'touch': [88, 89, 90],
}


def parse_xsb(path):
    with open(path, 'rb') as f:
        data = f.read()
    assert data[:4] == b'SDBK'
    num_simple = struct.unpack_from('<H', data, 0x13)[0]
    num_total = struct.unpack_from('<H', data, 0x19)[0]
    offsets = [struct.unpack_from('<I', data, 0x22 + i * 4)[0] for i in range(11)]
    simple_cues_off = offsets[0]
    hash_extra_off = offsets[8]

    cue_to_name = {}
    for i in range(num_total):
        off = hash_extra_off + i * 6
        name_ptr = struct.unpack_from('<I', data, off)[0]
        if name_ptr == 0 or name_ptr >= len(data):
            continue
        name_end = data.index(0, name_ptr)
        cue_to_name[i] = data[name_ptr:name_end].decode('ascii')

    cue_to_sound_off = {}
    for i in range(num_simple):
        off = simple_cues_off + i * 5
        cue_to_sound_off[i] = struct.unpack_from('<I', data, off + 1)[0]

    cue_to_track = {}
    for cue_idx, snd_off in cue_to_sound_off.items():
        flags = data[snd_off]
        if flags & 1 == 0:
            cue_to_track[cue_idx] = struct.unpack_from('<H', data, snd_off + 9)[0]
        else:
            entry_size = data[snd_off + 7]
            if entry_size == 0x24:
                cue_to_track[cue_idx] = struct.unpack_from('<H', data, snd_off + 28)[0]

    vo_to_track = {}
    for cue_idx, name in cue_to_name.items():
        if cue_idx in cue_to_track:
            vo_to_track[name] = cue_to_track[cue_idx]
    return vo_to_track


def vo_name(idx):
    return f'Vo_{idx:04d}'


def convert(wav_path, ogg_path):
    r = subprocess.run(
        ['ffmpeg', '-y', '-i', wav_path,
         '-c:a', 'libvorbis', '-b:a', '128k', '-ac', '2', '-ar', '44100',
         ogg_path],
        capture_output=True, text=True,
    )
    return r.returncode == 0


def main():
    all_maps = {}
    for char, path in XSBS.items():
        all_maps[char] = parse_xsb(path)
        print(f'{char}: {len(all_maps[char])} named tracks')

    # Collect all voice indices we need
    all_voice_indices = set()
    for indices in CORE_VOICES.values():
        all_voice_indices.update(indices)
    for vi in LEVEL_VOICES.values():
        all_voice_indices.add(vi)
    for vis in SE_VOICES.values():
        all_voice_indices.update(vis)
    all_voice_indices.update(SAD_ALT)
    all_voice_indices.update(RANK_VOICES.keys())
    print(f'\nTotal unique voice indices: {len(all_voice_indices)}')

    # Check availability
    missing = []
    for vi in sorted(all_voice_indices):
        vn = vo_name(vi)
        for char in XSBS:
            if vn not in all_maps[char]:
                missing.append((char, vn))
    if missing:
        print(f'Missing mappings: {len(missing)}')
        for char, vn in missing:
            print(f'  {char}: {vn}')

    # Plan conversions
    conversions = []
    manifest = {}

    for char in XSBS:
        voice_key = 'raz' if char == 'raz' else char
        char_out = os.path.join(OUT_DIR, voice_key)
        os.makedirs(char_out, exist_ok=True)
        char_manifest = {}

        # Core voices: meeting, touch
        for vtype, indices in CORE_VOICES.items():
            paths = []
            for n, vi in enumerate(indices, 1):
                vn = vo_name(vi)
                track = all_maps[char].get(vn)
                if track is None:
                    continue
                ogg = f'{vtype}_{n}.ogg'
                wav = os.path.join(WAV_DIRS[char], f'{track:08x}.wav')
                conversions.append((wav, os.path.join(char_out, ogg), char, ogg))
                paths.append(f'assets/voice/{voice_key}/{ogg}')
            char_manifest[vtype] = paths

        # Level voices
        level_paths = {}
        for level, vi in LEVEL_VOICES.items():
            vn = vo_name(vi)
            track = all_maps[char].get(vn)
            if track is None:
                continue
            ogg = f'level_{level}.ogg'
            wav = os.path.join(WAV_DIRS[char], f'{track:08x}.wav')
            conversions.append((wav, os.path.join(char_out, ogg), char, ogg))
            level_paths[level] = f'assets/voice/{voice_key}/{ogg}'
        char_manifest['level'] = level_paths

        # SE reaction voices
        se_paths = {}
        se_done = set()
        for level, vis in SE_VOICES.items():
            level_se = []
            for vi in vis:
                vn = vo_name(vi)
                track = all_maps[char].get(vn)
                if track is None:
                    continue
                ogg = f'se_{vi}.ogg'
                if vi not in se_done:
                    wav = os.path.join(WAV_DIRS[char], f'{track:08x}.wav')
                    conversions.append((wav, os.path.join(char_out, ogg), char, ogg))
                    se_done.add(vi)
                level_se.append(f'assets/voice/{voice_key}/{ogg}')
            se_paths[level] = level_se
        char_manifest['se'] = se_paths

        # Sad alternatives (for level 0)
        alt_paths = []
        for vi in SAD_ALT:
            vn = vo_name(vi)
            track = all_maps[char].get(vn)
            if track is None:
                continue
            ogg = f'sad_alt_{vi}.ogg'
            wav = os.path.join(WAV_DIRS[char], f'{track:08x}.wav')
            conversions.append((wav, os.path.join(char_out, ogg), char, ogg))
            alt_paths.append(f'assets/voice/{voice_key}/{ogg}')
        char_manifest['sad_alt'] = alt_paths

        # Rank voices
        rank_paths = {}
        for vi, rname in RANK_VOICES.items():
            vn = vo_name(vi)
            track = all_maps[char].get(vn)
            if track is None:
                continue
            ogg = f'{rname}.ogg'
            wav = os.path.join(WAV_DIRS[char], f'{track:08x}.wav')
            conversions.append((wav, os.path.join(char_out, ogg), char, ogg))
            rank_paths[rname] = f'assets/voice/{voice_key}/{ogg}'
        char_manifest['rank'] = rank_paths

        manifest[voice_key] = char_manifest

    print(f'\n=== Converting {len(conversions)} files ===')
    ok = 0
    fail = 0
    for wav_path, ogg_path, char, ogg_name in conversions:
        if not os.path.isfile(wav_path):
            print(f'  SKIP {char}/{ogg_name}: source not found ({wav_path})')
            fail += 1
            continue
        if convert(wav_path, ogg_path):
            sz = os.path.getsize(ogg_path)
            print(f'  {char}/{ogg_name}: OK ({sz:,}B)')
            ok += 1
        else:
            print(f'  {char}/{ogg_name}: FAIL')
            fail += 1

    print(f'\nDone: {ok} OK, {fail} failed')

    manifest_path = os.path.join(OUT_DIR, 'manifest.json')
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)
    print(f'Manifest written to {manifest_path}')


if __name__ == '__main__':
    main()

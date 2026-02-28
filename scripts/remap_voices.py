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

VOICE_FILES = {
    'meeting': [170, 171, 172],
    'touch':   [88, 89, 90],
}


def parse_xsb(path):
    with open(path, 'rb') as f:
        data = f.read()
    assert data[:4] == b'SDBK'

    num_simple  = struct.unpack_from('<H', data, 0x13)[0]
    num_complex = struct.unpack_from('<H', data, 0x15)[0]
    num_total   = struct.unpack_from('<H', data, 0x19)[0]
    num_sounds  = struct.unpack_from('<H', data, 0x1C)[0]

    offsets = [struct.unpack_from('<I', data, 0x22 + i * 4)[0] for i in range(11)]
    simple_cues_off = offsets[0]
    hash_extra_off  = offsets[8]
    sounds_off      = offsets[10]

    # Hash extra table: entry i = cue i. Format: (u32 name_ptr, u16 chain_next)
    cue_to_name = {}
    for i in range(num_total):
        off = hash_extra_off + i * 6
        name_ptr = struct.unpack_from('<I', data, off)[0]
        if name_ptr == 0 or name_ptr >= len(data):
            continue
        name_end = data.index(0, name_ptr)
        name = data[name_ptr:name_end].decode('ascii')
        cue_to_name[i] = name

    # Simple cue entries: 5 bytes each (u8 flags, u32 sound_offset)
    cue_to_sound_off = {}
    for i in range(num_simple):
        off = simple_cues_off + i * 5
        snd_off = struct.unpack_from('<I', data, off + 1)[0]
        cue_to_sound_off[i] = snd_off

    # Sound entries: simple = 12 bytes, track at +9 as u16 LE
    cue_to_track = {}
    for cue_idx, snd_off in cue_to_sound_off.items():
        flags = data[snd_off]
        if flags & 1 == 0:
            track = struct.unpack_from('<H', data, snd_off + 9)[0]
            cue_to_track[cue_idx] = track
        else:
            entry_size = data[snd_off + 7]
            if entry_size == 0x24:
                track = struct.unpack_from('<H', data, snd_off + 28)[0]
                cue_to_track[cue_idx] = track

    # Build Vo name → track mapping
    vo_to_track = {}
    for cue_idx, name in cue_to_name.items():
        if cue_idx in cue_to_track:
            vo_to_track[name] = cue_to_track[cue_idx]
    return vo_to_track, num_total, num_sounds


def vo_name(voice_idx):
    return f'Vo_{voice_idx:04d}'


def main():
    all_maps = {}
    for char, path in XSBS.items():
        vo_map, n_cues, n_sounds = parse_xsb(path)
        all_maps[char] = vo_map
        print(f'{char}: {n_cues} cues, {n_sounds} sounds, {len(vo_map)} named tracks')

    print('\n=== Voice Index → Track → WAV per character ===')
    for vtype, indices in VOICE_FILES.items():
        print(f'\n  {vtype}:')
        for vi in indices:
            vn = vo_name(vi)
            row = f'    {vn}:'
            for char in XSBS:
                track = all_maps[char].get(vn)
                if track is not None:
                    row += f'  {char}={track:3d} ({track:08x}.wav)'
                else:
                    row += f'  {char}=???'
            print(row)

    manifest = {}
    conversions = []
    for char in XSBS:
        voice_key = 'raz' if char == 'raz' else char
        char_out = os.path.join(OUT_DIR, voice_key)
        os.makedirs(char_out, exist_ok=True)
        char_manifest = {}
        for vtype, indices in VOICE_FILES.items():
            paths = []
            for n, vi in enumerate(indices, 1):
                vn = vo_name(vi)
                track = all_maps[char].get(vn)
                if track is None:
                    print(f'WARNING: {char} {vn} not found!')
                    continue
                wav_name = f'{track:08x}.wav'
                wav_path = os.path.join(WAV_DIRS[char], wav_name)
                ogg_name = f'{vtype}_{n}.ogg'
                ogg_path = os.path.join(char_out, ogg_name)
                if not os.path.isfile(wav_path):
                    print(f'WARNING: {wav_path} not found!')
                    continue
                conversions.append((wav_path, ogg_path, char, ogg_name))
                paths.append(f'assets/voice/{voice_key}/{ogg_name}')
            char_manifest[vtype] = paths
        manifest[voice_key] = char_manifest

    print(f'\n=== Converting {len(conversions)} files ===')
    for wav_path, ogg_path, char, ogg_name in conversions:
        cmd = [
            'ffmpeg', '-y', '-i', wav_path,
            '-c:a', 'libvorbis', '-b:a', '128k',
            '-ac', '2', '-ar', '44100',
            ogg_path
        ]
        r = subprocess.run(cmd, capture_output=True, text=True)
        sz = os.path.getsize(ogg_path) if os.path.isfile(ogg_path) else 0
        status = 'OK' if r.returncode == 0 else 'FAIL'
        print(f'  {char}/{ogg_name}: {status} ({sz:,} bytes)')

    manifest_path = os.path.join(OUT_DIR, 'manifest.json')
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)
    print(f'\nManifest written to {manifest_path}')


if __name__ == '__main__':
    main()

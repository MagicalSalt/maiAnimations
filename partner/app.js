'use strict';

const FPS = 60;
const FRAME_MS = 1000 / FPS;
const SCENE_SIZE = 1080;

const CHAR_HEIGHT_CM = {
    shama: 157, milk: 157, otohime: 152, ras: 158, chiffon: 160, salt: 142,
};
const CHAR_BODY_FRAC = {
    shama: 0.75, milk: 0.75, otohime: 0.78, ras: 0.85, chiffon: 0.83, salt: 0.85,
};
const HUD_TOP_H = 64;
const HUD_BOTTOM_H = 48;

const VOICE_NAME_MAP = { ras: 'raz' };

const LEVEL_ANIM = [
    'Sad1', 'Sad1', 'Sad1',
    'Determination1', 'Determination1',
    'Joy1', 'Joy1', 'Joy2',
    'Joy3', 'Happy1', 'Happy1', 'Happy1', 'Happy1', 'Happy1',
];

class VoiceManager {
    constructor() {
        this.ctx = null;
        this.buffers = {};
        this.current = null;
        this.currentSE = null;
        this.manifest = null;
    }

    async init(manifestPath) {
        this.manifest = await (await fetch(manifestPath)).json();
    }

    _ensureContext() {
        if (!this.ctx) this.ctx = new AudioContext();
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return this.ctx;
    }

    async preload(charName) {
        if (this.buffers[charName]) return;
        const voiceKey = VOICE_NAME_MAP[charName] || charName;
        const entry = this.manifest[voiceKey];
        if (!entry) return;
        const ctx = this._ensureContext();
        const decode = async (path) => {
            const resp = await fetch(path);
            return ctx.decodeAudioData(await resp.arrayBuffer());
        };
        const b = {
            meeting: await Promise.all(entry.meeting.map(decode)),
            touch: await Promise.all(entry.touch.map(decode)),
            level: {},
            se: {},
        };
        for (const [lv, path] of Object.entries(entry.level || {}))
            b.level[lv] = await decode(path);
        for (const [lv, paths] of Object.entries(entry.se || {}))
            b.se[lv] = await Promise.all(paths.map(decode));
        this.buffers[charName] = b;
    }

    async preloadAll(charNames) {
        await Promise.all(charNames.map(n => this.preload(n)));
    }

    _playBuf(buf) {
        const ctx = this._ensureContext();
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        source.buffer = buf;
        source.connect(gain);
        gain.connect(ctx.destination);
        source.start();
        return { source, gain };
    }

    play(charName, type) {
        this.stop();
        const bufs = this.buffers[charName];
        if (!bufs?.[type]?.length) return;
        const buf = bufs[type][Math.floor(Math.random() * bufs[type].length)];
        this.current = this._playBuf(buf);
        this.current.source.onended = () => {
            if (this.current?.source === this.current?.source) this.current = null;
        };
    }

    playLevel(charName, level) {
        this.stop();
        this.stopSE();
        const bufs = this.buffers[charName];
        if (!bufs) return;
        const lvBuf = bufs.level[String(level)];
        if (lvBuf) {
            this.current = this._playBuf(lvBuf);
            this.current.source.onended = () => { this.current = null; };
        }
        const seBufs = bufs.se[String(level)];
        if (seBufs?.length) {
            const se = seBufs[Math.floor(Math.random() * seBufs.length)];
            this.currentSE = this._playBuf(se);
            this.currentSE.source.onended = () => { this.currentSE = null; };
        }
    }

    _stopNode(node, fadeMs) {
        if (!node) return;
        const { source, gain } = node;
        if (!this.ctx || fadeMs <= 0) {
            try { source.stop(); } catch (_) {}
            return;
        }
        gain.gain.setValueAtTime(gain.gain.value, this.ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + fadeMs / 1000);
        setTimeout(() => { try { source.stop(); } catch (_) {} }, fadeMs + 10);
    }

    stop(fadeMs = 50) {
        this._stopNode(this.current, fadeMs);
        this.current = null;
    }

    stopSE(fadeMs = 50) {
        this._stopNode(this.currentSE, fadeMs);
        this.currentSE = null;
    }

    stopAll(fadeMs = 50) {
        this.stop(fadeMs);
        this.stopSE(fadeMs);
    }
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function evalTrack(track, frame) {
    const keys = track.k;
    if (!keys || !keys.length) return undefined;
    if (keys.length === 1) return keys[0][1];
    if (frame <= keys[0][0]) return keys[0][1];
    if (frame >= keys[keys.length - 1][0]) return keys[keys.length - 1][1];

    const interp = track.t & 0xF;
    for (let i = 0; i < keys.length - 1; i++) {
        const k0 = keys[i], k1 = keys[i + 1];
        if (frame >= k0[0] && frame < k1[0]) {
            if (interp === 0) return k0[1];
            const span = k1[0] - k0[0];
            if (span <= 0) return k0[1];
            const t = (frame - k0[0]) / span;
            if (interp === 3) {
                if (k0.length >= 5 && k1.length >= 5) {
                    const p0 = k0[1], p1 = k1[1];
                    const m0 = k0[4] * span, m1 = k1[3] * span;
                    const t2 = t * t, t3 = t2 * t;
                    return (2 * t3 - 3 * t2 + 1) * p0
                        + (t3 - 2 * t2 + t) * m0
                        + (-2 * t3 + 3 * t2) * p1
                        + (t3 - t2) * m1;
                }
                const s = t * t * (3 - 2 * t);
                return lerp(k0[1], k1[1], s);
            }
            return lerp(k0[1], k1[1], t);
        }
    }
    return keys[keys.length - 1][1];
}


class ScenePlayer {
    constructor(sceneData, images) {
        this.scene = sceneData;
        this.images = images;
        this.frame = 0;
        this.active = [];
        this.baseAnims = [];
        this.nodes = this.scene.nodes.map(n => ({ ...n }));
        this.motionPeriods = new Map();
        this.mountDrawFns = new Map();
        this._computePeriods();
    }

    _computePeriods() {
        for (const anim of Object.values(this.scene.animations)) {
            for (const mot of anim.m) {
                let maxF = 0;
                for (const trk of mot.tr)
                    for (const k of trk.k)
                        if (k[0] > maxF) maxF = k[0];
                mot._period = maxF || 0;
            }
        }
    }

    mount(nodeIndex, drawFn) {
        this.mountDrawFns.set(nodeIndex, drawFn);
    }

    unmount(nodeIndex) {
        this.mountDrawFns.delete(nodeIndex);
    }

    resetNodes() {
        for (const n of this.nodes) {
            n._x = n.x;
            n._y = n.y;
            n._r = -(n.r * Math.PI / 32768);
            n._sx = n.sx;
            n._sy = n.sy;
            n._hidden = !n.v;
            n._a = n.a;
            n._pat = n._patBase ?? 0;
            n._cropW = undefined;
            n._cropH = undefined;
            n._cr = 1; n._cg = 1; n._cb = 1;
        }
    }

    applyTrack(node, trk, f) {
        const isDiscrete = trk.p === 11 || trk.p === 18;
        const effectiveTrk = isDiscrete ? { ...trk, t: (trk.t & ~0xF) } : trk;
        const v = evalTrack(effectiveTrk, f);
        if (v === undefined) return;
        switch (trk.p) {
            case 0: node._x = v; break;
            case 1: node._y = v; break;
            case 5: node._r = -(v * Math.PI / 32768); break;
            case 6: node._sx = v; break;
            case 7: node._sy = v; break;
            case 11: node._hidden = !v; break;
            case 12: node._cropW = v; break;
            case 13: node._cropH = v; break;
            case 18: node._pat = v; break;
            case 21: node._cr = v; break;
            case 22: node._cg = v; break;
            case 23: node._cb = v; break;
            case 24: node._a = v; break;
        }
    }

    applyAnim(animName, frame, forceLoop) {
        const anim = this.scene.animations[animName];
        if (!anim) return;
        for (const mot of anim.m) {
            const node = this.nodes[mot.n];
            if (!node) continue;
            const useLoop = forceLoop || !!anim.l;
            const mf = useLoop && mot._period ? frame % mot._period : frame;
            for (const trk of mot.tr) this.applyTrack(node, trk, mf);
        }
    }

    play(animName, opts = {}) {
        const anim = this.scene.animations[animName];
        if (!anim) return null;
        const entry = {
            name: animName,
            frame: 0,
            loop: opts.loop ?? !!anim.l,
            hold: opts.hold ?? false,
            ended: false,
            endFrame: Math.max(1, Number(anim.d) || 1),
            onEnd: opts.onEnd || null,
        };
        this.active.push(entry);
        return entry;
    }

    stopAnim(animName) {
        this.active = this.active.filter(e => e.name !== animName);
    }

    clearAll() {
        this.active = [];
    }

    clearByPrefix(prefix) {
        this.active = this.active.filter(e => !e.name.startsWith(prefix));
    }

    tick() {
        this.resetNodes();
        for (const b of this.baseAnims) {
            this.applyAnim(b.name, b.frame, false);
        }
        for (const e of this.active) {
            this.applyAnim(e.name, e.frame, e.loop);
        }
        const callbacks = [];
        for (const e of this.active) {
            e.frame++;
            if (!e.loop && e.frame >= e.endFrame) {
                e.ended = true;
                if (e.onEnd) callbacks.push(e.onEnd);
            }
        }
        this.active = this.active.filter(e => !e.ended || e.hold);
        this.frame++;
        for (const cb of callbacks) cb();
    }

    drawNode(ctx, idx, parentAlpha, parentHidden) {
        const node = this.nodes[idx];
        if (!node) return;

        const hidden = node._hidden || parentHidden;

        const nodeAlpha = Math.max(0, Math.min(1, node._a ?? 1));
        const alpha = nodeAlpha * parentAlpha;

        ctx.save();
        ctx.translate(node._x, node._y);
        if (node._r) ctx.rotate(node._r);
        if (node._sx !== 1 || node._sy !== 1) ctx.scale(node._sx, node._sy);

        if (node._cr < 0.999 || node._cg < 0.999 || node._cb < 0.999) {
            ctx.filter = `brightness(${(node._cr + node._cg + node._cb) / 3})`;
        }

        if (!hidden && node.s && alpha > 0.003) {
            const spr = node.s;
            const pattern = Math.round(node._pat || 0);
            const layers = spr.layers || [];
            const layer = layers.length > 1 ? layers[pattern] : layers[0];
            if (layer) {
                let hasNameClip = false;
                if (this.enableNameClip && idx === 7) {
                    const baseNode = this.nodes[6];
                    if (baseNode && baseNode.s) {
                        const clipX = (baseNode._x - node._x) - baseNode.s.px;
                        const clipY = (baseNode._y - node._y) - baseNode.s.py;
                        ctx.save();
                        ctx.beginPath();
                        ctx.rect(clipX, clipY, baseNode.s.w, baseNode.s.h);
                        ctx.clip();
                        hasNameClip = true;
                    }
                }
                const tex = this.scene.textures[layer.ti];
                const img = this.images[layer.ti];
                if (tex && img) {
                    const crop = tex.crops[layer.ci];
                    if (crop) {
                        const sx = crop[0], sy = crop[1];
                        let sw = crop[2] - crop[0], sh = crop[3] - crop[1];
                        let dw = spr.w, dh = spr.h;
                        if (node._cropW !== undefined) { sw = node._cropW; dw = node._cropW; }
                        if (node._cropH !== undefined) { sh = node._cropH; dh = node._cropH; }
                        const cropKey = layer.ti * 10000 + layer.ci;
                        const trimRight = (this.cropTrimRights && this.cropTrimRights.get(cropKey)) || 0;
                        if (trimRight > 0) {
                            sw = Math.max(0, sw - trimRight);
                            dw = Math.max(0, dw - trimRight);
                        }
                        if (sw > 0 && sh > 0) {
                            ctx.globalAlpha = alpha;
                            const isolated = this.cropImages && this.cropImages.get(cropKey);
                            const cropPad = (this.cropPads && this.cropPads.get(cropKey)) || 0;
                            const leftExt = (this.cropLeftExts && this.cropLeftExts.get(cropKey)) || 0;
                            const src = isolated || img;
                            const csx = isolated ? cropPad : sx;
                            const csy = isolated ? cropPad : sy;
                            const drawSw = sw;
                            const drawDw = dw;
                            const drawPx = spr.px;
                            const sampleX = csx;
                            const sampleY = csy;
                            const sampleW = drawSw;
                            const sampleH = sh;
                            if (spr.fx) {
                                ctx.save();
                                ctx.scale(-1, 1);
                                ctx.drawImage(src, sampleX, sampleY, sampleW, sampleH, drawPx - drawDw, -spr.py, drawDw, dh);
                                ctx.restore();
                            } else {
                                ctx.drawImage(src, sampleX, sampleY, sampleW, sampleH, -drawPx, -spr.py, drawDw, dh);
                            }
                            if (this._debug) {
                                ctx.globalAlpha = 1;
                                ctx.strokeStyle = '#00e5ff';
                                ctx.lineWidth = 3;
                                const rx = spr.fx ? (spr.px - dw) : -spr.px;
                                ctx.strokeRect(rx, -spr.py, dw, dh);
                                const label = node._name ? `${idx}:${node._name}` : String(idx);
                                ctx.font = 'bold 16px monospace';
                                const textW = Math.ceil(ctx.measureText(label).width);
                                const tx = rx + 2;
                                const ty = -spr.py + 2;
                                ctx.fillStyle = 'rgba(0,0,0,0.85)';
                                ctx.fillRect(tx - 1, ty - 1, textW + 8, 20);
                                ctx.fillStyle = '#ffffff';
                                ctx.fillText(label, tx + 3, ty + 14);
                            }
                        }
                    }
                }
                if (hasNameClip) ctx.restore();
            }
        }

        const mountFn = this.mountDrawFns.get(idx);
        if (mountFn) mountFn(ctx, alpha);

        for (const ci of node.ch) {
            this.drawNode(ctx, ci, alpha, hidden);
        }
        ctx.restore();
    }

    computeVisualCenter() {
        const root = this.scene.nodes[0];
        const rx = root ? root.x : 0;
        const ry = root ? root.y : 0;
        if (rx !== 0 || ry !== 0) return { x: rx, y: ry };
        const bounds = [];
        const collectBounds = (idx, cx, cy) => {
            const n = this.scene.nodes[idx];
            if (!n || !n.v) return;
            const x = cx + n.x, y = cy + n.y;
            if (n.s && n.s.w * n.s.h > 1000) {
                bounds.push({ x, y, area: n.s.w * n.s.h });
            }
            for (const ci of (n.ch || [])) collectBounds(ci, x, y);
        };
        collectBounds(0, 0, 0);
        if (!bounds.length) return { x: 540, y: 540 };
        let totalArea = 0, wx = 0, wy = 0;
        for (const b of bounds) { wx += b.x * b.area; wy += b.y * b.area; totalArea += b.area; }
        return { x: wx / totalArea, y: wy / totalArea };
    }

    render(ctx, tx, ty, scale) {
        ctx.save();
        ctx.translate(tx, ty);
        ctx.scale(scale, scale);
        this.drawNode(ctx, 0, 1);
        ctx.restore();
    }
}


async function loadImage(path) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to load: ' + path));
        img.src = path;
    });
}

async function loadScene(path, opts = {}) {
    const r = await fetch(path);
    const scene = await r.json();

    for (const tex of (scene.textures || [])) {
        const crops = tex && tex.crops;
        if (!Array.isArray(crops) || !crops.length) continue;
        let needsRebase = false;
        for (const crop of crops) {
            if (!crop || crop.length < 4) continue;
            if (crop[0] === 0 || crop[1] === 0) {
                needsRebase = true;
                break;
            }
        }
        if (!needsRebase) continue;
        for (const crop of crops) {
            if (!crop || crop.length < 4) continue;
            crop[0] += 1;
            crop[1] += 1;
            crop[2] += 1;
            crop[3] += 1;
        }
    }

    const images = [];
    const cropImages = new Map();
    const cropPads = new Map();
    const cropLeftExts = new Map();
    const isolateCrops = opts.isolateCrops !== false;
    const cropPad = opts.cropPad === undefined ? 1 : Math.max(0, opts.cropPad | 0);

    for (let ti = 0; ti < scene.textures.length; ti++) {
        const tex = scene.textures[ti];
        const file = tex.file
            .replace('assets/textures/select_char/', 'assets/textures/select/')
            .replace('assets/textures/select_icon/', 'assets/textures/select/');
        const img = await loadImage(file);
        images.push(img);
        if (!isolateCrops) continue;
        for (let ci = 0; ci < tex.crops.length; ci++) {
            const crop = tex.crops[ci];
            if (!crop || crop.length < 4) continue;
            const sw = crop[2] - crop[0], sh = crop[3] - crop[1];
            if (sw <= 0 || sh <= 0) continue;
            const leftExt = 0;
            const c = document.createElement('canvas');
            c.width = sw + cropPad * 2;
            c.height = sh + cropPad * 2;
            const cctx = c.getContext('2d');
            const cropX = crop[0];
            const cropY = crop[1];
            cctx.drawImage(img, cropX, cropY, sw, sh, cropPad, cropPad, sw, sh);
            if (cropPad > 0) {
                cctx.drawImage(img, cropX, cropY, sw, 1, cropPad, 0, sw, cropPad);
                cctx.drawImage(img, cropX, cropY + sh - 1, sw, 1, cropPad, cropPad + sh, sw, cropPad);
                cctx.drawImage(img, cropX, cropY, 1, sh, 0, cropPad, cropPad, sh);
                cctx.drawImage(img, cropX + sw - 1, cropY, 1, sh, cropPad + sw, cropPad, cropPad, sh);
                cctx.drawImage(img, cropX, cropY, 1, 1, 0, 0, cropPad, cropPad);
                cctx.drawImage(img, cropX + sw - 1, cropY, 1, 1, cropPad + sw, 0, cropPad, cropPad);
                cctx.drawImage(img, cropX, cropY + sh - 1, 1, 1, 0, cropPad + sh, cropPad, cropPad);
                cctx.drawImage(img, cropX + sw - 1, cropY + sh - 1, 1, 1, cropPad + sw, cropPad + sh, cropPad, cropPad);
            }
            cropImages.set(ti * 10000 + ci, c);
            cropPads.set(ti * 10000 + ci, cropPad);
        }
    }
    const player = new ScenePlayer(scene, images);
    player.cropImages = cropImages;
    player.cropPads = cropPads;
    player.cropLeftExts = cropLeftExts;
    return player;
}

async function loadRawNodeNames(path) {
    const r = await fetch(path);
    if (!r.ok) return null;
    const data = await r.json();
    const chunks = data && data.chunks;
    if (!Array.isArray(chunks)) return null;
    const nodeChunk = chunks.find(c => (c.type || '').trim() === 'NODE');
    if (!nodeChunk || !Array.isArray(nodeChunk.tags)) return null;

    const names = [];
    let record = [];
    for (const tag of nodeChunk.tags) {
        if (tag.id === 254) {
            const nameTag = record.find(t => t.id === 3);
            names.push(typeof nameTag?.value === 'string' ? nameTag.value : '');
            record = [];
            continue;
        }
        record.push(tag);
    }
    if (record.length) {
        const nameTag = record.find(t => t.id === 3);
        names.push(typeof nameTag?.value === 'string' ? nameTag.value : '');
    }
    return names;
}

async function loadRawNodeNamesByCandidates(paths) {
    for (const p of paths) {
        try {
            const names = await loadRawNodeNames(p);
            if (Array.isArray(names) && names.length) return names;
        } catch (_) {}
    }
    return null;
}


class PartnerApp {
    constructor() {
        this.canvas = document.getElementById('c');
        this.ctx = this.canvas.getContext('2d');

        this.state = 'loading';
        this.selectedIndex = -1;
        this.prevIndex = -1;
        this.hoverIndex = -1;
        this.partners = [];
        this.manifest = null;

        this.selectPlayer = null;
        this.charRefPlayer = null;
        this.iconPlayers = [];
        this.charPlayers = {};

        this.voice = new VoiceManager();
        this.partnerLevel = 7;
        this.showEffects = true;
        this.meetingTimer = 0;
        this.transitionFrame = 0;
        this.transitionDuration = 0;
        this.debugOutlines = false;

        this.lastTs = 0;
        this.accum = 0;
        this.dpr = 1;
        this.viewW = 1;
        this.viewH = 1;

        this._onMouseMove = this._onMouseMove.bind(this);
        this._onClick = this._onClick.bind(this);
        this._onResize = this._onResize.bind(this);
        this._onKeyDown = this._onKeyDown.bind(this);

        this.canvas.addEventListener('mousemove', this._onMouseMove);
        this.canvas.addEventListener('click', this._onClick);
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('resize', this._onResize);
        this._onResize();
    }

    _onResize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.canvas.width = window.innerWidth * dpr;
        this.canvas.height = window.innerHeight * dpr;
        this.canvas.style.width = window.innerWidth + 'px';
        this.canvas.style.height = window.innerHeight + 'px';
        this.dpr = dpr;
        this.viewW = window.innerWidth;
        this.viewH = window.innerHeight;
    }

    _sceneTransform() {
        const s = Math.min(this.viewW, this.viewH) / SCENE_SIZE;
        const tx = (this.viewW - SCENE_SIZE * s) / 2;
        const ty = (this.viewH - SCENE_SIZE * s) / 2;
        return { tx: tx * this.dpr, ty: ty * this.dpr, scale: s * this.dpr };
    }

    _clientToScene(cx, cy) {
        const t = this._sceneTransform();
        return {
            x: (cx * this.dpr - t.tx) / t.scale,
            y: (cy * this.dpr - t.ty) / t.scale,
        };
    }

    _hitTestIcons(sx, sy) {
        const layout = this.manifest.layout;
        const ox = layout.topPos[0] + layout.underNulPos[0];
        const oy = layout.topPos[1] + layout.underNulPos[1];
        const r = layout.iconSize * 0.5;
        for (let i = 0; i < layout.iconSlots.length; i++) {
            const slot = layout.iconSlots[i];
            const dx = sx - (ox + slot.x);
            const dy = sy - (oy + slot.y);
            if (dx * dx + dy * dy < r * r) return i;
        }
        return -1;
    }

    _hitTestCharacter(cx, cy) {
        const t = this._charTransform();
        const name = this.partners[this.selectedIndex];
        const c = this.charCenters[name] || { x: 540, y: 540, bw: 600, bh: 1000 };
        const px = (cx * this.dpr - t.tx) / t.scale;
        const py = (cy * this.dpr - t.ty) / t.scale;
        const hw = (c.bw || 600) * 0.55, hh = (c.bh || 1000) * 0.55;
        return px > c.x - hw && px < c.x + hw && py > c.y - hh && py < c.y + hh;
    }

    _onMouseMove(e) {
        if (this.state === 'select') {
            const pt = this._clientToScene(e.clientX, e.clientY);
            const hit = this._hitTestIcons(pt.x, pt.y);
            this.canvas.style.cursor = hit >= 0 ? 'pointer' : 'default';
            this.hoverIndex = hit;
        } else if (this.state === 'active') {
            this.canvas.style.cursor = this._hitTestCharacter(e.clientX, e.clientY) ? 'pointer' : 'default';
        } else if (this.state === 'meeting') {
            this.canvas.style.cursor = 'pointer';
        } else {
            this.canvas.style.cursor = 'default';
        }
    }

    _onClick(e) {
        if (this.state === 'select') {
            const pt = this._clientToScene(e.clientX, e.clientY);
            const hit = this._hitTestIcons(pt.x, pt.y);
            if (hit >= 0) {
                if (hit === this.selectedIndex) this._confirmSelection();
                else this._selectIndex(hit);
            }
        } else if (this.state === 'active') {
            if (this._hitTestCharacter(e.clientX, e.clientY)) this._triggerInteraction();
        } else if (this.state === 'meeting') {
            this._endMeeting();
        }
    }

    _onKeyDown(e) {
        if (e.key === 'D') {
            this.debugOutlines = !this.debugOutlines;
            return;
        }
        if (this.state === 'select') {
            if (e.key === 'ArrowRight' || e.key === 'd') {
                this._selectIndex((this.selectedIndex + 1) % this.partners.length);
                e.preventDefault();
            } else if (e.key === 'ArrowLeft' || e.key === 'a') {
                this._selectIndex((this.selectedIndex - 1 + this.partners.length) % this.partners.length);
                e.preventDefault();
            } else if (e.key === 'Enter' || e.key === ' ') {
                this._confirmSelection();
                e.preventDefault();
            }
        } else if (this.state === 'meeting') {
            if (e.key === 'Enter' || e.key === ' ') {
                this._endMeeting();
                e.preventDefault();
            }
        } else if (this.state === 'active') {
            if (e.key === 'Escape' || e.key === 'Backspace') {
                this._returnToSelect();
                e.preventDefault();
            } else if (e.key === 'Enter' || e.key === ' ') {
                this._triggerInteraction();
                e.preventDefault();
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                this._cycleCostume(e.key === 'ArrowUp' ? -1 : 1);
                e.preventDefault();
            } else if (e.key >= '1' && e.key <= '3') {
                this._triggerMood(`Joy${e.key}`);
                e.preventDefault();
            } else if (e.key === '4') {
                this._triggerMood('Happy1');
                e.preventDefault();
            } else if (e.key === '5') {
                this._triggerMood('Sad1');
                e.preventDefault();
            } else if (e.key === '6') {
                this._triggerMood('Determination1');
                e.preventDefault();
            } else if (e.key === 'e' || e.key === 'E') {
                this.showEffects = !this.showEffects;
                this._updateDemoPanel();
                e.preventDefault();
            } else if (e.key === '+' || e.key === '=') {
                this.partnerLevel = Math.min(13, this.partnerLevel + 1);
                this._updateDemoPanel();
                e.preventDefault();
            } else if (e.key === '-') {
                this.partnerLevel = Math.max(0, this.partnerLevel - 1);
                this._updateDemoPanel();
                e.preventDefault();
            }
        }
    }

    _setIconPattern(player, charIdx) {
        const iconNode = player.nodes[8];
        if (iconNode) iconNode._patBase = charIdx;
    }

    _setCharRefPattern(charIdx) {
        for (const ni of [4, 7]) {
            const n = this.charRefPlayer.nodes[ni];
            if (n) n._patBase = charIdx;
        }
    }

    _selectIndex(idx) {
        if (idx === this.selectedIndex) return;
        const prev = this.selectedIndex;
        this.prevIndex = prev;
        this.selectedIndex = idx;

        if (this.selectPlayer) {
            this.selectPlayer.play('Character_Change', { loop: false });
        }
        this._setCharRefPattern(idx);

        if (prev >= 0 && prev < this.iconPlayers.length) {
            const oldIcon = this.iconPlayers[prev];
            oldIcon.clearAll();
            oldIcon.play('Loop_Unselected', { loop: true, hold: true });
        }
        if (idx >= 0 && idx < this.iconPlayers.length) {
            const newIcon = this.iconPlayers[idx];
            newIcon.clearAll();
            newIcon.play('Loop_Selected', { loop: true });
        }
    }

    _confirmSelection() {
        if (this.state !== 'select') return;
        this.state = 'select_fadeout';
        this.transitionFrame = 0;
        this.transitionDuration = 70;

        this.selectPlayer.play('Fade_Out', { loop: false });
        if (this.charRefPlayer) this.charRefPlayer.play('Fade_Out', { loop: false });
        if (this.selectedIndex >= 0 && this.selectedIndex < this.iconPlayers.length) {
            this.iconPlayers[this.selectedIndex].play('Action', { loop: false });
        }
    }

    _enterMeeting() {
        this.state = 'meeting';
        this.meetingTimer = 0;

        const name = this.partners[this.selectedIndex];
        const player = this.charPlayers[name];
        if (!player) return;
        player.clearAll();
        player.baseAnims = [];
        if (player.scene.animations['Change_Fashion']) {
            player.baseAnims.push({ name: 'Change_Fashion', frame: 0 });
        }
        if (player.scene.animations['Change_Position']) {
            player.baseAnims.push({ name: 'Change_Position', frame: 0 });
        }
        player.resetNodes();
        for (const b of player.baseAnims) player.applyAnim(b.name, b.frame, false);
        player.play('FadeIn1', { loop: false, hold: true });
        player.play('Action_Wait1', { loop: true });
        player.play('Mouth_Wait1', { loop: true });
        this.voice.play(name, 'meeting');
    }

    _hideEffectNodes(player) {
        const fx = player.scene.animations['Effect_Heart1'];
        if (!fx) return;
        for (const mot of fx.m) {
            for (const trk of mot.tr) {
                if (trk.p === 11) {
                    const n = player.nodes[mot.n];
                    if (n && n.v === 1) n.v = 0;
                }
            }
        }
    }

    _patchAlphaDefaults(player) {
        const cf = player.scene.animations['Change_Fashion'];
        if (!cf) return;
        for (const mot of cf.m) {
            for (const trk of mot.tr) {
                if (trk.p === 24 && trk.k.length && trk.k.every(k => k[1] === 0)) {
                    const n = player.nodes[mot.n];
                    if (n) n.a = 0;
                }
            }
        }
    }

    _attachRawNames(player, names) {
        if (!player || !Array.isArray(player.nodes) || !Array.isArray(names)) return;
        const n = Math.min(player.nodes.length, names.length);
        for (let i = 0; i < n; i++) {
            player.nodes[i]._name = names[i] || '';
        }
    }

    _patchMilkEffectAnims(player) {
        const happy = player.scene.animations['Action_Happy1'];
        if (happy && !happy.m.some(m => m.n === 291)) {
            happy.m.push({ n: 291, tr: [{ p: 24, t: 0, k: [[0, 0]] }] });
        }
    }

    _patchMilkThirdLeg(player) {
        if (!player || !Array.isArray(player.nodes)) return;
        for (const node of player.nodes) {
            const name = node._name || '';
            if (name === 'Leg_R_2_Under' || name === 'Leg_L_2_Under' || name === '02_Leg_L_2_Under') {
                node.v = 0;
            }
        }
    }

    _enforceMilkLegMask(player) {
        if (!player || !Array.isArray(player.nodes)) return;
        const forcedHiddenIndices = [60, 142];
        for (const idx of forcedHiddenIndices) {
            const n = player.nodes[idx];
            if (n) n._hidden = true;
        }
        for (const node of player.nodes) {
            const name = node._name || '';
            if (name === 'Leg_R_2_Under' || name === 'Leg_L_2_Under' || name === '02_Leg_L_2_Under') {
                node._hidden = true;
            }
        }
    }

    _endMeeting() {
        if (this.state !== 'meeting') return;
        this.state = 'active';
        this.voice.stop(100);
        this.voice.stopSE(100);
        const name = this.partners[this.selectedIndex];
        const player = this.charPlayers[name];
        if (player) player.clearByPrefix('Mouth_');
    }

    _clearReactionAnims(player) {
        for (const p of ['Action_Joy', 'Action_Touch', 'Action_Happy',
                         'Action_Sad', 'Action_Determination',
                         'Mouth_Joy', 'Mouth_Touch', 'Mouth_Happy',
                         'Mouth_Sad', 'Mouth_Determination', 'Effect_Heart'])
            player.clearByPrefix(p);
    }

    _triggerInteraction() {
        const name = this.partners[this.selectedIndex];
        const player = this.charPlayers[name];
        if (!player) return;
        this._clearReactionAnims(player);
        const idx = Math.floor(Math.random() * 2) + 1;
        const anims = [`Action_Touch${idx}`, `Mouth_Touch${idx}`];
        if (this.showEffects) anims.push('Effect_Heart1');
        for (const a of anims) if (player.scene.animations[a]) player.play(a, { loop: false });
        this.voice.play(name, 'touch');
    }

    _triggerMood(name) {
        if (this.state !== 'active') return;
        const charName = this.partners[this.selectedIndex];
        const player = this.charPlayers[charName];
        if (!player) return;
        this._clearReactionAnims(player);
        const anims = [`Action_${name}`, `Mouth_${name}`];
        if (this.showEffects) anims.push('Effect_Heart1');
        for (const a of anims) if (player.scene.animations[a]) player.play(a, { loop: false });
        this.voice.playLevel(charName, this.partnerLevel);
    }

    _returnToSelect() {
        this.voice.stopAll(200);
        this.state = 'active_to_select';
        this.transitionFrame = 0;
        this.transitionDuration = 20;
    }

    _cycleCostume(dir) {
        const name = this.partners[this.selectedIndex];
        const player = this.charPlayers[name];
        if (!player) return;
        const cfAnim = player.scene.animations['Change_Fashion'];
        if (!cfAnim) return;
        const maxFrame = cfAnim.d - 1;
        const cfEntry = player.baseAnims.find(b => b.name === 'Change_Fashion');
        if (!cfEntry) return;
        cfEntry.frame = ((cfEntry.frame + dir) % (maxFrame + 1) + (maxFrame + 1)) % (maxFrame + 1);
    }

    _charTransform() {
        const name = this.partners[this.selectedIndex];
        const m = this.charMetrics[name];
        if (!m) return { tx: 0, ty: 0, scale: this.dpr };
        const availH = this.viewH - HUD_TOP_H - HUD_BOTTOM_H;
        const bodyPx = (m.bodyCm / this.maxEffCm) * availH;
        let s = bodyPx / m.bodyH;
        if (m.bw > 0) s = Math.min(s, this.viewW * 0.95 / m.bw);
        const feetY = this.viewH - HUD_BOTTOM_H;
        const ty = feetY - m.feetY * s;
        const tx = this.viewW * 0.5 - m.centerX * s;
        return { tx: tx * this.dpr, ty: ty * this.dpr, scale: s * this.dpr };
    }

    _computeAnimatedCenter(player) {
        const rects = [];
        const walk = (idx, ma, mb, mc, md, mtx, mty, parentHidden) => {
            const n = player.nodes[idx];
            if (!n) return;
            const hidden = n._hidden || parentHidden;
            if (hidden) return;
            const a = n._a ?? n.a;
            if (a < 0.01) return;
            const lx = n._x ?? n.x, ly = n._y ?? n.y;
            const lsx = n._sx ?? n.sx, lsy = n._sy ?? n.sy;
            const lr = n._r ?? n.r ?? 0;
            let na = ma, nb = mb, nc = mc, nd = md;
            let ntx = mtx + ma * lx + mc * ly;
            let nty = mty + mb * lx + md * ly;
            if (lr) {
                const cos = Math.cos(lr), sin = Math.sin(lr);
                const ta = na * cos + nc * sin;
                const tb = nb * cos + nd * sin;
                const tc = nc * cos - na * sin;
                const td = nd * cos - nb * sin;
                na = ta; nb = tb; nc = tc; nd = td;
            }
            na *= lsx; nb *= lsx;
            nc *= lsy; nd *= lsy;
            if (n.s && n.s.w * n.s.h > 5000) {
                const corners = [
                    [-n.s.px, -n.s.py],
                    [n.s.w - n.s.px, -n.s.py],
                    [n.s.w - n.s.px, n.s.h - n.s.py],
                    [-n.s.px, n.s.h - n.s.py],
                ];
                let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
                for (const [cx, cy] of corners) {
                    const px = ntx + na * cx + nc * cy;
                    const py = nty + nb * cx + nd * cy;
                    x0 = Math.min(x0, px); x1 = Math.max(x1, px);
                    y0 = Math.min(y0, py); y1 = Math.max(y1, py);
                }
                const area = (x1 - x0) * (y1 - y0);
                rects.push({ x: (x0 + x1) * 0.5, y: (y0 + y1) * 0.5, w: x1 - x0, h: y1 - y0, area });
            }
            for (const ci of (n.ch || [])) walk(ci, na, nb, nc, nd, ntx, nty, hidden);
        };
        walk(0, 1, 0, 0, 1, 0, 0, false);
        if (!rects.length) return { x: 540, y: 540, bw: 1080, bh: 1080 };
        rects.sort((a, b) => b.area - a.area);
        let totalArea = 0;
        for (const r of rects) totalArea += r.area;
        const threshold = totalArea * 0.8;
        let cum = 0;
        const body = [];
        for (const r of rects) {
            body.push(r);
            cum += r.area;
            if (cum >= threshold) break;
        }
        let bodyArea = 0, sumX = 0, sumY = 0;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const r of body) {
            bodyArea += r.area;
            sumX += r.x * r.area;
            sumY += r.y * r.area;
        }
        for (const r of rects) {
            minX = Math.min(minX, r.x - r.w * 0.5);
            maxX = Math.max(maxX, r.x + r.w * 0.5);
            minY = Math.min(minY, r.y - r.h * 0.5);
            maxY = Math.max(maxY, r.y + r.h * 0.5);
        }
        return {
            x: sumX / bodyArea,
            y: sumY / bodyArea,
            bw: maxX - minX,
            bh: maxY - minY,
            minX, maxX, minY, maxY,
        };
    }

    async init() {
        const r = await fetch('assets/manifest.json');
        this.manifest = await r.json();
        this.partners = this.manifest.partners;

        const progress = document.getElementById('progress');
        const total = 3 + this.partners.length;
        let loaded = 0;
        const updateProgress = (label) => {
            loaded++;
            if (progress) progress.textContent = `Loading ${label}... (${loaded}/${total})`;
        };

        this.selectPlayer = await loadScene(this.manifest.scenes.select);
        for (let i = 0; i < 6; i++) {
            const mn = this.selectPlayer.nodes[59 + i];
            if (mn) { mn.sx = 0.8; mn.sy = 0.8; }
        }
        updateProgress('select scene');

        this.charRefPlayer = await loadScene(this.manifest.scenes.select_char);
        this.charRefPlayer.enableNameClip = false;
        this.charRefPlayer.cropTrimRights = new Map();
        const selectRawNames = await loadRawNodeNamesByCandidates([
            '/data_out/scenes/MM_UI_CharacterSelect__Reference_Character.json',
            '../data_out/scenes/MM_UI_CharacterSelect__Reference_Character.json',
            'data_out/scenes/MM_UI_CharacterSelect__Reference_Character.json',
        ]);
        this._attachRawNames(this.charRefPlayer, selectRawNames);
        updateProgress('char reference');

        const iconScenePath = this.manifest.scenes.select_icon;
        for (let i = 0; i < 6; i++) {
            const ip = await loadScene(iconScenePath);
            this._setIconPattern(ip, i);
            this.iconPlayers.push(ip);
        }
        updateProgress('icons');

        for (const name of this.partners) {
            this.charPlayers[name] = await loadScene(this.manifest.scenes[name]);
            if (name === 'milk') {
                const milkRawNames = await loadRawNodeNamesByCandidates([
                    '/data_out/scenes/MM_CH_Milk__Milk_00.json',
                    '../data_out/scenes/MM_CH_Milk__Milk_00.json',
                    'data_out/scenes/MM_CH_Milk__Milk_00.json',
                ]);
                this._attachRawNames(this.charPlayers[name], milkRawNames);
                this._patchMilkThirdLeg(this.charPlayers[name]);
            }
            updateProgress(name);
        }

        await this.voice.init('assets/voice/manifest.json');
        await this.voice.preloadAll(this.partners);

        this.charCenters = {};
        for (const name of this.partners) {
            const p = this.charPlayers[name];
            this._patchAlphaDefaults(p);
            this._hideEffectNodes(p);
            if (name === 'milk') this._patchMilkEffectAnims(p);

            const cfAnim = p.scene.animations['Change_Fashion'];
            const numFashions = cfAnim ? Math.max(1, cfAnim.d) : 1;
            let envMinX = Infinity, envMaxX = -Infinity;
            let envMinY = Infinity, envMaxY = -Infinity;
            let defaultBB = null;

            for (let f = 0; f < numFashions; f++) {
                p.resetNodes();
                if (cfAnim) p.applyAnim('Change_Fashion', f, false);
                if (p.scene.animations['Change_Position']) p.applyAnim('Change_Position', 0, false);
                if (name === 'milk') this._enforceMilkLegMask(p);
                const bb = this._computeAnimatedCenter(p);
                if (f === 0) defaultBB = bb;
                envMinX = Math.min(envMinX, bb.minX);
                envMaxX = Math.max(envMaxX, bb.maxX);
                envMinY = Math.min(envMinY, bb.minY);
                envMaxY = Math.max(envMaxY, bb.maxY);
            }

            this.charCenters[name] = {
                ...defaultBB,
                envMinX, envMaxX, envMinY, envMaxY,
                envW: envMaxX - envMinX,
                envH: envMaxY - envMinY,
            };
        }

        this.charMetrics = {};
        let maxEffCm = 0;
        for (const name of this.partners) {
            const c = this.charCenters[name];
            const bodyCm = CHAR_HEIGHT_CM[name] || 155;
            const bodyFrac = CHAR_BODY_FRAC[name] || 0.85;
            const envH = c.envH;
            const bodyH = envH * bodyFrac;
            const effCm = bodyCm / bodyFrac;
            this.charMetrics[name] = {
                centerX: c.x, feetY: c.envMaxY, bodyH, bodyCm, effCm, bw: c.envW,
            };
            if (effCm > maxEffCm) maxEffCm = effCm;
        }
        this.maxEffCm = maxEffCm;

        this._mountSubscenes();

        const defaultIdx = this.partners.indexOf('salt');
        this.selectedIndex = defaultIdx >= 0 ? defaultIdx : 0;
        this.prevIndex = this.selectedIndex;

        this._setCharRefPattern(this.selectedIndex);

        this._initSelectAnims();
        this._createDemoPanel();

        this.state = 'select';
        if (progress) progress.remove();

        this.lastTs = performance.now();
        requestAnimationFrame(ts => this.loop(ts));
    }

    _mountSubscenes() {
        this.selectPlayer.mount(52, (ctx, alpha) => {
            this.charRefPlayer.drawNode(ctx, 0, alpha);
        });

        for (let i = 0; i < 6; i++) {
            const nodeIdx = 59 + i;
            const ip = this.iconPlayers[i];
            this.selectPlayer.mount(nodeIdx, (ctx, alpha) => {
                ip.drawNode(ctx, 0, alpha);
            });
        }
    }

    _initSelectAnims() {
        this.selectPlayer.clearAll();
        this.selectPlayer.play('Fade_In', { loop: false });
        this.selectPlayer.play('Loop', { loop: true });

        this.charRefPlayer.clearAll();
        this.charRefPlayer.play('Fade_In', { loop: false, hold: true });
        this.charRefPlayer.play('Loop', { loop: true });

        for (let i = 0; i < this.iconPlayers.length; i++) {
            const ip = this.iconPlayers[i];
            ip.clearAll();
            ip.play(i === this.selectedIndex ? 'Loop_Selected' : 'Loop_Unselected',
                     { loop: true, hold: true });
        }
    }

    tick() {
        const charName = this.partners[this.selectedIndex];
        const charPlayer = charName ? this.charPlayers[charName] : null;

        if (this.state === 'select') {
            this.selectPlayer.tick();
            this.charRefPlayer.tick();
            for (const ip of this.iconPlayers) ip.tick();
        } else if (this.state === 'select_fadeout') {
            this.selectPlayer.tick();
            this.charRefPlayer.tick();
            for (const ip of this.iconPlayers) ip.tick();
            this.transitionFrame++;
            if (this.transitionFrame >= this.transitionDuration) {
                this._enterMeeting();
            }
        } else if (this.state === 'meeting') {
            if (charPlayer) {
                charPlayer.tick();
                if (charName === 'milk') this._enforceMilkLegMask(charPlayer);
            }
            this.meetingTimer++;
            if (this.meetingTimer >= 240) this._endMeeting();
        } else if (this.state === 'meeting_to_active') {
            if (charPlayer) {
                charPlayer.tick();
                if (charName === 'milk') this._enforceMilkLegMask(charPlayer);
            }
            this.transitionFrame++;
            if (this.transitionFrame >= this.transitionDuration) {
                this.state = 'active';
                if (charPlayer) charPlayer.clearByPrefix('Mouth_');
            }
        } else if (this.state === 'active') {
            if (charPlayer) {
                charPlayer.tick();
                if (charName === 'milk') this._enforceMilkLegMask(charPlayer);
            }
        } else if (this.state === 'active_to_select') {
            if (charPlayer) {
                charPlayer.tick();
                if (charName === 'milk') this._enforceMilkLegMask(charPlayer);
            }
            this.transitionFrame++;
            if (this.transitionFrame >= this.transitionDuration) {
                this.state = 'select';
                this._initSelectAnims();
            }
        }
    }

    _drawCharacter(transform, alpha) {
        const name = this.partners[this.selectedIndex];
        const player = this.charPlayers[name];
        if (!player) return;

        player._debug = this.debugOutlines;
        this.ctx.save();
        this.ctx.globalAlpha = alpha;
        this.ctx.translate(transform.tx, transform.ty);
        this.ctx.scale(transform.scale, transform.scale);
        player.drawNode(this.ctx, 0, 1);
        this.ctx.restore();
    }

    render() {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';

        if (this.state === 'loading') return;

        this.selectPlayer._debug = this.debugOutlines;
        this.charRefPlayer._debug = this.debugOutlines;
        for (const ip of this.iconPlayers) ip._debug = this.debugOutlines;

        if (this.state === 'select') {
            const t = this._sceneTransform();
            this.selectPlayer.render(this.ctx, t.tx, t.ty, t.scale);
            this._drawSelectHUD();
        } else if (this.state === 'select_fadeout') {
            const t = this._sceneTransform();
            this.selectPlayer.render(this.ctx, t.tx, t.ty, t.scale);
        } else if (this.state === 'meeting') {
            const t = this._charTransform();
            this._drawCharacter(t, 1);
            this._drawMeetingHUD();
        } else if (this.state === 'meeting_to_active') {
            const t = this._charTransform();
            this._drawCharacter(t, 1);
        } else if (this.state === 'active') {
            const t = this._charTransform();
            this._drawCharacter(t, 1);
            this._drawActiveHUD();
        } else if (this.state === 'active_to_select') {
            const progress = this.transitionFrame / this.transitionDuration;
            if (progress <= 0.5) {
                const t = this._charTransform();
                this._drawCharacter(t, Math.max(0, 1 - progress * 2));
            } else {
                const fadeIn = (progress - 0.5) * 2;
                const st = this._sceneTransform();
                this.ctx.save();
                this.ctx.globalAlpha = fadeIn;
                this.selectPlayer.render(this.ctx, st.tx, st.ty, st.scale);
                this.ctx.restore();
            }
        }
    }

    _drawSelectHUD() {
        const name = this.partners[this.selectedIndex];
        const displayName = name.charAt(0).toUpperCase() + name.slice(1);

        this.ctx.save();
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

        this.ctx.fillStyle = 'rgba(0,0,0,0.4)';
        this.ctx.fillRect(0, this.viewH - 48, this.viewW, 48);

        this.ctx.font = '600 18px "Segoe UI", sans-serif';
        this.ctx.fillStyle = '#FFD700';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText(`Partner: ${displayName}`, this.viewW / 2, this.viewH - 32);

        this.ctx.font = '13px "Segoe UI", sans-serif';
        this.ctx.fillStyle = 'rgba(255,255,255,0.6)';
        this.ctx.fillText('Click again to confirm \u00b7 \u2190\u2192 to navigate', this.viewW / 2, this.viewH - 12);

        this.ctx.restore();
    }

    _drawMeetingHUD() {
        this.ctx.save();
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.ctx.font = '13px "Segoe UI", sans-serif';
        this.ctx.fillStyle = 'rgba(255,255,255,0.4)';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'bottom';
        this.ctx.fillText('Click or press Enter to continue', this.viewW / 2, this.viewH - 16);
        this.ctx.restore();
    }

    _drawActiveHUD() {
        const name = this.partners[this.selectedIndex];
        const displayName = name.charAt(0).toUpperCase() + name.slice(1);

        this.ctx.save();
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

        this.ctx.fillStyle = 'rgba(0,0,0,0.3)';
        this.ctx.fillRect(0, 0, this.viewW, 40);

        this.ctx.font = '600 16px "Segoe UI", sans-serif';
        this.ctx.fillStyle = '#FFD700';
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText(`Partner: ${displayName}`, 16, 20);

        this.ctx.font = '13px "Segoe UI", sans-serif';
        this.ctx.fillStyle = 'rgba(255,255,255,0.5)';
        this.ctx.textAlign = 'right';
        this.ctx.fillText('Click/Enter: Touch \u00b7 1-3: Joy \u00b7 4: Happy \u00b7 5: Sad \u00b7 6: Determ. \u00b7 +/-: Level \u00b7 E: FX \u00b7 \u2191\u2193: Costume \u00b7 Esc: Back', this.viewW - 16, 20);

        this.ctx.restore();
    }

    _createDemoPanel() {
        const panel = document.createElement('div');
        panel.id = 'demo-panel';
        panel.style.cssText = 'position:fixed;bottom:56px;right:12px;display:none;flex-direction:column;gap:4px;z-index:20;pointer-events:auto;';

        const mkBtn = (label, onclick, id) => {
            const b = document.createElement('button');
            b.textContent = label;
            if (id) b.id = id;
            b.style.cssText = 'padding:4px 10px;border:none;border-radius:4px;background:rgba(255,255,255,0.15);color:#fff;font:600 12px "Segoe UI",sans-serif;cursor:pointer;backdrop-filter:blur(4px);';
            b.addEventListener('mouseenter', () => b.style.background = 'rgba(255,255,255,0.3)');
            b.addEventListener('mouseleave', () => b.style.background = 'rgba(255,255,255,0.15)');
            b.addEventListener('click', (e) => { e.stopPropagation(); onclick(); });
            return b;
        };

        const row = (children) => {
            const r = document.createElement('div');
            r.style.cssText = 'display:flex;gap:4px;justify-content:flex-end;align-items:center;';
            for (const c of children) r.appendChild(c);
            return r;
        };

        const lvLabel = document.createElement('span');
        lvLabel.id = 'demo-lv-label';
        lvLabel.style.cssText = 'color:#FFD700;font:600 12px "Segoe UI",sans-serif;min-width:40px;text-align:center;';
        lvLabel.textContent = `Lv.${this.partnerLevel}`;

        panel.appendChild(row([
            mkBtn('-', () => { this.partnerLevel = Math.max(0, this.partnerLevel - 1); this._updateDemoPanel(); }),
            lvLabel,
            mkBtn('+', () => { this.partnerLevel = Math.min(13, this.partnerLevel + 1); this._updateDemoPanel(); }),
            mkBtn('Play Level', () => this._triggerLevelAnim(), 'demo-play-lv'),
        ]));
        panel.appendChild(row([
            mkBtn('FX: ON', () => { this.showEffects = !this.showEffects; this._updateDemoPanel(); }, 'demo-effect-btn'),
        ]));
        panel.appendChild(row([1,2,3].map(n => mkBtn(`Joy ${n}`, () => this._triggerMood(`Joy${n}`)))));
        panel.appendChild(row([
            mkBtn('Happy', () => this._triggerMood('Happy1')),
            mkBtn('Sad', () => this._triggerMood('Sad1')),
            mkBtn('Determ.', () => this._triggerMood('Determination1')),
        ]));

        document.body.appendChild(panel);
        this._demoPanel = panel;
    }

    _triggerLevelAnim() {
        const anim = LEVEL_ANIM[this.partnerLevel];
        if (anim) this._triggerMood(anim);
    }

    _updateDemoPanel() {
        const fx = document.getElementById('demo-effect-btn');
        if (fx) fx.textContent = `FX: ${this.showEffects ? 'ON' : 'OFF'}`;
        const lv = document.getElementById('demo-lv-label');
        if (lv) lv.textContent = `Lv.${this.partnerLevel}`;
    }

    _syncDemoPanelVisibility() {
        if (!this._demoPanel) return;
        this._demoPanel.style.display = this.state === 'active' ? 'flex' : 'none';
    }

    loop(ts) {
        requestAnimationFrame(ts2 => this.loop(ts2));
        const dt = Math.min(ts - this.lastTs, 100);
        this.lastTs = ts;
        this.accum += dt;

        while (this.accum >= FRAME_MS) {
            this.tick();
            this.accum -= FRAME_MS;
        }
        this.render();
        this._syncDemoPanelVisibility();
    }
}




const app = new PartnerApp();
app.init().catch(err => {
    console.error(err);
    const el = document.getElementById('progress');
    if (el) el.textContent = 'Error: ' + err.message;
});

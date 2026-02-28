'use strict';

const SCALE = 3;
const FPS = 60;
const FRAME_MS = 1000 / FPS;

let canvas, ctx, data, texImg;
let frame = 0;
let lastTime = 0;
let accum = 0;

function lerp(a, b, t) { return a + (b - a) * t; }

function evalTrack(track, f) {
    const keys = track.k;
    if (!keys.length) return undefined;
    if (keys.length === 1) return keys[0][1];
    if (f <= keys[0][0]) return keys[0][1];
    if (f >= keys[keys.length - 1][0]) return keys[keys.length - 1][1];

    const interp = track.t & 0xF;
    for (let i = 0; i < keys.length - 1; i++) {
        const k0 = keys[i], k1 = keys[i + 1];
        if (f >= k0[0] && f < k1[0]) {
            if (interp === 0) return k0[1];
            const span = k1[0] - k0[0];
            if (span <= 0) return k0[1];
            const t = (f - k0[0]) / span;
            if (interp === 3) {
                if (k0.length >= 5 && k1.length >= 5) {
                    const p0 = k0[1], p1 = k1[1];
                    const m0 = k0[4] * span, m1 = k1[3] * span;
                    const t2 = t * t, t3 = t2 * t;
                    return (2*t3 - 3*t2 + 1)*p0 + (t3 - 2*t2 + t)*m0 + (-2*t3 + 3*t2)*p1 + (t3 - t2)*m1;
                }
                const s = t * t * (3 - 2 * t);
                return k0[1] + (k1[1] - k0[1]) * s;
            }
            return lerp(k0[1], k1[1], t);
        }
    }
    return keys[keys.length - 1][1];
}

function resetNodes() {
    for (const n of data.nodes) {
        n._x = n.x;
        n._y = n.y;
        n._r = -(n.r * Math.PI / 32768);
        n._sx = n.sx;
        n._sy = n.sy;
        n._pat = 0;
        n._a = n.v ? n.a : 0;
    }
}

function applyTrack(node, trk, f) {
    const v = evalTrack(trk, f);
    if (v === undefined) return;
    switch (trk.p) {
        case 0: node._x = v; break;
        case 1: node._y = v; break;
        case 5: node._r = -(v * Math.PI / 32768); break;
        case 6: node._sx = v; break;
        case 7: node._sy = v; break;
        case 18: node._pat = v; break;
        case 24: node._a = v; break;
    }
}

function applyAnim(anim, f, useLoop) {
    if (!anim) return;
    for (const mot of anim.m) {
        const node = data.nodes[mot.n];
        if (!node) continue;
        const mf = (useLoop && mot._period) ? f % mot._period : f;
        for (const trk of mot.tr) applyTrack(node, trk, mf);
    }
}

function drawNode(idx, parentAlpha) {
    const node = data.nodes[idx];
    if (!node) return;

    const alpha = Math.max(0, Math.min(1, node._a)) * parentAlpha;

    ctx.save();
    ctx.translate(node._x, node._y);
    if (node._r) ctx.rotate(node._r);
    if (node._sx !== 1 || node._sy !== 1) ctx.scale(node._sx, node._sy);

    if (node.s && alpha > 0.003 && texImg) {
        const spr = node.s;
        let ci = spr.ci + Math.round(node._pat || 0);
        if (ci < 0 || ci >= data.texture.crops.length) ci = spr.ci;
        const crop = data.texture.crops[ci];
        if (crop) {
            const sx = crop[0], sy = crop[1];
            const sw = crop[2] - crop[0], sh = crop[3] - crop[1];
            if (sw > 0 && sh > 0) {
                ctx.globalAlpha = alpha;
                if (spr.fx) {
                    ctx.scale(-1, 1);
                    ctx.drawImage(texImg, sx, sy, sw, sh,
                        spr.px - spr.w, -spr.py, spr.w, spr.h);
                    ctx.scale(-1, 1);
                } else {
                    ctx.drawImage(texImg, sx, sy, sw, sh,
                        -spr.px, -spr.py, spr.w, spr.h);
                }
            }
        }
    }

    for (const ci of node.ch) {
        drawNode(ci, alpha);
    }
    ctx.restore();
}

function tick() {
    resetNodes();
    applyAnim(data.animations.AdvertiseLoop, frame, true);
    frame++;
}

function render() {
    const dpr = window.devicePixelRatio || 1;
    const viewW = 480;
    const viewH = 160;
    const cw = viewW * SCALE;
    const ch = viewH * SCALE;

    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
        canvas.width = cw * dpr;
        canvas.height = ch * dpr;
        canvas.style.width = cw + 'px';
        canvas.style.height = ch + 'px';
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.save();
    ctx.scale(dpr * SCALE, dpr * SCALE);
    // Characters span X:-130..180, Y:420..535 in scene coords
    ctx.translate(viewW / 2 - 25, viewH / 2 - 478);
    drawNode(0, 1);
    ctx.restore();
}

function loop(ts) {
    requestAnimationFrame(loop);
    const dt = Math.min(ts - lastTime, 100);
    lastTime = ts;
    accum += dt;

    while (accum >= FRAME_MS) {
        tick();
        accum -= FRAME_MS;
    }
    render();
}

async function init() {
    canvas = document.getElementById('c');
    ctx = canvas.getContext('2d');

    const resp = await fetch('sd_data_hd.json');
    data = await resp.json();

    texImg = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = data.texFile;
    });

    for (const anim of Object.values(data.animations)) {
        for (const mot of anim.m) {
            let maxF = 0;
            for (const trk of mot.tr)
                for (const k of trk.k)
                    if (k[0] > maxF) maxF = k[0];
            mot._period = maxF || 0;
        }
    }

    tick();
    lastTime = performance.now();
    requestAnimationFrame(loop);
}

init().catch(console.error);

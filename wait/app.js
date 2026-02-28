'use strict';

const SCALE = 2;
const FPS = 60;
const FRAME_MS = 1000 / FPS;
const VIEW_W = 340;
const VIEW_H = 400;
const VIEW_CX = 154;
const VIEW_CY = 600;

let CROPS = [];
let NODES = [];
let H = 3;
let ANIM_FADEIN = null;
let ANIM_ACTION = null;

let canvas, ctx, texImg;
let lastTime = 0;
let accum = 0;
let state = 'fadein';
let fadeFrame = 0;
let actionFrame = 0;

function evalTrack(track, f) {
    const keys = track.k;
    if (!keys.length) return undefined;
    if (keys.length === 1) return keys[0][1];
    if (f <= keys[0][0]) return keys[0][1];
    if (f >= keys[keys.length - 1][0]) return keys[keys.length - 1][1];

    for (let i = 0; i < keys.length - 1; i++) {
        const k0 = keys[i], k1 = keys[i + 1];
        if (f >= k0[0] && f < k1[0]) {
            const span = k1[0] - k0[0];
            if (span <= 0) return k0[1];
            const t = (f - k0[0]) / span;
            const s = t * t * (3 - 2 * t);
            return k0[1] + (k1[1] - k0[1]) * s;
        }
    }
    return keys[keys.length - 1][1];
}

function resetNodes() {
    for (const n of NODES) {
        n._x = n.x;
        n._y = n.y;
        n._r = -(n.r * Math.PI / 32768);
        n._sx = n.sx;
        n._sy = n.sy;
        n._a = n.a;
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
        case 24: node._a = v; break;
    }
}

function applyAnim(anim, f, useLoop) {
    for (const mot of anim.m) {
        const node = NODES[mot.n];
        if (!node) continue;
        const mf = (useLoop && mot._period) ? f % mot._period : f;
        for (const trk of mot.tr) applyTrack(node, trk, mf);
    }
}

function drawNode(idx, parentAlpha) {
    const node = NODES[idx];
    if (!node) return;

    const alpha = Math.max(0, Math.min(1, node._a)) * parentAlpha;

    ctx.save();
    ctx.translate(node._x, node._y);
    if (node._r) ctx.rotate(node._r);
    if (node._sx !== 1 || node._sy !== 1) ctx.scale(node._sx, node._sy);

    if (node.s && alpha > 0.003) {
        const spr = node.s;
        const crop = CROPS[spr.ci];
        const sw = crop[2] - crop[0], sh = crop[3] - crop[1];
        ctx.globalAlpha = alpha;
        if (spr.fx) {
            ctx.save();
            ctx.scale(-1, 1);
            ctx.drawImage(texImg, crop[0], crop[1], sw, sh,
                spr.px - spr.w, -spr.py, spr.w, spr.h);
            ctx.restore();
        } else {
            ctx.drawImage(texImg, crop[0], crop[1], sw, sh,
                -spr.px, -spr.py, spr.w, spr.h);
        }
    }

    for (const ci of node.ch) drawNode(ci, alpha);
    ctx.restore();
}

function tick() {
    resetNodes();
    if (state === 'fadein') {
        applyAnim(ANIM_FADEIN, fadeFrame, false);
        fadeFrame++;
        if (fadeFrame >= ANIM_FADEIN.dur) {
            state = 'action';
            actionFrame = 0;
        }
    } else {
        applyAnim(ANIM_ACTION, actionFrame, true);
        actionFrame++;
    }
}

function render() {
    const dpr = window.devicePixelRatio || 1;
    const cw = VIEW_W * SCALE;
    const ch = VIEW_H * SCALE;

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
    ctx.translate(VIEW_W / 2 - VIEW_CX, VIEW_H / 2 - VIEW_CY);
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

    const constResp = await fetch('data.json');
    const constData = await constResp.json();
    CROPS = constData.CROPS;
    NODES = constData.NODES;
    H = constData.H;
    ANIM_FADEIN = constData.ANIM_FADEIN;
    ANIM_ACTION = constData.ANIM_ACTION;

    for (const anim of [ANIM_FADEIN, ANIM_ACTION]) {
        for (const mot of anim.m) {
            for (const trk of mot.tr) {
                trk.t = H;
            }
        }
    }

    texImg = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = 'atlas.png';
    });

    for (const anim of [ANIM_FADEIN, ANIM_ACTION]) {
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

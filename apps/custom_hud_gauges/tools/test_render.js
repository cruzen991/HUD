// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/**
 * The HUD renderer on its own: layer rectangles inside the target, updates
 * that are only what changed, a whole-picture replay equal to the
 * incremental one, dashes for missing values, the numbers right.
 *
 *   node tools/test_render.js
 */
const assert = require('assert');
const { Hud } = require('../src/hud_render.js');
const { demoSample } = require('../src/hud_demo.js');

function apply(images, frames, hud) {
    frames.forEach((fr) => {
        const L = hud.get(fr.id).layer;
        let off = 0;
        fr.rects.forEach((r) => {
            for (let y = 0; y < r.h; y++) {
                fr.pixels.copy(images[fr.id], ((r.y + y) * L.rect.w + r.x) * 4, off, off + r.w * 4);
                off += r.w * 4;
            }
        });
        assert.strictEqual(off, fr.pixels.length, 'pixels match the rects');
    });
}

[[800, 480], [353, 203], [1920, 720]].forEach(([W, H]) => {
    const hud = new Hud(W, H);
    const full = hud.full();
    const images = {};
    full.forEach((l) => {
        assert(l.rect.x >= 0 && l.rect.y >= 0 && l.rect.x + l.rect.w <= W && l.rect.y + l.rect.h <= H, `${l.id} inside ${W}x${H}`);
        assert.strictEqual(l.pixels.length, l.rect.w * l.rect.h * 4);
        images[l.id] = Buffer.from(l.pixels);
    });
    let changedPixels = 0;
    for (let i = 0; i < 40 * 10; i++) {
        const d = demoSample(i / 10);
        const frames = hud.render({ speed: d.speedKmh * 0.621371, rpm: d.rpm, boost: d.boostKpa * 0.145038, iat: d.iatC * 9 / 5 + 32 }, 1000 + i * 100);
        frames.forEach((f) => f.rects.forEach((r) => {
            assert(r.x >= 0 && r.y >= 0 && r.x + r.w <= hud.get(f.id).layer.rect.w && r.y + r.h <= hud.get(f.id).layer.rect.h, 'rect inside its layer');
            changedPixels += r.w * r.h;
        }));
        apply(images, frames, hud);
    }
    hud.layers.forEach((l) => {
        assert.strictEqual(Buffer.compare(images[l.id], Buffer.from(l.layer.raster.data)), 0, `${l.id}: incremental equals the drawn picture at ${W}x${H}`);
    });
    const whole = full.reduce((a, l) => a + l.rect.w * l.rect.h, 0);
    console.log(`ok   ${W}x${H}: rects inside, incremental == drawn; sent ${(changedPixels / (whole * 400) * 100).toFixed(1)}% of a full redraw per frame on average`);
});

/* the same bar drawn fresh and reached by steps is the same picture */
{
    const a = new Hud(800, 480);
    a.full();
    [0, 3000, 6500, 900, 5200, 0].forEach((rpm, i) => a.render({ speed: 0, rpm, boost: 0, iat: 90 }, 1000 + i * 1000));
    const b = new Hud(800, 480);
    b.full();
    b.render({ speed: 0, rpm: 0, boost: 0, iat: 90 }, 1000);
    assert.strictEqual(Buffer.compare(Buffer.from(a.get('bar').layer.raster.data), Buffer.from(b.get('bar').layer.raster.data)), 0);
    console.log('ok   the bar reached by steps equals a fresh one');
}

/* missing values are dashes, never zeros */
{
    const live = new Hud(800, 480);
    live.full();
    live.render({ speed: 0, rpm: 0, boost: 0, iat: 0 }, 1000);
    const dash = new Hud(800, 480);
    dash.full();
    dash.render({ speed: null, rpm: null, boost: null, iat: null }, 1000);
    ['bar', 'speed', 'boost', 'iat'].forEach((id) => {
        assert.notStrictEqual(Buffer.compare(Buffer.from(live.get(id).layer.raster.data), Buffer.from(dash.get(id).layer.raster.data)), 0, `${id}: zero differs from no data`);
    });
    console.log('ok   a zero reading and no reading look different');
}

/* the demo stays in a believable range */
for (let i = 0; i < 4000; i++) {
    const d = demoSample(i / 100);
    assert(d.rpm >= 700 && d.rpm <= 6900 && d.speedKmh >= 0 && d.speedKmh < 220, `rpm ${d.rpm} speed ${d.speedKmh}`);
    const psi = d.boostKpa * 0.145038;
    assert(psi >= -14.7 && psi <= 30, `boost ${psi}`);
}
console.log('ok   demo readings stay in range');
console.log('\nall render tests passed');

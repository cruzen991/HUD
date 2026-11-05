'use strict';
/**
 * Draws the HUD at a few readings into PNG files, over a dark "windshield",
 * so the layout can be judged without a car.
 *
 *   node tools/preview.js <out-dir> [WxH]
 */
const fs = require('fs');
const path = require('path');
const { Hud } = require('../src/hud_render.js');
const { encode } = require('./png.js');

const out = process.argv[2];
const size = /^(\d+)x(\d+)$/.exec(process.argv[3] || '800x480') || [null, '800', '480'];
if (!out) {
    console.error('usage: node tools/preview.js <out-dir> [WxH]');
    process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const W = Number(size[1]);
const H = Number(size[2]);

const SCENES = {
    idle: { speed: 0, rpm: 820, boost: -11.8, iat: 96 },
    cruise: { speed: 62, rpm: 1900, boost: -2.4, iat: 99 },
    pull: { speed: 74, rpm: 6420, boost: 21.4, iat: 118 },
    redline: { speed: 112, rpm: 6900, boost: 24.9, iat: 121 },
    nodata: { speed: null, rpm: null, boost: null, iat: null }
};

Object.keys(SCENES).forEach((name) => {
    const hud = new Hud(W, H);
    hud.full();
    hud.render(SCENES[name], 10000);
    const only = hud.layers.map((l) => l.id).filter((id) => id !== 'tag' || name === 'idle');
    const png = encode(hud.composite([12, 16, 22], only), W, H);
    fs.writeFileSync(path.join(out, `hud_${name}_${W}x${H}.png`), png);
    console.log(`hud_${name}_${W}x${H}.png`);
});

// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/**
 * The HUD controller against a fake cluster-render socket (tools/fake_render.js).
 *
 *   node tools/test_controller.js
 *
 * Covers: layers made on the `hud` target, hidden until the demo or a feed
 * starts; the picture the service holds equals the one the renderer drew;
 * the demo labelled DEMO and stopping by itself; a value older than staleMs
 * shown as dashes; live values hiding after liveHideMs; Stop hiding and
 * clearing; no layers on iDrive 8 or a unit without a HUD; the picture and
 * visibility coming back after the service restarts; upload bytes per second
 * of a demo run well under the shared budget.
 */
const assert = require('assert');
const { FakeRender } = require('./fake_render.js');
const { HudController } = require('../src/hud_controller.js');
const { Hud } = require('../src/hud_render.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, check) {
    const end = Date.now() + 3000;
    while (!check()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(5);
    }
}

let n = 0;
const sock = () => `/tmp/hud-fr-${process.pid}-${n++}.sock`;

function clock() {
    const c = { t: 1000000, now: () => c.t, advance: (ms) => { c.t += ms; } };
    return c;
}

async function setup(opts) {
    const srv = new FakeRender(sock(), opts && opts.server);
    await srv.listen();
    const clk = clock();
    const ctl = new HudController({ now: clk.now, config: Object.assign({ socketPath: srv.path, tickMs: 1e9 }, opts && opts.config) });
    ctl.open();
    return { srv, clk, ctl };
}

async function done(s) {
    s.ctl.close();
    await s.srv.close();
}

const IDS = ['bar', 'speed', 'boost', 'iat', 'tag'];
const picture = (srv, ctl, id) => srv.layers[ctl.refs[id]].image;
const drawn = (ctl, id) => Buffer.from(ctl.hud.get(id).layer.raster.data);
const same = (a, b) => Buffer.compare(a, b) === 0;

async function main() {
    /* ---- layers on the hud target ---- */
    let s = await setup();
    await until('ready', () => s.ctl.ready());
    await until('layers', () => s.srv.layerByTarget('hud').length === 5);
    assert.strictEqual(s.srv.layerByTarget('map').length + s.srv.layerByTarget('panel').length, 0, 'only the hud target');
    IDS.forEach((id) => {
        const m = s.srv.layers[s.ctl.refs[id]].msg;
        assert.strictEqual(m.target, 'hud');
        assert.strictEqual(m.kind, 'image');
        assert.strictEqual(m.class, 'content');
        assert.strictEqual(m.visible, 0, `${id} hidden until started`);
        assert(m.x >= 0 && m.y >= 0 && m.x + m.w <= 800 && m.y + m.h <= 480, `${id} inside 800x480`);
        assert.strictEqual(m.iw, m.w);
        assert.strictEqual(m.ih, m.h);
    });
    await until('first pictures', () => IDS.every((id) => s.srv.layers[s.ctl.refs[id]].wholes >= 1));
    assert.strictEqual(s.ctl.canStart(), true);
    assert.strictEqual(s.ctl.canStop(), false);
    assert(/Renderer id7, HUD 800x480/.test(s.ctl.detailText()), s.ctl.detailText());
    console.log('ok   five image layers on hud, class content, hidden, whole pictures sent');

    /* ---- demo ---- */
    assert.strictEqual(s.ctl.startDemo(30), true);
    await until('visible', () => IDS.every((id) => s.srv.layers[s.ctl.refs[id]].msg.visible === 1));
    assert(/^Demo, \d+ s left/.test(s.ctl.statusText()), s.ctl.statusText());
    for (let i = 0; i < 100; i++) {          /* 10 s of drive, at 10 Hz */
        s.clk.advance(100);
        s.ctl._tick();
    }
    await until('frames settle', () => {
        return IDS.every((id) => same(picture(s.srv, s.ctl, id), drawn(s.ctl, id)));
    });
    assert(!same(picture(s.srv, s.ctl, 'bar'), Buffer.alloc(picture(s.srv, s.ctl, 'bar').length)), 'the bar has something drawn');
    console.log('ok   demo: layers shown, the service picture equals the drawn one');

    /* a demo reading is never the real thing: the DEMO tag shows, and the demo ends */
    assert.strictEqual(s.srv.layers[s.ctl.refs.tag].msg.visible, 1, 'DEMO tag visible during the demo');
    s.clk.advance(25000);
    s.ctl._tick();
    assert.strictEqual(s.ctl.mode, 'off', 'the demo stops by itself');
    await until('hidden', () => IDS.every((id) => s.srv.layers[s.ctl.refs[id]].msg.visible === 0));
    console.log('ok   DEMO tag shown while demoing; demo ends by itself and hides the HUD');

    /* ---- live feed, staleness ---- */
    s.ctl.feed({ speedKmh: 100, rpm: 3000, boostKpa: 80, iatC: 40 });
    assert.strictEqual(s.ctl.mode, 'live');
    s.clk.advance(100);
    s.ctl._tick();
    await until('live visible', () => s.srv.layers[s.ctl.refs.speed].msg.visible === 1);
    assert.strictEqual(s.srv.layers[s.ctl.refs.tag].msg.visible, 0, 'no DEMO tag on a live feed');
    const fresh = new Hud(800, 480, s.ctl.hud.cfg);
    fresh.full();
    fresh.render({ speed: null, rpm: null, boost: null, iat: null }, Infinity);
    /* real values draw after a demo has ended (pacing must not be stuck) */
    s.clk.advance(1000);
    s.ctl._tick();
    await until('values drawn', () => ['bar', 'speed', 'boost'].every((id) =>
        !same(picture(s.srv, s.ctl, id), Buffer.from(fresh.get(id).layer.raster.data))));
    s.clk.advance(1000);                      /* past staleMs (1500), before liveHideMs (5000) */
    s.ctl._tick();
    await until('dashes', () => ['bar', 'speed', 'boost'].every((id) =>
        same(picture(s.srv, s.ctl, id), Buffer.from(fresh.get(id).layer.raster.data))));
    await until('iat shown', () => !same(picture(s.srv, s.ctl, 'iat'), Buffer.from(fresh.get('iat').layer.raster.data)));
    assert.strictEqual(s.srv.layers[s.ctl.refs.speed].msg.visible, 1, 'still shown, dashes only');
    s.clk.advance(9000 - 2000 + 1000);        /* 10 s since the feed: the slow one is stale too */
    s.ctl._tick();
    await until('iat dashes', () => same(picture(s.srv, s.ctl, 'iat'), Buffer.from(fresh.get('iat').layer.raster.data)));
    console.log('ok   a value older than its staleMs shows dashes, never the last reading (intake temperature counts 10 s, the rest 1.5 s)');

    s.clk.advance(100);
    s.ctl._tick();
    await until('live hides', () => s.srv.layers[s.ctl.refs.speed].msg.visible === 0);
    s.ctl.feed({ rpm: 900 });
    await until('live returns', () => s.srv.layers[s.ctl.refs.speed].msg.visible === 1);
    console.log('ok   a dead feed hides the HUD (stock HUD back), a new reading shows it again');

    /* ---- units: feed is SI, shown in mph / psi / F ---- */
    s.ctl.feed({ speedKmh: 160.934, boostKpa: 103.421, iatC: 20 });
    const d = s.ctl._display(s.clk.now());
    assert(Math.abs(d.speed - 100) < 0.01, `speed ${d.speed}`);
    assert(Math.abs(d.boost - 15) < 0.01, `boost ${d.boost}`);
    assert(Math.abs(d.iat - 68) < 0.01, `iat ${d.iat}`);
    console.log('ok   SI in, mph / psi / F out');

    /* ---- stop ---- */
    s.ctl.stop();
    await until('stop hides', () => s.srv.layers[s.ctl.refs.speed].msg.visible === 0);
    assert.strictEqual(s.ctl.canStart(), true);
    assert.strictEqual(s.ctl.canStop(), false);
    s.ctl.feed({ rpm: 1000 });                /* feed does not start a stopped controller's demo */
    s.ctl.stop();
    console.log('ok   Stop hides the HUD');

    /* ---- the service restarts ---- */
    s.ctl.startDemo(60);
    for (let i = 0; i < 40; i++) { s.clk.advance(100); s.ctl._tick(); }
    await until('settled', () => same(picture(s.srv, s.ctl, 'speed'), drawn(s.ctl, 'speed')));
    const hellos = s.srv.hellos;
    s.srv.dropClients();
    await until('reconnect', () => s.srv.hellos === hellos + 1);
    await until('layers again', () => s.srv.layerByTarget('hud').length === 5);
    await until('picture again', () => IDS.every((id) => {
        const L = s.srv.layers[s.ctl.refs[id]];
        return L && L.wholes >= 1 && same(L.image, drawn(s.ctl, id));
    }));
    IDS.forEach((id) => assert.strictEqual(s.srv.layers[s.ctl.refs[id]].msg.visible, 1, `${id} shown again`));
    console.log('ok   after a service restart the layers, pictures and visibility come back');
    await done(s);

    /* ---- upload budget ---- */
    s = await setup();
    await until('ready', () => s.ctl.ready());
    await until('layers', () => s.srv.layerByTarget('hud').length === 5);
    await until('first pictures', () => IDS.every((id) => s.srv.layers[s.ctl.refs[id]].wholes >= 1));
    s.ctl.startDemo(100);
    const total = () => IDS.reduce((a, id) => a + s.srv.layers[s.ctl.refs[id]].bytes, 0);
    await sleep(100);
    const before = total();
    const SIM_S = 40;
    for (let i = 0; i < SIM_S * 10; i++) {
        s.clk.advance(100);
        s.ctl._tick();
        if (i % 20 === 0) await sleep(1);
    }
    await sleep(200);
    const kbps = (total() - before) / 1024 / SIM_S;
    console.log(`     demo upload: ${kbps.toFixed(0)} KB per simulated second (budget 5500 shared)`);
    assert(kbps < 1500, `upload ${kbps} KB/s is too high`);
    console.log('ok   a demo run stays far under the shared upload budget');
    await done(s);

    /* ---- iDrive 8, and a unit without a HUD ---- */
    s = await setup({ server: { backend: 'id8', targets: 'map:874x749,hud:353x203,guide:702x213,widget:2240x896' } });
    await until('ready', () => s.ctl.connected);
    assert.strictEqual(s.ctl.ready(), false);
    assert(/iDrive 7/.test(s.ctl.statusText()), s.ctl.statusText());
    assert.strictEqual(s.ctl.startDemo(), false);
    await sleep(50);
    assert.strictEqual(Object.keys(s.srv.layers).length, 0, 'no layers on iDrive 8');
    await done(s);
    s = await setup({ server: { targets: 'map:1088x480,panel:1920x720' } });
    await until('ready', () => s.ctl.connected);
    assert.strictEqual(s.ctl.ready(), false);
    assert(/no HUD/.test(s.ctl.statusText()), s.ctl.statusText());
    assert.strictEqual(Object.keys(s.srv.layers).length, 0);
    console.log('ok   no layers on iDrive 8 or on a unit that offers no HUD; the page says why');
    await done(s);

    /* ---- no renderer ---- */
    const lone = new HudController({ config: { socketPath: `/tmp/hud-fr-none-${process.pid}.sock` } });
    lone.open();
    assert(/Waiting for the cluster renderer/.test(lone.statusText()));
    assert.strictEqual(lone.startDemo(), false);
    lone.close();
    console.log('ok   without the renderer the page waits and the demo will not start');
    console.log('\nall controller tests passed');
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

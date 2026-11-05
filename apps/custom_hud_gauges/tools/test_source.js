// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/**
 * The car's values, against a fake SOME/IP module and a fake engine unit.
 *
 *   node tools/test_source.js
 *
 * Covers: engine speed and speed from the signals the car sends (scalings,
 * invalid values); boost and intake temperature from the identifiers, one
 * request for both pressures; the OBD-II route when the identifiers are refused,
 * and the way back; implausible values dropped; the read-only check refusing
 * every other service, a request to all units and too many identifiers, with
 * nothing reaching the transport; busy verdicts retried; a pending reply
 * waited for; a silent unit skipped; the switches (engine reads off stops the
 * requests; stop shuts the proxies); the SDK's builders as the fallback for the
 * signals; the reason shown when nothing can be reached.
 */
const assert = require('assert');
const { FakeCar, TASU } = require('./fake_someip.js');
const someip = require('../src/someip_native.js');
const { VehicleSource } = require('../src/vehicle_source.js');
const { TasuLink, check } = require('../src/tasu_link.js');
const { EngineReader } = require('../src/engine_reader.js');

const CDS = 'de.bmw.infotainment.vehicle.CDS';
const VEH = 'de.bmw.infotainment.vehicle.Vehicle2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, check2) {
    const end = Date.now() + 3000;
    while (!check2()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(5);
    }
}
const u16 = (n) => [Math.floor(n / 256), n % 256];

/* a B58-like engine unit: identifiers answered */
function didDme(state) {
    return (sid, data) => {
        if (sid === 0x22 && data.join() === [0x42, 0x05, 0x42, 0x01].join()) {
            return [0x62, 0x42, 0x05].concat(u16(Math.round(state.absHpa / 0.078125)), [0x42, 0x01], u16(Math.round(state.ambHpa / 0.0390625)));
        }
        if (sid === 0x22 && data.join() === [0x58, 0x0F].join()) {
            return [0x62, 0x58, 0x0F, Math.round((state.iatC + 48) / 0.75)];
        }
        return [0x7F, sid, 0x31];
    };
}

function make(car, extra) {
    const samples = [];
    const src = new VehicleSource(Object.assign({ boostMs: 5, iatMs: 30, onSample: (s) => samples.push(s) }, extra || {}));
    return { src, samples, last: (k) => { const m = samples.filter((s) => k in s).pop(); return m && m[k]; } };
}

async function main() {
    /* ---- the read-only check ---- */
    [[0x12, 0x2E, [0x42, 0x05, 0x00]], [0x12, 0x10, [0x03]], [0x12, 0x11, [0x01]], [0x12, 0x14, [0xFF, 0xFF, 0xFF]], [0x12, 0x27, [0x01]],
        [0x12, 0x2C, [0x01]], [0x12, 0x2F, [0x60, 0xFD, 0x03]], [0x12, 0x31, [0x01, 0x02, 0x03]], [0x12, 0x3E, [0x00]], [0x12, 0x85, [0x02]],
        [0xDF, 0x22, [0xF1, 0x50]], [0xDF, 0x01, [0x0C]], [0x12, 0x22, []], [0x12, 0x22, [0x42]],
        [0x12, 0x22, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]], [0x12, 0x01, []], [0x12, 0x01, [0x0B, 0x33]],
        [0x12, 0x22, [0x42, 256]], [0x12, 0x22, 'x']].forEach(([t, s, d]) => {
        assert.throws(() => check(t, s, d), /read-only/, `${t.toString(16)} ${s.toString(16)} ${JSON.stringify(d)}`);
    });
    [[0x12, 0x22, [0x42, 0x05]], [0x12, 0x22, [0x42, 0x05, 0x42, 0x01]], [0x12, 0x01, [0x0B]]].forEach(([t, s, d]) => check(t, s, d));
    console.log('ok   read-only: only 22 (1-8 identifiers) and 01 (one PID), to one unit; everything else throws');

    /* ---- the transport sees nothing else ---- */
    let car = new FakeCar();
    car.install();
    const link = new TasuLink({ gapMs: 1, busyMs: 2 });
    await link.init();
    assert(link.ready);
    let threw = 0;
    for (const [t, s, d] of [[0x12, 0x2E, [0x42, 0x05, 0x00]], [0xDF, 0x22, [0xF1, 0x50]], [0x12, 0x10, [0x03]]]) {
        try { await link.read(t, s, d); } catch (e) { threw++; }
    }
    assert.strictEqual(threw, 3);
    assert.strictEqual(car.requests.length, 0, 'nothing reached the transport');
    assert.strictEqual(link.stats.blocked, 3);
    console.log('ok   refused requests never reach the transport');

    /* ---- identifiers: values, the one request for both pressures ---- */
    const st = { absHpa: 2012.5, ambHpa: 990, iatC: 30 };
    car.dme = didDme(st);
    const eng = new EngineReader(link);
    const kpa = await eng.boost();
    assert(Math.abs(kpa - 102.25) < 0.1, `boost ${kpa}`);
    const iat = await eng.iat();
    assert(Math.abs(iat - 30) < 0.8, `iat ${iat}`);
    assert.deepStrictEqual(car.requests.map((r) => [r.target, r.sid, r.data.map((b) => b.toString(16).padStart(2, '0')).join('')]),
        [[0x12, 0x22, '42054201'], [0x12, 0x22, '580f']]);
    assert(car.requests.every((r) => r.source === 0xF2 && r.sub === 0));
    st.absHpa = 800;                    /* vacuum */
    assert(Math.abs((await eng.boost()) - (-19)) < 0.1);
    console.log('ok   boost = 4205 - 4201 from one request (kPa, negative in vacuum); intake from 580F');

    /* ---- implausible values are dropped ---- */
    st.absHpa = 5000;
    assert.strictEqual(await eng.boost(), null);
    st.absHpa = 2000; st.ambHpa = 300;
    assert.strictEqual(await eng.boost(), null);
    st.ambHpa = 990; st.iatC = 140;
    assert.strictEqual(await eng.iat(), null);
    console.log('ok   implausible pressures and temperatures are dropped, not shown');
    link.close();

    /* ---- refused identifiers: OBD-II, and the way back ---- */
    car = new FakeCar();
    car.install();
    let now = 1000000;
    const obd = { map: 190, baro: 99, iat: 70 };
    let refuse = true;
    car.dme = (sid, data) => {
        if (sid === 0x22) return refuse ? [0x7F, 0x22, 0x31] : didDme({ absHpa: 1500, ambHpa: 990, iatC: 25 })(sid, data);
        if (data[0] === 0x0B) return [0x41, 0x0B, obd.map];
        if (data[0] === 0x33) return [0x41, 0x33, obd.baro];
        if (data[0] === 0x0F) return [0x41, 0x0F, obd.iat];
        return [0x7F, sid, 0x12];
    };
    const link2 = new TasuLink({ gapMs: 1 });
    await link2.init();
    const eng2 = new EngineReader(link2, { now: () => now });
    assert.strictEqual(await eng2.boost(), null, 'first refusal');
    assert.strictEqual(await eng2.boost(), null, 'second refusal switches route');
    const k2 = await eng2.boost();
    assert(Math.abs(k2 - 91) < 0.01, `obd boost ${k2}`);
    assert.strictEqual(await eng2.iat(), null);
    assert.strictEqual(await eng2.iat(), null);
    assert.strictEqual(await eng2.iat(), 30, 'OBD 0F = A - 40');
    const sids = car.requests.map((r) => r.sid + ':' + r.data[0].toString(16));
    assert(sids.includes('1:33') && sids.includes('1:b'), sids.join(' '));
    const baroReads = () => car.requests.filter((r) => r.sid === 1 && r.data[0] === 0x33).length;
    assert.strictEqual(baroReads(), 1);
    await eng2.boost();
    assert.strictEqual(baroReads(), 1, 'barometric pressure kept, not asked every time');
    now += 25000;
    await eng2.boost();
    assert.strictEqual(baroReads(), 2, 'asked again after 20 s');
    refuse = false;
    now += 61000;
    const back = await eng2.boost();
    assert(Math.abs(back - 51) < 0.1, `identifiers again ${back}`);
    console.log('ok   identifiers refused twice -> OBD-II 0B less 33 (baro kept 20 s) and 0F; the identifiers are tried again after 60 s');
    link2.close();

    /* ---- transport behaviour: busy, pending, silence ---- */
    car = new FakeCar();
    car.install();
    const link3 = new TasuLink({ gapMs: 1, busyMs: 2, silentAfter: 3 });
    await link3.init();
    car.dme = didDme({ absHpa: 1500, ambHpa: 990, iatC: 25 });
    car.verdicts = ['APP_REQUEST_TEMPORARILY_NOT_ACCEPTED', 'BUSY'];
    const r1 = await link3.read(0x12, 0x22, [0x58, 0x0F]);
    assert.strictEqual(r1[0], 0x62);
    assert.strictEqual(link3.stats.busy, 2);
    assert.strictEqual(car.requests.length, 3, 'two busy verdicts, then accepted');
    car.pending = true;
    const r2 = await link3.read(0x12, 0x22, [0x58, 0x0F]);
    assert.strictEqual(r2[0], 0x62, 'the reply after a 78 pending');
    car.pending = false;
    car.dme = () => null;
    for (let i = 0; i < 3; i++) assert.strictEqual(await link3.read(0x12, 0x22, [0x58, 0x0F], 20), null);
    assert(link3.silent(0x12));
    const n = car.requests.length;
    assert.strictEqual(await link3.read(0x12, 0x22, [0x58, 0x0F], 20), null);
    assert.strictEqual(car.requests.length, n, 'a silent unit is not asked');
    link3.wake();
    assert(!link3.silent(0x12));
    console.log('ok   busy verdicts retried; a pending reply waited for; a silent unit skipped until wake()');
    link3.close();

    /* ---- the source: passive values ---- */
    car = new FakeCar();
    car.install();
    car.dme = didDme({ absHpa: 1980, ambHpa: 990, iatC: 31.5 });
    car.initial[CDS + '.statusEngineSpeed2'] = { actualValueRPMEngineCrankshaft: 3200 };
    let m = make(car);
    await m.src.start();
    assert(m.src.passiveVia === 'native');
    assert.deepStrictEqual(m.samples.filter((s) => 'rpm' in s)[0], { rpm: 800 }, 'the value read at start: 3200 x 0.25');
    car.emit(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 12800 });
    assert.strictEqual(m.last('rpm'), 3200);
    car.emit(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 65535 });
    assert.strictEqual(m.last('rpm'), 3200, '65535 = invalid, ignored');
    car.emit(VEH, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 6400 });
    assert.strictEqual(m.last('speedKmh'), 100);
    car.emit(VEH, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 65535 });
    assert.strictEqual(m.last('speedKmh'), 100);
    car.emit(VEH, 'statusCarSpeed2', {});
    car.emit(VEH, 'statusCarSpeed2', null);
    assert.strictEqual(m.samples.filter((s) => 'speedKmh' in s).length, 1);
    console.log('ok   engine speed x 0.25 and speed x 0.015625 from the car\'s signals; invalid values ignored');

    /* ---- engine reads feed boost and intake, and only reads ---- */
    await until('boost and intake', () => m.last('boostKpa') !== undefined && m.last('iatC') !== undefined);
    assert(Math.abs(m.last('boostKpa') - 99) < 0.1);
    assert(Math.abs(m.last('iatC') - 31.5) < 0.8);
    assert(car.requests.length >= 2);
    assert(car.requests.every((r) => r.target === 0x12 && r.sid === 0x22 && r.source === 0xF2), 'only 22 to the engine unit');
    assert(/RPM ok.*Speed ok.*Boost ok.*Intake ok/.test(m.src.text()), m.src.text());
    assert(/boost ok via identifiers; intake ok via identifier/.test(m.src.notes()), m.src.notes());
    console.log('ok   boost and intake temperature arrive; only 22 requests to unit 12 were sent');

    /* ---- the switch: engine reads off ---- */
    m.src.setEngine(false);
    await sleep(40);
    const sent = car.requests.length;
    await sleep(80);
    assert.strictEqual(car.requests.length, sent, 'no request once engine reads are off');
    assert(/Boost off.*Intake off/.test(m.src.text()), m.src.text());
    m.src.setEngine(true);
    await until('requests again', () => car.requests.length > sent);
    console.log('ok   engine reads off: no more requests; on again: they resume');

    /* ---- stop: proxies shut, nothing more from the car ---- */
    m.src.stop();
    await sleep(30);
    assert(car.proxies.every((p) => p.shut || p.iface === TASU), 'the signal proxies are shut');
    const count = m.samples.length;
    car.emit(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 4000 });
    await sleep(40);
    assert.strictEqual(m.samples.length, count, 'nothing is passed on after stop');
    const reqs = car.requests.length;
    await sleep(60);
    assert.strictEqual(car.requests.length, reqs, 'no requests after stop');
    assert.strictEqual(m.src.text(), 'Off');
    console.log('ok   stop: signal proxies shut, no values passed on, no requests');

    /* start again after stop */
    m = make(car);
    await m.src.start();
    car.emit(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 8000 });
    assert.strictEqual(m.last('rpm'), 2000);
    m.src.stop();
    console.log('ok   starts again after a stop');

    /* ---- the diagnostic link is missing ---- */
    car = new FakeCar();
    car.install();
    delete car.configs[TASU];
    require('fs').unlinkSync(require('path').join(car.dir, TASU.replace(/\./g, '_') + '.json'));
    m = make(car);
    await m.src.start();
    await until('link error', () => /No diagnostic link/.test(m.src.problem()));
    car.emit(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 4000 });
    assert.strictEqual(m.last('rpm'), 1000, 'the passive values still work');
    console.log('ok   without the TASU interface: the reason is shown, RPM and speed still work');
    m.src.stop();

    /* ---- no native module: the SDK's typed proxies for the signals ---- */
    someip.useNative(null);
    const subs = {};
    const builders = {
        buildTypedProxy: (iface, inst) => Promise.resolve({
            init: () => Promise.resolve(),
            waitUntilAvailable: () => Promise.resolve(),
            statusEngineSpeed2: { subscribe: (cb) => { subs.rpm = cb; return Promise.resolve(); }, getValue: () => Promise.resolve({ actualValueRPMEngineCrankshaft: 2000 }) },
            statusCarSpeed2: { subscribe: (cb) => { subs.speed = cb; return Promise.resolve(); }, getValue: () => Promise.reject(new Error('no getter')) }
        })
    };
    m = make(car, { builders, engine: false });
    await m.src.start();
    assert.strictEqual(m.src.passiveVia, 'sdk');
    assert.strictEqual(m.last('rpm'), 500);
    subs.speed({ speedVehicleCentreOfGravity: 3200 });
    assert.strictEqual(m.last('speedKmh'), 50);
    console.log('ok   without the native module the SDK builders carry RPM and speed');
    m.src.stop();

    /* ---- nothing at all ---- */
    m = make(car, { engine: false });
    await m.src.start();
    assert(/Car signals: .*someip native module not available/.test(m.src.problem()), m.src.problem());
    console.log('ok   with no way to the car the page says why');
    m.src.stop();

    console.log('\nall source tests passed');
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

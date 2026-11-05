// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/**
 * Runs the app's entry module (mgu-app.json's first) against a fake SDK and
 * HMI built from the shipped uiDescription.json, with the renderer socket
 * pointed at tools/fake_render.js.
 *
 *   node tools/test_page.js
 *
 * Covers: application.xml and uiDescription.json agree; the page's two
 * switches and two buttons are the ones the app binds; the waiting line before
 * the renderer is there; Demo draws on the HUD target and Stop demo removes it;
 * a press delivered twice counts once; the HUD switch on starts the car's
 * values (RPM, speed, boost, intake temperature reach the HUD), keeps the
 * gauges and the app active when the page is hidden, and off stops reading
 * and drawing; the engine switch off stops the requests to the engine unit;
 * both switches kept across a restart; the page shown again; RESTORE_HMI.
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { FakeRender } = require('./fake_render.js');
const { FakeCar } = require('./fake_someip.js');
const someip = require('../src/someip_native.js');

const ROOT = path.join(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-app.json'), 'utf8'));
const PKG = path.join(ROOT, MANIFEST.tree);
const UI_DIR = path.join(PKG, 'rhmiData', 'uiDescriptions', 'ID7');
const UI = JSON.parse(fs.readFileSync(path.join(UI_DIR, 'uiDescription.json'), 'utf8'));
const XML = fs.readFileSync(path.join(UI_DIR, 'application.xml'), 'utf8');
const APP_JSON = JSON.parse(fs.readFileSync(path.join(PKG, 'rhmiData', 'application.json'), 'utf8'));

const SOCK = `/tmp/hud-pg-${process.pid}.sock`;
const DEFAULT = '/dev/shm/cluster-render/render.sock';
const realConnect = net.connect;
net.connect = (p, ...rest) => realConnect.call(net, p === DEFAULT ? SOCK : p, ...rest);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, check) {
    const end = Date.now() + 3000;
    while (!check()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(10);
    }
}

class FakeComponent extends EventEmitter {
    constructor(id, desc) {
        super();
        this.id = Number(id);
        this.text = null;
        this.enabled = null;
    }
    getId() { return this.id; }
    setValue(row, cell, value) {
        if (cell === 'eParam_RowSelected') this.selected = value; else this.text = value;
        return Promise.resolve();
    }
    setEnabled(e) { this.enabled = e; return Promise.resolve(); }
    setVisible() { return Promise.resolve(); }
    updateResources() { return Promise.resolve(); }
}
const byName = {};
Object.entries(UI.containers).forEach(([cid, cont]) => {
    byName[cont.name] = new FakeComponent(cid, cont);
    Object.entries(cont.components).forEach(([id, d]) => { byName[d.name] = new FakeComponent(id, d); });
});
const rhmi = new EventEmitter();
rhmi.getByName = (n) => byName[n] || null;
rhmi.mapEntryState = () => Promise.resolve();
rhmi.openEntryState = () => Promise.resolve();

const logs = [];
const logger = {};
['error', 'warn', 'info', 'verbose', 'debug'].forEach((l) => { logger[l] = (m) => logs.push(`${l}: ${m}`); });

class OnlineApp extends EventEmitter {
    constructor() {
        super();
        this._packageJson = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
        this.appDescription = APP_JSON;
        this.rhmiApplication = rhmi;
        this.startReason = 'ENTRY_POINT';
        this._initialized = false;
        this._appStatusService = null;
        const description = APP_JSON.application.entryPoints[0];
        this._eps = [{
            entryPoint: { setText: () => Promise.resolve(), setIcon: () => Promise.resolve() },
            getDescription: () => description, init: () => Promise.resolve(), setAvailability: () => Promise.resolve()
        }];
    }
    start() { setImmediate(() => this.emit('initialized')); return Promise.resolve(); }
    getAppId() { return 'custom_hud_gauges'; }
    getEntryPoints() { return this._eps; }
    getLastExecutedEntryPointUuid() { return null; }
    initialized() { this._initialized = true; this._appStatusService = {}; return Promise.resolve(); }
    registerActive() { return Promise.resolve(); }
    registerInactive() { return Promise.resolve(); }
    registerHmiVisible() { return Promise.resolve(); }
    unregisterHmiVisible() { return Promise.resolve(); }
    destroyBundles() { return Promise.resolve(); }
}
const FAKE = {
    'oap-sdk/src/core/OnlineApp.js': OnlineApp,
    'oap-sdk/src/logging/logging': { getSDKLogger: () => logger },
    'oap-sdk/src/someip/someipBuilders': { buildTypedProxy: () => Promise.reject(new Error('not used in this test')) }
};
/* the app keeps its switches in <app root>/../../data, which is outside the repository here */
const DATA = path.join(__dirname, '..', '..', 'data');
const SETTINGS = path.join(DATA, 'hud-gauges.json');

/* A second run: the switch was left on, the app starts by itself and the gauges come back. */
async function resume() {
    fs.mkdirSync(DATA, { recursive: true });
    process.env.HUDG_RESUME_DELAY_MS = '50';
    fs.writeFileSync(SETTINGS, JSON.stringify({ hud: true, engine: false }));
    const car = new FakeCar();
    car.install();
    const Module = require('module');
    const load = Module._load;
    Module._load = function (req, parent, isMain) { return FAKE[req] || load.call(this, req, parent, isMain); };
    OnlineApp.prototype.registerActive = function () { activeCalls++; return Promise.resolve(); };
    const srv = new FakeRender(SOCK);
    await srv.listen();
    require(path.join(ROOT, MANIFEST.modules[0]));
    await until('page ready', () => logs.some((l) => /entry point custom_hud_gauges ENABLED/.test(l)));
    await until('signals watched', () => car.live('de.bmw.infotainment.vehicle.CDS').length === 1);
    await until('switches shown', () => byName.hgMaster.selected === true && byName.hgEngine.selected === false);
    assert(activeCalls > 0, 'the app reports itself active');
    car.emit('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 4000 });
    await until('hud layers', () => srv.layerByTarget('hud').filter((r) => srv.layers[r].msg.visible === 1).length === 4);
    assert.strictEqual(car.requests.length, 0, 'engine reads were left off');
    console.log('ok   a restart with the switches left on: signals watched and gauges drawn without a press; engine reads stay off');
    try { fs.unlinkSync(SETTINGS); fs.rmdirSync(DATA); } catch (e) { /* tidy */ }
    await srv.close();
    console.log('\nall page tests passed (resume)');
}
let activeCalls = 0;

async function main() {
    if (process.argv.indexOf('--resume') >= 0) {
        return resume();
    }
    try { fs.unlinkSync(SETTINGS); } catch (e) { /* none */ }
    /* the shipped description */
    const comps = UI.containers['1'].components;
    const xmlIds = [...XML.matchAll(/<component id="(\d+)" type="(\w+)"/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepStrictEqual(xmlIds.slice().sort(), Object.entries(comps).map(([id, d]) => `${id} ${d.type}`).sort(), 'application.xml and uiDescription agree');
    assert.deepStrictEqual(xmlIds.map((x) => x.split(' ')[0]), ['10', '35', '36', '20', '22', '21', '32', '33'], 'the page order');
    assert.deepStrictEqual(Object.values(comps).filter((d) => d.type === 'button').map((d) => d.name), ['hgStart', 'hgStop']);
    assert.deepStrictEqual(Object.values(comps).filter((d) => d.type === 'checkBox').map((d) => d.name), ['hgMaster', 'hgEngine']);
    assert.strictEqual(UI.containers['1'].name, 'ST_OnlineApps_HudGauges');
    assert.strictEqual(APP_JSON.application.entryPoints.length, 1);
    assert.strictEqual(APP_JSON.application.name, MANIFEST.id);
    /* the SOME/IP interfaces the app uses are in the manifest it installs with */
    const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(manifest.proxies['de.bmw.infotainment.vehicle.CDS'], { instances: '1', attributes: { statusEngineSpeed2: 'rs' } });
    assert.deepStrictEqual(manifest.proxies['de.bmw.infotainment.vehicle.Vehicle2'], { instances: '1', attributes: { statusCarSpeed2: 'rs' } });
    assert.deepStrictEqual(manifest.proxies['com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu'],
        { instances: 'SystemFunctionsInternalTasuInst1', methods: ['sendTasuRequest'], broadcasts: ['sendTasuResponse'] });
    assert(!Object.keys(manifest.proxies).some((k) => /FES|CDS2/.test(k)), 'no interface the app does not use');
    console.log('ok   page: two switches, two buttons, three status lines; xml, json and the manifest agree');

    /* the app, with no renderer yet; its switches are off */
    const car = new FakeCar();
    car.install();
    car.dme = (sid, data) => {
        if (sid === 0x22 && data.join() === '66,5,66,1') return [0x62, 0x42, 0x05, 0x64, 0x00, 0x42, 0x01, 0x63, 0x00];   /* 2000 hPa, 990 hPa */
        if (sid === 0x22 && data.join() === '88,15') return [0x62, 0x58, 0x0F, 104];
        return [0x7F, sid, 0x31];
    };
    const Module = require('module');
    const load = Module._load;
    Module._load = function (req, parent, isMain) { return FAKE[req] || load.call(this, req, parent, isMain); };
    const entry = path.join(ROOT, MANIFEST.modules[0]);
    require(entry);
    await until('page ready', () => logs.some((l) => /entry point custom_hud_gauges ENABLED/.test(l)));
    await until('status written', () => byName.hgStatus.text);
    assert(/Waiting for the cluster renderer/.test(byName.hgStatus.text), byName.hgStatus.text);
    assert.strictEqual(byName.hgStart.enabled, false, 'Demo greyed without a renderer');
    assert.strictEqual(byName.hgMaster.selected, false);
    assert.strictEqual(byName.hgEngine.selected, false);
    assert.strictEqual(car.proxies.length, 0, 'switches off: nothing of the car is touched');
    console.log('ok   without the renderer: waiting line, Demo greyed, switches shown (both off), the car untouched');

    /* renderer arrives */
    const srv = new FakeRender(SOCK);
    await srv.listen();
    await until('connected', () => /HUD gauges are off/.test(byName.hgStatus.text || ''));
    assert(/Renderer id7, HUD 800x480/.test(byName.hgDetail.text), byName.hgDetail.text);
    assert.strictEqual(byName.hgStart.enabled, true);
    assert.strictEqual(byName.hgStop.enabled, false);
    await until('hud layers', () => srv.layerByTarget('hud').length === 5);
    assert.strictEqual(car.proxies.length, 0, 'still nothing of the car');
    console.log('ok   renderer found: "HUD gauges are off", five hud layers, hidden');

    /* the demo, a doubled press */
    byName.hgStart.emit('action');
    rhmi.emit('userEvent', { eventType: 'ACTION', sourceId: byName.hgStart.id });
    await until('demo status', () => /^Demo, \d+ s left/.test(byName.hgStatus.text || ''));
    await until('layers shown', () => srv.layerByTarget('hud').every((r) => srv.layers[r].msg.visible === 1));
    assert.strictEqual(logs.filter((l) => /BUTTON ACTION hgStart/.test(l)).length, 1, 'one press');
    assert.strictEqual(byName.hgStop.enabled, true);
    assert.strictEqual(car.proxies.length, 0, 'the demo reads nothing from the car');
    byName.hgStop.emit('action');
    await until('stopped', () => srv.layerByTarget('hud').every((r) => srv.layers[r].msg.visible === 0));
    console.log('ok   Demo shows the layers (a doubled press counts once), reads nothing from the car; Stop demo hides them');

    /* the HUD switch on: the car's values reach the HUD */
    await sleep(450);
    byName.hgMaster.emit('action');
    await until('switch shown on', () => byName.hgMaster.selected === true);
    assert.strictEqual(JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).hud, true, 'the switch is kept');
    await until('signals watched', () => car.live('de.bmw.infotainment.vehicle.CDS').length === 1 && car.live('de.bmw.infotainment.vehicle.Vehicle2').length === 1);
    car.emit('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 12800 });
    car.emit('de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2', { speedVehicleCentreOfGravity: 4800 });
    await until('layers shown live', () => srv.layerByTarget('hud').filter((r) => srv.layers[r].msg.visible === 1).length === 4);
    await until('live status', () => /^Live values/.test(byName.hgStatus.text || ''));
    await until('source line, engine reads off', () => /RPM ok.*Speed ok.*Boost off.*Intake off/.test(byName.hgSource.text || ''));
    assert.strictEqual(car.requests.length, 0, 'the HUD switch alone asks the engine unit for nothing');
    assert.strictEqual(byName.hgEngine.selected, false, 'engine reads start off');
    await sleep(450);
    byName.hgEngine.emit('action');
    await until('engine reads on', () => byName.hgEngine.selected === true);
    await until('source line', () => /RPM ok.*Speed ok.*Boost ok.*Intake ok/.test(byName.hgSource.text || ''));
    assert(car.requests.length > 0 && car.requests.every((r) => r.sid === 0x22 && r.target === 0x12), 'only 22 requests to the engine unit');
    console.log('ok   HUD switch on: RPM and speed first with no engine request; engine switch on adds boost and intake, only 22 requests to unit 12');

    /* the page goes: the gauges and the app stay */
    const before = car.requests.length;
    byName.ST_OnlineApps_HudGauges.emit('visible', { visible: false });
    await sleep(1100);
    assert(srv.clients.size === 1, 'the renderer connection stays open');
    assert(srv.layerByTarget('hud').filter((r) => srv.layers[r].msg.visible === 1).length === 4, 'the gauges stay');
    await until('requests go on', () => car.requests.length > before + 2);
    console.log('ok   hiding the page: the gauges, the renderer connection and the readings go on');

    /* the engine switch off: no more requests, boost and intake go */
    byName.ST_OnlineApps_HudGauges.emit('visible', { visible: true });
    await sleep(50);
    await sleep(450);
    byName.hgEngine.emit('action');
    await until('engine switch off', () => byName.hgEngine.selected === false);
    assert.strictEqual(JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).engine, false);
    await sleep(100);
    const sent = car.requests.length;
    await sleep(300);
    assert.strictEqual(car.requests.length, sent, 'no requests with engine reads off');
    await until('source line, engine off', () => /Boost off.*Intake off/.test(byName.hgSource.text || ''));
    console.log('ok   engine switch off: the requests to the engine unit stop, RPM and speed go on');

    /* the HUD switch off: nothing read, nothing drawn */
    await sleep(450);
    byName.hgMaster.emit('action');
    await until('hud off', () => byName.hgMaster.selected === false);
    await until('layers hidden', () => srv.layerByTarget('hud').every((r) => srv.layers[r].msg.visible === 0));
    assert(car.live('de.bmw.infotainment.vehicle.CDS').length === 0, 'signal proxies shut');
    await until('off status', () => /HUD gauges are off/.test(byName.hgStatus.text));
    console.log('ok   HUD switch off: the signal proxies shut, the layers hidden');

    /* hidden page with the switch off: the connection closes */
    byName.ST_OnlineApps_HudGauges.emit('visible', { visible: false });
    await until('connection closed', () => srv.clients.size === 0);
    byName.ST_OnlineApps_HudGauges.emit('visible', { visible: true });
    await until('reconnected', () => srv.clients.size === 1);
    await until('layers', () => srv.layerByTarget('hud').length === 5);
    console.log('ok   hidden with the switch off: the renderer connection closes; shown again it reconnects');

    /* RESTORE_HMI rewrites everything */
    byName.hgStatus.text = null;
    byName.hgMaster.selected = undefined;
    rhmi.emit('restoreHmi');
    await until('rewritten', () => byName.hgStatus.text && byName.hgMaster.selected === false);
    console.log('ok   RESTORE_HMI rewrites the page and the switches');

    assert(!logs.some((l) => /^error:/.test(l)), logs.filter((l) => /^error:/.test(l)).join('\n'));
    await srv.close();
    try { fs.unlinkSync(SETTINGS); fs.rmdirSync(DATA); } catch (e) { /* tidy */ }
    console.log('\nall page tests passed');
}

main().then(() => process.exit(0), (e) => { console.error(e); console.error(logs.slice(-20).join('\n')); process.exit(1); });

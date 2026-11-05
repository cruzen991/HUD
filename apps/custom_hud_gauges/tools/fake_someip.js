// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/**
 * A stand-in for the `someip` native module and the engine unit behind the
 * head unit's diagnostic transport, for tests.
 *
 *   const car = new FakeCar();      car.install();   (puts it behind someip_native.js)
 *   car.emit('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 12800 });
 *   car.dme = (sid, data) => [...uds bytes];         what the engine unit answers
 *   car.requests                                     every sendTasuRequest it received
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const someip = require('../src/someip_native.js');

const TASU = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';

class FakeCar {
    constructor() {
        this.proxies = [];
        this.requests = [];
        this.dme = () => null;            /* (sid, data, target) -> uds bytes, or null for silence */
        this.verdict = 'NO_ERROR';
        this.verdicts = [];               /* queued verdicts, used first */
        this.pending = false;             /* answer with 7F sid 78 first */
        this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-someip-'));
        this.configs = {
            'de.bmw.infotainment.vehicle.CDS': { fields: { statusEngineSpeed2: { getter: true } } },
            'de.bmw.infotainment.vehicle.Vehicle2': { fields: { statusCarSpeed2: { getter: true } } }
        };
        this.configs[TASU] = { methods: { sendTasuRequest: {} }, broadcasts: { sendTasuResponse: {} } };
        Object.keys(this.configs).forEach((i) => {
            fs.writeFileSync(path.join(this.dir, i.replace(/\./g, '_') + '.json'), JSON.stringify(this.configs[i]));
        });
        this.initial = {};                /* iface.field -> value returned by getValue */
        this.available = true;
    }

    install() {
        someip.useNative({ buildProxy: (cfg, instance) => this._build(cfg, instance) });
        someip.setConfigDirs([this.dir]);
    }

    _build(cfg, instance) {
        const car = this;
        const iface = Object.keys(this.configs).find((i) => JSON.stringify(this.configs[i]) === JSON.stringify(cfg));
        const px = {
            iface, instance, subs: {}, shut: false, availCb: null,
            init() { return Promise.resolve(); },
            subscribe(o) { px.subs[o.name] = o.onReceive; return Promise.resolve(); },
            getValue(f) { const v = car.initial[iface + '.' + f]; return v === undefined ? Promise.reject(new Error('none')) : Promise.resolve(v); },
            subscribeToAvailability(cb) { px.availCb = cb; setImmediate(() => cb(car.available)); },
            isAvailable() { return car.available; },
            shutdown() { px.shut = true; },
            callMethod(method, params) { return car._call(px, method, params); }
        };
        this.proxies.push(px);
        return Promise.resolve(px);
    }

    _call(px, method, p) {
        if (method !== 'sendTasuRequest') {
            return Promise.reject(new Error('no method ' + method));
        }
        const data = Array.prototype.slice.call(p.udsData);
        this.requests.push({ target: p.targetAddress, sid: p.serviceID, data, source: p.sourceAddress, sub: p.subroutineID });
        const verdict = this.verdicts.length ? this.verdicts.shift() : this.verdict;
        if (verdict !== 'NO_ERROR') {
            return Promise.resolve({ TasuErrorEnum: verdict });
        }
        const answer = this.dme(p.serviceID, data, p.targetAddress);
        const sub = this.proxies.filter((x) => x.iface === TASU && x.subs.sendTasuResponse)[0];
        if (answer && sub && !px.shut) {
            const send = (uds) => setImmediate(() => {
                const frame = Buffer.alloc(9 + uds.length);
                frame[6] = p.targetAddress;
                Buffer.from(uds).copy(frame, 9);
                sub.subs.sendTasuResponse({ udsResponse: frame, errorCode: 'NO_ERROR' });
            });
            if (this.pending) {
                send([0x7F, p.serviceID, 0x78]);
            }
            send(answer);
        }
        return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
    }

    emit(iface, field, value) {
        this.proxies.filter((x) => x.iface === iface && x.subs[field]).forEach((x) => x.subs[field](value));
    }

    live(iface) {
        return this.proxies.filter((x) => x.iface === iface && !x.shut);
    }
}

module.exports = { FakeCar, TASU };

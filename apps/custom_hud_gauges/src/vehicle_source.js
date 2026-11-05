// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real readings for the HUD.
 *
 *   passive  engine speed and vehicle speed, which the car sends the head unit
 *            on its own (SOME/IP CDS.statusEngineSpeed2, Vehicle2.statusCarSpeed2).
 *            Nothing is asked of any control unit. Scalings are BMW's own, as
 *            apps/live_data of cauliflowermossgrape/idrive7-apps (MIT) applies them:
 *            engine speed x 0.25 rpm, speed x 0.015625 km/h, 65535 = invalid.
 *   engine   boost and intake air temperature, asked of the engine unit with
 *            read-only requests (engine_reader.js over tasu_link.js). Optional.
 *
 * Every reading goes to onSample({ rpm, speedKmh, boostKpa, iatC }), any subset.
 * Nothing here writes to the car.
 */
'use strict';

const someip = require('./someip_native.js');
const { TasuLink } = require('./tasu_link.js');
const { EngineReader } = require('./engine_reader.js');

const IF_CDS = 'de.bmw.infotainment.vehicle.CDS';
const IF_VEHICLE2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const OK_MS = 3000;
const INVALID = 65535;

const SILENT = { info() {}, warn() {}, error() {} };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class VehicleSource {
    constructor(opts) {
        const o = opts || {};
        this.log = o.log || SILENT;
        this.now = o.now || Date.now;
        this.onSample = o.onSample || (() => {});
        this.boostMs = o.boostMs || 250;
        this.iatMs = o.iatMs || 2000;
        this.builders = o.builders || null;          /* the SDK's someipBuilders, for the passive fallback */
        this.engineOn = o.engine !== false;
        this.running = false;
        this.watches = [];
        this.passiveVia = '';
        this.passiveError = '';
        this.engineError = '';
        this.link = null;
        this.reader = null;
        this.seen = {};                              /* rpm, speed, boost, iat -> time of the last value */
        this.loopId = 0;
        this.starting = null;
    }

    /* ---- control ---- */

    start() {
        if (this.running) {
            return this.starting || Promise.resolve();
        }
        this.running = true;
        this.seen = {};
        this.starting = this._startPassive().then(() => {
            if (this.running && this.engineOn) {
                this._startEngine();
            }
        }).catch((e) => this.log.warn('source start: ' + ((e && e.message) || e)));
        return this.starting;
    }

    stop() {
        this.running = false;
        this.loopId++;
        this.seen = {};
        if (this.link) {
            this.link.cancel();
        }
        const w = this.watches;
        this.watches = [];
        w.forEach((x) => x.shutdown());
        this.passiveVia = '';
    }

    setEngine(on) {
        this.engineOn = !!on;
        if (!this.running) {
            return;
        }
        if (this.engineOn) {
            this._startEngine();
        } else {
            this.loopId++;
            if (this.link) {
                this.link.cancel();
            }
            delete this.seen.boost;
            delete this.seen.iat;
        }
    }

    /* ---- passive ---- */

    async _startPassive() {
        this.passiveError = '';
        if (someip.available()) {
            const cds = await someip.watch(IF_CDS, '1', {
                statusEngineSpeed2: (v) => this._rpm(v)
            }, this.log);
            const veh = await someip.watch(IF_VEHICLE2, '1', {
                statusCarSpeed2: (v) => this._speed(v)
            }, this.log);
            if (!this.running) {
                cds.shutdown();
                veh.shutdown();
                return;
            }
            this.watches = [cds, veh];
            this.passiveVia = 'native';
            const err = cds.error || veh.error;
            if (err) {
                this.passiveError = err;
            }
            return;
        }
        if (this.builders) {
            await this._typed(IF_CDS, 'statusEngineSpeed2', (v) => this._rpm(v));
            await this._typed(IF_VEHICLE2, 'statusCarSpeed2', (v) => this._speed(v));
            this.passiveVia = 'sdk';
            return;
        }
        this.passiveError = someip.unavailableReason() || 'no SOME/IP access';
        this.log.warn('no way to read the car signals: ' + this.passiveError);
    }

    /* the SDK's typed proxies: fields only */
    async _typed(iface, field, fn) {
        try {
            const p = await this.builders.buildTypedProxy(iface, '1');
            await p.init();
            await p.waitUntilAvailable();
            await p[field].subscribe(fn);
            try {
                fn(await p[field].getValue());
            } catch (e) {
                /* no getter: the next change comes */
            }
            this.watches.push({ shutdown() {} });
        } catch (e) {
            this.passiveError = String((e && e.message) || e);
            this.log.warn(iface + ' ' + field + ': ' + this.passiveError);
        }
    }

    _rpm(v) {
        const raw = v && v.actualValueRPMEngineCrankshaft;
        if (!this.running || typeof raw !== 'number' || raw >= INVALID) {
            return;
        }
        this.seen.rpm = this.now();
        this.onSample({ rpm: raw * 0.25 });
    }

    _speed(v) {
        const raw = v && v.speedVehicleCentreOfGravity;
        if (!this.running || typeof raw !== 'number' || raw >= INVALID) {
            return;
        }
        this.seen.speed = this.now();
        this.onSample({ speedKmh: raw * 0.015625 });
    }

    /* ---- engine reads ---- */

    async _startEngine() {
        const id = ++this.loopId;
        if (!this.link) {
            this.link = new TasuLink({ log: this.log });
        }
        if (!this.link.ready) {
            await this.link.init();
        }
        if (id !== this.loopId || !this.running || !this.engineOn) {
            return;
        }
        if (!this.link.ready) {
            this.log.warn('engine reads: ' + this.link.error);
            this.engineError = this.link.error;
            return;
        }
        this.engineError = '';
        if (!this.reader) {
            this.reader = new EngineReader(this.link, { now: this.now, log: this.log });
        }
        this._loop(id).catch((e) => this.log.warn('engine loop: ' + ((e && e.message) || e)));
    }

    async _loop(id) {
        const alive = () => id === this.loopId && this.running && this.engineOn;
        let lastIat = 0;
        let idle = 0;
        while (alive()) {
            let got = false;
            if (this.now() - lastIat >= this.iatMs) {
                lastIat = this.now();
                const c = await this.reader.iat();
                if (c !== null && alive()) {
                    got = true;
                    this.seen.iat = this.now();
                    this.onSample({ iatC: c });
                }
            }
            if (!alive()) {
                break;
            }
            const kpa = await this.reader.boost();
            if (kpa !== null && alive()) {
                got = true;
                this.seen.boost = this.now();
                this.onSample({ boostKpa: kpa });
            }
            /* a unit that does not answer (ignition off, asleep): ask again gently */
            idle = got ? 0 : idle + 1;
            if (idle >= 10) {
                this.link.wake();
                await sleep(3000);
            } else {
                await sleep(this.boostMs);
            }
        }
    }

    /* ---- what the page shows ---- */

    _state(key) {
        const t = this.seen[key];
        return t !== undefined && this.now() - t <= OK_MS;
    }

    status() {
        const s = {
            rpm: this._state('rpm'),
            speed: this._state('speed'),
            boost: this._state('boost'),
            iat: this._state('iat')
        };
        return s;
    }

    text() {
        if (!this.running) {
            return 'Off';
        }
        const s = this.status();
        const mark = (ok) => (ok ? 'ok' : '-');
        const parts = ['RPM ' + mark(s.rpm), 'Speed ' + mark(s.speed)];
        parts.push(this.engineOn ? 'Boost ' + mark(s.boost) : 'Boost off');
        parts.push(this.engineOn ? 'Intake ' + mark(s.iat) : 'Intake off');
        return parts.join('  ');
    }

    /* What the engine unit last said, for the page: where a value does not come, why not. */
    notes() {
        if (!this.running || !this.engineOn || !this.reader) {
            return '';
        }
        const l = this.reader.last;
        const parts = [];
        if (l.boost) {
            parts.push('boost ' + l.boost);
        }
        if (l.iat) {
            parts.push('intake ' + l.iat);
        }
        return parts.join('; ');
    }

    problem() {
        if (!this.running) {
            return '';
        }
        if (this.passiveError) {
            return 'Car signals: ' + this.passiveError;
        }
        if (this.engineOn && this.engineError) {
            return 'No diagnostic link: ' + this.engineError;
        }
        return '';
    }
}

module.exports = { VehicleSource, IF_CDS, IF_VEHICLE2 };

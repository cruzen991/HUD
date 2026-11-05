'use strict';
/**
 * Runs the HUD gauges: owns the connection to the cluster renderer (the
 * `hud` target), turns readings into display numbers, and sends only the
 * pixels that changed.
 *
 * Where readings come from is open on purpose. Whatever produces them calls
 *
 *     controller.feed({ speedKmh, rpm, boostKpa, iatC })     any subset, any time
 *
 * Each value counts for `staleMs`; after that its gauge shows dashes, never the
 * last reading. A feed shows the gauges and, once every value has been stale for
 * `liveHideMs`, hides them again so the stock HUD is back. The built-in demo
 * (hud_demo.js) is only one such source: it is labelled DEMO on the HUD and
 * stops by itself.
 *
 * Nothing here reads from or writes to the car.
 */

const EventEmitter = require('events');
const fs = require('fs');
const { ClusterRender } = require('./cluster_render_client.js');
const { Hud } = require('./hud_render.js');
const { demoSample } = require('./hud_demo.js');

const APP = 'custom_hud_gauges';
const TARGET = 'hud';
const FIELDS = ['speedKmh', 'rpm', 'boostKpa', 'iatC'];

const SPEED_UNITS = { mph: { f: 0.621371, label: 'MPH' }, kmh: { f: 1, label: 'KM/H' } };
const BOOST_UNITS = {
    psi: { f: 0.145038, label: 'PSI', dec: 1, min: -14.7, max: 30, mid: 15, high: 24 },
    bar: { f: 0.01, label: 'BAR', dec: 2, min: -1, max: 2, mid: 1, high: 1.65 },
    kpa: { f: 1, label: 'KPA', dec: 0, min: -100, max: 200, mid: 100, high: 165 }
};
const TEMP_UNITS = {
    F: { conv: (c) => c * 9 / 5 + 32, label: '°F' },
    C: { conv: (c) => c, label: '°C' }
};

const DEFAULTS = {
    units: { speed: 'mph', boost: 'psi', temp: 'F' },
    tickMs: 100,
    /* how long a reading counts; slow ones (intake temperature) longer */
    staleMs: { speedKmh: 1500, rpm: 1500, boostKpa: 1500, iatC: 10000 },
    liveHideMs: 5000,
    demoSeconds: 90,
    socketPath: undefined
};

const SILENT = { info() {}, warn() {}, error() {} };

class HudController extends EventEmitter {
    constructor(opts) {
        super();
        const o = opts || {};
        this.log = o.log || SILENT;
        this.now = o.now || Date.now;
        this.cfg = Object.assign({}, DEFAULTS, o.config || {});
        if (typeof this.cfg.staleMs === 'object') {
            this.cfg.staleMs = Object.assign({}, DEFAULTS.staleMs, this.cfg.staleMs);
        }
        this.cfg.units = Object.assign({}, DEFAULTS.units, (o.config && o.config.units) || {});
        this.speedUnit = SPEED_UNITS[this.cfg.units.speed] || SPEED_UNITS.mph;
        this.boostUnit = BOOST_UNITS[this.cfg.units.boost] || BOOST_UNITS.psi;
        this.tempUnit = TEMP_UNITS[this.cfg.units.temp] || TEMP_UNITS.F;
        this.client = o.client || new ClusterRender(APP, this.cfg.socketPath);
        this.connected = false;
        this.backend = '';
        this.hudSize = null;
        this.unsupported = '';
        this.hud = null;
        this.refs = {};
        this.mode = 'off';            /* off, demo or live */
        this.samples = {};            /* field -> { v, t } */
        this.demoStart = 0;
        this.timer = null;
        this.visible = false;
        this.hudTarget = { state: '', holder: '' };
        this.layerState = {};
        this.stats = { frames: 0, bytes: 0 };
        this.lastFresh = 0;
        this._wire();
    }

    _wire() {
        const c = this.client;
        c.on('ready', () => this._ready());
        c.on('disconnected', () => {
            this.connected = false;
            this.hudTarget = { state: '', holder: '' };
            this._changed();
        });
        c.on('target', (name, state, holder) => {
            if (name === TARGET) {
                this.hudTarget = { state, holder: holder || '' };
                this._changed();
            }
        });
        c.on('layer', (ref, state, reason) => {
            this.layerState[ref] = state;
            if (state === 'error') {
                this.log.warn(`HUD layer ${ref} refused by the renderer: ${reason}`);
            }
            this._changed();
        });
        c.on('refused', (op, ref, reason) => this.log.warn(`renderer refused ${op} ${ref}: ${reason}`));
    }

    open() {
        this.client.connect();
    }

    close() {
        this._stopTimer();
        this.client.close();
        this.connected = false;
    }

    /* ---- connection ------------------------------------------------------ */

    _ready() {
        this.connected = true;
        this.backend = this.client.backend;
        const m = /(?:^|,)hud:(\d+)x(\d+)/.exec(this.client.targets || '');
        this.hudSize = m ? { w: Number(m[1]), h: Number(m[2]) } : null;
        this.unsupported = '';
        if (this.backend !== 'id7') {
            this.unsupported = `This layout is for iDrive 7; the renderer reports ${this.backend || 'an unknown unit'}`;
        } else if (!this.hudSize) {
            this.unsupported = 'The renderer offers no HUD on this unit';
        }
        this.log.info(`renderer ${this.backend}, targets ${this.client.targets}${this.unsupported ? `: ${this.unsupported}` : ''}`);
        if (!this.unsupported && !this.hud) {
            this._build();
        }
        this._changed();
    }

    _build() {
        const cfg = {
            speedUnit: this.speedUnit.label,
            boostUnit: this.boostUnit.label,
            boostDecimals: this.boostUnit.dec,
            boostMin: this.boostUnit.min,
            boostMax: this.boostUnit.max,
            boostMid: this.boostUnit.mid,
            boostHigh: this.boostUnit.high,
            tempUnit: this.tempUnit.label
        };
        this.hud = new Hud(this.hudSize.w, this.hudSize.h, cfg);
        this.hud.full().forEach((l) => {
            const ref = this.client.image({ target: TARGET, klass: 'content', z: this.hud.get(l.id).z,
                x: l.rect.x, y: l.rect.y, w: l.rect.w, h: l.rect.h, iw: l.rect.w, ih: l.rect.h,
                fps: 10, visible: false, contend: true });
            if (!ref) {
                this.log.error(`the client refused the ${l.id} layer`);
                return;
            }
            this.refs[l.id] = ref;
            this.client.pixels(ref, null, l.pixels);
        });
    }

    /* ---- showing and hiding ------------------------------------------------ */

    _show(on) {
        if (!this.hud) {
            return;
        }
        this.visible = on;
        Object.keys(this.refs).forEach((id) => {
            this.client.set(this.refs[id], { visible: on && (id !== 'tag' || this.mode === 'demo') });
        });
    }

    ready() {
        return this.connected && !!this.hud && !this.unsupported;
    }

    /* ---- sources ----------------------------------------------------------- */

    startDemo(seconds) {
        if (!this.ready()) {
            return false;
        }
        this.mode = 'demo';
        this.demoStart = this.now();
        this.demoSeconds = seconds || this.cfg.demoSeconds;
        this.samples = {};
        this._show(true);
        this._startTimer();
        this._tick();
        this._changed();
        return true;
    }

    stop() {
        if (this.mode === 'off') {
            return;
        }
        this._stopTimer();
        this.mode = 'off';
        this.samples = {};
        this._tick();
        this._show(false);
        this._changed();
    }

    stopDemo() {
        if (this.mode === 'demo') {
            this.stop();
        }
    }

    /* The hook for a real source. Values are SI: km/h, rpm, kPa gauge, deg C. */
    feed(sample) {
        if (this.mode === 'demo' || !this.ready()) {
            return;
        }
        const t = this.now();
        FIELDS.forEach((f) => {
            if (sample && typeof sample[f] === 'number' && isFinite(sample[f])) {
                this.samples[f] = { v: sample[f], t };
            }
        });
        this.lastFresh = t;
        if (this.mode !== 'live') {
            this.mode = 'live';
            this._startTimer();
            this._changed();
        }
        if (!this.visible) {
            this._show(true);
        }
    }

    _startTimer() {
        if (!this.timer) {
            this.timer = setInterval(() => this._tick(), this.cfg.tickMs);
        }
    }

    _stopTimer() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /* ---- the frame ------------------------------------------------------------ */

    _display(now) {
        const staleOf = (f) => (typeof this.cfg.staleMs === 'number' ? this.cfg.staleMs : this.cfg.staleMs[f]);
        const fresh = (f) => {
            const s = this.samples[f];
            return s && now - s.t <= staleOf(f) ? s.v : null;
        };
        const num = (v, fn) => (v === null ? null : fn(v));
        return {
            speed: num(fresh('speedKmh'), (v) => v * this.speedUnit.f),
            rpm: num(fresh('rpm'), (v) => v),
            boost: num(fresh('boostKpa'), (v) => v * this.boostUnit.f),
            iat: num(fresh('iatC'), (v) => this.tempUnit.conv(v))
        };
    }

    _tick() {
        if (!this.hud) {
            return;
        }
        const now = this.now();
        if (this.mode === 'demo') {
            const elapsed = (now - this.demoStart) / 1000;
            if (elapsed >= this.demoSeconds) {
                this.log.info('demo finished');
                this.stop();
                return;
            }
            const d = demoSample(elapsed);
            FIELDS.forEach((f) => {
                this.samples[f] = { v: d[f], t: now };
            });
            this._changed();
        } else if (this.mode === 'live') {
            const anyFresh = FIELDS.some((f) => this.samples[f] && now - this.samples[f].t <= this.cfg.liveHideMs);
            if (!anyFresh && this.visible) {
                this._show(false);
            } else if (anyFresh && !this.visible) {
                this._show(true);
            }
        }
        /* missing values are drawn at once, whatever the pacing, so no forced time is needed */
        const frames = this.hud.render(this._display(now), now);
        frames.forEach((fr) => {
            if (this.client.pixels(this.refs[fr.id], fr.rects, fr.pixels)) {
                this.stats.frames++;
                this.stats.bytes += fr.pixels.length;
            }
        });
    }

    /* ---- what the page says -------------------------------------------------- */

    _where() {
        const t = this.hudTarget;
        if (t.state === 'shown') {
            return 'on the HUD';
        }
        if (t.state === 'waiting' || t.state === 'parked') {
            return t.holder ? `waiting for the HUD (${t.holder} content holds it)` : 'waiting for the HUD';
        }
        if (t.state === 'acquiring') {
            return 'asking for the HUD';
        }
        if (t.state === 'unavailable') {
            return 'the HUD is unavailable';
        }
        return t.state ? `HUD ${t.state}` : 'HUD not requested yet';
    }

    statusText() {
        if (!this.connected) {
            return 'Waiting for the cluster renderer…';
        }
        if (this.unsupported) {
            return this.unsupported;
        }
        if (this.mode === 'demo') {
            const left = Math.max(0, Math.ceil(this.demoSeconds - (this.now() - this.demoStart) / 1000));
            return `Demo, ${left} s left: ${this._where()}`;
        }
        if (this.mode === 'live') {
            return `Live values: ${this._where()}`;
        }
        return 'Ready. Nothing is drawn on the HUD.';
    }

    detailText() {
        if (!this.connected) {
            return `Renderer: not connected (${this._why()})`;
        }
        const size = this.hudSize ? `${this.hudSize.w}x${this.hudSize.h}` : 'none';
        return `Renderer ${this.backend || '?'}, HUD ${size}`;
    }

    /* Why the renderer cannot be reached, from what the socket looks like. */
    _why() {
        const file = this.client.path;
        if (!file) {
            return 'no socket path';
        }
        try {
            fs.statSync(file);
            return `${file} is there but refuses the connection`;
        } catch (e) {
            if (e && e.code === 'ENOENT') {
                return `cluster-render is not running: no ${file}`;
            }
            return `${file}: ${(e && e.code) || 'unreadable'}`;
        }
    }

    canStart() {
        return this.ready() && this.mode === 'off';
    }

    canStop() {
        return this.mode !== 'off';
    }

    _changed() {
        this.emit('change');
    }
}

module.exports = { HudController, SPEED_UNITS, BOOST_UNITS, TEMP_UNITS, DEFAULTS, TARGET };

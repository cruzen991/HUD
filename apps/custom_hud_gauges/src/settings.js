// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The two switches, kept in the app's data folder so they survive a restart.
 * A folder that cannot be written costs only that: the switches start from the
 * defaults every time.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* Both start off: nothing is drawn and nothing is asked of the car until the
 * driver turns it on. The engine reads are a second, separate step. */
const DEFAULTS = { hud: false, engine: false };

/* Crash guard for the automatic start. A start that was not followed by
 * STABLE_MS of running counts as a strike; MAX_STRIKES in a row and the
 * automatic start is switched off (the driver can switch it on again). */
const STABLE_MS = 30000;
const MAX_STRIKES = 3;

class Settings {
    constructor(dir, log) {
        this.dir = dir;
        this.file = path.join(dir, 'hud-gauges.json');
        this.log = log || { warn() {} };
        this.values = Object.assign({}, DEFAULTS);
        this.strikes = 0;
        this._stableTimer = null;
        this._load();
    }

    _load() {
        try {
            const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            Object.keys(DEFAULTS).forEach((k) => {
                if (typeof saved[k] === 'boolean') {
                    this.values[k] = saved[k];
                }
            });
            if (Number.isInteger(saved.strikes) && saved.strikes >= 0) {
                this.strikes = saved.strikes;
            }
        } catch (e) {
            /* none yet */
        }
    }

    _save() {
        try {
            fs.mkdirSync(this.dir);
        } catch (e) {
            /* exists, or cannot be made */
        }
        try {
            fs.writeFileSync(this.file, JSON.stringify(Object.assign({ strikes: this.strikes }, this.values)) + '\n');
        } catch (e) {
            this.log.warn('settings not saved: ' + ((e && e.message) || e));
        }
    }

    /* Called when the app is about to start the gauges by itself. Returns false,
     * and switches the gauges off, when the last starts did not survive. */
    beginAutoStart() {
        if (this.strikes >= MAX_STRIKES) {
            this.strikes = 0;
            this.values.hud = false;
            this._save();
            return false;
        }
        this.strikes++;
        this._save();
        clearTimeout(this._stableTimer);
        this._stableTimer = setTimeout(() => this.markStable(), STABLE_MS);
        if (this._stableTimer.unref) {
            this._stableTimer.unref();
        }
        return true;
    }

    markStable() {
        clearTimeout(this._stableTimer);
        this._stableTimer = null;
        if (this.strikes !== 0) {
            this.strikes = 0;
            this._save();
        }
    }

    get(key) {
        return this.values[key];
    }

    set(key, value) {
        if (!(key in DEFAULTS) || typeof value !== 'boolean') {
            return;
        }
        this.values[key] = value;
        if (key === 'hud') {
            this.strikes = 0;
        }
        this._save();
    }
}

module.exports = { Settings, DEFAULTS, STABLE_MS, MAX_STRIKES };

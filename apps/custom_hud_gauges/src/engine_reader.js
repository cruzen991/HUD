// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Boost and intake air temperature from the engine control unit (DME), read
 * through tasu_link.js (reading only).
 *
 * Identifiers and scalings are those of the B58 / B48 / B38 DME ("DME8FF_R"),
 * taken from apps/live_data of cauliflowermossgrape/idrive7-apps (MIT), which
 * decodes them on cars:
 *
 *   4205  charge pressure before the throttle   u16 x 0.078125    hPa, absolute
 *   4201  ambient pressure                      u16 x 0.0390625   hPa
 *   580F  intake air temperature                u8  x 0.75 - 48   deg C
 *
 * boost (gauge) = 4205 - 4201, in kPa; read as ONE request for both.
 * Where the unit refuses those identifiers the standard OBD-II PIDs are used:
 * 01 0B (manifold pressure, kPa absolute) less 01 33 (barometric, kPa), and
 * 01 0F (intake air, A - 40 deg C).
 */
'use strict';

const DME = 0x12;
const DID_BOOST = [0x42, 0x05, 0x42, 0x01];
const DID_IAT = [0x58, 0x0F];
const DID_RETRY_MS = 60000;
const BARO_OBD_MS = 20000;

const NRC_TEXT = { 0x11: 'service not supported', 0x12: 'sub-function not supported', 0x22: 'conditions not correct',
    0x31: 'out of range' };

function u16(b, i) {
    return b[i] * 256 + b[i + 1];
}

class EngineReader {
    constructor(link, opts) {
        const o = opts || {};
        this.link = link;
        this.ecu = o.ecu || DME;
        this.now = o.now || Date.now;
        this.log = o.log || { info() {}, warn() {} };
        this.via = { boost: 'did', iat: 'did' };       /* which way answers now */
        this.misses = { boost: 0, iat: 0 };            /* refusals or silence in a row on the identifier route */
        this.retryAt = { boost: 0, iat: 0 };
        this.baro = { kpa: null, t: 0 };
        this.last = { boost: '', iat: '' };            /* what the last read said, for the status page */
    }

    _note(what, text) {
        if (this.last[what] !== text) {
            this.last[what] = text;
            this.log.info('engine ' + what + ': ' + text);
        }
    }

    _refusal(uds) {
        return uds[0] === 0x7F ? 'refused (' + (NRC_TEXT[uds[2]] || '0x' + uds[2].toString(16)) + ')' : null;
    }

    /* After two answers in a row that are not the value, the standard PID route takes over for a while. */
    _miss(what, why) {
        this.misses[what]++;
        this._note(what, why);
        if (this.via[what] === 'did' && this.misses[what] >= 2) {
            this.via[what] = 'obd';
            this.retryAt[what] = this.now() + DID_RETRY_MS;
            this.misses[what] = 0;
            this._note(what, 'identifiers refused, using OBD-II PIDs');
        }
    }

    _ok(what, via) {
        this.misses[what] = 0;
        this._note(what, 'ok via ' + via);
    }

    _route(what) {
        if (this.via[what] === 'obd' && this.now() >= this.retryAt[what]) {
            this.via[what] = 'did';
            this.misses[what] = 0;
        }
        return this.via[what];
    }

    /* kPa above ambient (negative in vacuum), or null. */
    async boost() {
        if (this._route('boost') === 'did') {
            const uds = await this.link.read(this.ecu, 0x22, DID_BOOST);
            if (uds === undefined) {
                return null;
            }
            if (!uds) {
                this._miss('boost', 'no answer');
                return null;
            }
            const why = this._refusal(uds);
            if (why) {
                this._miss('boost', why);
                return null;
            }
            if (uds.length >= 9 && uds[0] === 0x62 && uds[1] === 0x42 && uds[2] === 0x05 && uds[5] === 0x42 && uds[6] === 0x01) {
                const abs = u16(uds, 3) * 0.078125;
                const amb = u16(uds, 7) * 0.0390625;
                if (abs >= 300 && abs <= 4000 && amb >= 450 && amb <= 1100) {
                    this._ok('boost', 'identifiers');
                    return (abs - amb) / 10;
                }
                this._miss('boost', 'implausible (' + abs.toFixed(0) + ' / ' + amb.toFixed(0) + ' hPa)');
                return null;
            }
            this._miss('boost', 'unexpected reply');
            return null;
        }
        /* OBD-II: manifold pressure now, barometric pressure now and then */
        const t = this.now();
        if (this.baro.kpa === null || t - this.baro.t >= BARO_OBD_MS) {
            const b = await this.link.read(this.ecu, 0x01, [0x33]);
            if (b && b[0] === 0x41 && b[1] === 0x33 && b.length >= 3 && b[2] >= 45 && b[2] <= 110) {
                this.baro = { kpa: b[2], t: t };
            } else if (b === undefined) {
                return null;
            }
        }
        const m = await this.link.read(this.ecu, 0x01, [0x0B]);
        if (m === undefined) {
            return null;
        }
        if (m && m[0] === 0x41 && m[1] === 0x0B && m.length >= 3 && this.baro.kpa !== null) {
            this._ok('boost', 'OBD-II');
            return m[2] - this.baro.kpa;
        }
        this._note('boost', !m ? 'OBD-II: no answer' : this._refusal(m) || 'OBD-II: unexpected reply');
        return null;
    }

    /* Degrees Celsius, or null. */
    async iat() {
        if (this._route('iat') === 'did') {
            const uds = await this.link.read(this.ecu, 0x22, DID_IAT);
            if (uds === undefined) {
                return null;
            }
            if (!uds) {
                this._miss('iat', 'no answer');
                return null;
            }
            const why = this._refusal(uds);
            if (why) {
                this._miss('iat', why);
                return null;
            }
            if (uds.length >= 4 && uds[0] === 0x62 && uds[1] === 0x58 && uds[2] === 0x0F) {
                const c = uds[3] * 0.75 - 48;
                if (c >= -45 && c <= 130) {
                    this._ok('iat', 'identifier');
                    return c;
                }
                this._miss('iat', 'implausible (' + c.toFixed(1) + ' C)');
                return null;
            }
            this._miss('iat', 'unexpected reply');
            return null;
        }
        const r = await this.link.read(this.ecu, 0x01, [0x0F]);
        if (r === undefined) {
            return null;
        }
        if (r && r[0] === 0x41 && r[1] === 0x0F && r.length >= 3) {
            const c = r[2] - 40;
            if (c >= -45 && c <= 130) {
                this._ok('iat', 'OBD-II');
                return c;
            }
        }
        this._note('iat', !r ? 'OBD-II: no answer' : this._refusal(r) || 'OBD-II: unexpected reply');
        return null;
    }
}

module.exports = { EngineReader, DME, DID_BOOST, DID_IAT };

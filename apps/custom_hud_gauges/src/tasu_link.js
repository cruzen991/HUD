// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The head unit's own diagnostic transport (TASU), restricted to READING one
 * engine control unit.
 *
 * The transport, as BMW's ts_diagnostic_service uses it and as
 * kit/runtime/diag.js of cauliflowermossgrape/idrive7-apps (MIT) documents:
 *
 *   request: sendTasuRequest{ sourceAddress 0xF2, targetAddress, serviceID,
 *            subroutineID 0, udsDataLength, udsData, deadlockTime 0 }
 *   reply:   event sendTasuResponse{ udsResponse, errorCode }. The frame has a
 *            9-byte header: [2] 0x7F = rejected by the transport (code in [4]),
 *            [6] = the answering unit's address, the UDS reply from [9] on.
 *
 * Every request passes check() before it can reach the transport. Allowed:
 *
 *   0x22 <DID>...   ReadDataByIdentifier, one to 8 identifiers, to one unit
 *   0x01 <PID>      OBD-II current data, one PID, to one unit
 *
 * Nothing else: no session change, no reset, no clearing, no security access,
 * no write, no routine, no tester present, no request to all units. One request
 * at a time, at least gapMs apart; a unit that did not answer silentAfter
 * requests in a row is skipped until wake().
 */
'use strict';

const EventEmitter = require('events');
const someip = require('./someip_native.js');

const IFACE = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
const INSTANCE = 'SystemFunctionsInternalTasuInst1';
const TESTER = 0xF2;
const ALL = 0xDF;
const MAX_DIDS = 8;
const READ = { 0x22: 'ReadDataByIdentifier', 0x01: 'OBD current data' };

const hex = (n, w) => n.toString(16).toUpperCase().padStart(w || 2, '0');
const isByte = (b) => Number.isInteger(b) && b >= 0 && b <= 0xFF;

/* Throws unless the request only reads. Exported for the tests. */
function check(target, sid, data) {
    if (!Array.isArray(data) || !data.every(isByte)) {
        throw new Error('read-only: bad request bytes');
    }
    if (!isByte(sid) || !READ[sid]) {
        throw new Error('read-only: service ' + String(sid) + ' is not allowed');
    }
    if (!isByte(target) || target === ALL) {
        throw new Error('read-only: a request goes to one unit, not ' + String(target));
    }
    if (sid === 0x22 && (data.length < 2 || data.length > 2 * MAX_DIDS || data.length % 2)) {
        throw new Error('read-only: 22 takes 1 to ' + MAX_DIDS + ' identifiers');
    }
    if (sid === 0x01 && data.length !== 1) {
        throw new Error('read-only: 01 takes exactly one PID');
    }
}

function toBytes(b) {
    if (!b) {
        return [];
    }
    if (Buffer.isBuffer(b) || b instanceof Uint8Array) {
        return Array.prototype.slice.call(b);
    }
    if (Array.isArray(b)) {
        return b.slice();
    }
    if (b.data) {
        return toBytes(b.data);
    }
    if (typeof b === 'object' && typeof b.length === 'number') {
        return Array.prototype.slice.call(b);
    }
    return [];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class TasuLink extends EventEmitter {
    constructor(opts) {
        super();
        const o = opts || {};
        this.log = o.log || { info() {}, warn() {}, error() {} };
        this.gapMs = o.gapMs || 25;
        this.silentAfter = o.silentAfter || 5;
        this.busyMs = o.busyMs || 100;
        this.p = null;
        this.available = false;
        this.error = null;
        this.misses = {};
        this.stats = { sent: 0, replies: 0, missed: 0, busy: 0, blocked: 0, refused: 0, ms: 0, timed: 0 };
        this.chain = Promise.resolve();
        this.next = 0;
        this.gen = 0;
    }

    async init() {
        if (this.p) {
            return this;
        }
        try {
            this.p = await someip.proxy(IFACE, INSTANCE);
            await someip.on(this.p, 'sendTasuResponse', (v) => this._onResponse(v), this.log);
            await someip.onAvailable(this.p, (a) => {
                this.available = a;
                this.emit('available', a);
            });
            this.error = null;
            this.log.info('TASU proxy ready (available=' + this.available + ')');
        } catch (e) {
            this.p = null;
            this.error = String((e && e.message) || e);
            this.log.warn('TASU: ' + this.error);
        }
        return this;
    }

    get ready() {
        return !!this.p;
    }

    close() {
        this.gen++;
        const p = this.p;
        this.p = null;
        this.available = false;
        if (p && p.shutdown) {
            try {
                p.shutdown();
            } catch (e) {
                /* gone */
            }
        }
    }

    silent(target) {
        return (this.misses[target] || 0) >= this.silentAfter;
    }

    wake(target) {
        if (target === undefined) {
            this.misses = {};
        } else {
            delete this.misses[target];
        }
    }

    /* Drop what is queued; those requests resolve with undefined. */
    cancel() {
        this.gen++;
    }

    _onResponse(v) {
        const err = v && v.errorCode;
        if (err !== undefined && err !== 'NO_ERROR' && err !== 0) {
            this.emit('tasError', String(err));
            return;
        }
        const b = toBytes(v && (v.udsResponse !== undefined ? v.udsResponse : v));
        if (b.length >= 5 && b[2] === 0x7F) {
            this.stats.refused++;
            this.emit('tasReject', b[4]);
            return;
        }
        if (b.length < 10) {
            return;
        }
        this.emit('frame', { ecu: b[6], uds: b.slice(9) });
    }

    /* The unit's reply to one read: the UDS bytes (positive reply or a refusal
     * 7F sid nrc), null when it did not answer, undefined when cancelled. */
    read(target, sid, data, timeoutMs) {
        const d = Array.isArray(data) ? data.slice() : data;     /* checked = sent */
        try {
            check(target, sid, d);
        } catch (e) {
            this.stats.blocked++;
            return Promise.reject(e);
        }
        if (!this.p) {
            return Promise.resolve(null);
        }
        if (this.silent(target)) {
            return Promise.resolve(null);
        }
        const gen = this.gen;
        const run = async () => {
            if (gen !== this.gen) {
                return undefined;
            }
            const wait = this.next - Date.now();
            if (wait > 0) {
                await sleep(wait);
            }
            if (gen !== this.gen || !this.p) {
                return undefined;
            }
            this.stats.sent++;
            const t0 = Date.now();
            const uds = await this._exchange(target, sid, d, timeoutMs || 1500);
            this.next = Date.now() + this.gapMs;
            if (!uds) {
                this.stats.missed++;
                this.misses[target] = (this.misses[target] || 0) + 1;
                if (this.silent(target)) {
                    this.log.info('unit ' + hex(target) + ': no answer ' + this.silentAfter + ' times in a row, skipped');
                }
                return null;
            }
            this.stats.ms += Date.now() - t0;
            this.stats.timed++;
            this.stats.replies++;
            this.misses[target] = 0;
            if (uds[0] === 0x7F && uds[2] === 0x21) {
                this.next = Math.max(this.next, Date.now() + 1000);
            }
            return uds;
        };
        const p = this.chain.then(run, run);
        this.chain = p.catch(() => {});
        return p;
    }

    /* Send one request and wait for the matching reply. */
    async _exchange(target, sid, data, timeoutMs) {
        /* a positive reply echoes the first identifier (22) or the PID (01), then the data */
        const echo = data.slice(0, sid === 0x22 ? 2 : 1);
        const mine = (uds) => (uds[0] === sid + 0x40 && echo.every((b, i) => uds[i + 1] === b)) ||
            (uds[0] === 0x7F && uds[1] === sid);
        let timer = null;
        let onFrame = null;
        let finish = null;
        let done = false;
        const got = new Promise((resolve) => {
            finish = (v) => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                this.removeListener('frame', onFrame);
                resolve(v);
            };
            onFrame = (f) => {
                if (f.ecu !== target) {
                    return;
                }
                if (f.uds[0] === 0x7F && f.uds[2] === 0x78) {        /* response pending: not the reply */
                    if (f.uds[1] === sid) {
                        clearTimeout(timer);
                        timer = setTimeout(() => finish(null), 5000);
                    }
                    return;
                }
                if (mine(f.uds)) {
                    finish(f.uds);
                }
            };
            this.on('frame', onFrame);
        });
        let verdict;
        try {
            verdict = await this._send(target, sid, data);
        } catch (e) {
            finish(null);
            this.error = String((e && e.message) || e);
            return null;
        }
        if (verdict !== 'NO_ERROR' && verdict !== 'REQUEST_PENDING' && verdict !== '0' && verdict !== '1') {
            this.stats.refused++;
            finish(null);
            return null;
        }
        if (!done) {
            timer = setTimeout(() => finish(null), timeoutMs);
        }
        return got;
    }

    /* The transport turns requests away while busy with another app's; try again soon. */
    async _send(target, sid, data) {
        for (let attempt = 0; ; attempt++) {
            const r = await someip.call(this.p, 'sendTasuRequest', {
                sourceAddress: TESTER, targetAddress: target, serviceID: sid, subroutineID: 0,
                udsDataLength: data.length, udsData: Buffer.from(data), deadlockTime: 0
            }, 5000);
            const v = r && typeof r === 'object' ?
                (r.TasuErrorEnum || Object.keys(r).map((k) => r[k]).find((x) => typeof x === 'string')) : r;
            const verdict = v === undefined ? 'NO_ERROR' : String(v);
            if (!/TEMPORARILY_NOT_ACCEPTED|BUSY/i.test(verdict) || attempt >= 4) {
                return verdict;
            }
            this.stats.busy++;
            await sleep(this.busyMs * (attempt + 1));
        }
    }
}

module.exports = { TasuLink, check, IFACE, INSTANCE, hex, MAX_DIDS };

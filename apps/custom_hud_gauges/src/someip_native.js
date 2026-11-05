// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Access to the head unit's SOME/IP services through the `someip` native module
 * the oap-sdk itself uses, with the interface descriptions MainApp writes into
 * the app's someipInterfaces/ folder from its manifest.json.
 *
 * The way of calling it (one native call per event-loop turn, never next to
 * the SDK's own traffic; subscribe to a field and also read it once) follows
 * kit/runtime/signals.js of cauliflowermossgrape/idrive7-apps (MIT), which runs
 * on cars.
 *
 * `someip` is loaded by a name built at run time, so the app linker does not
 * take it for one of the app's own modules: the head unit's own require
 * resolves it. Where it is missing (a desk), everything here reports it.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let someip = null;
let loadError = null;
function native() {
    if (someip || loadError) {
        return someip;
    }
    try {
        const name = ['some', 'ip'].join('');
        someip = require(name);
    } catch (e) {
        loadError = String((e && e.message) || e);
    }
    return someip;
}

/* tests put a fake module here */
function useNative(mod) {
    someip = mod || null;
    loadError = mod ? null : 'someip native module not available';
}

const dirs = [
    path.join(__dirname, '..', '..', 'someipInterfaces'),
    path.join(__dirname, '..', 'someipInterfaces'),
    path.join(process.cwd(), 'someipInterfaces')
];
/* tests point it at their own folder */
function addConfigDir(dir) {
    dirs.unshift(dir);
}

function setConfigDirs(list) {
    dirs.length = 0;
    list.forEach((d) => dirs.push(d));
}

function loadConfig(iface) {
    const file = iface.replace(/\./g, '_') + '.json';
    for (let i = 0; i < dirs.length; i++) {
        try {
            return JSON.parse(fs.readFileSync(path.join(dirs[i], file), 'utf8'));
        } catch (e) {
            /* next folder */
        }
    }
    throw new Error('no SOME/IP config for ' + iface + ' (is it in the manifest the unit installed?)');
}

/* The native binding deadlocks when buildProxy, init and subscribe run inline
 * inside promise chains next to the SDK's own SOME/IP traffic; the SDK calls
 * them from a fresh setImmediate turn, one at a time. So do we. */
let chain = Promise.resolve();
function nativeTick(fn) {
    const run = () => new Promise((resolve, reject) => {
        setImmediate(() => {
            try {
                Promise.resolve(fn()).then(resolve, reject);
            } catch (e) {
                reject(e);
            }
        });
    });
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
}

function available() {
    return !!native();
}

function unavailableReason() {
    native();
    return loadError;
}

/* A proxy for one interface instance, initialised. */
function proxy(iface, instance) {
    const mod = native();
    if (!mod) {
        return Promise.reject(new Error(loadError));
    }
    const cfg = loadConfig(iface);
    return nativeTick(() => mod.buildProxy(cfg, String(instance)).then((p) => p.init().then(() => p)));
}

function call(p, method, params, timeoutMs) {
    return nativeTick(() => p.callMethod(method, params || {}, timeoutMs || 5000));
}

/* Subscribe to a broadcast or a field of a proxy. */
function on(p, name, fn, log) {
    return nativeTick(() => p.subscribe({
        name: name,
        onReceive: (v) => {
            try {
                fn(v);
            } catch (e) {
                if (log) {
                    log.warn(name + ': ' + e);
                }
            }
        }
    }));
}

/* fn(bool) on every change of the provider's availability. */
function onAvailable(p, fn) {
    return nativeTick(() => {
        try {
            return p.subscribeToAvailability((a) => fn(!!a));
        } catch (e) {
            return null;
        }
    }).then(() => {
        if (p.isAvailable && p.isAvailable()) {
            fn(true);
        }
    });
}

/**
 * Watch fields of one interface: handlers = { field: fn(value) }. Each field is
 * subscribed and, when it has a getter, read once when the provider is there.
 * Resolves with { available, proxy, error, shutdown() }.
 */
async function watch(iface, instance, handlers, log) {
    const res = { iface: iface, available: false, proxy: null, error: null, shutdown: () => Promise.resolve() };
    try {
        const cfg = loadConfig(iface);
        const p = await proxy(iface, instance);
        res.proxy = p;
        res.shutdown = () => Promise.resolve().then(() => p.shutdown && p.shutdown()).catch(() => {});
        const fields = Object.keys(handlers);
        const fetchAll = () => fields.forEach((f) => {
            if (cfg.fields && cfg.fields[f] && cfg.fields[f].getter) {
                p.getValue(f, 3000).then((v) => handlers[f](v)).catch(() => {});
            }
        });
        await nativeTick(() => {
            try {
                return p.subscribeToAvailability((a) => {
                    res.available = !!a;
                    if (a) {
                        setImmediate(fetchAll);
                    }
                });
            } catch (e) {
                return null;
            }
        });
        for (let i = 0; i < fields.length; i++) {
            const f = fields[i];
            try {
                await on(p, f, handlers[f], log);
            } catch (e) {
                if (log) {
                    log.warn('subscribe ' + iface + '.' + f + ': ' + e);
                }
            }
        }
        if (p.isAvailable && p.isAvailable()) {
            res.available = true;
            fetchAll();
        }
    } catch (e) {
        res.error = String((e && e.message) || e);
        if (log) {
            log.warn('signals ' + iface + ': ' + res.error);
        }
    }
    return res;
}

module.exports = { available, unavailableReason, useNative, addConfigDir, setConfigDirs, loadConfig, proxy, call, on, onAvailable, watch };

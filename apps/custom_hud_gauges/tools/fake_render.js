// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/**
 * A stand-in for the cluster-render socket (PROTOCOL.md), for tests and desk
 * runs. Answers a client's hello, remembers each layer, applies image frames
 * to a per-layer picture and keeps every message it received.
 *
 *   const srv = new FakeRender(path, { backend: 'id7', targets: 'map:1088x480,panel:1920x720,hud:800x480' });
 *   await srv.listen();
 */
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');

class FakeRender extends EventEmitter {
    constructor(sockPath, opts) {
        super();
        const o = opts || {};
        this.path = sockPath;
        this.backend = o.backend || 'id7';
        this.targets = o.targets || 'map:1088x480,panel:1920x720,hud:800x480';
        this.received = [];
        this.layers = {};        /* ref -> { msg, image, frames, bytes } */
        this.clients = new Set();
        this.hellos = 0;
        this.server = net.createServer((s) => this._client(s));
    }

    listen() {
        try { fs.unlinkSync(this.path); } catch (e) { /* none */ }
        return new Promise((resolve) => this.server.listen(this.path, resolve));
    }

    close() {
        this.dropClients();
        return new Promise((resolve) => this.server.close(() => resolve()));
    }

    dropClients() {
        this.clients.forEach((s) => s.destroy());
        this.layers = {};
    }

    send(obj) {
        const body = Buffer.from(JSON.stringify(obj));
        const m = Buffer.alloc(5 + body.length);
        m.writeUInt32LE(body.length + 1, 0);
        m[4] = 0x4a;
        body.copy(m, 5);
        this.clients.forEach((s) => { if (!s.destroyed) s.write(m); });
    }

    _client(s) {
        this.clients.add(s);
        let buf = Buffer.alloc(0);
        s.on('error', () => {});
        s.on('close', () => { this.clients.delete(s); });
        s.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            while (buf.length >= 5) {
                const len = buf.readUInt32LE(0);
                if (buf.length < 4 + len) break;
                const type = buf[4];
                const body = buf.slice(5, 4 + len);
                buf = buf.slice(4 + len);
                if (type === 0x4a) this._json(JSON.parse(body.toString('utf8')));
                else if (type === 0x46) this._frame(body);
            }
        });
    }

    _json(m) {
        this.received.push(m);
        if (m.op === 'hello') {
            this.hellos++;
            this.send({ ev: 'hello', proto: 1, backend: this.backend, targets: this.targets });
        } else if (m.op === 'layer') {
            this.layers[m.ref] = { msg: Object.assign({}, m), image: Buffer.alloc(m.iw * m.ih * 4), frames: 0, bytes: 0, wholes: 0 };
        } else if (m.op === 'set' && this.layers[m.ref]) {
            Object.assign(this.layers[m.ref].msg, m);
        }
        this.emit('message', m);
    }

    _frame(body) {
        const ref = body.readUInt32LE(0);
        const n = body.readUInt16LE(12);
        const L = this.layers[ref];
        if (!L) return;
        let off = 14 + n * 8;
        L.frames++;
        L.bytes += body.length;
        if (n === 0) {
            body.copy(L.image, 0, off);
            L.wholes++;
        } else {
            for (let i = 0; i < n; i++) {
                const x = body.readUInt16LE(14 + i * 8), y = body.readUInt16LE(16 + i * 8);
                const w = body.readUInt16LE(18 + i * 8), h = body.readUInt16LE(20 + i * 8);
                for (let r = 0; r < h; r++) {
                    body.copy(L.image, ((y + r) * L.msg.iw + x) * 4, off, off + w * 4);
                    off += w * 4;
                }
            }
        }
        this.emit('frame', ref, L);
    }

    layerByTarget(target) {
        return Object.keys(this.layers).map((r) => Number(r)).filter((r) => this.layers[r].msg.target === target);
    }

    count(op) {
        return this.received.filter((m) => m.op === op).length;
    }
}

module.exports = { FakeRender };

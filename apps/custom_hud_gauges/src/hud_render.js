'use strict';
/**
 * The HUD gauges' pixels: RPM bar with its numbers, speed, boost and intake
 * air temperature, drawn into small RGBA image layers (straight alpha, a clear
 * background: the HUD lights only what is drawn). Nothing here touches the
 * car; it is plain JavaScript on Buffers, so it runs the same on a desk.
 *
 *   const hud = new Hud(800, 480, cfg);
 *   hud.full()                 -> every layer's whole picture (after a (re)connect)
 *   hud.render(values, now)    -> only what changed: [{ id, rects, pixels }]
 *
 * `values` are display numbers { speed, rpm, boost, iat }, each a number or
 * null for "no fresh value" (the gauge then shows dashes, never the last
 * reading). Everything is laid out for 800x480 and scaled to the size the
 * service reports for the HUD. Node 8 syntax.
 */

const { textMask, SevenSeg } = require('./hud_font.js');

const COLORS = {
    low: [0, 214, 255, 255],
    mid: [255, 196, 0, 255],
    high: [255, 56, 56, 255],
    vacuum: [90, 150, 255, 255],
    off: [120, 130, 140, 70],
    text: [255, 255, 255, 255],
    label: [160, 180, 200, 255],
    dim: [120, 130, 140, 200],
    demo: [255, 196, 0, 255]
};

const DEFAULTS = {
    rpmMax: 7000,        /* the bar's end */
    rpmStep: 200,        /* rpm per segment */
    rpmAmber: 5000,      /* segments from here are amber */
    rpmRed: 6200,        /* and from here red */
    speedUnit: 'MPH',
    boostUnit: 'PSI',
    boostDecimals: 1,
    boostMin: -14.7,     /* the boost bar's ends, in the boost unit */
    boostMax: 30,
    boostMid: 15,        /* the bar turns amber, then red, from here */
    boostHigh: 24,
    tempUnit: '°F',
    speedMinMs: 250,     /* the fastest a number is redrawn */
    rpmMinMs: 200,
    boostMinMs: 250,
    iatMinMs: 1000
};

/* ---- pixels ------------------------------------------------------------- */

class Raster {
    constructor(w, h) {
        this.w = w;
        this.h = h;
        this.data = Buffer.alloc(w * h * 4);
    }

    clear(x, y, w, h) {
        const r = clip({ x, y, w, h }, this.w, this.h);
        if (!r) {
            return;
        }
        for (let yy = r.y; yy < r.y + r.h; yy++) {
            const o = (yy * this.w + r.x) * 4;
            this.data.fill(0, o, o + r.w * 4);
        }
    }

    fill(x, y, w, h, c) {
        const r = clip({ x, y, w, h }, this.w, this.h);
        if (!r) {
            return;
        }
        for (let yy = r.y; yy < r.y + r.h; yy++) {
            for (let xx = r.x; xx < r.x + r.w; xx++) {
                this.put(xx, yy, c, 255);
            }
        }
    }

    /* A parallelogram: the top leans right by `skew` pixels. */
    skewFill(x, y, w, h, skew, c) {
        for (let r = 0; r < h; r++) {
            const shift = h > 1 ? Math.round(skew * (h - 1 - r) / (h - 1)) : 0;
            this.fill(x + shift, y + r, w, 1, c);
        }
    }

    put(x, y, c, cover) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h || cover <= 0) {
            return;
        }
        const a = Math.round(cover * c[3] / 255);
        const o = (y * this.w + x) * 4;
        if (a >= this.data[o + 3]) {
            this.data[o] = c[0];
            this.data[o + 1] = c[1];
            this.data[o + 2] = c[2];
            this.data[o + 3] = a;
        }
    }

    mask(m, x, y, c) {
        for (let my = 0; my < m.h; my++) {
            for (let mx = 0; mx < m.w; mx++) {
                const cover = m.data[my * m.w + mx];
                if (cover) {
                    this.put(x + mx, y + my, c, cover);
                }
            }
        }
    }
}

function clip(r, w, h) {
    const x0 = Math.max(0, Math.round(r.x));
    const y0 = Math.max(0, Math.round(r.y));
    const x1 = Math.min(w, Math.round(r.x + r.w));
    const y1 = Math.min(h, Math.round(r.y + r.h));
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/* The smallest box around the pixels of r that differ between cur and prev. */
function diffBox(cur, prev, width, r) {
    let minX = r.x + r.w;
    let maxX = -1;
    let minY = r.y + r.h;
    let maxY = -1;
    for (let y = r.y; y < r.y + r.h; y++) {
        const o = (y * width + r.x) * 4;
        if (cur.compare(prev, o, o + r.w * 4, o, o + r.w * 4) === 0) {
            continue;
        }
        let a = 0;
        while (a < r.w && cur.readUInt32LE(o + a * 4) === prev.readUInt32LE(o + a * 4)) {
            a++;
        }
        let b = r.w - 1;
        while (b > a && cur.readUInt32LE(o + b * 4) === prev.readUInt32LE(o + b * 4)) {
            b--;
        }
        minX = Math.min(minX, r.x + a);
        maxX = Math.max(maxX, r.x + b);
        minY = Math.min(minY, y);
        maxY = y;
    }
    return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/* ---- layers -------------------------------------------------------------- */

class Layer {
    constructor(rect) {
        this.rect = rect;
        this.raster = new Raster(rect.w, rect.h);
        this.prev = Buffer.alloc(rect.w * rect.h * 4);
        this.dirty = [];
    }

    mark(x, y, w, h) {
        this.dirty.push({ x, y, w, h });
    }

    /* The rectangles that really changed since the last commit or full(). */
    commit() {
        const out = [];
        const cands = this.dirty;
        this.dirty = [];
        cands.forEach((c) => {
            const r = clip(c, this.rect.w, this.rect.h);
            const box = r && diffBox(this.raster.data, this.prev, this.rect.w, r);
            if (!box) {
                return;
            }
            for (let y = box.y; y < box.y + box.h; y++) {
                const o = (y * this.rect.w + box.x) * 4;
                this.raster.data.copy(this.prev, o, o, o + box.w * 4);
            }
            out.push(box);
        });
        return out;
    }

    /* The rows of rects, one after another, as the protocol's frames carry them. */
    pack(rects) {
        const rows = [];
        rects.forEach((r) => {
            for (let y = 0; y < r.h; y++) {
                const o = ((r.y + y) * this.rect.w + r.x) * 4;
                rows.push(this.raster.data.slice(o, o + r.w * 4));
            }
        });
        return Buffer.concat(rows);
    }

    full() {
        this.dirty = [];
        this.raster.data.copy(this.prev);
        return this.raster.data;
    }
}

/* Numbers in seven-segment digits, right-aligned in an area. */
function drawNumber(raster, seg, text, area, color, gap) {
    raster.clear(area.x, area.y, area.w, area.h);
    const dp = Math.max(2, seg.t);
    let width = 0;
    const items = text.split('').map((ch) => {
        const adv = ch === '.' ? dp : seg.cellW;
        width += adv + gap;
        return { ch, adv };
    });
    width -= items.length ? gap : 0;
    let x = area.x + area.w - width;
    items.forEach((it) => {
        if (it.ch === '.') {
            raster.fill(x, area.y + seg.h - dp, dp, dp, color);
        } else {
            raster.mask(seg.mask(it.ch), x, area.y, color);
        }
        x += it.adv + gap;
    });
}

function drawText(raster, text, x, y, scale, color) {
    const m = textMask(text, scale);
    raster.mask(m, x, y, color);
    return m;
}

class BarLayer extends Layer {
    constructor(rect, lay, cfg) {
        super(rect);
        const S = lay.S;
        this.cfg = cfg;
        this.n = Math.round(cfg.rpmMax / cfg.rpmStep);
        this.skew = S(6);
        this.gap = Math.max(1, S(4));
        this.pitch = Math.floor((rect.w - this.skew) / this.n);
        this.segW = this.pitch - this.gap;
        this.segH = S(50);
        this.seg = new SevenSeg(S(20), S(38), S(5), 0.12);
        this.digitGap = S(6);
        this.numY = rect.h - this.seg.h - S(2);
        this.numArea = { x: rect.w - (4 * (this.seg.cellW + this.digitGap) - this.digitGap), y: this.numY,
            w: 4 * (this.seg.cellW + this.digitGap) - this.digitGap, h: this.seg.h };
        this.lit = 0;
        this.text = null;
        this.lastNum = -1e9;
        this.labelScale = Math.max(1, Math.round(3 * lay.k));
        this._static(lay);
        for (let i = 0; i < this.n; i++) {
            this._segment(i, false);
        }
        this._number('----', true);
    }

    _static(lay) {
        const S = lay.S;
        const tickTop = this.segH + S(4);
        const labelY = tickTop + S(8);
        const ticks = Math.floor(this.cfg.rpmMax / 1000);
        for (let i = 0; i <= ticks; i++) {
            const idx = i * 1000 / this.cfg.rpmStep;
            const x = Math.min(this.rect.w - 1, Math.round(idx * this.pitch - (i === ticks ? this.gap : 0)));
            this.raster.fill(x, tickTop, Math.max(1, S(2)), S(6), COLORS.label);
            const m = textMask(String(i), this.labelScale);
            const lx = Math.max(0, Math.min(this.rect.w - m.w, Math.round(x - m.w / 2)));
            this.raster.mask(m, lx, labelY, COLORS.label);
        }
        const rpm = textMask('RPM', this.labelScale);
        this.raster.mask(rpm, this.numArea.x - S(12) - rpm.w, this.numY + this.seg.h - rpm.h, COLORS.label);
    }

    _color(i) {
        const rpm = i * this.cfg.rpmStep;
        return rpm >= this.cfg.rpmRed ? COLORS.high : rpm >= this.cfg.rpmAmber ? COLORS.mid : COLORS.low;
    }

    _segment(i, on) {
        this.raster.clear(i * this.pitch, 0, this.segW + this.skew, this.segH);
        this.raster.skewFill(i * this.pitch, 0, this.segW, this.segH, this.skew, on ? this._color(i) : COLORS.off);
    }

    _number(text, stale) {
        drawNumber(this.raster, this.seg, text, this.numArea, stale ? COLORS.dim : COLORS.text, this.digitGap);
        this.mark(this.numArea.x, this.numArea.y, this.numArea.w, this.numArea.h);
        this.text = text;
    }

    update(st, now) {
        const rpm = st.rpm;
        const lit = rpm === null || rpm === undefined ? 0 :
            Math.max(0, Math.min(this.n, Math.round(rpm / this.cfg.rpmStep)));
        if (lit !== this.lit) {
            const lo = Math.min(lit, this.lit);
            const hi = Math.max(lit, this.lit);
            /* A segment's clear also takes the slanted edge of its left
             * neighbour, so every segment from lo on is drawn again, in order:
             * the picture is then the one a fresh bar has. Only what differs
             * is sent. */
            for (let i = lo; i < this.n; i++) {
                this._segment(i, i < lit);
            }
            this.mark(Math.max(0, lo - 1) * this.pitch, 0, this.rect.w - Math.max(0, lo - 1) * this.pitch, this.segH);
            this.lit = lit;
        }
        const stale = rpm === null || rpm === undefined;
        const text = stale ? '----' : String(Math.round(rpm / 10) * 10).padStart(4, ' ');
        if (text !== this.text && (stale || now - this.lastNum >= this.cfg.rpmMinMs)) {
            this._number(text, stale);
            this.lastNum = now;
        }
    }
}

class SpeedLayer extends Layer {
    constructor(rect, lay, cfg) {
        super(rect);
        const S = lay.S;
        this.cfg = cfg;
        this.seg = new SevenSeg(S(72), S(124), S(15), 0.12);
        this.gap = S(10);
        this.y0 = S(4);
        this.cells = ['?', '?', '?'];
        this.lastWrite = -1e9;
        const s4 = Math.max(1, Math.round(4 * lay.k));
        const unit = textMask(cfg.speedUnit, s4);
        const ux = 3 * this.seg.cellW + 2 * this.gap + S(14);
        this.raster.mask(unit, ux, this.y0 + this.seg.h - unit.h, COLORS.label);
        this._cells('---');
    }

    _cells(text) {
        const stale = text.indexOf('-') >= 0;
        for (let i = 0; i < 3; i++) {
            if (this.cells[i] === text[i]) {
                continue;
            }
            const x = i * (this.seg.cellW + this.gap);
            this.raster.clear(x, this.y0, this.seg.cellW, this.seg.h);
            this.raster.mask(this.seg.mask(text[i]), x, this.y0, stale ? COLORS.dim : COLORS.text);
            this.mark(x, this.y0, this.seg.cellW, this.seg.h);
            this.cells[i] = text[i];
        }
    }

    update(st, now) {
        const v = st.speed;
        const stale = v === null || v === undefined;
        const text = stale ? '---' : String(Math.max(0, Math.min(999, Math.round(v)))).padStart(3, ' ');
        if (text !== this.cells.join('') && (stale || now - this.lastWrite >= this.cfg.speedMinMs)) {
            this._cells(text);
            this.lastWrite = now;
        }
    }
}

/* A label, a number in seven-segment digits and its unit; optionally a bar. */
class ValueLayer extends Layer {
    constructor(rect, lay, cfg, opts) {
        super(rect);
        const S = lay.S;
        this.cfg = cfg;
        this.opts = opts;
        this.seg = new SevenSeg(S(30), S(50), S(7), 0.12);
        this.gap = S(6);
        const s3 = Math.max(1, Math.round(3 * lay.k));
        this.numArea = { x: 0, y: S(26), w: S(200), h: this.seg.h };
        drawText(this.raster, opts.label, 0, 0, s3, COLORS.label);
        const unit = textMask(opts.unit, s3);
        this.raster.mask(unit, this.numArea.w + S(10), this.numArea.y + this.seg.h - unit.h, COLORS.label);
        this.text = null;
        this.lastWrite = -1e9;
        this.bar = opts.bar ? { x: 0, y: this.numArea.y + this.seg.h + S(8), w: rect.w, h: S(12), tick: S(16) } : null;
        this.barKey = null;
        this._number('--', true);
        if (this.bar) {
            this._bar(null);
        }
    }

    _number(text, stale) {
        drawNumber(this.raster, this.seg, text, this.numArea, stale ? COLORS.dim : COLORS.text, this.gap);
        this.mark(this.numArea.x, this.numArea.y, this.numArea.w, this.numArea.h);
        this.text = text;
    }

    _bar(v) {
        const b = this.bar;
        const lo = this.cfg.boostMin;
        const hi = this.cfg.boostMax;
        const at = (x) => Math.round((Math.max(lo, Math.min(hi, x)) - lo) / (hi - lo) * (b.w - 1));
        const top = b.y - Math.round((b.tick - b.h) / 2);
        this.raster.clear(b.x, top, b.w, b.tick);
        this.raster.fill(b.x, b.y, b.w, b.h, COLORS.off);
        if (v !== null) {
            const zero = at(0);
            const x = at(v);
            const color = v < 0 ? COLORS.vacuum : v >= this.cfg.boostHigh ? COLORS.high :
                v >= this.cfg.boostMid ? COLORS.mid : COLORS.low;
            this.raster.fill(Math.min(zero, x), b.y, Math.abs(x - zero) + 1, b.h, color);
        }
        this.raster.fill(at(0), top, Math.max(1, Math.round(b.h / 5)), b.tick, COLORS.label);
        this.mark(b.x, top, b.w, b.tick);
    }

    update(st, now) {
        const v = st[this.opts.field];
        const stale = v === null || v === undefined;
        let text;
        if (stale) {
            text = '--';
        } else if (this.opts.decimals > 0) {
            text = v.toFixed(this.opts.decimals);
            if (/^-0(\.0*)?$/.test(text)) {
                text = text.slice(1);
            }
        } else {
            text = String(Math.round(v));
        }
        if (text !== this.text && (stale || now - this.lastWrite >= this.opts.minMs)) {
            this._number(text, stale);
            this.lastWrite = now;
            if (this.bar) {
                const key = stale ? 'x' : Math.round(v * 4);
                if (key !== this.barKey) {
                    this.barKey = key;
                    this._bar(stale ? null : v);
                }
            }
        }
    }
}

class TagLayer extends Layer {
    constructor(rect, lay, text, color) {
        super(rect);
        const m = textMask(text, Math.max(1, Math.round(4 * lay.k)));
        this.raster.mask(m, 0, Math.round((rect.h - m.h) / 2), color);
    }

    update() {}
}

/* ---- the whole HUD ---------------------------------------------------------- */

function layoutFor(W, H) {
    const k = Math.min(W / 800, H / 480);
    const ox = (W - 800 * k) / 2;
    const oy = (H - 480 * k) / 2;
    const S = (v) => Math.max(1, Math.round(v * k));
    const R = (x, y, w, h) => ({ x: Math.round(ox + x * k), y: Math.round(oy + y * k), w: S(w), h: S(h) });
    return {
        W, H, k, S,
        rects: {
            bar: R(44, 6, 712, 132),
            tag: R(44, 102, 120, 28),
            speed: R(210, 148, 380, 132),
            boost: R(50, 320, 330, 100),
            iat: R(420, 320, 330, 100)
        }
    };
}

class Hud {
    constructor(W, H, cfg) {
        this.cfg = Object.assign({}, DEFAULTS, cfg || {});
        this.lay = layoutFor(W, H);
        const r = this.lay.rects;
        this.layers = [
            { id: 'bar', z: 0, layer: new BarLayer(r.bar, this.lay, this.cfg) },
            { id: 'speed', z: 1, layer: new SpeedLayer(r.speed, this.lay, this.cfg) },
            { id: 'boost', z: 2, layer: new ValueLayer(r.boost, this.lay, this.cfg, { label: 'BOOST', unit: this.cfg.boostUnit,
                field: 'boost', decimals: this.cfg.boostDecimals, minMs: this.cfg.boostMinMs, bar: true }) },
            { id: 'iat', z: 3, layer: new ValueLayer(r.iat, this.lay, this.cfg, { label: 'IAT', unit: this.cfg.tempUnit,
                field: 'iat', decimals: 0, minMs: this.cfg.iatMinMs, bar: false }) },
            { id: 'tag', z: 4, layer: new TagLayer(r.tag, this.lay, 'DEMO', COLORS.demo) }
        ];
    }

    get(id) {
        return this.layers.filter((l) => l.id === id)[0];
    }

    /* Every layer's whole picture, as the service needs it after a (re)connect. */
    full() {
        return this.layers.map((l) => ({ id: l.id, rect: l.layer.rect, pixels: l.layer.full() }));
    }

    render(values, now) {
        const out = [];
        this.layers.forEach((l) => {
            l.layer.update(values, now);
            const rects = l.layer.commit();
            if (rects.length) {
                out.push({ id: l.id, rects, pixels: l.layer.pack(rects) });
            }
        });
        return out;
    }

    /* The layers laid over `bg` ([r, g, b]) as one W x H RGBA picture, for previews. */
    composite(bg, only) {
        const { W, H } = this.lay;
        const buf = Buffer.alloc(W * H * 4);
        for (let i = 0; i < W * H; i++) {
            buf[i * 4] = bg[0];
            buf[i * 4 + 1] = bg[1];
            buf[i * 4 + 2] = bg[2];
            buf[i * 4 + 3] = 255;
        }
        this.layers.forEach((l) => {
            if (only && only.indexOf(l.id) < 0) {
                return;
            }
            const r = l.layer.rect;
            const d = l.layer.raster.data;
            for (let y = 0; y < r.h; y++) {
                for (let x = 0; x < r.w; x++) {
                    const s = (y * r.w + x) * 4;
                    const a = d[s + 3] / 255;
                    if (!a || r.x + x < 0 || r.y + y < 0 || r.x + x >= W || r.y + y >= H) {
                        continue;
                    }
                    const o = ((r.y + y) * W + r.x + x) * 4;
                    for (let c = 0; c < 3; c++) {
                        buf[o + c] = Math.round(d[s + c] * a + buf[o + c] * (1 - a));
                    }
                }
            }
        });
        return buf;
    }
}

module.exports = { Hud, Raster, Layer, DEFAULTS, COLORS, layoutFor, diffBox };

'use strict';
/**
 * Glyph masks for the HUD gauges: a 5x7 bitmap font (upper case, digits and a
 * few symbols) and anti-aliased, slanted seven-segment digits. A mask is
 * { w, h, data } with data a Uint8Array of coverage, 0-255, row by row.
 * No dependencies; Node 8 syntax.
 */

const COLS = 5;
const ROWS = 7;

const GLYPH_SRC = {
    ' ': '.....|.....|.....|.....|.....|.....|.....',
    '-': '.....|.....|.....|#####|.....|.....|.....',
    '.': '.....|.....|.....|.....|.....|.##..|.##..',
    ':': '.....|.##..|.##..|.....|.##..|.##..|.....',
    '/': '....#|....#|...#.|..#..|.#...|#....|#....',
    '%': '##..#|##..#|...#.|..#..|.#...|#..##|#..##',
    '+': '.....|..#..|..#..|#####|..#..|..#..|.....',
    '°': '.##..|#..#.|#..#.|.##..|.....|.....|.....',
    '0': '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.',
    '1': '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
    '2': '.###.|#...#|....#|...#.|..#..|.#...|#####',
    '3': '####.|....#|....#|.###.|....#|....#|####.',
    '4': '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.',
    '5': '#####|#....|####.|....#|....#|#...#|.###.',
    '6': '..##.|.#...|#....|####.|#...#|#...#|.###.',
    '7': '#####|....#|...#.|..#..|.#...|.#...|.#...',
    '8': '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
    '9': '.###.|#...#|#...#|.####|....#|...#.|.##..',
    'A': '.###.|#...#|#...#|#####|#...#|#...#|#...#',
    'B': '####.|#...#|#...#|####.|#...#|#...#|####.',
    'C': '.###.|#...#|#....|#....|#....|#...#|.###.',
    'D': '####.|#...#|#...#|#...#|#...#|#...#|####.',
    'E': '#####|#....|#....|####.|#....|#....|#####',
    'F': '#####|#....|#....|####.|#....|#....|#....',
    'G': '.###.|#...#|#....|#.###|#...#|#...#|.###.',
    'H': '#...#|#...#|#...#|#####|#...#|#...#|#...#',
    'I': '.###.|..#..|..#..|..#..|..#..|..#..|.###.',
    'J': '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
    'K': '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
    'L': '#....|#....|#....|#....|#....|#....|#####',
    'M': '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#',
    'N': '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#',
    'O': '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
    'P': '####.|#...#|#...#|####.|#....|#....|#....',
    'Q': '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#',
    'R': '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
    'S': '.####|#....|#....|.###.|....#|....#|####.',
    'T': '#####|..#..|..#..|..#..|..#..|..#..|..#..',
    'U': '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
    'V': '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
    'W': '#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#',
    'X': '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
    'Y': '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
    'Z': '#####|....#|...#.|..#..|.#...|#....|#####'
};

const GLYPHS = {};
Object.keys(GLYPH_SRC).forEach((ch) => {
    GLYPHS[ch] = GLYPH_SRC[ch].split('|');
});

/* The mask of `text` at an integer scale: 5x7 cells, one cell between letters. */
function textMask(text, scale) {
    const s = Math.max(1, Math.round(scale));
    const chars = String(text).toUpperCase().split('');
    const w = chars.length ? (chars.length * (COLS + 1) - 1) * s : 0;
    const h = ROWS * s;
    const data = new Uint8Array(w * h);
    chars.forEach((ch, i) => {
        const g = GLYPHS[ch] || GLYPHS[' '];
        for (let y = 0; y < ROWS; y++) {
            for (let x = 0; x < COLS; x++) {
                if (g[y][x] !== '#') {
                    continue;
                }
                const ox = (i * (COLS + 1) + x) * s;
                const oy = y * s;
                for (let yy = 0; yy < s; yy++) {
                    for (let xx = 0; xx < s; xx++) {
                        data[(oy + yy) * w + ox + xx] = 255;
                    }
                }
            }
        }
    });
    return { w, h, data };
}

const SEGMENTS = {
    '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
    '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
    '-': 'g', ' ': ''
};

function inside(poly, x, y) {
    let sign = 0;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
        if (cross !== 0) {
            const s = cross > 0 ? 1 : -1;
            if (sign === 0) {
                sign = s;
            } else if (s !== sign) {
                return false;
            }
        }
    }
    return true;
}

/**
 * Seven-segment digits w x h pixels with stroke t, leaning right by `slant`
 * (pixels of lean per pixel of height). mask(ch) is cached; its width is
 * cellW, the digit plus the lean.
 */
class SevenSeg {
    constructor(w, h, t, slant) {
        this.w = Math.max(4, Math.round(w));
        this.h = Math.max(6, Math.round(h));
        this.t = Math.max(1, Math.round(t));
        this.slant = slant || 0;
        this.cellW = this.w + Math.ceil(this.h * this.slant);
        this.polys = this._polys();
        this.cache = {};
    }

    _polys() {
        const w = this.w;
        const h = this.h;
        const hs = this.t / 2;
        const g = Math.max(0.7, this.t * 0.1);
        const horizontal = (y) => {
            const p = hs + g;
            const q = w - hs - g;
            return [[p, y], [p + hs, y - hs], [q - hs, y - hs], [q, y], [q - hs, y + hs], [p + hs, y + hs]];
        };
        const vertical = (x, y1, y2) => {
            const p = y1 + g;
            const q = y2 - g;
            return [[x, p], [x + hs, p + hs], [x + hs, q - hs], [x, q], [x - hs, q - hs], [x - hs, p + hs]];
        };
        const mid = h / 2;
        return {
            a: horizontal(hs),
            g: horizontal(mid),
            d: horizontal(h - hs),
            f: vertical(hs, hs, mid),
            b: vertical(w - hs, hs, mid),
            e: vertical(hs, mid, h - hs),
            c: vertical(w - hs, mid, h - hs)
        };
    }

    mask(ch) {
        const key = SEGMENTS[ch] === undefined ? ' ' : ch;
        if (this.cache[key]) {
            return this.cache[key];
        }
        const polys = SEGMENTS[key].split('').map((s) => this.polys[s]);
        const W = this.cellW;
        const H = this.h;
        const data = new Uint8Array(W * H);
        const N = 3;
        if (polys.length) {
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    let hits = 0;
                    for (let j = 0; j < N; j++) {
                        for (let i = 0; i < N; i++) {
                            const sy = y + (j + 0.5) / N;
                            const sx = x + (i + 0.5) / N - (H - sy) * this.slant;
                            for (let p = 0; p < polys.length; p++) {
                                if (inside(polys[p], sx, sy)) {
                                    hits++;
                                    break;
                                }
                            }
                        }
                    }
                    data[y * W + x] = Math.round(hits * 255 / (N * N));
                }
            }
        }
        this.cache[key] = { w: W, h: H, data };
        return this.cache[key];
    }
}

module.exports = { textMask, SevenSeg, GLYPHS, COLS, ROWS };

'use strict';
/**
 * Made-up readings for the demo: a standing start, a pull through four gears
 * with boost and a heat-soaking intake, a lift, and a stop, then it repeats.
 * A pure function of time, so it is the same on the head unit and on a desk.
 * None of it is measured from the car.
 */

const CYCLE_S = 40;
const MPH_PER_S = 6.5;
const SHIFT_MPH = [30, 55, 80];
const RATIO = [6500 / 30, 6500 / 55, 6500 / 80, 6500 / 120];   /* rpm per mph, gears 1-4 */
const PULL_START = 5;
const PULL_END = 19;
const COAST_END = 27;

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function lerp(a, b, f) {
    return a + (b - a) * clamp(f, 0, 1);
}

/* t: seconds. Returns { speedKmh, rpm, boostKpa, iatC }. */
function demoSample(t) {
    const s = ((t % CYCLE_S) + CYCLE_S) % CYCLE_S;
    let mph;
    let rpm;
    let psi;
    let iatC;
    if (s < PULL_START) {
        mph = 0;
        rpm = 800 + 25 * Math.sin(s * 5);
        psi = -9;
        iatC = 35;
    } else if (s < PULL_END) {
        const x = s - PULL_START;
        mph = MPH_PER_S * x;
        const gear = mph < SHIFT_MPH[0] ? 0 : mph < SHIFT_MPH[1] ? 1 : mph < SHIFT_MPH[2] ? 2 : 3;
        rpm = Math.max(1500, RATIO[gear] * mph);
        /* boost builds with rpm, tapers toward the top, and drops at each shift */
        let boost = lerp(-4, 22, (rpm - 1500) / 3500) - Math.max(0, rpm - 5600) / 1000 * 3;
        const lastShift = SHIFT_MPH.filter((m) => mph >= m).map((m) => m / MPH_PER_S);
        if (lastShift.length) {
            boost *= clamp((x - lastShift[lastShift.length - 1]) / 0.6, 0.1, 1);
        }
        psi = boost;
        iatC = lerp(35, 48, x / (PULL_END - PULL_START));
    } else if (s < COAST_END) {
        const x = (s - PULL_END) / (COAST_END - PULL_END);
        mph = lerp(MPH_PER_S * (PULL_END - PULL_START), 45, x);
        rpm = RATIO[3] * mph;
        psi = lerp(0, -9, (s - PULL_END) / 1.5);
        iatC = lerp(48, 41, x);
    } else {
        const x = (s - COAST_END) / (CYCLE_S - COAST_END);
        mph = lerp(45, 0, x);
        rpm = Math.max(800, RATIO[3] * mph);
        psi = -9.5;
        iatC = lerp(41, 35, x);
    }
    return {
        speedKmh: mph / 0.621371,
        rpm: clamp(rpm, 700, 6900),
        boostKpa: psi / 0.145038,
        iatC
    };
}

module.exports = { demoSample, CYCLE_S };

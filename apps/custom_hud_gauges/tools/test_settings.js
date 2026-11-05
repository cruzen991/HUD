'use strict';
/* The switches' defaults and the crash guard of the automatic start. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings, MAX_STRIKES } = require('../src/settings.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hudg-'));
let s = new Settings(dir);
assert.strictEqual(s.get('hud'), false, 'the gauges start off');
assert.strictEqual(s.get('engine'), false, 'engine reads start off');
s.set('hud', true);
s.set('engine', 'yes');   /* not a boolean: ignored */
assert.strictEqual(s.get('engine'), false);

/* starts that never get to be stable: after MAX_STRIKES the gauges are switched off */
for (let i = 0; i < MAX_STRIKES; i++) {
    s = new Settings(dir);
    assert.strictEqual(s.get('hud'), true, 'start ' + i + ': still on');
    assert.strictEqual(s.beginAutoStart(), true);
    clearTimeout(s._stableTimer);
}
s = new Settings(dir);
assert.strictEqual(s.beginAutoStart(), false, 'the next automatic start is refused');
assert.strictEqual(s.get('hud'), false, 'and the gauges are off');
assert.strictEqual(new Settings(dir).get('hud'), false, 'for good');
assert.strictEqual(new Settings(dir).strikes, 0);

/* a start that stays up (a clean stop does the same) clears the count */
s.set('hud', true);
s = new Settings(dir);
assert.strictEqual(s.beginAutoStart(), true);
s.markStable();
assert.strictEqual(new Settings(dir).strikes, 0);
assert.strictEqual(new Settings(dir).get('hud'), true);

/* turning the switch by hand also clears the count; a broken file is just defaults */
fs.writeFileSync(path.join(dir, 'hud-gauges.json'), '{nonsense');
assert.strictEqual(new Settings(dir).get('hud'), false);
/* a folder that cannot be written costs only the saving */
const bad = new Settings(path.join(dir, 'hud-gauges.json', 'x'), { warn() {} });
bad.set('hud', true);
assert.strictEqual(bad.get('hud'), true);

fs.rmSync ? fs.rmSync(dir, { recursive: true, force: true }) : null;
console.log('ok   settings: both switches start off; three failed automatic starts switch the gauges off; a stable start or clean stop clears the count');
console.log('\nall settings tests passed');

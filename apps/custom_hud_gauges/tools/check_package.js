// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/**
 * Checks the source package the way the head unit's link step will read it
 * (tools/oap_link.js of mgu-store): mgu-app.json, the staged tree and the
 * names each module requires. Nothing here needs BMW's SDK.
 *
 *   node tools/check_package.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const ROOT = path.join(__dirname, '..');
const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-app.json'), 'utf8'));
assert.strictEqual(m.schema, 1);
assert(/^[a-z][a-z0-9_]*$/.test(m.id), 'id');
assert(/^\d+\.\d+\.\d+$/.test(m.version), 'version');
assert.strictEqual(m.tree, `${m.id}@${m.version}`);
const tree = path.join(ROOT, m.tree);
const pkg = JSON.parse(fs.readFileSync(path.join(tree, 'package.json'), 'utf8'));
assert.strictEqual(pkg.name, m.id);
assert.strictEqual(pkg.version, m.version);
assert.strictEqual(pkg.main, 'javascript/runner.js');
assert(!fs.existsSync(path.join(tree, 'javascript')), 'the head unit makes javascript/');
const app = JSON.parse(fs.readFileSync(path.join(tree, 'rhmiData', 'application.json'), 'utf8')).application;
assert.strictEqual(app.name, m.id);
assert.strictEqual(app.version, m.version);
const shrink = JSON.parse(fs.readFileSync(path.join(tree, 'npm-shrinkwrap.json'), 'utf8'));
assert.strictEqual(shrink.name, m.id);
assert.strictEqual(shrink.version, m.version);
['manifest.json', 'permissions.json', 'config/base.json'].forEach((f) => JSON.parse(fs.readFileSync(path.join(tree, f), 'utf8')));
const perms = JSON.parse(fs.readFileSync(path.join(tree, 'permissions.json'), 'utf8'));
assert(Array.isArray(perms.masterAccessTable) && Array.isArray(perms.masterRegistrationTable));
const icon = fs.readFileSync(path.join(tree, 'rhmiData/variantGroups/Common/images', app.entryPoints[0].icon));
assert.strictEqual(icon.readUInt32BE(16), 140);
assert.strictEqual(icon.readUInt32BE(20), 140);
const text = JSON.parse(fs.readFileSync(path.join(tree, 'rhmiData/variantGroups/Common/texts/en_GB.json'), 'utf8'));
assert(text[app.entryPoints[0].textId], 'the tile text exists');

const names = m.modules.map((f) => './' + path.basename(f));
assert.strictEqual(new Set(names).size, names.length, 'module names are unique');
m.modules.forEach((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const re = /require\('([^']+)'\)/g;
    let r;
    while ((r = re.exec(src)) !== null) {
        const n = r[1];
        assert(names.indexOf(n) >= 0 || m.sdk.indexOf(n) >= 0 || builtinModules.indexOf(n) >= 0,
            `${f} requires "${n}": not an app module, a Node builtin or an sdk name in mgu-app.json`);
    }
    /* what Node 8.16 (the unit) cannot parse */
    const bad = /\?\.|\?\?|\bcatch\s*\{|\.flat\(|\.flatMap\(|\.matchAll\(|Object\.fromEntries|\.trimEnd\(|\.trimStart\(|BigInt|\.finally\(|\bfor await\b/.exec(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''));
    assert(!bad, `${f}: ${bad && bad[0]} needs a newer Node than the unit's 8.16`);
});
fs.readdirSync(path.join(ROOT, 'src')).filter((f) => /\.js$/.test(f)).forEach((f) => {
    assert(m.modules.indexOf(`src/${f}`) >= 0, `src/${f} is not in mgu-app.json modules`);
});
console.log(`ok   ${m.id}@${m.version}: manifest, staged tree, ${m.modules.length} modules, requires and syntax`);

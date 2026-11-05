// Checks that the Steam images are produced: right files, right dimensions, logo with a transparent corner.
// Usage like smoke.mjs with Electron as Node: ELECTRON_BIN=<electron> ELECTRON_RUN_AS_NODE=1 <electron> test/artwork.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronBin = process.env.ELECTRON_BIN || require('electron');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-art-'));
const env = { ...process.env, ROLLOUT_ART_OUT: out };
delete env.ELECTRON_RUN_AS_NODE;
const run = spawnSync(electronBin, ['--user-data-dir=' + path.join(out, 'ud'), '.'], { env, cwd: path.resolve('.'), timeout: 60000 });
assert.equal(run.status, 0, `Electron exited with ${run.status}`);
const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
const by = Object.fromEntries(report.map((r) => [r.name, r]));
const expected = { '1p.png': [600, 900], '1.png': [920, 430], '1_hero.png': [1920, 620], '1_logo.png': [1280, 720] };
for (const [name, [w, h]] of Object.entries(expected)) {
  assert.ok(by[name], `${name} fehlt`);
  assert.deepEqual([by[name].width, by[name].height], [w, h], `${name} has wrong dimensions`);
  console.log(`  ✓ ${name} ${w} x ${h}`);
}
assert.equal(by['1_logo.png'].cornerAlpha, 0, 'Logo corner is not transparent');
console.log('  ✓ Logo hat durchsichtigen Hintergrund');
assert.equal(by['1p.png'].cornerAlpha, 255, 'Portrait image is not opaque');
console.log(`Bilder liegen in ${out}`);
if (!process.env.ROLLOUT_KEEP) fs.rmSync(out, { recursive: true, force: true });

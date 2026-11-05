// Checks scripts/release.mjs pack with one test key per run: archives, manifest and signature against the client's logic.
// Nothing is uploaded and no real key is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-release-test-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
await build({ entryPoints: ['src/main/selfupdate.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(work, 'selfupdate.mjs'), logLevel: 'error' });
const su = await import(path.join(work, 'selfupdate.mjs'));
const release = await import('../scripts/release.mjs');

const { privateKey } = generateKeyPairSync('ed25519');
const keyFile = path.join(work, 'test-key.pem');
fs.writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }));
const electronDir = path.join(work, 'electron');
fs.mkdirSync(electronDir);
fs.writeFileSync(path.join(electronDir, 'electron'), '#!/bin/sh\necho 45.0.0\n', { mode: 0o755 });
fs.writeFileSync(path.join(electronDir, 'version'), '45.0.0\n');
fs.writeFileSync(path.join(electronDir, 'LICENSE'), 'MIT');
const skip = !fs.existsSync('dist/main/main.js') && 'dist/ is missing, run npm run build first';

test('pack: archives, manifest and signature match the client', { skip }, async () => {
  const out = path.join(work, 'out');
  const { manifest } = await release.pack({ key: keyFile, 'key-id': 'rollout-update-test', runtime: electronDir, out });
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual(fs.readdirSync(out).sort(), [`rollout-${pkg.version}-app.tar.gz`, 'rollout-runtime-electron-45.0.0-linux-x64.tar.gz', 'rollout-update.json']);

  const pub = release.publicKeyB64(privateKey);
  const raw = fs.readFileSync(path.join(out, 'rollout-update.json'), 'utf8');
  const verdict = su.evaluateManifest(raw, { keys: { 'rollout-update-test': pub }, channel: manifest.channel, current: '0.0.1', bad: [] });
  assert.equal(verdict.ok, true, verdict.detail);
  assert.equal(su.evaluateManifest(raw, { keys: { 'rollout-update-test': pub }, channel: manifest.channel, current: pkg.version, bad: [] }).reason, 'old');

  const appFile = path.join(out, `rollout-${pkg.version}-app.tar.gz`);
  assert.equal(manifest.app.size, fs.statSync(appFile).size);
  const listing = execFileSync('tar', ['-tzf', appFile], { encoding: 'utf8' }).split('\n');
  for (const name of ['./package.json', './dist/main/main.js', './dist/preload/preload.js', './dist/renderer/index.html', './bootstrap/rollout', './bootstrap/rollout-run', './vendor/mywhoosh.sh', './vendor/ble-bridge.py', './vendor/LICENSE-mywhoosh-linux-installer']) assert.ok(listing.includes(name), name);
  const stage = fs.mkdtempSync(path.join(work, 'x-'));
  execFileSync('tar', ['-xzf', appFile, '-C', stage]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8')), { name: 'rollout', version: pkg.version, main: 'dist/main/main.js' });
  assert.deepEqual(fs.readFileSync(path.join(stage, 'bootstrap/rollout')), fs.readFileSync('scripts/bin-rollout.sh'));
  assert.deepEqual(fs.readFileSync(path.join(stage, 'bootstrap/rollout-run')), fs.readFileSync('scripts/bin-rollout-run.sh'));
  assert.deepEqual(fs.readFileSync(path.join(stage, 'vendor/mywhoosh.sh')), fs.readFileSync('vendor/mywhoosh.sh'));
  assert.ok(fs.statSync(path.join(stage, 'vendor/mywhoosh.sh')).mode & 0o100, 'mywhoosh.sh stays executable');
  assert.equal(execFileSync('tar', ['-tzf', path.join(out, 'rollout-runtime-electron-45.0.0-linux-x64.tar.gz')], { encoding: 'utf8' }).includes('./LICENSE'), true, 'Lizenz im Electron-Archiv');
  assert.equal(manifest.runtime.electron, '45.0.0');

  // Later releases take over the runtime block from an earlier manifest.
  const again = await release.pack({ key: keyFile, 'key-id': 'rollout-update-test', 'runtime-from': path.join(out, 'rollout-update.json'), out: path.join(work, 'out2') });
  assert.deepEqual(again.manifest.runtime, manifest.runtime);
  assert.deepEqual(fs.readdirSync(path.join(work, 'out2')).sort(), [`rollout-${pkg.version}-app.tar.gz`, 'rollout-update.json']);
});

test('pack lehnt fehlende Angaben ab', { skip }, async () => {
  await assert.rejects(release.pack({ key: keyFile, out: path.join(work, 'out3') }), /--runtime/);
  await assert.rejects(release.pack({ key: path.join(work, 'does-not-exist.pem'), runtime: electronDir, out: path.join(work, 'out4') }));
});

test('bumpVersion: artificial version +1', () => {
  assert.equal(release.bumpVersion('0.9.0-beta.1'), '0.9.0-beta.2');
  assert.equal(release.bumpVersion('1.2.3'), '1.2.4');
  assert.equal(release.bumpVersion('1.0.0-rc'), '1.0.0-rc.1');
  assert.equal(release.channelOf('1.0.0-beta.1'), 'beta');
  assert.equal(release.channelOf('1.0.0'), 'stable');
});

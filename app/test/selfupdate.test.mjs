// Checks the logic and the service of the self-update (U1 to U4, U6 to U9) in throwaway directories, without network.
// Test keys are generated per run. The key in selfupdate-keys.ts is never used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-selfupdate-test-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
for (const name of ['selfupdate', 'selfupdate-fake']) {
  await build({ entryPoints: [`src/main/${name}.ts`], bundle: true, platform: 'node', format: 'esm', outfile: path.join(work, `${name}.mjs`), logLevel: 'error', external: ['electron'] });
}
// Both bundles contain selfupdate.ts: FeedError and service come from the same bundle for the service.
const su = await import(path.join(work, 'selfupdate.mjs'));
const fake = await import(path.join(work, 'selfupdate-fake.mjs'));

const keypair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'), priv: privateKey };
};
const main = keypair();
const reserve = keypair();
const KEYS = { 'rollout-update-1': main.pub, 'rollout-update-2': reserve.pub };
const BASE = 'https://github.com/mace-ops/rollout-cycling-launcher-linux/releases/download';

const archive = (name, extra = {}) => ({ url: `${BASE}/v1.3.0/${name}`, size: 5_300_000, unpacked: 5_400_000, sha256: 'a'.repeat(64), ...extra });
const manifestOf = (patch = {}) => ({
  format: 1, product: 'rollout', channel: 'stable', version: '1.3.0', published: '2026-11-20T10:00:00Z',
  app: archive('rollout-1.3.0-app.tar.gz'),
  runtime: { electron: '45.0.0', min: '45.0.0', ...archive('rollout-runtime-electron-45.0.0-linux-x64.tar.gz', { size: 124_000_000, unpacked: 274_000_000 }) },
  ...patch
});
const envelope = (manifest, { keyId = 'rollout-update-1', key = main.priv, tamper } = {}) => {
  const signed = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
  const signature = sign(null, Buffer.from(signed), key).toString('base64');
  return JSON.stringify({ keyId, signature, signed: tamper ? tamper(signed) : signed });
};
const ctx = (patch = {}) => ({ keys: KEYS, channel: 'stable', current: '1.2.0', bad: [], ...patch });
const verdict = (raw, patch) => su.evaluateManifest(raw, ctx(patch));

test('U1 SemVer-Reihenfolge', () => {
  const order = ['1.3.0-beta.9', '1.3.0-beta.10', '1.3.0', '1.10.0'];
  for (let i = 0; i < order.length - 1; i += 1) {
    assert.equal(su.compareSemver(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`);
    assert.equal(su.compareSemver(order[i + 1], order[i]), 1);
  }
  assert.equal(su.compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(su.compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(su.compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
  assert.equal(su.compareSemver('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(su.parseSemver('1.2'), null);
  assert.equal(su.parseSemver('v1.2.3'), null);
  assert.equal(su.parseSemver('1.2.3-'), null);
});

test('U2 Signatur', () => {
  const m = manifestOf();
  assert.equal(verdict(envelope(m)).ok, true, 'valid');
  assert.equal(verdict(envelope(m, { tamper: (s) => s.replace('1.3.0', '1.3.1') })).ok, false, 'one byte changed');
  assert.equal(verdict(envelope(m, { tamper: (s) => `${s} ` })).ok, false, 'appended space');
  assert.equal(verdict(envelope(m, { keyId: 'rollout-update-9' })).ok, false, 'unbekannte keyId');
  assert.equal(verdict(envelope(m, { keyId: '__proto__' })).ok, false, 'keyId from the prototype');
  assert.equal(verdict(envelope(m, { keyId: 'rollout-update-2' })).ok, false, 'signature of a different key');
  assert.equal(verdict(envelope(m, { keyId: 'rollout-update-2', key: reserve.priv })).ok, true, 'reserve key valid');
  const parsed = JSON.parse(envelope(m));
  for (const signature of [parsed.signature.slice(0, -8), `${parsed.signature}AAAA`, '', '!!!']) {
    assert.equal(verdict(JSON.stringify({ ...parsed, signature })).ok, false, `signature length ${signature.length}`);
  }
  assert.equal(su.verifySignature('x', parsed.signature, Buffer.alloc(31).toString('base64')), false, 'key too short');
  assert.equal(su.verifySignature('x', parsed.signature, Buffer.alloc(33).toString('base64')), false, 'key too long');
  assert.equal(verdict(envelope(m), { keys: {} }).ok, false, 'without a configured key everything is rejected');
});

test('U3 Manifest', () => {
  const reason = (raw, patch) => { const v = verdict(raw, patch); return v.ok ? 'ok' : v.reason; };
  assert.equal(reason(envelope(manifestOf())), 'ok');
  assert.equal(reason(envelope(manifestOf({ channel: 'beta' }))), 'invalid', 'falscher Kanal');
  assert.equal(reason(envelope(manifestOf({ product: 'anderes' }))), 'invalid', 'falsches Produkt');
  assert.equal(reason(envelope(manifestOf({ app: archive('x.tar.gz', { url: 'https://example.com/x.tar.gz' }) }))), 'invalid', 'fremde URL');
  assert.equal(reason(envelope(manifestOf({ app: archive('x.tar.gz', { url: `${BASE.replace('https', 'http')}/v1.3.0/x.tar.gz` }) }))), 'invalid', 'http');
  assert.equal(reason(envelope(manifestOf({ app: archive('x.tar.gz', { url: `${BASE}/../../../evil/x.tar.gz` }) }))), 'invalid', 'path traversal upwards');
  assert.equal(reason(envelope(manifestOf({ app: archive('x.tar.gz', { url: 'https://github.com@evil.example/mace-ops/rollout-cycling-launcher-linux/releases/download/x' }) }))), 'invalid', 'user in the URL');
  assert.equal(reason(envelope(manifestOf({ app: archive('x.tar.gz', { size: su.LIMITS.app + 1 }) }))), 'invalid', 'app archive too large');
  assert.equal(reason(envelope(manifestOf({ runtime: { ...manifestOf().runtime, size: su.LIMITS.runtime + 1 } }))), 'invalid', 'Electron archive too large');
  assert.equal(reason(envelope(manifestOf({ app: archive('x.tar.gz', { sha256: 'xyz' }) }))), 'invalid', 'checksum broken');
  assert.equal(reason(envelope(manifestOf({ runtime: { ...manifestOf().runtime, min: '46.0.0' } }))), 'invalid', 'min above electron');
  assert.equal(reason(envelope(manifestOf({ padding: 'x'.repeat(su.LIMITS.manifest) }))), 'invalid', 'manifest over 64 KiB');
  assert.equal(reason('{kaputt'), 'invalid', 'kaputtes JSON');
  assert.equal(reason(envelope('{kaputt')), 'invalid', 'kaputtes JSON im signierten Teil');
  assert.equal(reason(JSON.stringify([1])), 'invalid', 'envelope is not an object');
  assert.equal(reason(envelope(manifestOf({ version: '1.2.0' }))), 'old', 'gleiche Version');
  assert.equal(reason(envelope(manifestOf({ version: '1.1.9' }))), 'old', 'older version');
  assert.equal(reason(envelope(manifestOf({ version: '1.2.0-beta.1' }))), 'old', 'prerelease of the running one');
  assert.equal(reason(envelope(manifestOf()), { bad: ['1.3.0'] }), 'bad', 'Version in bad');
  assert.equal(reason(envelope(manifestOf({ format: 2, added: true }))), 'format', 'format too high');
  assert.equal(reason(envelope(manifestOf({ format: 0 }))), 'invalid', 'format 0');
  assert.equal(reason(envelope(manifestOf({ format: 2 }), { key: reserve.priv })), 'invalid', 'format too high without a valid signature does not count');
});

test('U4 Electron-Regel', () => {
  const rt = (electron, min) => ({ electron, min });
  assert.deepEqual(su.electronPlan(['45.0.0'], '45.0.0', rt('45.0.0', '45.0.0')), { use: '45.0.0', download: false }, 'gleich');
  assert.deepEqual(su.electronPlan(['45.0.0'], '45.0.0', rt('45.2.2', '45.0.0')), { use: '45.0.0', download: false }, 'same major version from min downloads nothing');
  assert.deepEqual(su.electronPlan(['45.2.2'], '45.2.2', rt('45.0.0', '45.0.0')), { use: '45.2.2', download: false }, 'installed one is newer');
  assert.deepEqual(su.electronPlan(['45.0.0'], '45.0.0', rt('45.2.2', '45.1.0')), { use: '45.2.2', download: true }, 'below min downloads along');
  assert.deepEqual(su.electronPlan(['45.0.0'], '45.0.0', rt('46.0.0', '46.0.0')), { use: '46.0.0', download: true }, 'new major version downloads along');
  assert.deepEqual(su.electronPlan(['45.0.0', '46.0.0'], '45.0.0', rt('46.0.0', '46.0.0')), { use: '46.0.0', download: false }, 'existing directory is reused');
  assert.deepEqual(su.electronPlan(['45.0.0', '45.2.2'], '45.0.0', rt('45.2.2', '45.1.0')), { use: '45.2.2', download: false }, 'existing directory below min');
  const m = su.evaluateManifest(envelope(manifestOf()), ctx()).manifest;
  assert.equal(su.neededBytes(m, { use: '45.0.0', download: false }), 5_300_000 + 5_400_000 + 50 * 1024 ** 2);
  assert.ok(su.neededBytes(m, { use: '45.0.0', download: true }) > 400_000_000);
  assert.equal(su.downloadBytes(m, { use: '45.0.0', download: true }), 129_300_000);
});

// ---------- Dienst (U6 bis U9) ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Directory laid out as in concept 4.3 with running version 1.2.0 (Electron 45.0.0, a shell script). */
function makeHome(name) {
  const home = path.join(work, name);
  for (const d of ['bin', 'versions/1.2.0/dist/renderer/assets/brand', 'versions/1.2.0/bootstrap', 'electron/45.0.0', 'state', 'feed']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, 'electron/45.0.0/electron'), '#!/bin/sh\necho 45.0.0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'versions/1.2.0/package.json'), JSON.stringify({ name: 'rollout', version: '1.2.0', main: 'dist/main/main.js' }));
  fs.writeFileSync(path.join(home, 'versions/1.2.0/runtime'), '45.0.0\n');
  fs.writeFileSync(path.join(home, 'versions/1.2.0/dist/renderer/assets/brand/logo.png'), 'logo');
  fs.writeFileSync(path.join(home, 'icon.png'), 'logo');
  fs.symlinkSync('versions/1.2.0', path.join(home, 'current'));
  return home;
}

const APP_FILES = { 'dist/main/main.js': '//', 'dist/preload/preload.js': '//', 'dist/renderer/index.html': '<html>', 'bootstrap/rollout': '#!/bin/sh\n# rollout-bootstrap: 1\n' };

/** Builds an app archive (and optionally an Electron archive) with a signed manifest into the `feed` directory of the test directory. */
function publish(home, { version = '1.3.0', channel = 'stable', files = APP_FILES, pkgVersion = version, electron = null, patch = {}, manifestFile } = {}) {
  const feed = path.join(home, 'feed');
  const stage = fs.mkdtempSync(path.join(work, 'stage-'));
  const appDir = path.join(stage, 'app');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(appDir, name)), { recursive: true });
    fs.writeFileSync(path.join(appDir, name), text);
  }
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'rollout', version: pkgVersion, main: 'dist/main/main.js' }));
  const appFile = path.join(feed, `rollout-${version}-app.tar.gz`);
  execFileSync('tar', ['-czf', appFile, '-C', appDir, '.']);
  const m = manifestOf({
    channel, version,
    app: { url: `${BASE}/v${version}/rollout-${version}-app.tar.gz`, size: fs.statSync(appFile).size, unpacked: 1000, sha256: sha(appFile) }, ...patch
  });
  if (electron) {
    const edir = path.join(stage, 'electron');
    fs.mkdirSync(edir);
    fs.writeFileSync(path.join(edir, 'electron'), `#!/bin/sh\necho ${electron.reported ?? electron.version}\n`, { mode: 0o755 });
    const efile = path.join(feed, `rollout-runtime-electron-${electron.version}-linux-x64.tar.gz`);
    execFileSync('tar', ['-czf', efile, '-C', edir, '.']);
    m.runtime = { electron: electron.version, min: electron.min ?? electron.version, url: `${BASE}/v${version}/${path.basename(efile)}`, size: fs.statSync(efile).size, unpacked: 1000, sha256: sha(efile) };
  } else {
    m.runtime = { ...m.runtime, electron: '45.0.0', min: '45.0.0' };
  }
  fs.writeFileSync(path.join(feed, manifestFile ?? (channel === 'beta' ? 'rollout-update-beta.json' : 'rollout-update.json')), envelope(m));
  return m;
}

function makeService(home, overrides = {}) {
  const state = { busy: false, exits: [], steps: [], settings: { autoUpdate: false, channel: 'stable' } };
  const service = new su.SelfUpdater({
    home, version: '1.2.0', keys: KEYS, feed: new fake.FakeFeed(path.join(home, 'feed')), supervised: true, arch: 'x64',
    settings: () => state.settings, busy: () => state.busy, exit: (code) => state.exits.push(code), freeBytes: () => 10 * 1024 ** 3,
    step: (name) => state.steps.push({ name, pending: fs.existsSync(path.join(home, 'state/pending')), versionDir: fs.existsSync(path.join(home, 'versions/1.3.0')) }),
    ...overrides
  });
  return { service, state };
}

const exists = (home, rel) => fs.existsSync(path.join(home, rel));
const noTraces = (home) => { assert.equal(exists(home, 'state/pending'), false, 'no pending'); assert.ok(!exists(home, 'staging') || fs.readdirSync(path.join(home, 'staging')).length === 0, 'staging empty'); };

test('without watcher or on a different architecture everything stays quiet', async () => {
  for (const patch of [{ supervised: false }, { arch: 'arm64' }]) {
    const home = makeHome(`still-${Object.keys(patch)[0]}`);
    publish(home);
    const { service } = makeService(home, { ...patch, feed: { manifest: () => { throw new Error('Netz benutzt'); }, download: () => { throw new Error('Netz benutzt'); } } });
    await service.check(true);
    await service.download();
    assert.equal(service.snapshot().status, 'none');
    assert.equal(service.restart(), false);
  }
});

test('the service reads the settings only at start(), not in the constructor', async () => {
  const home = makeHome('einstellungen-spaet');
  const timing = { firstCheckMs: 1e9, healthyMs: 1e9, intervalMs: 1e9 };
  const { service } = makeService(home, { settings: () => { throw new Error('Backend not there yet'); }, timing });
  assert.equal(service.snapshot().status, 'current');
  const ok = makeService(home, { timing });
  ok.service.start();
  ok.state.settings.channel = 'beta';
  publish(home, { version: '1.4.0-beta.1', channel: 'beta' });
  ok.service.settingsChanged();
  await sleep(200);
  assert.equal(ok.service.snapshot().next, '1.4.0-beta.1', 'channel switch triggers a check immediately');
});

test('without a configured key nothing is queried and nothing downloaded', async () => {
  const home = makeHome('without-key');
  publish(home);
  const { service } = makeService(home, { keys: {}, feed: { manifest: () => { throw new Error('Netz benutzt'); }, download: () => { throw new Error('Netz benutzt'); } } });
  await service.check(false);
  assert.equal(service.snapshot().status, 'current');
  await service.check(true);
  assert.equal(service.snapshot().status, 'checkFailed');
  noTraces(home);
});

test('Checking finds the update and shows version and size', async () => {
  const home = makeHome('pruefen');
  publish(home);
  const { service, state } = makeService(home);
  await service.check(true);
  const snap = service.snapshot();
  assert.equal(snap.status, 'available');
  assert.equal(snap.next, '1.3.0');
  assert.equal(snap.mb, 1, 'kleine Archive zeigen mindestens 1 MB');
  assert.equal(snap.blocked, false);
  assert.ok(exists(home, 'state/check.json'));
  noTraces(home);
  state.settings.channel = 'beta';
  publish(home, { version: '1.4.0-beta.1', channel: 'beta' });
  await service.check(true);
  assert.equal(service.snapshot().next, '1.4.0-beta.1', 'Beta takes the higher version from both channels');
});

test('automatic check: at most once in 6 hours, cache keeps showing the update', async () => {
  const home = makeHome('takt');
  publish(home);
  let calls = 0;
  const inner = new fake.FakeFeed(path.join(home, 'feed'));
  const feed = { manifest: (...a) => { calls += 1; return inner.manifest(...a); }, download: (...a) => inner.download(...a) };
  let clock = 1_000_000;
  const { service } = makeService(home, { feed, now: () => clock });
  await service.check(false);
  assert.equal(calls, 1);
  clock += 3600_000;
  const second = makeService(home, { feed, now: () => clock }).service;
  await second.check(false);
  assert.equal(calls, 1, 'second start within 6 hours does not ask again');
  assert.equal(second.snapshot().status, 'available', 'cache delivers the update');
  clock += 7 * 3600_000;
  await second.check(false);
  assert.equal(calls, 2);
});

test('Network and HTTP errors: silent when automatic, a failed check message when by hand, network errors do not count as a check', async () => {
  const home = makeHome('netzfehler');
  const down = { manifest: async () => { throw new Error('offline'); }, download: async () => { throw new Error('offline'); } };
  const { service } = makeService(home, { feed: down });
  await service.check(false);
  assert.equal(service.snapshot().status, 'current');
  assert.equal(exists(home, 'state/check.json'), false);
  await service.check(true);
  assert.equal(service.snapshot().status, 'checkFailed');
  assert.equal(exists(home, 'state/check.json'), false);
  for (const status of [403, 404, 429, 503]) {
    const h = makeHome(`http-${status}`);
    const { service: s } = makeService(h, { feed: { manifest: async () => ({ status }), download: down.download } });
    await s.check(false);
    assert.equal(s.snapshot().status, 'current', `${status} automatisch still`);
    assert.ok(exists(h, 'state/check.json'), `${status} throttles to once in 6 hours`);
    await s.check(true);
    assert.equal(s.snapshot().status, 'checkFailed', `${status} by hand`);
  }
});

test('tampered manifest: no pending, silent when automatic, "check not passed" when by hand', async () => {
  const home = makeHome('manipuliert');
  publish(home);
  const file = path.join(home, 'feed/rollout-update.json');
  const text = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...text, signed: text.signed.replace('1.3.0', '9.9.9') }));
  const { service, state } = makeService(home, {});
  state.settings.autoUpdate = true;
  await service.check(false);
  assert.equal(service.snapshot().status, 'current');
  await service.check(true);
  assert.equal(service.snapshot().status, 'invalid');
  noTraces(home);
});

test('manifest format too new leads to "fresh install needed"', async () => {
  const home = makeHome('format');
  publish(home, { patch: { format: 2 } });
  const { service } = makeService(home);
  await service.check(false);
  assert.equal(service.snapshot().status, 'manual');
});

async function downloaded(home, setup = {}) {
  publish(home, setup.publish);
  const made = makeService(home, setup.options);
  await made.service.check(true);
  assert.equal(made.service.snapshot().status, 'available');
  await made.service.download();
  return made;
}

test('Download and staging: version, runtime and pending are right, staging is empty', async () => {
  const home = makeHome('laden');
  const { service } = await downloaded(home);
  const snap = service.snapshot();
  assert.equal(snap.status, 'ready');
  assert.equal(fs.readFileSync(path.join(home, 'state/pending'), 'utf8'), '1.3.0\n');
  assert.equal(fs.readFileSync(path.join(home, 'versions/1.3.0/runtime'), 'utf8'), '45.0.0\n');
  assert.ok(exists(home, 'versions/1.3.0/dist/main/main.js'));
  assert.ok(exists(home, 'versions/1.3.0/bootstrap/rollout'));
  assert.equal(exists(home, 'staging'), false);
  assert.equal(path.basename(fs.readlinkSync(path.join(home, 'current'))), '1.2.0', 'current stays untouched');
});

test('U6 Download: wrong checksum, wrong size, too many bytes, space', async () => {
  const cases = {
    'Checksum': (m) => ({ app: { ...m.app, sha256: 'b'.repeat(64) } }),
    'size declared too small (too many bytes)': (m) => ({ app: { ...m.app, size: m.app.size - 10 } }),
    'size declared too large': (m) => ({ app: { ...m.app, size: m.app.size + 10 } })
  };
  for (const [name, patch] of Object.entries(cases)) {
    const home = makeHome(`u6-${name.length}`);
    const base = publish(home);
    publish(home, { patch: patch(base) });
    const { service } = makeService(home);
    await service.check(true);
    await service.download();
    assert.equal(service.snapshot().status, 'invalid', name);
    noTraces(home);
    assert.equal(exists(home, 'versions/1.3.0'), false, name);
  }
  const noSpace = makeHome('u6-platz');
  publish(noSpace);
  const { service } = makeService(noSpace, { freeBytes: () => 1024 });
  await service.check(true);
  await service.download();
  assert.equal(service.snapshot().status, 'noSpace');
  noTraces(noSpace);
});

test('U6 Download: abort and network abort leave nothing behind', async () => {
  const home = makeHome('u6-abbruch');
  publish(home);
  const inner = new fake.FakeFeed(path.join(home, 'feed'));
  let started;
  const begun = new Promise((r) => { started = r; });
  const feed = {
    manifest: (...a) => inner.manifest(...a),
    download: (url, dest, o) => { started(); return new Promise((resolve, reject) => o.signal.addEventListener('abort', () => reject(new su.FeedError('abort', 'abgebrochen')))); }
  };
  const { service } = makeService(home, { feed });
  await service.check(true);
  const running = service.download();
  await begun;
  assert.equal(service.snapshot().status, 'downloading');
  service.cancel();
  await running;
  assert.equal(service.snapshot().status, 'available');
  noTraces(home);

  const broken = makeService(home, { feed: { manifest: (...a) => inner.manifest(...a), download: async () => { throw new su.FeedError('net', 'weg'); } } }).service;
  await broken.check(true);
  await broken.download();
  assert.equal(broken.snapshot().status, 'available');
  noTraces(home);
});

test('U7 Archiv: falsche Version, fehlende Datei, Electron-Probelauf scheitert', async () => {
  const cases = {
    'falsche Version in package.json': { pkgVersion: '1.3.1' },
    'fehlende main.js': { files: Object.fromEntries(Object.entries(APP_FILES).filter(([n]) => n !== 'dist/main/main.js')) },
    'missing watcher': { files: Object.fromEntries(Object.entries(APP_FILES).filter(([n]) => n !== 'bootstrap/rollout')) },
    'Electron meldet andere Version': { electron: { version: '45.2.2', min: '45.1.0', reported: '45.0.0' } },
    'Electron without executable': { electron: { version: '45.2.2', min: '45.1.0' }, breakElectron: true }
  };
  let n = 0;
  for (const [name, setup] of Object.entries(cases)) {
    n += 1;
    const home = makeHome(`u7-${n}`);
    const { breakElectron, ...rest } = setup;
    const m = publish(home, rest);
    if (breakElectron) {
      const file = path.join(home, 'feed', path.basename(new URL(m.runtime.url).pathname));
      const dir = fs.mkdtempSync(path.join(work, 'leer-'));
      fs.writeFileSync(path.join(dir, 'nichts'), 'x');
      execFileSync('tar', ['-czf', file, '-C', dir, '.']);
      const fixed = { ...m, runtime: { ...m.runtime, size: fs.statSync(file).size, sha256: sha(file) } };
      fs.writeFileSync(path.join(home, 'feed/rollout-update.json'), envelope(fixed));
    }
    const { service } = makeService(home);
    await service.check(true);
    assert.equal(service.snapshot().status, 'available', name);
    await service.download();
    assert.equal(service.snapshot().status, 'invalid', name);
    noTraces(home);
    assert.equal(exists(home, 'versions/1.3.0'), false, `${name}: no half version`);
    assert.equal(exists(home, 'electron/45.2.2'), false, `${name}: no half Electron`);
  }
});

test('U7 New Electron is downloaded, verified and placed next to the old one', async () => {
  const home = makeHome('u7-electron');
  const { service } = await downloaded(home, { publish: { electron: { version: '45.2.2', min: '45.1.0' } } });
  assert.equal(service.snapshot().status, 'ready');
  assert.equal(service.snapshot().mb > 0, true);
  assert.equal(fs.readFileSync(path.join(home, 'versions/1.3.0/runtime'), 'utf8'), '45.2.2\n');
  assert.ok(exists(home, 'electron/45.2.2/electron'));
  assert.ok(exists(home, 'electron/45.0.0/electron'), 'altes Electron bleibt liegen');
});

test('U8 Order: pending is created last, after the rename', async () => {
  const home = makeHome('u8');
  const { service, state } = await downloaded(home, { publish: { electron: { version: '45.2.2', min: '45.1.0' } } });
  assert.deepEqual(state.steps.map((s) => s.name), ['electron', 'app', 'pending']);
  const pending = state.steps.find((s) => s.name === 'pending');
  assert.equal(pending.pending, false, 'before writing there is no pending');
  assert.equal(pending.versionDir, true, 'the version is already there');
  assert.ok(exists(home, 'state/pending'));
  assert.equal(service.snapshot().status, 'ready');

  const crash = makeHome('u8-abbruch');
  publish(crash);
  const made = makeService(crash, { step: (name) => { if (name === 'pending') throw new Error('Strom weg'); } });
  await made.service.check(true);
  await made.service.download();
  assert.equal(made.service.snapshot().status, 'invalid');
  noTraces(crash);
  assert.equal(exists(crash, 'versions/1.3.0'), false, 'abort before pending removes the version again');
});

test('U9 Busy: no download, no restart, abort on start, cleanup keeps current, previous, pending', async () => {
  // Busy before downloading: checking by hand works, downloading does not, automatically not even checking.
  const home = makeHome('u9');
  publish(home);
  const { service, state } = makeService(home);
  state.settings.autoUpdate = true;
  state.busy = true;
  await service.check(false);
  assert.equal(exists(home, 'state/check.json'), false, 'no automatic check');
  await service.check(true);
  assert.equal(service.snapshot().status, 'available');
  assert.equal(service.snapshot().blocked, true);
  await service.download();
  assert.equal(service.snapshot().status, 'available', 'Laden gesperrt');
  noTraces(home);

  // Busy through rollout-run: state/run.pid with a live process.
  state.busy = false;
  fs.writeFileSync(path.join(home, 'state/run.pid'), `${process.pid}\n`);
  assert.equal(service.snapshot().blocked, true);
  await service.download();
  assert.equal(service.snapshot().status, 'available');
  fs.writeFileSync(path.join(home, 'state/run.pid'), '999999999\n');
  assert.equal(service.snapshot().blocked, false, 'dead process does not count');
  fs.rmSync(path.join(home, 'state/run.pid'));

  // A running download aborts when something starts.
  const inner = new fake.FakeFeed(path.join(home, 'feed'));
  let started;
  const begun = new Promise((r) => { started = r; });
  const slow = {
    manifest: (...a) => inner.manifest(...a),
    download: (url, dest, o) => { started(); return new Promise((resolve, reject) => o.signal.addEventListener('abort', () => reject(new su.FeedError('abort', 'abgebrochen')))); }
  };
  const second = makeService(home, { feed: slow });
  await second.service.check(true);
  const running = second.service.download();
  await begun;
  second.state.busy = true;
  second.service.busyChanged();
  await running;
  assert.equal(second.service.snapshot().status, 'available');
  noTraces(home);

  // Ready and busy: restart blocked, pending stays.
  const ready = makeHome('u9-bereit');
  const r = await downloaded(ready);
  r.state.busy = true;
  assert.equal(r.service.restart(), false);
  assert.deepEqual(r.state.exits, []);
  assert.equal(r.service.snapshot().blocked, true);
  assert.ok(exists(ready, 'state/pending'));
  r.state.busy = false;
  assert.equal(r.service.restart(), true);
  assert.deepEqual(r.state.exits, [75]);
});

test('U9 Cleanup: keeps current, previous, pending and their Electron, nothing when busy or during a running trial', async () => {
  const home = makeHome('aufraeumen');
  const add = (v, rt) => {
    fs.mkdirSync(path.join(home, 'versions', v), { recursive: true });
    fs.writeFileSync(path.join(home, 'versions', v, 'package.json'), JSON.stringify({ version: v }));
    fs.writeFileSync(path.join(home, 'versions', v, 'runtime'), `${rt}\n`);
    fs.mkdirSync(path.join(home, 'electron', rt), { recursive: true });
    fs.writeFileSync(path.join(home, 'electron', rt, 'electron'), '#!/bin/sh\n', { mode: 0o755 });
  };
  add('1.1.0', '44.0.0');
  add('1.1.5', '44.5.0');
  add('1.3.0', '45.2.2');
  add('1.4.0', '46.0.0');
  fs.mkdirSync(path.join(home, 'versions/.new-123'));
  fs.mkdirSync(path.join(home, 'staging'));
  fs.writeFileSync(path.join(home, 'staging/rest'), 'x');
  fs.symlinkSync('versions/1.1.5', path.join(home, 'previous'));
  fs.writeFileSync(path.join(home, 'state/pending'), '1.3.0\n');
  const { service, state } = makeService(home);

  state.busy = true;
  await service.housekeeping();
  assert.ok(exists(home, 'versions/1.1.0'), 'belegt: nichts entfernt');
  state.busy = false;
  fs.writeFileSync(path.join(home, 'state/trial'), '1.2.0\n0\n');
  await service.housekeeping();
  assert.ok(exists(home, 'versions/1.1.0'), 'trial running: nothing removed');
  fs.rmSync(path.join(home, 'state/trial'));

  await service.housekeeping();
  const versions = fs.readdirSync(path.join(home, 'versions')).sort();
  assert.deepEqual(versions, ['1.1.5', '1.2.0', '1.3.0']);
  assert.deepEqual(fs.readdirSync(path.join(home, 'electron')).sort(), ['44.5.0', '45.0.0', '45.2.2']);
  assert.equal(exists(home, 'staging'), false);
  assert.equal(fs.readFileSync(path.join(home, 'state/pending'), 'utf8'), '1.3.0\n');
});

test('Cleanup renews starter and icon only after verification, only for a higher number', async () => {
  const home = makeHome('starter');
  const old = '#!/bin/sh\n# rollout-bootstrap: 1\necho alt\n';
  fs.writeFileSync(path.join(home, 'bin/rollout'), old, { mode: 0o755 });
  const fresh = (n, body) => fs.writeFileSync(path.join(home, 'versions/1.2.0/bootstrap/rollout'), `#!/bin/sh\n# rollout-bootstrap: ${n}\n${body}\n`);
  const { service } = makeService(home);
  fresh(1, 'echo gleich');
  await service.housekeeping();
  assert.equal(fs.readFileSync(path.join(home, 'bin/rollout'), 'utf8'), old, 'same number: not renewed');
  fresh(2, 'if [ then');
  await service.housekeeping();
  assert.equal(fs.readFileSync(path.join(home, 'bin/rollout'), 'utf8'), old, 'syntax error: not renewed');
  fresh(2, 'echo "rollout-bootstrap 3 flock=ja"; exit 0');
  fs.writeFileSync(path.join(home, 'versions/1.2.0/bootstrap/rollout'), '#!/bin/sh\n# rollout-bootstrap: 2\nif [ "$1" = --bootstrap-selftest ]; then echo "rollout-bootstrap 9"; exit 0; fi\n');
  await service.housekeeping();
  assert.equal(fs.readFileSync(path.join(home, 'bin/rollout'), 'utf8'), old, 'self-test reports a different number: not renewed');
  fs.writeFileSync(path.join(home, 'versions/1.2.0/bootstrap/rollout'), '#!/bin/sh\n# rollout-bootstrap: 2\nif [ "$1" = --bootstrap-selftest ]; then echo "rollout-bootstrap 2 flock=ja"; exit 0; fi\n');
  fs.writeFileSync(path.join(home, 'versions/1.2.0/dist/renderer/assets/brand/logo.png'), 'neues logo');
  await service.housekeeping();
  assert.match(fs.readFileSync(path.join(home, 'bin/rollout'), 'utf8'), /# rollout-bootstrap: 2/);
  assert.equal(fs.statSync(path.join(home, 'bin/rollout')).mode & 0o111, 0o111, 'executable');
  assert.equal(fs.readFileSync(path.join(home, 'icon.png'), 'utf8'), 'neues logo');
});

test('Cleanup creates rollout-run and renews it only for a higher number', async () => {
  const home = makeHome('run-starter');
  const file = path.join(home, 'versions/1.2.0/bootstrap/rollout-run');
  const write = (n, selftest) => fs.writeFileSync(file, `#!/bin/sh\n# rollout-bootstrap: ${n}\nif [ "$1" = --bootstrap-selftest ]; then echo "rollout-bootstrap ${selftest} run"; exit 0; fi\n`);
  const { service } = makeService(home);
  await service.housekeeping();
  assert.equal(exists(home, 'bin/rollout-run'), false, 'older version without rollout-run: nothing created');
  write(1, 2);
  await service.housekeeping();
  assert.equal(exists(home, 'bin/rollout-run'), false, 'self-test names a different number: not created');
  write(1, 1);
  await service.housekeeping();
  assert.match(fs.readFileSync(path.join(home, 'bin/rollout-run'), 'utf8'), /# rollout-bootstrap: 1/);
  assert.equal(fs.statSync(path.join(home, 'bin/rollout-run')).mode & 0o111, 0o111, 'executable');
  const before = fs.readFileSync(path.join(home, 'bin/rollout-run'), 'utf8');
  fs.appendFileSync(file, '# changed\n');
  await service.housekeeping();
  assert.equal(fs.readFileSync(path.join(home, 'bin/rollout-run'), 'utf8'), before, 'same number: not renewed');
});

test('"Previous version" blocks the running one and stages the previous one as pending', async () => {
  const home = makeHome('vorherige');
  fs.mkdirSync(path.join(home, 'versions/1.1.0'));
  fs.writeFileSync(path.join(home, 'versions/1.1.0/package.json'), '{}');
  fs.writeFileSync(path.join(home, 'versions/1.1.0/runtime'), '45.0.0\n');
  fs.symlinkSync('versions/1.1.0', path.join(home, 'previous'));
  const { service, state } = makeService(home);
  assert.equal(service.snapshot().previous, '1.1.0');
  state.busy = true;
  assert.equal(service.startPrevious(), false, 'belegt: gesperrt');
  state.busy = false;
  assert.equal(service.startPrevious(), true);
  assert.deepEqual(state.exits, [75]);
  assert.equal(fs.readFileSync(path.join(home, 'state/bad'), 'utf8'), '1.2.0\n');
  assert.equal(fs.readFileSync(path.join(home, 'state/pending'), 'utf8'), '1.1.0\n');

  const bad = makeHome('vorherige-gesperrt');
  fs.mkdirSync(path.join(bad, 'versions/1.1.0'));
  fs.symlinkSync('versions/1.1.0', path.join(bad, 'previous'));
  fs.writeFileSync(path.join(bad, 'state/bad'), '1.1.0\n');
  assert.equal(makeService(bad).service.snapshot().previous, '', 'blocked version is not offered');
});

test('Notice after rollback: appears until it is acknowledged', () => {
  const home = makeHome('hinweis');
  fs.writeFileSync(path.join(home, 'state/notice'), '1.3.0\n');
  const { service } = makeService(home);
  assert.equal(service.snapshot().notice, '1.3.0');
  service.dismissNotice();
  assert.equal(service.snapshot().notice, '');
  assert.equal(exists(home, 'state/notice'), false);
});

test('Healthy report: only with a trial, only for its own version', async () => {
  const timing = { firstCheckMs: 1e9, healthyMs: 20, intervalMs: 1e9 };
  const home = makeHome('gesund');
  const { service } = makeService(home, { timing });
  service.uiReady();
  await sleep(100);
  assert.equal(exists(home, 'state/healthy'), false, 'without a trial nothing is reported');

  const trial = makeHome('gesund-probe');
  fs.writeFileSync(path.join(trial, 'state/trial'), '1.2.0\n0\n');
  const made = makeService(trial, { timing });
  made.service.uiReady();
  made.service.uiReady();
  await sleep(100);
  assert.equal(fs.readFileSync(path.join(trial, 'state/healthy'), 'utf8'), '1.2.0\n');

  const other = makeHome('gesund-andere');
  fs.writeFileSync(path.join(other, 'state/trial'), '1.3.0\n0\n');
  makeService(other, { timing }).service.uiReady();
  await sleep(100);
  assert.equal(exists(other, 'state/healthy'), false);
});

test('staged update survives the app restart, a newer one replaces it', async () => {
  const home = makeHome('pending-neustart');
  await downloaded(home);
  const again = makeService(home).service;
  assert.equal(again.snapshot().status, 'ready');
  assert.equal(again.snapshot().next, '1.3.0');
  publish(home, { version: '1.3.5' });
  await again.check(true);
  assert.equal(again.snapshot().status, 'available');
  assert.equal(again.snapshot().next, '1.3.5');
  await again.download();
  assert.equal(fs.readFileSync(path.join(home, 'state/pending'), 'utf8'), '1.3.5\n');
});

test('blocked version is not offered again', async () => {
  const home = makeHome('gesperrt');
  publish(home);
  fs.writeFileSync(path.join(home, 'state/bad'), '1.3.0\n');
  const { service } = makeService(home);
  await service.check(true);
  assert.equal(service.snapshot().status, 'current');
});

test('automatic download with auto_update, once per version and start', async () => {
  const home = makeHome('auto');
  publish(home);
  const { service, state } = makeService(home);
  state.settings.autoUpdate = true;
  await service.check(true);
  assert.equal(service.snapshot().status, 'ready');
  const failing = makeHome('auto-fehler');
  publish(failing);
  let downloads = 0;
  const inner = new fake.FakeFeed(path.join(failing, 'feed'));
  const feed = { manifest: (...a) => inner.manifest(...a), download: async () => { downloads += 1; throw new su.FeedError('net', 'weg'); } };
  const second = makeService(failing, { feed });
  second.state.settings.autoUpdate = true;
  await second.service.check(true);
  assert.equal(downloads, 1);
  assert.equal(second.service.snapshot().status, 'available');
  await second.service.check(true);
  assert.equal(downloads, 1, 'no second automatic attempt');
  await second.service.download();
  assert.equal(downloads, 2, 'by hand it works again');
});

test('FakeSelfUpdate: states, checking, downloading and restart without files', async () => {
  const f = new fake.FakeSelfUpdate('available,previous=1.1.0,notice=1.3.0,mb=129', '1.2.0');
  assert.deepEqual(f.snapshot(), { status: 'available', version: '1.2.0', next: '1.3.0', mb: 129, progress: 0, blocked: false, previous: '1.1.0', notice: '1.3.0' });
  await f.download();
  await sleep(2000);
  assert.equal(f.snapshot().status, 'ready');
  assert.equal(f.restart(), true);
  assert.equal(f.snapshot().version, '1.3.0');
  assert.equal(new fake.FakeSelfUpdate('ready,blocked', '1.2.0').restart(), false);
  assert.equal(new fake.FakeSelfUpdate('unsinn', '1.2.0').snapshot().status, 'current');
});

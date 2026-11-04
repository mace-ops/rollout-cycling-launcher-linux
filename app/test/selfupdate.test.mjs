// Prüft die Logik und den Dienst des Selbst-Updates (U1 bis U4, U6 bis U9) in Wegwerf-Ordnern, ohne Netz.
// Testschlüssel entstehen pro Lauf. Der Schlüssel in selfupdate-keys.ts wird nie benutzt.
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
// Beide Bündel enthalten selfupdate.ts: FeedError und Dienst kommen für den Dienst aus demselben Bündel.
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
  assert.equal(verdict(envelope(m)).ok, true, 'gültig');
  assert.equal(verdict(envelope(m, { tamper: (s) => s.replace('1.3.0', '1.3.1') })).ok, false, 'ein Byte geändert');
  assert.equal(verdict(envelope(m, { tamper: (s) => `${s} ` })).ok, false, 'angehängtes Leerzeichen');
  assert.equal(verdict(envelope(m, { keyId: 'rollout-update-9' })).ok, false, 'unbekannte keyId');
  assert.equal(verdict(envelope(m, { keyId: '__proto__' })).ok, false, 'keyId aus dem Prototyp');
  assert.equal(verdict(envelope(m, { keyId: 'rollout-update-2' })).ok, false, 'Signatur eines anderen Schlüssels');
  assert.equal(verdict(envelope(m, { keyId: 'rollout-update-2', key: reserve.priv })).ok, true, 'Reserveschlüssel gültig');
  const parsed = JSON.parse(envelope(m));
  for (const signature of [parsed.signature.slice(0, -8), `${parsed.signature}AAAA`, '', '!!!']) {
    assert.equal(verdict(JSON.stringify({ ...parsed, signature })).ok, false, `Signatur-Länge ${signature.length}`);
  }
  assert.equal(su.verifySignature('x', parsed.signature, Buffer.alloc(31).toString('base64')), false, 'Schlüssel zu kurz');
  assert.equal(su.verifySignature('x', parsed.signature, Buffer.alloc(33).toString('base64')), false, 'Schlüssel zu lang');
  assert.equal(verdict(envelope(m), { keys: {} }).ok, false, 'ohne eingetragenen Schlüssel wird alles abgelehnt');
});

test('U3 Manifest', () => {
  const reason = (raw, patch) => { const v = verdict(raw, patch); return v.ok ? 'ok' : v.reason; };
  assert.equal(reason(envelope(manifestOf())), 'ok');
  assert.equal(reason(envelope(manifestOf({ channel: 'beta' }))), 'invalid', 'falscher Kanal');
  assert.equal(reason(envelope(manifestOf({ product: 'anderes' }))), 'invalid', 'falsches Produkt');
  assert.equal(reason(envelope(manifestOf({ app: archive('x.tar.gz', { url: 'https://example.com/x.tar.gz' }) }))), 'invalid', 'fremde URL');
  assert.equal(reason(envelope(manifestOf({ app: archive('x.tar.gz', { url: `${BASE.replace('https', 'http')}/v1.3.0/x.tar.gz` }) }))), 'invalid', 'http');
  assert.equal(reason(envelope(manifestOf({ app: archive('x.tar.gz', { url: `${BASE}/../../../evil/x.tar.gz` }) }))), 'invalid', 'Pfad nach oben');
  assert.equal(reason(envelope(manifestOf({ app: archive('x.tar.gz', { url: 'https://github.com@evil.example/mace-ops/rollout-cycling-launcher-linux/releases/download/x' }) }))), 'invalid', 'Nutzer in der URL');
  assert.equal(reason(envelope(manifestOf({ app: archive('x.tar.gz', { size: su.LIMITS.app + 1 }) }))), 'invalid', 'App-Archiv zu groß');
  assert.equal(reason(envelope(manifestOf({ runtime: { ...manifestOf().runtime, size: su.LIMITS.runtime + 1 } }))), 'invalid', 'Electron-Archiv zu groß');
  assert.equal(reason(envelope(manifestOf({ app: archive('x.tar.gz', { sha256: 'xyz' }) }))), 'invalid', 'Prüfsumme kaputt');
  assert.equal(reason(envelope(manifestOf({ runtime: { ...manifestOf().runtime, min: '46.0.0' } }))), 'invalid', 'min über electron');
  assert.equal(reason(envelope(manifestOf({ padding: 'x'.repeat(su.LIMITS.manifest) }))), 'invalid', 'Manifest über 64 KiB');
  assert.equal(reason('{kaputt'), 'invalid', 'kaputtes JSON');
  assert.equal(reason(envelope('{kaputt')), 'invalid', 'kaputtes JSON im signierten Teil');
  assert.equal(reason(JSON.stringify([1])), 'invalid', 'Umschlag ist kein Objekt');
  assert.equal(reason(envelope(manifestOf({ version: '1.2.0' }))), 'old', 'gleiche Version');
  assert.equal(reason(envelope(manifestOf({ version: '1.1.9' }))), 'old', 'ältere Version');
  assert.equal(reason(envelope(manifestOf({ version: '1.2.0-beta.1' }))), 'old', 'Vorabversion der laufenden');
  assert.equal(reason(envelope(manifestOf()), { bad: ['1.3.0'] }), 'bad', 'Version in bad');
  assert.equal(reason(envelope(manifestOf({ format: 2, neu: true }))), 'format', 'zu hohes format');
  assert.equal(reason(envelope(manifestOf({ format: 0 }))), 'invalid', 'format 0');
  assert.equal(reason(envelope(manifestOf({ format: 2 }), { key: reserve.priv })), 'invalid', 'zu hohes format ohne gültige Signatur zählt nicht');
});

test('U4 Electron-Regel', () => {
  const rt = (electron, min) => ({ electron, min });
  assert.deepEqual(su.electronPlan(['45.0.0'], '45.0.0', rt('45.0.0', '45.0.0')), { use: '45.0.0', download: false }, 'gleich');
  assert.deepEqual(su.electronPlan(['45.0.0'], '45.0.0', rt('45.2.2', '45.0.0')), { use: '45.0.0', download: false }, 'gleiche Hauptversion ab min lädt nichts');
  assert.deepEqual(su.electronPlan(['45.2.2'], '45.2.2', rt('45.0.0', '45.0.0')), { use: '45.2.2', download: false }, 'installiertes ist neuer');
  assert.deepEqual(su.electronPlan(['45.0.0'], '45.0.0', rt('45.2.2', '45.1.0')), { use: '45.2.2', download: true }, 'unter min lädt mit');
  assert.deepEqual(su.electronPlan(['45.0.0'], '45.0.0', rt('46.0.0', '46.0.0')), { use: '46.0.0', download: true }, 'neue Hauptversion lädt mit');
  assert.deepEqual(su.electronPlan(['45.0.0', '46.0.0'], '45.0.0', rt('46.0.0', '46.0.0')), { use: '46.0.0', download: false }, 'vorhandener Ordner wird wiederverwendet');
  assert.deepEqual(su.electronPlan(['45.0.0', '45.2.2'], '45.0.0', rt('45.2.2', '45.1.0')), { use: '45.2.2', download: false }, 'vorhandener Ordner unter min');
  const m = su.evaluateManifest(envelope(manifestOf()), ctx()).manifest;
  assert.equal(su.neededBytes(m, { use: '45.0.0', download: false }), 5_300_000 + 5_400_000 + 50 * 1024 ** 2);
  assert.ok(su.neededBytes(m, { use: '45.0.0', download: true }) > 400_000_000);
  assert.equal(su.downloadBytes(m, { use: '45.0.0', download: true }), 129_300_000);
});

// ---------- Dienst (U6 bis U9) ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Ordner im Aufbau von Konzept 4.3 mit laufender Version 1.2.0 (Electron 45.0.0, ein Shell-Skript). */
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

/** Baut ein App-Archiv (und optional ein Electron-Archiv) samt signiertem Manifest in den Ordner `feed` des Testordners. */
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
const noTraces = (home) => { assert.equal(exists(home, 'state/pending'), false, 'kein pending'); assert.ok(!exists(home, 'staging') || fs.readdirSync(path.join(home, 'staging')).length === 0, 'staging leer'); };

test('ohne Wächter oder auf anderer Architektur bleibt alles still', async () => {
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

test('der Dienst liest die Einstellungen erst bei start(), nicht im Konstruktor', async () => {
  const home = makeHome('einstellungen-spaet');
  const timing = { firstCheckMs: 1e9, healthyMs: 1e9, intervalMs: 1e9 };
  const { service } = makeService(home, { settings: () => { throw new Error('Backend noch nicht da'); }, timing });
  assert.equal(service.snapshot().status, 'current');
  const ok = makeService(home, { timing });
  ok.service.start();
  ok.state.settings.channel = 'beta';
  publish(home, { version: '1.4.0-beta.1', channel: 'beta' });
  ok.service.settingsChanged();
  await sleep(200);
  assert.equal(ok.service.snapshot().next, '1.4.0-beta.1', 'Kanalwechsel löst sofort eine Prüfung aus');
});

test('ohne eingetragenen Schlüssel wird nichts abgefragt und nichts geladen', async () => {
  const home = makeHome('ohne-schluessel');
  publish(home);
  const { service } = makeService(home, { keys: {}, feed: { manifest: () => { throw new Error('Netz benutzt'); }, download: () => { throw new Error('Netz benutzt'); } } });
  await service.check(false);
  assert.equal(service.snapshot().status, 'current');
  await service.check(true);
  assert.equal(service.snapshot().status, 'checkFailed');
  noTraces(home);
});

test('Prüfen findet das Update und zeigt Version und Größe', async () => {
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
  assert.equal(service.snapshot().next, '1.4.0-beta.1', 'Beta nimmt die höhere Version aus beiden Kanälen');
});

test('automatische Prüfung: höchstens einmal in 6 Stunden, Zwischenspeicher zeigt das Update weiter', async () => {
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
  assert.equal(calls, 1, 'zweiter Start innerhalb von 6 Stunden fragt nicht erneut');
  assert.equal(second.snapshot().status, 'available', 'Zwischenspeicher liefert das Update');
  clock += 7 * 3600_000;
  await second.check(false);
  assert.equal(calls, 2);
});

test('Netzfehler und HTTP-Fehler: automatisch still, von Hand „Prüfen ging nicht“, Netzfehler zählen nicht als Prüfung', async () => {
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
    assert.ok(exists(h, 'state/check.json'), `${status} bremst auf einmal in 6 Stunden`);
    await s.check(true);
    assert.equal(s.snapshot().status, 'checkFailed', `${status} von Hand`);
  }
});

test('manipuliertes Manifest: kein pending, automatisch still, von Hand „Prüfung nicht bestanden“', async () => {
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

test('zu neues Manifest-Format führt zu „Neuinstallation nötig“', async () => {
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

test('Laden und Bereitlegen: Version, runtime und pending stimmen, staging ist leer', async () => {
  const home = makeHome('laden');
  const { service } = await downloaded(home);
  const snap = service.snapshot();
  assert.equal(snap.status, 'ready');
  assert.equal(fs.readFileSync(path.join(home, 'state/pending'), 'utf8'), '1.3.0\n');
  assert.equal(fs.readFileSync(path.join(home, 'versions/1.3.0/runtime'), 'utf8'), '45.0.0\n');
  assert.ok(exists(home, 'versions/1.3.0/dist/main/main.js'));
  assert.ok(exists(home, 'versions/1.3.0/bootstrap/rollout'));
  assert.equal(exists(home, 'staging'), false);
  assert.equal(path.basename(fs.readlinkSync(path.join(home, 'current'))), '1.2.0', 'current bleibt unberührt');
});

test('U6 Download: falsche Prüfsumme, falsche Größe, zu viele Bytes, Platz', async () => {
  const cases = {
    'Prüfsumme': (m) => ({ app: { ...m.app, sha256: 'b'.repeat(64) } }),
    'Größe zu klein angegeben (zu viele Bytes)': (m) => ({ app: { ...m.app, size: m.app.size - 10 } }),
    'Größe zu groß angegeben': (m) => ({ app: { ...m.app, size: m.app.size + 10 } })
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

test('U6 Download: Abbruch und Netzabbruch lassen nichts zurück', async () => {
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
    'fehlender Wächter': { files: Object.fromEntries(Object.entries(APP_FILES).filter(([n]) => n !== 'bootstrap/rollout')) },
    'Electron meldet andere Version': { electron: { version: '45.2.2', min: '45.1.0', reported: '45.0.0' } },
    'Electron ohne Programmdatei': { electron: { version: '45.2.2', min: '45.1.0' }, breakElectron: true }
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
    assert.equal(exists(home, 'versions/1.3.0'), false, `${name}: keine halbe Version`);
    assert.equal(exists(home, 'electron/45.2.2'), false, `${name}: kein halbes Electron`);
  }
});

test('U7 Neues Electron wird geladen, geprüft und neben dem alten abgelegt', async () => {
  const home = makeHome('u7-electron');
  const { service } = await downloaded(home, { publish: { electron: { version: '45.2.2', min: '45.1.0' } } });
  assert.equal(service.snapshot().status, 'ready');
  assert.equal(service.snapshot().mb > 0, true);
  assert.equal(fs.readFileSync(path.join(home, 'versions/1.3.0/runtime'), 'utf8'), '45.2.2\n');
  assert.ok(exists(home, 'electron/45.2.2/electron'));
  assert.ok(exists(home, 'electron/45.0.0/electron'), 'altes Electron bleibt liegen');
});

test('U8 Reihenfolge: pending entsteht zuletzt, nach dem rename', async () => {
  const home = makeHome('u8');
  const { service, state } = await downloaded(home, { publish: { electron: { version: '45.2.2', min: '45.1.0' } } });
  assert.deepEqual(state.steps.map((s) => s.name), ['electron', 'app', 'pending']);
  const pending = state.steps.find((s) => s.name === 'pending');
  assert.equal(pending.pending, false, 'vor dem Schreiben gibt es kein pending');
  assert.equal(pending.versionDir, true, 'die Version liegt schon da');
  assert.ok(exists(home, 'state/pending'));
  assert.equal(service.snapshot().status, 'ready');

  const crash = makeHome('u8-abbruch');
  publish(crash);
  const made = makeService(crash, { step: (name) => { if (name === 'pending') throw new Error('Strom weg'); } });
  await made.service.check(true);
  await made.service.download();
  assert.equal(made.service.snapshot().status, 'invalid');
  noTraces(crash);
  assert.equal(exists(crash, 'versions/1.3.0'), false, 'Abbruch vor pending räumt die Version wieder weg');
});

test('U9 Belegt: kein Laden, kein Neustart, Abbruch beim Start, Aufräumen behält current, previous, pending', async () => {
  // Belegt vor dem Laden: von Hand prüfen geht, Laden nicht, automatisch wird nicht einmal geprüft.
  const home = makeHome('u9');
  publish(home);
  const { service, state } = makeService(home);
  state.settings.autoUpdate = true;
  state.busy = true;
  await service.check(false);
  assert.equal(exists(home, 'state/check.json'), false, 'automatisch keine Prüfung');
  await service.check(true);
  assert.equal(service.snapshot().status, 'available');
  assert.equal(service.snapshot().blocked, true);
  await service.download();
  assert.equal(service.snapshot().status, 'available', 'Laden gesperrt');
  noTraces(home);

  // Belegt durch rollout-run: state/run.pid mit lebendem Prozess.
  state.busy = false;
  fs.writeFileSync(path.join(home, 'state/run.pid'), `${process.pid}\n`);
  assert.equal(service.snapshot().blocked, true);
  await service.download();
  assert.equal(service.snapshot().status, 'available');
  fs.writeFileSync(path.join(home, 'state/run.pid'), '999999999\n');
  assert.equal(service.snapshot().blocked, false, 'toter Prozess zählt nicht');
  fs.rmSync(path.join(home, 'state/run.pid'));

  // Laufender Download bricht ab, wenn etwas beginnt.
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

  // Bereit und belegt: Neustart gesperrt, pending bleibt.
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

test('U9 Aufräumen: behält current, previous, pending und deren Electron, nichts bei Belegt oder laufender Probe', async () => {
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
  assert.ok(exists(home, 'versions/1.1.0'), 'Probe läuft: nichts entfernt');
  fs.rmSync(path.join(home, 'state/trial'));

  await service.housekeeping();
  const versions = fs.readdirSync(path.join(home, 'versions')).sort();
  assert.deepEqual(versions, ['1.1.5', '1.2.0', '1.3.0']);
  assert.deepEqual(fs.readdirSync(path.join(home, 'electron')).sort(), ['44.5.0', '45.0.0', '45.2.2']);
  assert.equal(exists(home, 'staging'), false);
  assert.equal(fs.readFileSync(path.join(home, 'state/pending'), 'utf8'), '1.3.0\n');
});

test('Aufräumen erneuert Starter und Symbol erst nach Prüfung, nur bei höherer Nummer', async () => {
  const home = makeHome('starter');
  const old = '#!/bin/sh\n# rollout-bootstrap: 1\necho alt\n';
  fs.writeFileSync(path.join(home, 'bin/rollout'), old, { mode: 0o755 });
  const fresh = (n, body) => fs.writeFileSync(path.join(home, 'versions/1.2.0/bootstrap/rollout'), `#!/bin/sh\n# rollout-bootstrap: ${n}\n${body}\n`);
  const { service } = makeService(home);
  fresh(1, 'echo gleich');
  await service.housekeeping();
  assert.equal(fs.readFileSync(path.join(home, 'bin/rollout'), 'utf8'), old, 'gleiche Nummer: nicht erneuert');
  fresh(2, 'if [ then');
  await service.housekeeping();
  assert.equal(fs.readFileSync(path.join(home, 'bin/rollout'), 'utf8'), old, 'Syntaxfehler: nicht erneuert');
  fresh(2, 'echo "rollout-bootstrap 3 flock=ja"; exit 0');
  fs.writeFileSync(path.join(home, 'versions/1.2.0/bootstrap/rollout'), '#!/bin/sh\n# rollout-bootstrap: 2\nif [ "$1" = --bootstrap-selftest ]; then echo "rollout-bootstrap 9"; exit 0; fi\n');
  await service.housekeeping();
  assert.equal(fs.readFileSync(path.join(home, 'bin/rollout'), 'utf8'), old, 'Selbsttest meldet andere Nummer: nicht erneuert');
  fs.writeFileSync(path.join(home, 'versions/1.2.0/bootstrap/rollout'), '#!/bin/sh\n# rollout-bootstrap: 2\nif [ "$1" = --bootstrap-selftest ]; then echo "rollout-bootstrap 2 flock=ja"; exit 0; fi\n');
  fs.writeFileSync(path.join(home, 'versions/1.2.0/dist/renderer/assets/brand/logo.png'), 'neues logo');
  await service.housekeeping();
  assert.match(fs.readFileSync(path.join(home, 'bin/rollout'), 'utf8'), /# rollout-bootstrap: 2/);
  assert.equal(fs.statSync(path.join(home, 'bin/rollout')).mode & 0o111, 0o111, 'ausführbar');
  assert.equal(fs.readFileSync(path.join(home, 'icon.png'), 'utf8'), 'neues logo');
});

test('Aufräumen legt rollout-run an und erneuert es nur bei höherer Nummer', async () => {
  const home = makeHome('run-starter');
  const file = path.join(home, 'versions/1.2.0/bootstrap/rollout-run');
  const write = (n, selftest) => fs.writeFileSync(file, `#!/bin/sh\n# rollout-bootstrap: ${n}\nif [ "$1" = --bootstrap-selftest ]; then echo "rollout-bootstrap ${selftest} run"; exit 0; fi\n`);
  const { service } = makeService(home);
  await service.housekeeping();
  assert.equal(exists(home, 'bin/rollout-run'), false, 'ältere Version ohne rollout-run: nichts angelegt');
  write(1, 2);
  await service.housekeeping();
  assert.equal(exists(home, 'bin/rollout-run'), false, 'Selbsttest nennt eine andere Nummer: nicht angelegt');
  write(1, 1);
  await service.housekeeping();
  assert.match(fs.readFileSync(path.join(home, 'bin/rollout-run'), 'utf8'), /# rollout-bootstrap: 1/);
  assert.equal(fs.statSync(path.join(home, 'bin/rollout-run')).mode & 0o111, 0o111, 'ausführbar');
  const before = fs.readFileSync(path.join(home, 'bin/rollout-run'), 'utf8');
  fs.appendFileSync(file, '# geändert\n');
  await service.housekeeping();
  assert.equal(fs.readFileSync(path.join(home, 'bin/rollout-run'), 'utf8'), before, 'gleiche Nummer: nicht erneuert');
});

test('„Vorherige Version“ sperrt die laufende und legt die vorherige als pending ab', async () => {
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
  assert.equal(makeService(bad).service.snapshot().previous, '', 'gesperrte Version wird nicht angeboten');
});

test('Hinweis nach Rollback: erscheint, bis er bestätigt wird', () => {
  const home = makeHome('hinweis');
  fs.writeFileSync(path.join(home, 'state/notice'), '1.3.0\n');
  const { service } = makeService(home);
  assert.equal(service.snapshot().notice, '1.3.0');
  service.dismissNotice();
  assert.equal(service.snapshot().notice, '');
  assert.equal(exists(home, 'state/notice'), false);
});

test('Gesund-Meldung: nur mit Probe, nur für die eigene Version', async () => {
  const timing = { firstCheckMs: 1e9, healthyMs: 20, intervalMs: 1e9 };
  const home = makeHome('gesund');
  const { service } = makeService(home, { timing });
  service.uiReady();
  await sleep(100);
  assert.equal(exists(home, 'state/healthy'), false, 'ohne Probe wird nichts gemeldet');

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

test('bereitgelegtes Update überlebt den Neustart der App, ein neueres ersetzt es', async () => {
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

test('gesperrte Version wird nicht erneut angeboten', async () => {
  const home = makeHome('gesperrt');
  publish(home);
  fs.writeFileSync(path.join(home, 'state/bad'), '1.3.0\n');
  const { service } = makeService(home);
  await service.check(true);
  assert.equal(service.snapshot().status, 'current');
});

test('automatisches Laden bei auto_update, einmal je Version und Start', async () => {
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
  assert.equal(downloads, 1, 'kein zweiter automatischer Versuch');
  await second.service.download();
  assert.equal(downloads, 2, 'von Hand geht es erneut');
});

test('FakeSelfUpdate: Zustände, Prüfen, Laden und Neustart ohne Dateien', async () => {
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

// Prüft den Zwift-Adapter (src/main/zwift.ts) und seine Anbindung an SimBackend (Z1 bis Z12) in Wegwerf-Ordnern.
// Kein echtes Steam, kein echter Container, kein Netz: der Download ist eine Funktion, podman und docker sind Attrappen im PATH
// (wie in run.test.mjs). Nur Z13 geht ins Netz und läuft nur mit ROLLOUT_ZWIFT_NET=1.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-zwift-test-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
// Nie die echte config.toml des Prüfrechners.
process.env.ROLLOUT_CONFIG_HOME = path.join(work, 'cfg-default');
for (const name of ['zwift', 'zwift-window', 'sim', 'config']) {
  await build({ entryPoints: [path.join(root, `src/main/${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile: path.join(work, `${name}.mjs`), logLevel: 'error' });
}
const zwift = await import(path.join(work, 'zwift.mjs'));
const zwin = await import(path.join(work, 'zwift-window.mjs'));
const sim = await import(path.join(work, 'sim.mjs'));
const config = await import(path.join(work, 'config.mjs'));

const BODY = '#!/usr/bin/env bash\necho "zwift.sh Attrappe"\n';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const COMMIT = 'a'.repeat(40);
const pin = (over = {}) => ({ repo: 'netbrain/zwift', commit: COMMIT, path: 'src/zwift.sh', sha256: sha(BODY), image: 'docker.io/netbrain/zwift', tag: '1.2.3', ...over });

let counter = 0;
const makeHome = () => { counter += 1; const home = path.join(work, `h${counter}`); fs.mkdirSync(home, { recursive: true }); return home; };
/** Download-Attrappe: schreibt `body`, zählt Aufrufe und merkt sich die URL. */
function downloader(body = BODY) {
  const calls = [];
  const fn = async (url, dest, options) => { calls.push({ url, options }); fs.writeFileSync(dest, body); };
  fn.calls = calls;
  return fn;
}
const leftovers = (home) => (fs.existsSync(path.join(home, 'zwift')) ? fs.readdirSync(path.join(home, 'zwift')) : []);
const expectError = async (promise, problem) => {
  await assert.rejects(promise, (e) => e instanceof zwift.ZwiftError && e.problem === problem, `erwartet ZwiftError(${problem})`);
};

test('Z1 Download: gepinntes Skript liegt atomar unter zwift/<commit>/zwift.sh, ausführbar, ohne Reste; ein zweiter Lauf lädt nichts', async () => {
  const home = makeHome();
  const dl = downloader();
  assert.equal(await zwift.installScript({ home, pin: pin(), download: dl }), true);
  const file = path.join(home, 'zwift', COMMIT, 'zwift.sh');
  assert.equal(fs.readFileSync(file, 'utf8'), BODY);
  assert.equal(fs.statSync(file).mode & 0o777, 0o755);
  assert.deepEqual(leftovers(home), [COMMIT]);
  assert.equal(dl.calls.length, 1);
  assert.equal(dl.calls[0].url, `https://raw.githubusercontent.com/netbrain/zwift/${COMMIT}/src/zwift.sh`);
  assert.ok(dl.calls[0].options.maxBytes <= 1024 * 1024, 'Größenbegrenzung gesetzt');
  assert.equal(zwift.scriptReady(home, pin()), true);
  assert.equal(await zwift.installScript({ home, pin: pin(), download: dl }), false);
  assert.equal(dl.calls.length, 1, 'zweiter Lauf lädt nicht erneut');
});

test('Z2 falsche Prüfsumme: nichts wird abgelegt, ein vorhandenes gutes Skript bleibt, keine Reste', async () => {
  const home = makeHome();
  await expectError(zwift.installScript({ home, pin: pin(), download: downloader('#!/bin/sh\nrm -rf ~\n') }), 'verify');
  assert.deepEqual(leftovers(home), [], 'weder Ziel noch Staging');
  assert.equal(zwift.scriptReady(home, pin()), false);
  // Gutes Skript liegt, ein Austausch mit falschem Inhalt (anderer Pin-Hash) lässt es unberührt.
  await zwift.installScript({ home, pin: pin(), download: downloader() });
  await expectError(zwift.installScript({ home, pin: pin({ sha256: 'f'.repeat(64) }), download: downloader() }), 'verify');
  assert.equal(fs.readFileSync(path.join(home, 'zwift', COMMIT, 'zwift.sh'), 'utf8'), BODY);
  assert.deepEqual(leftovers(home), [COMMIT]);
});

test('Z3 Netzfehler und Abbruch: eigener Fehlercode, keine Reste, das Ziel entsteht nicht', async () => {
  const home = makeHome();
  const failing = async () => { throw Object.assign(new Error('Verbindung'), { kind: 'net' }); };
  await expectError(zwift.installScript({ home, pin: pin(), download: failing }), 'net');
  const aborting = async () => { throw Object.assign(new Error('abgebrochen'), { kind: 'abort' }); };
  await expectError(zwift.installScript({ home, pin: pin(), download: aborting }), 'abort');
  const silent = async () => {}; // schreibt nichts
  await expectError(zwift.installScript({ home, pin: pin(), download: silent }), 'net');
  assert.deepEqual(leftovers(home), []);
});

test('Z4 zu große oder leere Datei wird abgelehnt', async () => {
  const home = makeHome();
  await expectError(zwift.installScript({ home, pin: pin(), download: downloader('x'.repeat(zwift.MAX_SCRIPT_BYTES + 1)) }), 'verify');
  await expectError(zwift.installScript({ home, pin: pin(), download: downloader('') }), 'verify');
  assert.deepEqual(leftovers(home), []);
});

test('Z5 verändertes Skript wird ersetzt, Skripte früherer Pins verschwinden, Fremdes bleibt', async () => {
  const home = makeHome();
  const oldCommit = 'b'.repeat(40);
  fs.mkdirSync(path.join(home, 'zwift', oldCommit), { recursive: true });
  fs.writeFileSync(path.join(home, 'zwift', oldCommit, 'zwift.sh'), 'alt');
  fs.mkdirSync(path.join(home, 'zwift', 'eigenes'));
  fs.mkdirSync(path.join(home, 'zwift', COMMIT));
  fs.writeFileSync(path.join(home, 'zwift', COMMIT, 'zwift.sh'), 'verändert', { mode: 0o755 });
  fs.mkdirSync(path.join(home, 'zwift', '.staging-alt'));
  assert.equal(zwift.scriptReady(home, pin()), false, 'Hash passt nicht');
  assert.equal(await zwift.installScript({ home, pin: pin(), download: downloader() }), true);
  assert.equal(fs.readFileSync(path.join(home, 'zwift', COMMIT, 'zwift.sh'), 'utf8'), BODY);
  assert.deepEqual(leftovers(home).sort(), [COMMIT, 'eigenes'].sort());
  // Nicht ausführbar zählt nicht als bereit.
  fs.chmodSync(path.join(home, 'zwift', COMMIT, 'zwift.sh'), 0o644);
  assert.equal(zwift.scriptReady(home, pin()), false);
  // Ein Symlink statt einer Datei auch nicht.
  fs.rmSync(path.join(home, 'zwift', COMMIT, 'zwift.sh'));
  fs.writeFileSync(path.join(home, 'ziel.sh'), BODY, { mode: 0o755 });
  fs.symlinkSync(path.join(home, 'ziel.sh'), path.join(home, 'zwift', COMMIT, 'zwift.sh'));
  assert.equal(zwift.scriptReady(home, pin()), false);
});

test('Z6 der Pin wird streng geprüft (er geht in URL und Pfad ein)', () => {
  assert.deepEqual(zwift.checkPin(pin()), pin());
  const bad = [
    { commit: '../../etc' }, { commit: 'A'.repeat(40) }, { commit: 'a'.repeat(39) }, { repo: 'netbrain' }, { repo: 'a/b/c' }, { repo: '../x/y' },
    { path: '../zwift.sh' }, { path: '/abs/zwift.sh' }, { path: 'src//zwift.sh' }, { sha256: 'abc' }, { sha256: 'G'.repeat(64) },
    { image: '../x' }, { image: 'UPPER/x' }, { tag: 'latest!' }, { tag: '-x' }, { tag: '' }
  ];
  for (const over of bad) assert.throws(() => zwift.checkPin(pin(over)), (e) => e.problem === 'verify', JSON.stringify(over));
  assert.throws(() => zwift.checkPin(null));
  assert.throws(() => zwift.checkPin({ ...pin(), repo: 7 }));
  // Der echte Pin aus upstreams.json besteht die Prüfung.
  const real = JSON.parse(fs.readFileSync(path.join(root, 'upstreams.json'), 'utf8')).zwift;
  assert.deepEqual(zwift.checkPin(real), real);
  assert.notEqual(real.tag, 'latest');
});

// --- RealZwift mit dem echten rollout-run und Container-Attrappen -----------------------------------------------------------
const FAKE_TOOL = `#!/bin/sh
echo "\${0##*/} $*" >> "$ROLLOUT_HOME/containers.log"
case $1 in
  info) [ -n "\${FAKE_INFO_FAIL:-}" ] && { echo "$FAKE_INFO_FAIL" >&2; exit 125; }; exit 0 ;;
  image) [ -f "$ROLLOUT_HOME/image-present" ] || exit 1; exit 0 ;;
  pull) [ -n "\${FAKE_PULL_FAIL:-}" ] && exit 1; echo "Copying blob aaa done"; echo "Copying blob bbb done" >&2; : > "$ROLLOUT_HOME/image-present"; exit 0 ;;
  rmi) [ -n "\${FAKE_RMI_FAIL:-}" ] && { echo "image is in use" >&2; exit 2; }; rm -f "$ROLLOUT_HOME/image-present"; exit 0 ;;
esac
exit 0
`;
function runtimeHome({ image = false } = {}) {
  const home = makeHome();
  fs.mkdirSync(path.join(home, 'bin'));
  fs.copyFileSync(path.join(root, 'scripts/bin-rollout-run.sh'), path.join(home, 'bin/rollout-run'));
  fs.chmodSync(path.join(home, 'bin/rollout-run'), 0o755);
  fs.mkdirSync(path.join(home, 'fakebin'));
  for (const tool of ['podman', 'docker']) fs.writeFileSync(path.join(home, 'fakebin', tool), FAKE_TOOL, { mode: 0o755 });
  if (image) fs.writeFileSync(path.join(home, 'image-present'), '');
  return home;
}
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ROLLOUT_|FAKE_|CONTAINER_TOOL$|IMAGE$|VERSION$)/.test(k)));
const realZwift = (home, extra = {}, download = downloader()) => new zwift.RealZwift({
  home, pin: pin(), download, env: { ...cleanEnv(), ROLLOUT_CONFIG_HOME: path.join(home, 'cfg'), ROLLOUT_ZWIFT_TAG: '1.2.3', PATH: `${path.join(home, 'fakebin')}:${process.env.PATH}`, ...extra }
});
const containerLog = (home) => { try { return fs.readFileSync(path.join(home, 'containers.log'), 'utf8').trim().split('\n'); } catch { return []; } };

test('Z7 RealZwift.status: Skript, Laufzeit, Image und Zustimmung aus rollout-run --zwift-status', async () => {
  const home = runtimeHome({ image: true });
  const z = realZwift(home);
  assert.deepEqual(await z.status(), { script: false, runtime: 'podman', image: true, consent: false, ref: 'docker.io/netbrain/zwift:1.2.3', problem: '' });
  await z.installScript(new AbortController().signal);
  assert.equal((await z.status()).script, true);
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state/zwift-image-ok'), 'docker.io/netbrain/zwift:1.2.3\n');
  fs.rmSync(path.join(home, 'image-present'));
  const s = await z.status();
  assert.equal(s.image, false);
  assert.equal(s.consent, true);
  assert.equal(containerLog(home).filter((l) => / pull /.test(l)).length, 0, 'status zieht nie');
});

test('Z8 RealZwift.status: fehlende Laufzeit und fehlender Tag werden unterschieden, ohne Starter gibt es einen Fehler', async () => {
  const home = runtimeHome({ image: true });
  assert.equal((await realZwift(home, { FAKE_INFO_FAIL: 'Cannot connect to the Docker daemon' }).status()).problem, 'runtime');
  assert.equal((await realZwift(home, { ROLLOUT_ZWIFT_TAG: '' }).status()).problem, 'tag');
  const bare = makeHome();
  assert.equal((await realZwift(bare).status()).problem, 'error');
});

test('Z9 RealZwift.pullImage: zieht über rollout-run, meldet Zeilen, merkt die Zustimmung; Fehler tragen ihren Code', async () => {
  const home = runtimeHome();
  const lines = [];
  await realZwift(home).pullImage((l) => lines.push(l), new AbortController().signal);
  assert.deepEqual(lines.filter((l) => /^Copying/.test(l)).sort(), ['Copying blob aaa done', 'Copying blob bbb done']);
  assert.ok(containerLog(home).includes('podman pull docker.io/netbrain/zwift:1.2.3'));
  assert.equal(fs.readFileSync(path.join(home, 'state/zwift-image-ok'), 'utf8'), 'docker.io/netbrain/zwift:1.2.3\n');
  const home2 = runtimeHome();
  await expectError(realZwift(home2, { FAKE_PULL_FAIL: '1' }).pullImage(() => {}, new AbortController().signal), 'pull');
  await expectError(realZwift(home2, { FAKE_INFO_FAIL: 'Cannot connect' }).pullImage(() => {}, new AbortController().signal), 'runtime');
  await expectError(realZwift(home2, { ROLLOUT_ZWIFT_TAG: '' }).pullImage(() => {}, new AbortController().signal), 'tag');
  const aborted = new AbortController();
  aborted.abort();
  await expectError(realZwift(home2).pullImage(() => {}, aborted.signal), 'abort');
});

// --- Anbindung an SimBackend ----------------------------------------------------------------------------------------------
function backendWith(service, { cfg, env = {} } = {}) {
  const dir = cfg ?? path.join(work, `cfg-b${(counter += 1)}`);
  fs.mkdirSync(dir, { recursive: true });
  const files = path.join(dir, 'config.toml');
  const store = { load: () => (fs.existsSync(files) ? config.parseConfig(fs.readFileSync(files, 'utf8')) : { ...config.DEFAULTS }), save: (s) => fs.writeFileSync(files, config.serializeConfig(s)) };
  const updates = { snapshot: () => ({ status: 'none', version: '1.0.0', next: '', mb: 0, progress: 0, blocked: false, previous: '', notice: '' }), settingsChanged() {}, busyChanged() {} };
  const bt = { adapter: async () => 'ready', scan: async () => {} };
  const steam = { status: () => ({ state: 'out', steamRunning: false, message: '' }), set: async () => ({ status: 'done', message: '' }) };
  const snaps = [];
  const backend = new sim.SimBackend((s) => snaps.push(s), 'en', steam, store, bt, updates, env, service);
  return { backend, store, snaps, files };
}
const settle = async (backend, until, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const snap = await backend.getSnapshot();
    if (until(snap)) return snap;
    if (Date.now() > end) throw new Error('Zeitüberschreitung');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('Z10 Installation über RealZwift: Skript laden, Tag eintragen, Image ziehen, Fortschritt, am Ende installiert und Image da', async () => {
  const home = runtimeHome();
  // rollout-run liest dieselbe config.toml wie der Speicher: derselbe Config-Ordner, und der Tag kommt nur aus dieser Datei.
  const cfgHome = path.join(work, 'cfg-z10');
  const z = realZwift(home, { ROLLOUT_ZWIFT_TAG: undefined, ROLLOUT_CONFIG_HOME: cfgHome });
  const b = backendWith(z, { cfg: cfgHome });
  const first = await b.backend.getSnapshot();
  assert.equal(first.apps.zwift.installed, false);
  assert.equal(first.apps.zwift.problem, '', 'kein Tag vor der Installation ist kein Fehler');
  await b.backend.install('zwift', { steam: false, hd: false });
  assert.equal(b.snaps.at(-1).job.app, 'zwift');
  const done = await settle(b.backend, (s) => !s.job);
  assert.equal(done.apps.zwift.installed, true);
  assert.equal(done.apps.zwift.problem, '');
  assert.equal(done.finished.app, 'zwift');
  assert.ok(zwift.scriptReady(home, pin()));
  assert.match(fs.readFileSync(path.join(cfgHome, 'config.toml'), 'utf8'), /zwift_tag = "1\.2\.3"/);
  assert.ok(containerLog(home).includes('podman pull docker.io/netbrain/zwift:1.2.3'));
  const progress = b.snaps.filter((s) => s.job).map((s) => s.job.progress);
  assert.ok(progress.includes(5), 'Skript geladen');
  assert.ok(progress.some((p) => p > 5 && p < 100), 'Schichten zählen mit');
  assert.deepEqual([...progress].sort((x, y) => x - y), progress, 'Fortschritt fällt nie');
});

test('Z11 Zustand kommt aus der Laufzeit: Skript und Image da = installiert; Image weg = nicht mehr installiert', async () => {
  const home = runtimeHome({ image: true });
  const z = realZwift(home);
  await z.installScript(new AbortController().signal);
  const { backend } = backendWith(z);
  assert.equal((await backend.getSnapshot()).apps.zwift.installed, true);
  fs.rmSync(path.join(home, 'image-present'));
  await new Promise((r) => setTimeout(r, 5200)); // Zwischenspeicher des Zustands läuft ab (5 s)
  const snap = await backend.getSnapshot();
  assert.equal(snap.apps.zwift.installed, false);
});

test('Z12 Fehlerfälle erscheinen als Problem in der Karte, nichts bleibt hängen; MyWhoosh bleibt unberührt', async () => {
  for (const [mode, problem] of [['nonet', 'net'], ['nopull', 'pull'], ['norun', 'runtime']]) {
    const { backend } = backendWith(new zwift.FakeZwift(mode, 5));
    await backend.install('zwift', { steam: false, hd: false });
    const snap = await settle(backend, (s) => !s.job && s.apps.zwift.problem !== '');
    assert.equal(snap.apps.zwift.problem, problem, mode);
    assert.equal(snap.apps.zwift.installed, false, mode);
    assert.equal(snap.finished, null, mode);
    assert.equal(snap.apps.mywhoosh.problem, '');
  }
  // Nach einem Fehler geht ein neuer Versuch (Attrappe „ready“ nach Installation).
  const { backend } = backendWith(new zwift.FakeZwift('', 5));
  await backend.install('zwift', { steam: true, hd: false });
  const snap = await settle(backend, (s) => !s.job && s.apps.zwift.installed);
  assert.equal(snap.apps.zwift.steam, true);
  assert.equal(snap.apps.zwift.problem, '');
  // Ohne Dienst bleibt Zwift wie bisher simuliert (Fortschritt in 120-ms-Schritten).
  const sim0 = backendWith(null);
  await sim0.backend.install('zwift', { steam: false, hd: false });
  assert.equal(sim0.snaps.at(-1).job.app, 'zwift');
  await sim0.backend.remove('mywhoosh');
});

// --- Start, Beenden, Entfernen (Z14 bis Z21) --------------------------------------------------------------------------------------
/** Upstream-Attrappe für `rollout-run zwift` (ROLLOUT_RUN_UPSTREAM): ersetzt zwift.sh, es startet nie ein Container. */
function stubUpstream(home, body) {
  const file = path.join(home, 'up.sh');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { ROLLOUT_RUN_UPSTREAM: file, ROLLOUT_RUN_NO_INHIBIT: '1' };
}
const STUB_OK = `printf '\\033[34m[*] Preparing to launch Zwift\\033[0m\\n'
echo "env tool=$CONTAINER_TOOL image=$IMAGE version=$VERSION fg=$ZWIFT_FG noupdate=$DONT_UPDATE"
printf '\\033[34m[*] Launching Zwift\\033[0m\\n'`;
const collect = (z) => { const lines = []; return { lines, run: z.start((l) => lines.push(l)) }; };

test('Z14 RealZwift.start: Ausgabe zeilenweise ohne Farbcodes, die Startzeile wird erkannt, Umgebung für zwift.sh, Exit 0', async () => {
  const home = runtimeHome({ image: true });
  const { lines, run } = collect(realZwift(home, stubUpstream(home, STUB_OK)));
  assert.equal(await run.done, 0);
  assert.deepEqual(lines, ['[*] Preparing to launch Zwift', 'env tool=podman image=docker.io/netbrain/zwift version=1.2.3 fg=1 noupdate=1', '[*] Launching Zwift']);
  assert.deepEqual(lines.map(zwift.isStartLine), [false, false, true]);
  assert.equal(zwift.isStartLine('[*] Preparing to launch Zwift'), false);
  assert.equal(zwift.isRunningLine('[podman|✓] Zwift started using wine'), true);
  assert.equal(zwift.isRunningLine('[podman|*] Starting Zwift using wine'), false);
  assert.equal(containerLog(home).filter((l) => / (pull|run|rmi) /.test(l)).length, 0, 'nur geprüft, nichts gezogen oder gestartet');
});

test('Z15 RealZwift.start: Exit-Codes von rollout-run tragen ihren Grund (Laufzeit, Tag, Image fehlt, Starter fehlt)', async () => {
  const exitOf = async (home, extra) => collect(realZwift(home, { ...stubUpstream(home, 'exit 0'), ...extra })).run.done;
  assert.equal(await exitOf(runtimeHome({ image: true }), { FAKE_INFO_FAIL: 'Cannot connect' }), 10);
  assert.equal(await exitOf(runtimeHome({ image: true }), { ROLLOUT_ZWIFT_TAG: '' }), 11);
  assert.equal(await exitOf(runtimeHome(), {}), 12, 'Image fehlt und keine Zustimmung: nichts wird gezogen');
  assert.equal(await collect(realZwift(makeHome())).run.done, 127, 'ohne Starter');
  const bare = runtimeHome({ image: true });
  assert.equal(await exitOf(bare, { ROLLOUT_RUN_UPSTREAM: path.join(bare, 'fehlt.sh') }), 127);
  assert.deepEqual(zwift.RUN_PROBLEM, { 10: 'runtime', 11: 'tag', 12: 'pull', 127: 'error' });
  assert.equal(containerLog(bare).filter((l) => / pull /.test(l)).length, 0);
});

test('Z16 RealZwift.start.stop: TERM geht an den Starter, der den Container mit podman stop anhält (nicht an die Gruppe: das ließ ihn als Waise laufen); das Warten endet', async () => {
  const home = runtimeHome({ image: true });
  const { lines, run } = collect(realZwift(home, { ...stubUpstream(home, `sleep 30 & echo $! > "$ROLLOUT_HOME/child.pid"\necho "Launching Zwift"\nwait`), USER: 'fahrer' }));
  const end = Date.now() + 5000;
  while (!lines.some(zwift.isStartLine) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.equal(containerLog(home).filter((l) => / stop /.test(l)).length, 0, 'läuft: noch kein stop');
  run.stop();
  const code = await run.done;
  assert.notEqual(code, 0);
  assert.deepEqual(containerLog(home).filter((l) => / stop /.test(l)), ['podman stop -t 10 zwift-fahrer']);
  assert.equal(fs.existsSync(path.join(home, 'state/run.pid')), false, 'run.pid aufgeräumt');
  try { process.kill(Number(fs.readFileSync(path.join(home, 'child.pid'), 'utf8'))); } catch { /* schon weg */ }
  // ZWIFT_RIDER bestimmt den Namen, wie in zwift.sh.
  const home2 = runtimeHome({ image: true });
  const second = collect(realZwift(home2, { ...stubUpstream(home2, `echo "Launching Zwift"\nsleep 30 &\nwait`), ZWIFT_RIDER: 'rollouttest', USER: 'fahrer' }));
  const end2 = Date.now() + 5000;
  while (!second.lines.some(zwift.isStartLine) && Date.now() < end2) await new Promise((r) => setTimeout(r, 20));
  second.run.stop();
  await second.run.done;
  assert.deepEqual(containerLog(home2).filter((l) => / stop /.test(l)), ['podman stop -t 10 zwift-rollouttest']);
});

test('Z17 RealZwift.removeImage: podman rmi für genau Image:Tag, Zustimmung vergessen; ohne Image ebenfalls Erfolg; Fehler tragen ihren Grund', async () => {
  const home = runtimeHome({ image: true });
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state/zwift-image-ok'), 'docker.io/netbrain/zwift:1.2.3\n');
  const z = realZwift(home);
  await z.removeImage(new AbortController().signal);
  assert.ok(containerLog(home).includes('podman rmi docker.io/netbrain/zwift:1.2.3'));
  assert.equal(fs.existsSync(path.join(home, 'image-present')), false);
  assert.equal(fs.existsSync(path.join(home, 'state/zwift-image-ok')), false, 'Zustimmung vergessen');
  const before = containerLog(home).length;
  await z.removeImage(new AbortController().signal);
  assert.equal(containerLog(home).filter((l) => / rmi /.test(l)).length, 1, 'ohne Image kein zweites rmi');
  assert.ok(containerLog(home).length > before - 1);
  const busy = runtimeHome({ image: true });
  await expectError(realZwift(busy, { FAKE_RMI_FAIL: '1' }).removeImage(new AbortController().signal), 'error');
  assert.equal(fs.existsSync(path.join(busy, 'image-present')), true, 'bei Fehler bleibt das Image');
  await expectError(realZwift(runtimeHome({ image: true }), { FAKE_INFO_FAIL: 'Cannot connect' }).removeImage(new AbortController().signal), 'runtime');
  await expectError(realZwift(runtimeHome({ image: true }), { ROLLOUT_ZWIFT_TAG: '' }).removeImage(new AbortController().signal), 'tag');
  await expectError(realZwift(makeHome()).removeImage(new AbortController().signal), 'error');
});

const launchOf = async (backend, until, ms) => (await settle(backend, until, ms)).launch;
const READY = { ROLLOUT_ZWIFT_RUNNING_MS: '300' };

test('Z18 Start über SimBackend mit RealZwift: Phasen aus der Ausgabe (Vorbereiten, Startet, Läuft), Beenden stoppt das Spiel', async () => {
  const home = runtimeHome({ image: true });
  const z = realZwift(home, stubUpstream(home, `echo "[*] Preparing to launch Zwift"\nsleep 0.4\necho "[*] Launching Zwift"\nsleep 30 &\nwait`));
  await z.installScript(new AbortController().signal);
  const { backend, snaps } = backendWith(z, { env: READY });
  assert.equal((await backend.getSnapshot()).apps.zwift.installed, true);
  await backend.launch('zwift');
  assert.equal(snaps.at(-1).launch.phase, 'updates');
  assert.equal(snaps.at(-1).launch.problem, '');
  await launchOf(backend, (s) => s.launch?.phase === 'starting');
  const running = await launchOf(backend, (s) => s.launch?.phase === 'running');
  assert.equal(running.progress, 100);
  const seen = snaps.filter((s) => s.launch).map((s) => s.launch.phase);
  assert.deepEqual([...new Set(seen)], ['updates', 'starting', 'running']);
  assert.ok(!seen.includes('bluetooth'), 'Zwift prüft kein Bluetooth');
  const progress = snaps.filter((s) => s.launch).map((s) => s.launch.progress);
  assert.deepEqual([...progress].sort((a, b) => a - b), progress, 'Fortschritt fällt nie');
  await backend.launch('zwift'); // zweiter Start läuft nicht an
  const stopping = backend.stopLaunch();
  assert.equal(snaps.at(-1).launch.phase, 'stopping', 'Beenden ist sichtbar, solange der Container stoppt');
  await backend.launch('zwift'); // und ein Start in dieser Zeit wird abgewiesen
  await stopping;
  const after = await backend.getSnapshot();
  assert.equal(after.launch, null);
  assert.equal(fs.existsSync(path.join(home, 'state/run.pid')), false);
  assert.equal(after.apps.zwift.installed, true);
});

test('Z23 „Läuft“ aus der Meldung des Containers statt nach der Wartezeit; ohne Startzeile geht es über „Zwift startet“', async () => {
  const phasesFor = async (body) => {
    const home = runtimeHome({ image: true });
    const z = realZwift(home, stubUpstream(home, body));
    await z.installScript(new AbortController().signal);
    const { backend, snaps } = backendWith(z, { env: { ROLLOUT_ZWIFT_RUNNING_MS: '60000' } });
    await backend.getSnapshot();
    const t0 = Date.now();
    await backend.launch('zwift');
    await launchOf(backend, (s) => s.launch?.phase === 'running', 5000);
    assert.ok(Date.now() - t0 < 5000, 'weit vor den 60 s der Wartezeit');
    const seen = [...new Set(snaps.filter((s) => s.launch).map((s) => s.launch.phase))];
    await backend.stopLaunch();
    return seen;
  };
  assert.deepEqual(await phasesFor('echo "[*] Launching Zwift"\nsleep 0.2\necho "[podman|✓] Zwift started using wine"\nsleep 30 &\nwait'), ['updates', 'starting', 'running']);
  assert.deepEqual(await phasesFor('echo "[podman|✓] Zwift started using wine"\nsleep 30 &\nwait'), ['updates', 'starting', 'running']);
});

test('Z19 Start endet: Exit 0 = Spiel beendet; Fehler kurz nach dem Start = Absturz; Exit 10 bis 12 und 127 = Start gescheitert mit Grund', async () => {
  const ended = async (body) => {
    const home = runtimeHome({ image: true });
    const z = realZwift(home, stubUpstream(home, body));
    await z.installScript(new AbortController().signal);
    const { backend } = backendWith(z, { env: READY });
    assert.equal((await backend.getSnapshot()).apps.zwift.installed, true);
    await backend.launch('zwift');
    const snap = await settle(backend, (s) => s.launch === null || ['crash', 'failed'].includes(s.launch.phase));
    await backend.stopLaunch(); // räumt den Zustand und den Takt auf
    assert.equal((await backend.getSnapshot()).launch, null, 'Verlassen der Fehleransicht beendet den Start');
    return snap.launch;
  };
  assert.equal(await ended('echo "Launching Zwift"\nexit 0'), null);
  assert.equal((await ended('echo "Launching Zwift"\nexit 1')).phase, 'crash');
  for (const [code, problem] of [[10, 'runtime'], [11, 'tag'], [12, 'pull'], [127, 'error']]) {
    const launch = await ended(`exit ${code}`);
    assert.deepEqual([launch.phase, launch.problem], ['failed', problem], `Exit ${code}`);
  }
  // Die Attrappe: Exit 12 (Image fehlt) und Exit 1 nach der Startzeile.
  for (const [mode, phase, problem] of [['runfail', 'failed', 'pull'], ['runcrash', 'crash', '']]) {
    const { backend } = backendWith(new zwift.FakeZwift(mode, 5));
    await backend.getSnapshot();
    await backend.launch('zwift');
    const launch = await launchOf(backend, (s) => s.launch && ['crash', 'failed'].includes(s.launch.phase));
    assert.deepEqual([launch.phase, launch.problem], [phase, problem], mode);
    await backend.stopLaunch();
  }
});

test('Z20 Entfernen über SimBackend: Image weg, nicht mehr installiert, Skript bleibt, Steam-Eintrag weg; Fehler bleiben sichtbar und nichts geht verloren', async () => {
  const home = runtimeHome({ image: true });
  const z = realZwift(home);
  await z.installScript(new AbortController().signal);
  const { backend } = backendWith(z);
  await backend.setSteam('zwift', true);
  assert.equal((await backend.getSnapshot()).apps.zwift.installed, true);
  await backend.remove('zwift');
  const snap = await backend.getSnapshot();
  assert.equal(snap.apps.zwift.installed, false);
  assert.equal(snap.apps.zwift.steam, false);
  assert.equal(snap.apps.zwift.problem, '');
  assert.ok(containerLog(home).includes('podman rmi docker.io/netbrain/zwift:1.2.3'));
  assert.ok(zwift.scriptReady(home, pin()), 'das geprüfte Skript bleibt für eine Neuinstallation');
  // Scheitert rmi (Container läuft noch), bleibt Zwift installiert und die Karte nennt das Problem.
  const busy = runtimeHome({ image: true });
  const zb = realZwift(busy, { FAKE_RMI_FAIL: '1' });
  await zb.installScript(new AbortController().signal);
  const b2 = backendWith(zb).backend;
  await b2.getSnapshot();
  await b2.remove('zwift');
  const kept = await b2.getSnapshot();
  assert.equal(kept.apps.zwift.installed, true);
  assert.equal(kept.apps.zwift.problem, 'error');
  // Attrappe: dasselbe.
  const { backend: fb } = backendWith(new zwift.FakeZwift('norem', 5));
  await fb.getSnapshot();
  await fb.remove('zwift');
  assert.equal((await fb.getSnapshot()).apps.zwift.problem, 'error');
  assert.equal((await fb.getSnapshot()).apps.zwift.installed, true);
  // Ohne Dienst bleibt Entfernen die Simulation wie bei MyWhoosh.
  const plain = backendWith(null).backend;
  await plain.remove('zwift');
  assert.equal((await plain.getSnapshot()).apps.zwift.installed, false);
});

test('Z21 Tag für den Zustimmungsdialog: leer ohne Dienst, sonst Umgebung vor config.toml vor dem Pin; Fortschritt der Installation bleibt stabil', async () => {
  assert.equal((await backendWith(null).backend.getSnapshot()).zwiftTag, '');
  const fake = new zwift.FakeZwift('', 5);
  assert.equal((await backendWith(fake).backend.getSnapshot()).zwiftTag, '1.0.0', 'Pin als Voreinstellung');
  const cfg = path.join(work, 'cfg-z21');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'config.toml'), 'zwift_tag = "2.0.0"\n');
  assert.equal((await backendWith(fake, { cfg }).backend.getSnapshot()).zwiftTag, '2.0.0', 'config.toml vor dem Pin');
  assert.equal((await backendWith(fake, { cfg, env: { ROLLOUT_ZWIFT_TAG: '3.0.0' } }).backend.getSnapshot()).zwiftTag, '3.0.0', 'Umgebung vor config.toml');
});

test('Z22 chooseZwiftMode: echt, sobald rollout-run da ist und der Pin gilt; ausdrückliche Wahl gewinnt; sonst Simulation', () => {
  const good = pin();
  const mode = (m, runnerExists, p = good) => zwift.chooseZwiftMode({ mode: m, runnerExists, pin: p });
  assert.equal(mode(undefined, true), 'real');
  assert.equal(mode(undefined, false), 'sim');
  assert.equal(mode(undefined, true, { ...good, sha256: 'x' }), 'sim', 'ungültiger Pin');
  assert.equal(mode('', true), 'real');
  assert.equal(mode('sim', true), 'sim');
  assert.equal(mode('real', false), 'real');
  assert.equal(mode('fake', false), 'fake');
  assert.equal(mode('unsinn', true), 'sim');
  const real = JSON.parse(fs.readFileSync(path.join(root, 'upstreams.json'), 'utf8')).zwift;
  assert.equal(mode(undefined, true, real), 'real', 'der echte Pin aus upstreams.json');
});

// --- Sichtbarkeit im Spielmodus (Z24 bis Z28): nie ein echter X-Server, die Werkzeuge sind eine Funktion --------------------------

const TREE = (...windows) => `\nxwininfo: Window id: 0x3d9 (the root window) (has no name)\n\n  Root window id: 0x3d9 (the root window) (has no name)\n  Parent window id: 0x0 (none)\n     ${windows.length} children:\n${windows.join('\n')}\n`;
const WIN = (id, name, cls, size) => `     ${id} "${name}": ("${cls}" "${cls}")  ${size}+4+30  +4+30`;
const CHILD = (id) => `        ${id} (has no name): ()  1912x1046+0+0  +4+30`;
const focusOut = (id) => (id === null ? 'GAMESCOPE_FOCUSED_WINDOW:  not found.\n' : `GAMESCOPE_FOCUSED_WINDOW(CARDINAL) = ${id}\n`);

test('Z24 AppID aus dem Prozessbaum: reaper SteamLaunch AppId=<N> als Vorfahre; sonst null', () => {
  const proc = path.join(work, 'proc1');
  const put = (pid, ppid, comm, argv) => {
    fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} 1 1 0 -1 0\n`);
    fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), argv.join('\0') + '\0');
  };
  put(1, 0, 'init', ['/sbin/init']);
  put(100, 1, 'steam', ['/usr/bin/steam']);
  put(200, 100, 'reaper', ['/home/u/.steam/ubuntu12_32/reaper', 'SteamLaunch', 'AppId=4070058561', '--', '/x/rollout/bin/rollout']);
  put(300, 200, 'bash (x) y', ['bash', '/x/rollout/bin/rollout']); // Name mit Klammern und Leerzeichen
  put(400, 300, 'electron', ['electron', '.']);
  assert.equal(zwin.appIdFromAncestors(400, proc), '4070058561');
  assert.equal(zwin.appIdFromAncestors(200, proc), '4070058561');
  assert.equal(zwin.appIdFromAncestors(100, proc), null, 'Steam selbst ist kein Eintrag');
  put(201, 100, 'reaper', ['reaper', 'SteamLaunch', 'AppId=99999999999', '--', 'x']); // zu groß für eine AppID
  put(401, 201, 'x', ['x']);
  assert.equal(zwin.appIdFromAncestors(401, proc), null);
  assert.equal(zwin.appIdFromAncestors(999, proc), null, 'unbekannter Prozess');
});

test('Z25 Fenstererkennung: Spielfenster der obersten Ebene, Hilfsfenster und Fremdes zählen nicht; Fokus aus GAMESCOPE_FOCUSED_WINDOW', () => {
  const tree = TREE(
    WIN('0x4200006', 'Default IME', 'zwiftapp.exe', '1x1'),
    WIN('0x3e00004', '', 'explorer.exe', '1912x1046'),
    WIN('0x4200005', 'Zwift', 'zwiftapp.exe', '1912x1046'), CHILD('0x4200009'),
    WIN('0x4200010', 'Zwift Launcher', 'ZwiftApp.exe', '800x600'));
  assert.deepEqual(zwin.findZwiftWindow(tree), { id: 0x4200005, hex: '0x4200005', width: 1912, height: 1046 }, 'das größte Fenster');
  assert.equal(zwin.findZwiftWindow(TREE(WIN('0x1', 'Rollout', 'rollout', '1280x800'))), null);
  assert.equal(zwin.findZwiftWindow(TREE(WIN('0x2', 'x', 'zwiftapp.exe', '1x1'))), null);
  assert.equal(zwin.findZwiftWindow(''), null);
  assert.equal(zwin.parseFocusedWindow(focusOut(67108869)), 67108869);
  assert.equal(zwin.parseFocusedWindow(focusOut(null)), null);
});

/** X-Attrappe: `state.tree` und `state.focus` sind veränderbar, alle Aufrufe landen in `calls`. */
function fakeX(state) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args].join(' '));
    if (state.down) throw new Error('cannot open display');
    if (file === 'xwininfo') return state.tree;
    if (file === 'xprop' && args[0] === '-root') return focusOut(state.focus);
    if (file === 'xprop' && args[0] === '-id') { state.tagged = args.at(-1); return ''; }
    if (file === 'xhost') {
      if (args[0] === '-local:') { state.local = false; return 'access control enabled\n'; }
      return `access control enabled, only authorized clients can connect\n${state.local ? 'LOCAL:\n' : ''}SI:localuser:mace\n`;
    }
    throw new Error(`unerwartet: ${file}`);
  };
  return { exec, calls };
}
const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('Zeitüberschreitung'); await new Promise((r) => setTimeout(r, 5)); } };

test('Z26 Beobachter: Fenster kennzeichnen (einmal je Fenster), „sichtbar“ erst bei Fokus, Verlust und neues Fenster werden erkannt', async () => {
  const state = { tree: TREE(WIN('0x3e00004', '', 'explorer.exe', '160x20')), focus: 6291459 };
  const { exec, calls } = fakeX(state);
  const events = [];
  const w = zwin.watchZwiftWindow({ exec, appId: '4070058561', onVisible: (v) => events.push(v), intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(events, [], 'kein Fenster: nichts gemeldet');
  assert.equal(calls.filter((c) => c.startsWith('xprop -id')).length, 0, 'nichts gekennzeichnet');

  state.tree = TREE(WIN('0x4200006', 'IME', 'zwiftapp.exe', '1x1'), WIN('0x4200005', 'Zwift', 'zwiftapp.exe', '1912x1046'));
  await until(() => state.tagged);
  assert.equal(state.tagged, '4070058561');
  assert.ok(calls.includes('xprop -id 0x4200005 -f STEAM_GAME 32c -set STEAM_GAME 4070058561'), 'genau der Aufruf aus Test T3');
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(events, [], 'gekennzeichnet, aber Rollout hat noch den Fokus: nicht sichtbar');

  state.focus = 0x4200005;
  await until(() => events.length === 1);
  assert.deepEqual(events, [true]);
  assert.equal(w.visible, true);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.filter((c) => c.startsWith('xprop -id')).length, 1, 'je Fenster nur einmal gesetzt');

  state.focus = 6291459; // Steam-Overlay oder Rücksprung
  await until(() => events.length === 2);
  assert.deepEqual(events, [true, false]);

  state.tree = TREE(WIN('0x4200099', 'Zwift', 'zwiftapp.exe', '1920x1080')); // Launcher wird durch das Spiel ersetzt
  state.focus = 0x4200099;
  await until(() => events.length === 3);
  assert.deepEqual(events, [true, false, true]);
  assert.equal(calls.filter((c) => c.startsWith('xprop -id')).length, 2, 'das neue Fenster wird erneut gekennzeichnet');

  state.down = true; // X-Server kurz weg: Beobachter bleibt am Leben
  await new Promise((r) => setTimeout(r, 40));
  state.down = false;
  state.tree = TREE();
  await until(() => events.length === 4);
  assert.deepEqual(events, [true, false, true, false]);

  w.stop();
  const n = calls.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.length, n, 'nach stop() keine Abfragen mehr');
});

test('Z27 Beobachter ohne AppID (nicht aus Steam gestartet): nichts gesetzt, nichts gemeldet, ein Hinweis', async () => {
  const state = { tree: TREE(WIN('0x4200005', 'Zwift', 'zwiftapp.exe', '1912x1046')), focus: 0x4200005 };
  const { exec, calls } = fakeX(state);
  const notes = []; const events = [];
  const w = zwin.watchZwiftWindow({ exec, appId: null, onVisible: (v) => events.push(v), onNote: (t) => notes.push(t), intervalMs: 5 });
  await new Promise((r) => setTimeout(r, 50));
  w.stop();
  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
  assert.equal(notes.length, 1);
});

test('Z28 Start mit RealZwift und Fenster: sichtbar im Snapshot, bei Ende zurückgesetzt; xhost +local: wird nur zurückgenommen, wenn es vorher fehlte', async () => {
  for (const hadLocal of [false, true]) {
    const home = runtimeHome({ image: true });
    const state = { tree: TREE(), focus: 6291459, local: hadLocal };
    const { exec, calls } = fakeX(state);
    const z = new zwift.RealZwift({
      home, pin: pin(), download: downloader(), windows: { exec, appId: '4070058561', intervalMs: 10 },
      env: { ...cleanEnv(), ROLLOUT_CONFIG_HOME: path.join(home, 'cfg'), ROLLOUT_ZWIFT_TAG: '1.2.3', PATH: `${path.join(home, 'fakebin')}:${process.env.PATH}`, ...stubUpstream(home, 'echo "[*] Launching Zwift"\nsleep 30 &\nwait') }
    });
    await z.installScript(new AbortController().signal);
    const { backend, snaps } = backendWith(z, { env: { ROLLOUT_ZWIFT_RUNNING_MS: '60000' } });
    await backend.getSnapshot();
    await backend.launch('zwift');
    state.local = true; // zwift.sh hat `xhost +local:` aufgerufen
    state.tree = TREE(WIN('0x4200005', 'Zwift', 'zwiftapp.exe', '1912x1046'));
    await until(() => state.tagged);
    assert.notEqual(snaps.at(-1).launch.visible, true, 'noch nicht im Fokus');
    state.focus = 0x4200005;
    await settle(backend, (s) => s.launch?.visible === true);
    await backend.stopLaunch();
    const after = await backend.getSnapshot();
    assert.equal(after.launch, null);
    assert.equal(snaps.some((s) => s.launch?.visible === false), true, 'beim Beenden zurückgesetzt');
    const revoked = calls.includes('xhost -local:');
    assert.equal(revoked, !hadLocal, hadLocal ? 'bestehender xhost-Eintrag bleibt' : 'von zwift.sh geöffneter Zugriff wird geschlossen');
    assert.equal(state.local, hadLocal);
    const n = calls.length;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls.length, n, 'nach dem Ende keine Abfragen mehr');
  }
});

test('Z29 ohne Angabe `windows` berührt RealZwift.start keinen X-Server (xwininfo, xprop und xhost im PATH wären Fallen)', async () => {
  const home = runtimeHome({ image: true });
  for (const tool of ['xwininfo', 'xprop', 'xhost']) fs.writeFileSync(path.join(home, 'fakebin', tool), `#!/bin/sh\necho "$0" >> "${path.join(home, 'x-called')}"\n`, { mode: 0o755 });
  const { lines, run } = collect(realZwift(home, stubUpstream(home, STUB_OK)));
  assert.equal(await run.done, 0);
  assert.equal(lines.length, 3);
  assert.equal(fs.existsSync(path.join(home, 'x-called')), false);
});

test('Z13 echtes Netz (nur mit ROLLOUT_ZWIFT_NET=1): das gepinnte zwift.sh von GitHub hat die Prüfsumme aus upstreams.json', { skip: process.env.ROLLOUT_ZWIFT_NET !== '1' }, async () => {
  const real = JSON.parse(fs.readFileSync(path.join(root, 'upstreams.json'), 'utf8')).zwift;
  const home = makeHome();
  const download = async (url, dest) => {
    const res = await fetch(url, { headers: { 'User-Agent': 'Rollout' } });
    assert.equal(res.status, 200, url);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  };
  assert.equal(await zwift.installScript({ home, pin: real, download }), true);
  assert.ok(zwift.scriptReady(home, real));
  assert.match(fs.readFileSync(path.join(home, 'zwift', real.commit, 'zwift.sh'), 'utf8'), /^#!\/usr\/bin\/env bash/);
});

// Prüft den MyWhoosh-Adapter (src/main/mywhoosh.ts) und seine Anbindung an SimBackend (M1 bis M16) in Wegwerf-Ordnern.
// Kein echtes MyWhoosh, kein Netz, kein Wine, nie das echte ~/Games: Der Upstream ist die Attrappe `mywhoosh.sh` (ROLLOUT_RUN_UPSTREAM) und
// legt dieselben Dateien an wie das echte Skript; HOME und MYWHOOSH_ROOT zeigen in den Wegwerf-Ordner. `rollout-run` ist das echte.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-mywhoosh-test-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
process.env.ROLLOUT_CONFIG_HOME = path.join(work, 'cfg-default');
for (const name of ['mywhoosh', 'sim', 'config']) {
  await build({ entryPoints: [path.join(root, `src/main/${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile: path.join(work, `${name}.mjs`), logLevel: 'error' });
}
const mw = await import(path.join(work, 'mywhoosh.mjs'));
const sim = await import(path.join(work, 'sim.mjs'));
const config = await import(path.join(work, 'config.mjs'));
const upstreams = JSON.parse(fs.readFileSync(path.join(root, 'upstreams.json'), 'utf8'));

const EXE = 'MyWhoosh/Binaries/Win64/MyWhoosh-Win64-Shipping.exe';
// Attrappe von mywhoosh.sh. FAKE_FAIL=<Text> lässt install und update mit dieser Meldung scheitern, FAKE_UNINSTALL_FAIL=1 das Entfernen,
// RUN_MODE steuert `run` (exit N, wait). Wie das Original bricht install ab, wenn der Spielordner schon da ist.
const FAKE_UPSTREAM = `#!/bin/sh
echo "$*" >> "$ROLLOUT_HOME/calls.log"
echo "pid=$$ pgid=$(ps -o pgid= -p $$ | tr -d ' ') pidfile=$(cat "$ROLLOUT_HOME/state/run.pid" 2>/dev/null)" >> "$ROLLOUT_HOME/env.log"
hd=; for a in "$@"; do [ "$a" = --hd ] && hd=-hd; done
ROOT=\${MYWHOOSH_ROOT:-$HOME/Games/mywhoosh\${hd}-linux}
say() { echo "[mywhoosh] $*" >&2; }
manifest() { printf '<Package><Identity Name="MyWhooshTechnologyService.644173E064ED2" Publisher="CN=X" Version="%s" ProcessorArchitecture="x64" /></Package>' "$1" > "$ROOT/game/AppxManifest.xml"; }
case $1 in
  install)
    [ -e "$ROOT/game" ] && { say "error: $ROOT/game exists; run 'uninstall' first"; exit 1; }
    mkdir -p "$ROOT/cache"
    say "Proton GE-Proton11-9 already installed"
    case \${RUN_MODE:-} in slow) : > "$ROLLOUT_HOME/started"; sleep 30 & wait ;; esac
    say "downloading MyWhoosh from Microsoft's Store servers (about 4 GB, this takes a while)"
    [ -n "\${FAKE_FAIL:-}" ] && { say "error: $FAKE_FAIL"; exit 1; }
    mkdir -p "$ROOT/game/MyWhoosh/Binaries/Win64"; : > "$ROOT/game/${EXE}"; manifest 6.2.3.0
    [ -n "$hd" ] && echo hd > "$ROOT/edition"
    say "MyWhoosh 6.2.3.0 installed"
    say "preparing Windows environment (first time downloads the Steam runtime, a few minutes)"
    say "shortcuts added to the desktop (/x) and the application menu" ;;
  update)
    [ -n "\${FAKE_FAIL:-}" ] && { say "error: $FAKE_FAIL"; exit 1; }
    manifest 6.3.0.0; say "MyWhoosh updated to 6.3.0.0" ;;
  uninstall)
    [ -n "\${FAKE_UNINSTALL_FAIL:-}" ] && { say "error: cannot remove"; exit 1; }
    rm -rf "$ROOT"; say "removed $ROOT" ;;
  run)
    say "updating MyWhoosh 6.2.3.0 -> 6.3.0.0"
    sleep 0.3
    say "starting MyWhoosh 6.2.3.0 (direct Bluetooth), log: /x/run.log"
    echo "cursor=\${XCURSOR_THEME-} size=\${XCURSOR_SIZE-} path=\${XCURSOR_PATH-}" >> "$ROLLOUT_HOME/cursor.log"
    case \${RUN_MODE:-wait} in
      exit*) exit "\${RUN_MODE#exit }" ;;
      wait) sleep 30 >/dev/null 2>&1 & echo $! > "$ROLLOUT_HOME/child.pid"; : > "$ROLLOUT_HOME/started"; wait ;;
    esac ;;
esac
`;

let counter = 0;
/** Wegwerf-Aufbau: ROLLOUT_HOME mit dem echten rollout-run, eigenes HOME, Spielordner unter MYWHOOSH_ROOT (oder HOME bei `homeRoot`). */
function setup({ homeRoot = false, extra = {} } = {}) {
  counter += 1;
  const home = path.join(work, `h${counter}`);
  const userHome = path.join(work, `u${counter}`);
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.mkdirSync(userHome, { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/bin-rollout-run.sh'), path.join(home, 'bin/rollout-run'));
  fs.chmodSync(path.join(home, 'bin/rollout-run'), 0o755);
  fs.writeFileSync(path.join(home, 'mywhoosh.sh'), FAKE_UPSTREAM, { mode: 0o755 });
  const gameRoot = path.join(work, `g${counter}`);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ROLLOUT_|MYWHOOSH_|FAKE_|RUN_MODE$)/.test(k)));
  const env = {
    ...clean, HOME: userHome, ROLLOUT_HOME: home, ROLLOUT_RUN_UPSTREAM: path.join(home, 'mywhoosh.sh'), ROLLOUT_RUN_NO_INHIBIT: '1',
    ...(homeRoot ? {} : { MYWHOOSH_ROOT: gameRoot }), ...extra
  };
  const service = new mw.RealMywhoosh({ home, env, pollMs: 50, checkSpace: false, stopGraceMs: 5000 });
  const log = (name) => { try { return fs.readFileSync(path.join(home, name), 'utf8').trim().split('\n'); } catch { return []; } };
  return { home, userHome, gameRoot: homeRoot ? path.join(userHome, 'Games/mywhoosh-linux') : gameRoot, env, service, calls: () => log('calls.log') };
}

function backendWith(service, { env = {}, adapter = async () => 'ready' } = {}) {
  const dir = path.join(work, `cfg-b${(counter += 1)}`);
  fs.mkdirSync(dir, { recursive: true });
  const files = path.join(dir, 'config.toml');
  const store = { load: () => (fs.existsSync(files) ? config.parseConfig(fs.readFileSync(files, 'utf8')) : { ...config.DEFAULTS }), save: (s) => fs.writeFileSync(files, config.serializeConfig(s)) };
  const updates = { snapshot: () => ({ status: 'none', version: '1.0.0', next: '', mb: 0, progress: 0, blocked: false, previous: '', notice: '' }), settingsChanged() {}, busyChanged() {} };
  const bt = { adapter: (...a) => adapter(...a), scan: async () => {} };
  const steam = { status: () => ({ state: 'out', steamRunning: false, message: '' }), set: async () => ({ status: 'done', message: '' }) };
  const snaps = [];
  const backend = new sim.SimBackend((s) => snaps.push(s), 'en', steam, store, bt, updates, env, null, service);
  return { backend, snaps };
}
const settle = async (backend, until, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const snap = await backend.getSnapshot();
    if (until(snap)) return snap;
    if (Date.now() > end) throw new Error('Zeitüberschreitung');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const installed = (s) => s.apps.mywhoosh.installed;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (fn()) return true; await new Promise((r) => setTimeout(r, 30)); } return false; };

function placeGame(gameRoot, version = '6.2.3.0') {
  fs.mkdirSync(path.join(gameRoot, 'game/MyWhoosh/Binaries/Win64'), { recursive: true });
  fs.writeFileSync(path.join(gameRoot, 'game', EXE), '');
  fs.writeFileSync(path.join(gameRoot, 'game/AppxManifest.xml'), `<Package><Identity Name="A.644173E064ED2" Version="${version}" ProcessorArchitecture="x64"/></Package>`);
}

test('M1 Zustand von der Platte: nicht installiert, installiert mit Version, nur HD, Ordner ohne Spiel, unlesbares Manifest', () => {
  const a = setup();
  assert.deepEqual(mw.readStatus(a.env), { installed: false, version: '', edition: 'standard' });
  fs.mkdirSync(path.join(a.gameRoot, 'game'), { recursive: true });
  assert.equal(mw.readStatus(a.env).installed, false, 'Ordner ohne Spiel zählt nicht');
  placeGame(a.gameRoot);
  assert.deepEqual(mw.readStatus(a.env), { installed: true, version: '6.2.3.0', edition: 'standard' });
  fs.writeFileSync(path.join(a.gameRoot, 'game/AppxManifest.xml'), 'kaputt');
  assert.deepEqual(mw.readStatus(a.env), { installed: true, version: '', edition: 'standard' });
  const hd = setup({ homeRoot: true });
  placeGame(path.join(hd.userHome, 'Games/mywhoosh-hd-linux'), '6.2.3.0');
  assert.deepEqual(mw.readStatus(hd.env), { installed: true, version: '6.2.3.0', edition: 'hd' });
  placeGame(path.join(hd.userHome, 'Games/mywhoosh-linux'), '6.1.0.0');
  assert.equal(mw.readStatus(hd.env).edition, 'standard', 'bei beiden gilt die Standard-Ausgabe');
});

test('M2 Installation über SimBackend: Job mit Fortschritt (nie rückwärts, Zeilen setzen Mindestwerte), am Ende installiert mit Version, Protokoll liegt da', async () => {
  const a = setup();
  const { backend, snaps } = backendWith(a.service);
  assert.equal((await backend.getSnapshot()).apps.mywhoosh.installed, false);
  assert.equal(snaps.length, 0);
  await backend.install('mywhoosh', { steam: true, hd: false });
  assert.deepEqual({ app: snaps.at(-1).job.app, kind: snaps.at(-1).job.kind, steam: snaps.at(-1).job.steam }, { app: 'mywhoosh', kind: 'install', steam: true });
  const done = await settle(backend, (s) => !s.job && installed(s));
  assert.equal(done.apps.mywhoosh.version, '6.2.3.0');
  assert.equal(done.apps.mywhoosh.steam, true);
  assert.equal(done.apps.mywhoosh.problem, '');
  assert.equal(done.finished.app, 'mywhoosh');
  assert.deepEqual(a.calls(), ['install']);
  const progress = snaps.filter((s) => s.job).map((s) => s.job.progress);
  assert.ok(progress.some((p) => p >= 92), 'Zeile „preparing Windows environment“ setzt mindestens 92');
  assert.deepEqual([...progress].sort((x, y) => x - y), progress, 'Fortschritt fällt nie');
  assert.ok(progress.every((p) => p < 100), 'bei 100 ist der Job schon weg');
  assert.match(fs.readFileSync(path.join(a.home, 'state/mywhoosh.log'), 'utf8'), /MyWhoosh 6\.2\.3\.0 installed/);
  assert.equal(fs.existsSync(path.join(a.home, 'state/mywhoosh-setup.pid')), false);
  assert.equal(fs.existsSync(path.join(a.home, 'state/run.pid')), false, 'Einrichten nimmt run.pid nicht');
});

test('M3 Fortschritt aus der Größe der geschriebenen Dateien', async () => {
  const a = setup();
  const percents = [];
  const grow = setInterval(() => { fs.mkdirSync(path.join(a.gameRoot, 'cache'), { recursive: true }); fs.appendFileSync(path.join(a.gameRoot, 'cache/x'), Buffer.alloc(3e6)); }, 20);
  // Die Attrappe schreibt nichts Großes; die Messung liest, was hier wächst. Erwartete Menge ist 9 GB, also bleibt es klein, aber sichtbar > 0 nur mit echten GB.
  await a.service.install({ hd: false }, (p) => percents.push(p), new AbortController().signal);
  clearInterval(grow);
  assert.deepEqual([...percents].sort((x, y) => x - y), percents);
  assert.ok(percents.every((p) => p >= 0 && p <= 99));
});

test('M4 HD: install --hd legt den HD-Ordner an, Zustand und Entfernen folgen der Ausgabe (ohne MYWHOOSH_ROOT)', async () => {
  const a = setup({ homeRoot: true });
  await a.service.install({ hd: true }, () => {}, new AbortController().signal);
  assert.deepEqual(a.calls(), ['install --hd']);
  assert.deepEqual(mw.readStatus(a.env), { installed: true, version: '6.2.3.0', edition: 'hd' });
  assert.ok(fs.existsSync(path.join(a.userHome, 'Games/mywhoosh-hd-linux/game', EXE)));
  await a.service.update(() => {}, new AbortController().signal);
  assert.equal(mw.readStatus(a.env).version, '6.3.0.0');
  await a.service.uninstall(new AbortController().signal);
  assert.deepEqual(a.calls(), ['install --hd', 'update --hd', 'uninstall --hd']);
  assert.equal(mw.readStatus(a.env).installed, false);
});

test('M5 Fehler der Einrichtung: Grund aus der Ausgabe, nichts bleibt hängen, ein erneuter Versuch geht', async () => {
  for (const [fail, problem] of [['download failed: https://x', 'net'], ['checksum mismatch: https://x', 'verify'], ['kaputt', 'error']]) {
    const a = setup({ extra: { FAKE_FAIL: fail } });
    const { backend } = backendWith(a.service);
    await backend.getSnapshot();
    await backend.install('mywhoosh', { steam: false, hd: false });
    const snap = await settle(backend, (s) => !s.job);
    assert.equal(snap.apps.mywhoosh.installed, false, fail);
    assert.equal(snap.apps.mywhoosh.problem, problem, fail);
    assert.equal(snap.finished, null);
    assert.equal(fs.existsSync(path.join(a.home, 'state/mywhoosh-setup.pid')), false);
  }
  assert.equal(mw.problemFromOutput(1, 'tar: write error: No space left on device'), 'disk');
  // Zweiter Versuch ohne Fehler: das Problem verschwindet.
  const a = setup({ extra: { FAKE_FAIL: 'download failed: x' } });
  const retry = new mw.RealMywhoosh({ home: a.home, env: { ...a.env, FAKE_FAIL: '' }, pollMs: 50, checkSpace: false });
  const { backend } = backendWith(a.service);
  await backend.install('mywhoosh', { steam: false, hd: false });
  assert.equal((await settle(backend, (s) => !s.job)).apps.mywhoosh.problem, 'net');
  await retry.install({ hd: false }, () => {}, new AbortController().signal);
  assert.equal((await backend.getSnapshot()).apps.mywhoosh.installed, true);
  assert.equal((await backend.getSnapshot()).apps.mywhoosh.problem, '');
});

test('M6 Reste eines abgebrochenen Versuchs (Spielordner ohne Spiel) werden aufgeräumt; ein vorhandenes Spiel bleibt unberührt', async () => {
  const a = setup();
  fs.mkdirSync(path.join(a.gameRoot, 'game/halb'), { recursive: true });
  await a.service.install({ hd: false }, () => {}, new AbortController().signal);
  assert.equal(mw.readStatus(a.env).installed, true);
  assert.equal(fs.existsSync(path.join(a.gameRoot, 'game/halb')), false);
  // Mit Spiel bricht das Skript ab (wie das Original), die Dateien bleiben.
  fs.writeFileSync(path.join(a.gameRoot, 'game/eigene-datei'), 'x');
  await assert.rejects(a.service.install({ hd: false }, () => {}, new AbortController().signal), (e) => e.problem === 'error');
  assert.equal(fs.readFileSync(path.join(a.gameRoot, 'game/eigene-datei'), 'utf8'), 'x');
});

test('M7 Eine noch laufende Einrichtung eines früheren Rollout sperrt eine neue; die Reste werden dann nicht angefasst', async () => {
  const a = setup();
  fs.mkdirSync(path.join(a.gameRoot, 'game/halb'), { recursive: true });
  fs.writeFileSync(path.join(a.home, 'state/mywhoosh-setup.pid'), `${process.pid}\n`);
  await assert.rejects(a.service.install({ hd: false }, () => {}, new AbortController().signal), (e) => e.problem === 'error' && /läuft noch/.test(e.message));
  assert.equal(fs.existsSync(path.join(a.gameRoot, 'game/halb')), true);
  assert.deepEqual(a.calls(), []);
  fs.writeFileSync(path.join(a.home, 'state/mywhoosh-setup.pid'), '999999999\n');
  await a.service.install({ hd: false }, () => {}, new AbortController().signal);
  assert.equal(mw.readStatus(a.env).installed, true, 'veraltete Pid-Datei sperrt nicht');
});

test('M8 Aktualisieren: neue Version, update läuft über rollout-run; Fehler tragen ihren Grund', async () => {
  const a = setup();
  placeGame(a.gameRoot);
  const percents = [];
  await a.service.update((p) => percents.push(p), new AbortController().signal);
  assert.equal(mw.readStatus(a.env).version, '6.3.0.0');
  assert.deepEqual(a.calls(), ['update']);
  const bad = new mw.RealMywhoosh({ home: a.home, env: { ...a.env, FAKE_FAIL: 'download failed: x' }, pollMs: 50 });
  await assert.rejects(bad.update(() => {}, new AbortController().signal), (e) => e.problem === 'net');
});

test('M9 Entfernen über SimBackend: Ordner weg, nicht mehr installiert, Overrides zurück; Fehler bleiben sichtbar und nichts geht verloren', async () => {
  const a = setup();
  placeGame(a.gameRoot);
  const { backend } = backendWith(a.service);
  assert.equal((await backend.getSnapshot()).apps.mywhoosh.installed, true);
  assert.equal((await backend.getSnapshot()).apps.mywhoosh.version, '6.2.3.0');
  await backend.setSteam('mywhoosh', true);
  await backend.setOverrides('mywhoosh', { mode: 'custom' });
  await backend.remove('mywhoosh');
  const snap = await backend.getSnapshot();
  assert.equal(snap.apps.mywhoosh.installed, false);
  assert.equal(snap.apps.mywhoosh.steam, false);
  assert.equal(snap.apps.mywhoosh.version, '');
  assert.equal(snap.apps.mywhoosh.problem, '');
  assert.equal(snap.overrides.mywhoosh.mode, 'rec');
  assert.equal(fs.existsSync(a.gameRoot), false);
  // Scheitert uninstall, bleibt MyWhoosh installiert und die Karte nennt das Problem.
  const b = setup({ extra: { FAKE_UNINSTALL_FAIL: '1' } });
  placeGame(b.gameRoot);
  const { backend: b2 } = backendWith(b.service);
  await b2.getSnapshot();
  await b2.remove('mywhoosh');
  const kept = await b2.getSnapshot();
  assert.equal(kept.apps.mywhoosh.installed, true);
  assert.equal(kept.apps.mywhoosh.problem, 'error');
});

test('M10 Start: Bluetooth, Updates, Startet, Läuft (Phasen aus der Ausgabe), Fortschritt fällt nie; Beenden stoppt Spiel und Enkel', async () => {
  const a = setup({ extra: { ROLLOUT_MYWHOOSH_RUNNING_MS: '300' } });
  placeGame(a.gameRoot);
  const { backend, snaps } = backendWith(a.service, { env: { ROLLOUT_MYWHOOSH_RUNNING_MS: '300' } });
  assert.equal((await backend.getSnapshot()).apps.mywhoosh.installed, true);
  await backend.launch('mywhoosh');
  await settle(backend, (s) => s.launch?.phase === 'starting');
  const running = await settle(backend, (s) => s.launch?.phase === 'running');
  assert.equal(running.launch.progress, 100);
  const seen = snaps.filter((s) => s.launch).map((s) => s.launch.phase);
  assert.deepEqual([...new Set(seen)], ['bluetooth', 'updates', 'starting', 'running']);
  const progress = snaps.filter((s) => s.launch).map((s) => s.launch.progress);
  assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1] || seen[i] === 'updates'), 'Fortschritt fällt nie (außer beim Wechsel Bluetooth zu Updates)');
  assert.equal(backend.hasRunningGame(), true);
  assert.deepEqual(a.calls(), ['run']);
  await backend.launch('mywhoosh'); // zweiter Start läuft nicht an
  assert.deepEqual(a.calls(), ['run']);
  assert.match(fs.readFileSync(path.join(a.home, 'state/run.pid'), 'utf8'), /^\d+$/m);
  const grandchild = Number(fs.readFileSync(path.join(a.home, 'child.pid'), 'utf8'));
  assert.ok(alive(grandchild));
  const stopping = backend.stopLaunch();
  assert.equal(snaps.at(-1).launch.phase, 'stopping');
  await stopping;
  assert.equal((await backend.getSnapshot()).launch, null);
  assert.equal(backend.hasRunningGame(), false);
  assert.ok(await until(() => !alive(grandchild)), 'Enkel (Wine) ist weg');
  assert.equal(fs.existsSync(path.join(a.home, 'state/run.pid')), false);
  assert.equal((await backend.getSnapshot()).apps.mywhoosh.installed, true);
});

test('M11 Bluetooth vor dem Start: ohne Adapter „bterror“ und kein Start; „Trotzdem starten“ startet; Abbruch in der Prüfung verwirft die Antwort', async () => {
  const a = setup();
  placeGame(a.gameRoot);
  let adapter = 'problem';
  const { backend } = backendWith(a.service, { adapter: async () => adapter });
  await backend.getSnapshot();
  await backend.launch('mywhoosh');
  const err = await settle(backend, (s) => s.launch?.phase === 'bterror');
  assert.equal(err.bluetooth.state, 'problem');
  assert.deepEqual(a.calls(), [], 'nichts gestartet');
  assert.equal(backend.hasRunningGame(), false);
  await backend.launch('mywhoosh', { ignoreBluetooth: true });
  assert.ok(await until(() => a.calls().length === 1), 'Spiel gestartet');
  assert.deepEqual(a.calls(), ['run']);
  await backend.stopLaunch();
  // Beenden während der Prüfung: Die späte Antwort startet nichts.
  fs.rmSync(path.join(a.home, 'calls.log'), { force: true });
  let release = () => {};
  let first = true;
  const slow = backendWith(a.service, { adapter: () => { if (first) { first = false; return Promise.resolve('ready'); } return new Promise((resolve) => { release = () => resolve('ready'); }); } });
  await slow.backend.getSnapshot();
  await slow.backend.launch('mywhoosh');
  assert.equal(slow.snaps.at(-1).launch.phase, 'bluetooth');
  await slow.backend.stopLaunch();
  assert.equal(slow.snaps.at(-1).launch, null);
  release();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(a.calls(), [], 'die späte Antwort startete nichts');
  assert.equal(slow.backend.hasRunningGame(), false);
});

test('M12 Start endet: Exit 0 = beendet, Fehler kurz nach dem Start = Absturz, fehlender Starter = „kann nicht starten“; nach einem Update im Start stimmt die Version', async () => {
  const ok = setup({ extra: { RUN_MODE: 'exit 0' } });
  placeGame(ok.gameRoot);
  const b1 = backendWith(ok.service);
  await b1.backend.getSnapshot();
  await b1.backend.launch('mywhoosh');
  assert.equal((await settle(b1.backend, (s) => !s.launch && b1.snaps.some((x) => x.launch?.phase === 'updates'))).launch, null);
  const crash = setup({ extra: { RUN_MODE: 'exit 3' } });
  placeGame(crash.gameRoot);
  const b2 = backendWith(crash.service);
  await b2.backend.getSnapshot();
  await b2.backend.launch('mywhoosh');
  assert.equal((await settle(b2.backend, (s) => s.launch?.phase === 'crash')).launch.phase, 'crash');
  assert.equal(b2.backend.hasRunningGame(), false);
  await b2.backend.stopLaunch(); // die Absturz-Ansicht hält den Takt der Anzeige an: aufräumen
  const missing = setup({ extra: { ROLLOUT_RUN_UPSTREAM: '' } });
  placeGame(missing.gameRoot);
  const b3 = backendWith(missing.service);
  await b3.backend.getSnapshot();
  await b3.backend.launch('mywhoosh');
  const failed = await settle(b3.backend, (s) => s.launch?.phase === 'failed');
  assert.equal(failed.launch.problem, 'error');
  await b3.backend.stopLaunch();
  const none = new mw.RealMywhoosh({ home: path.join(work, 'leer'), env: ok.env });
  assert.equal(await none.start(() => {}).done, 127, 'ohne rollout-run');
});

test('M13 Beenden von Rollout während der Einrichtung: bricht ab, das Skript und seine Kinder sind weg, kein Problem in der Karte', async () => {
  const a = setup({ extra: { RUN_MODE: 'slow' } });
  const { backend } = backendWith(a.service);
  await backend.getSnapshot();
  await backend.install('mywhoosh', { steam: false, hd: false });
  assert.ok(await until(() => fs.existsSync(path.join(a.home, 'started'))), 'Einrichtung läuft');
  assert.equal(backend.hasRunningGame(), true, 'zählt als laufend: Rollout wartet beim Beenden');
  await backend.stopLaunch();
  const snap = await backend.getSnapshot();
  assert.equal(snap.job, null);
  assert.equal(snap.apps.mywhoosh.installed, false);
  assert.equal(snap.apps.mywhoosh.problem, '', 'Abbruch ist kein Fehler');
  assert.equal(backend.hasRunningGame(), false);
  assert.equal(fs.existsSync(path.join(a.home, 'state/mywhoosh-setup.pid')), false);
});

test('M14 Bluetooth-Zustand im Snapshot kommt bei jeder Abfrage frisch aus dem Dienst', async () => {
  const a = setup();
  let state = 'ready';
  const { backend } = backendWith(a.service, { adapter: async () => state });
  assert.equal((await backend.getSnapshot()).bluetooth.state, 'ready');
  state = 'problem';
  assert.equal((await backend.getSnapshot()).bluetooth.state, 'problem');
  state = 'ready';
  assert.equal((await backend.getSnapshot()).bluetooth.state, 'ready');
});

test('M15 chooseMywhooshMode: echt, sobald Starter und Skript da sind; ausdrückliche Wahl gewinnt; sonst Simulation. Ohne Dienst bleibt MyWhoosh simuliert', async () => {
  const c = mw.chooseMywhooshMode;
  assert.equal(c({ mode: undefined, runnerExists: true, scriptExists: true }), 'real');
  assert.equal(c({ mode: undefined, runnerExists: false, scriptExists: true }), 'sim');
  assert.equal(c({ mode: undefined, runnerExists: true, scriptExists: false }), 'sim');
  assert.equal(c({ mode: 'sim', runnerExists: true, scriptExists: true }), 'sim');
  assert.equal(c({ mode: 'real', runnerExists: false, scriptExists: false }), 'real');
  const plain = backendWith(null).backend;
  const first = await plain.getSnapshot();
  assert.equal(first.apps.mywhoosh.installed, true, 'Simulation: von Anfang an installiert');
  await plain.remove('mywhoosh');
  assert.equal((await plain.getSnapshot()).apps.mywhoosh.installed, false);
});

test('M16 Mitgelieferte Dateien: vendor/ stimmt mit den Prüfsummen in upstreams.json überein, ist ausführbar und hat seine Lizenz', () => {
  const pin = upstreams.mywhoosh;
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  assert.equal(pin.repo, 'Parapeth962/mywhoosh-linux-installer');
  assert.deepEqual(Object.keys(pin.files).sort(), ['ble-bridge.py', 'mywhoosh.sh'], 'install kopiert ble-bridge.py, ohne sie bricht es ab');
  for (const [name, sha] of Object.entries(pin.files)) {
    const file = path.join(root, 'vendor', name);
    assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), sha, name);
    assert.ok(fs.statSync(file).mode & 0o100, `${name} ausführbar`);
  }
  assert.match(fs.readFileSync(path.join(root, 'vendor/LICENSE-mywhoosh-linux-installer'), 'utf8'), /MIT License/);
  assert.equal(spawnSync('bash', ['-n', path.join(root, 'vendor/mywhoosh.sh')]).status, 0);
  // Das Skript nennt in seinen Hilfetext genau die Befehle, die der Adapter benutzt.
  const help = fs.readFileSync(path.join(root, 'vendor/mywhoosh.sh'), 'utf8');
  for (const cmd of ['install', 'run', 'update', 'uninstall']) assert.match(help, new RegExp(`mywhoosh\\.sh ${cmd}`));
  assert.equal(mw.percentForLine('[mywhoosh] preparing Windows environment (x)'), 92);
  assert.equal(mw.percentForLine('irgendwas'), 0);
});

// --- Spielfenster und Controller im Spielmodus (M17, M18) ---------------------------------------------------------------------
const TREE = (...windows) => `\nxwininfo: Window id: 0x3d9 (the root window) (has no name)\n\n  Root window id: 0x3d9 (the root window) (has no name)\n  Parent window id: 0x0 (none)\n     ${windows.length} children:\n${windows.join('\n')}\n`;
const WIN = (id, name, cls, size) => `     ${id} "${name}": ("${cls}" "${cls}")  ${size}+4+30  +4+30`;
const focusOut = (id) => `GAMESCOPE_FOCUSED_WINDOW(CARDINAL) = ${id}\n`;
function fakeX(state) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args].join(' '));
    if (file === 'xwininfo') return state.tree;
    if (file === 'xprop' && args[0] === '-root') return focusOut(state.focus);
    throw new Error(`unerwartet: ${file} ${args.join(' ')}`);
  };
  return { exec, calls };
}

test('M17 Fenster und Controller: erst wenn das MyWhoosh-Fenster im Fokus ist, startet die Weitergabe; bei Verlust und am Ende stoppt sie; nie STEAM_GAME setzen', async () => {
  const a = setup({ extra: { RUN_MODE: 'wait' } });
  placeGame(a.gameRoot);
  const state = { tree: TREE(WIN('0x1', 'Rollout', 'rollout', '1280x800')), focus: 1 };
  const { exec, calls } = fakeX(state);
  const events = [];
  const pad = (display) => { events.push(`start ${display}`); return { stop: () => events.push('stop') }; };
  const service = new mw.RealMywhoosh({ home: a.home, env: a.env, windows: { display: ':7', exec, intervalMs: 10, pad }, stopGraceMs: 5000 });
  const { backend, snaps } = backendWith(service, { env: { ROLLOUT_MYWHOOSH_RUNNING_MS: '60000' } });
  await backend.getSnapshot();
  await backend.launch('mywhoosh');
  await settle(backend, (s) => s.launch?.phase === 'updates' || s.launch?.phase === 'starting');
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(events, [], 'ohne Spielfenster keine Weitergabe (A wäre ein Klick in Rollout)');
  state.tree = TREE(WIN('0x1', 'Rollout', 'rollout', '1280x800'), WIN('0x4200005', 'MyWhoosh', 'MyWhoosh-Win64-Shipping.exe', '1912x1046'));
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(events, [], 'Fenster da, aber noch nicht im Fokus');
  state.focus = 0x4200005;
  await settle(backend, (s) => s.launch?.visible === true);
  assert.deepEqual(events, ['start :7']);
  state.focus = 1;
  await settle(backend, (s) => s.launch?.visible === false);
  assert.deepEqual(events, ['start :7', 'stop']);
  state.focus = 0x4200005;
  await settle(backend, (s) => s.launch?.visible === true);
  await backend.stopLaunch();
  assert.deepEqual(events, ['start :7', 'stop', 'start :7', 'stop']);
  assert.equal(snaps.at(-1).launch, null);
  assert.ok(calls.every((c) => c.startsWith('xwininfo') || c.startsWith('xprop -root')), 'es wird nur gelesen');
  const n = calls.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.length, n, 'nach dem Ende keine Abfragen mehr');
});

test('M18 Ohne `windows` berührt start keinen X-Server und startet keine Weitergabe; ROLLOUT_MYWHOOSH_PAD=off schaltet nur den Controller ab', async () => {
  const a = setup({ extra: { RUN_MODE: 'exit 0' } });
  const lines = [];
  const run = a.service.start((l) => lines.push(l));
  assert.equal(await run.done, 0);
  const state = { tree: TREE(WIN('0x4200005', 'MyWhoosh', 'mywhoosh-win64-shipping.exe', '1912x1046')), focus: 0x4200005 };
  const { exec } = fakeX(state);
  const notes = [];
  const off = new mw.RealMywhoosh({ home: a.home, env: { ...a.env, ROLLOUT_MYWHOOSH_PAD: 'off' }, windows: { display: ':7', exec, intervalMs: 10, onNote: (t) => notes.push(t) } });
  const shown = [];
  const r2 = off.start(() => {}, (v) => shown.push(v));
  assert.equal(await r2.done, 0);
  assert.ok(notes.some((n) => /Fensterüberwachung an/.test(n)));
  assert.ok(!notes.some((n) => /Controller-Weitergabe aktiv/.test(n)), 'Controller aus');
});

test('M19 Runder Zeiger: Thema als Xcursor-Dateien, dem Spiel über XCURSOR_* genannt; ROLLOUT_MYWHOOSH_CURSOR=off und fehlender Ordner lassen den normalen Zeiger', async () => {
  const cur = await (async () => {
    await build({ entryPoints: [path.join(root, 'src/main/xcursor.ts')], bundle: true, platform: 'node', format: 'esm', outfile: path.join(work, 'xcursor.mjs'), logLevel: 'error' });
    return import(path.join(work, 'xcursor.mjs'));
  })();
  const file = cur.cursorFile();
  assert.equal(file.readUInt32LE(0), 0x72756358, 'Xcur');
  assert.equal(file.readUInt32LE(12), 1, 'ein Bild');
  const at = file.readUInt32LE(24);
  assert.deepEqual([file.readUInt32LE(at + 16), file.readUInt32LE(at + 20), file.readUInt32LE(at + 24), file.readUInt32LE(at + 28)], [48, 48, 24, 24], 'Größe und Hotspot in der Mitte');
  assert.equal(file.length, at + 36 + 48 * 48 * 4);
  const px = (x, y) => file.readUInt32LE(at + 36 + (y * 48 + x) * 4);
  assert.equal(px(0, 0) >>> 24, 0, 'Ecke durchsichtig');
  assert.equal(px(24, 24) >>> 24, 255, 'Mitte deckend');
  assert.ok(((px(24, 24) >>> 16) & 255) < 100 && (px(24, 24) & 255) > 200, 'blaue Mitte');
  assert.ok((px(24, 8) & 255) > 240 && ((px(24, 8) >>> 16) & 255) > 240, 'weißer Ring');

  const a = setup({ extra: { RUN_MODE: 'exit 0' } });
  placeGame(a.gameRoot);
  const dir = path.join(a.home, 'state/cursors');
  const on = new mw.RealMywhoosh({ home: a.home, env: a.env, cursorDir: dir });
  assert.equal(await on.start(() => {}).done, 0);
  assert.ok(fs.existsSync(path.join(dir, 'rollout-dot/index.theme')));
  assert.ok(fs.existsSync(path.join(dir, 'rollout-dot/cursors/left_ptr')));
  assert.deepEqual(fs.readFileSync(path.join(a.home, 'cursor.log'), 'utf8').trim().split('\n'), [`cursor=rollout-dot size=48 path=${dir}`]);
  for (const [name, svc] of [['off', new mw.RealMywhoosh({ home: a.home, env: { ...a.env, ROLLOUT_MYWHOOSH_CURSOR: 'off' }, cursorDir: dir })], ['ohne Ordner', new mw.RealMywhoosh({ home: a.home, env: a.env })]]) {
    fs.rmSync(path.join(a.home, 'cursor.log'));
    assert.equal(await svc.start(() => {}).done, 0);
    assert.deepEqual(fs.readFileSync(path.join(a.home, 'cursor.log'), 'utf8').trim().split('\n'), ['cursor= size= path='], name);
  }
  // Ein Ordner, der sich nicht anlegen lässt, verhindert den Start nicht.
  fs.writeFileSync(path.join(a.home, 'datei'), '');
  fs.rmSync(path.join(a.home, 'cursor.log'));
  assert.equal(await new mw.RealMywhoosh({ home: a.home, env: a.env, cursorDir: path.join(a.home, 'datei/x') }).start(() => {}).done, 0);
});

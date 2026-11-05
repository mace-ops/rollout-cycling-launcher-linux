// Checks the MyWhoosh adapter (src/main/mywhoosh.ts) and its connection to SimBackend (M1 to M16) in throwaway directories.
// No real MyWhoosh, no network, no Wine, never the real ~/Games: the upstream is the fake `mywhoosh.sh` (ROLLOUT_RUN_UPSTREAM) and
// creates the same files as the real script; HOME and MYWHOOSH_ROOT point into the throwaway directory. `rollout-run` is the real one.
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
// Fake of mywhoosh.sh. FAKE_FAIL=<text> makes install and update fail with that message, FAKE_UNINSTALL_FAIL=1 the removal,
// RUN_MODE controls `run` (exit N, wait). Like the original, install aborts if the game directory already exists.
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
/** Throwaway setup: ROLLOUT_HOME with the real rollout-run, own HOME, game directory under MYWHOOSH_ROOT (or HOME with `homeRoot`). */
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
    if (Date.now() > end) throw new Error('Timeout');
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

test('M1 State from disk: not installed, installed with version, HD only, directory without game, unreadable manifest', () => {
  const a = setup();
  assert.deepEqual(mw.readStatus(a.env), { installed: false, version: '', edition: 'standard' });
  fs.mkdirSync(path.join(a.gameRoot, 'game'), { recursive: true });
  assert.equal(mw.readStatus(a.env).installed, false, 'directory without a game does not count');
  placeGame(a.gameRoot);
  assert.deepEqual(mw.readStatus(a.env), { installed: true, version: '6.2.3.0', edition: 'standard' });
  fs.writeFileSync(path.join(a.gameRoot, 'game/AppxManifest.xml'), 'kaputt');
  assert.deepEqual(mw.readStatus(a.env), { installed: true, version: '', edition: 'standard' });
  const hd = setup({ homeRoot: true });
  placeGame(path.join(hd.userHome, 'Games/mywhoosh-hd-linux'), '6.2.3.0');
  assert.deepEqual(mw.readStatus(hd.env), { installed: true, version: '6.2.3.0', edition: 'hd' });
  placeGame(path.join(hd.userHome, 'Games/mywhoosh-linux'), '6.1.0.0');
  assert.equal(mw.readStatus(hd.env).edition, 'standard', 'with both, the standard edition applies');
});

test('M2 Installation via SimBackend: job with progress (never backwards, lines set minimum values), finally installed with version, log exists', async () => {
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
  assert.ok(progress.some((p) => p >= 92), 'line "preparing Windows environment" sets at least 92');
  assert.deepEqual([...progress].sort((x, y) => x - y), progress, 'progress never decreases');
  assert.ok(progress.every((p) => p < 100), 'at 100 the job is already gone');
  assert.match(fs.readFileSync(path.join(a.home, 'state/mywhoosh.log'), 'utf8'), /MyWhoosh 6\.2\.3\.0 installed/);
  assert.equal(fs.existsSync(path.join(a.home, 'state/mywhoosh-setup.pid')), false);
  assert.equal(fs.existsSync(path.join(a.home, 'state/run.pid')), false, 'setup does not take run.pid');
});

test('M3 Progress from the size of the written files', async () => {
  const a = setup();
  const percents = [];
  const grow = setInterval(() => { fs.mkdirSync(path.join(a.gameRoot, 'cache'), { recursive: true }); fs.appendFileSync(path.join(a.gameRoot, 'cache/x'), Buffer.alloc(3e6)); }, 20);
  // The fake writes nothing large; the measurement reads what grows here. The expected amount is 9 GB, so it stays small, visibly > 0 only with real GB.
  await a.service.install({ hd: false }, (p) => percents.push(p), new AbortController().signal);
  clearInterval(grow);
  assert.deepEqual([...percents].sort((x, y) => x - y), percents);
  assert.ok(percents.every((p) => p >= 0 && p <= 99));
});

test('M4 HD: install --hd creates the HD directory, state and removal follow the edition (without MYWHOOSH_ROOT)', async () => {
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

test('M5 Setup errors: reason from the output, nothing hangs, a retry works', async () => {
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
  // Second attempt without error: the problem disappears.
  const a = setup({ extra: { FAKE_FAIL: 'download failed: x' } });
  const retry = new mw.RealMywhoosh({ home: a.home, env: { ...a.env, FAKE_FAIL: '' }, pollMs: 50, checkSpace: false });
  const { backend } = backendWith(a.service);
  await backend.install('mywhoosh', { steam: false, hd: false });
  assert.equal((await settle(backend, (s) => !s.job)).apps.mywhoosh.problem, 'net');
  await retry.install({ hd: false }, () => {}, new AbortController().signal);
  assert.equal((await backend.getSnapshot()).apps.mywhoosh.installed, true);
  assert.equal((await backend.getSnapshot()).apps.mywhoosh.problem, '');
});

test('M6 Leftovers of an aborted attempt (game directory without game) are cleaned up; an existing game stays untouched', async () => {
  const a = setup();
  fs.mkdirSync(path.join(a.gameRoot, 'game/halb'), { recursive: true });
  await a.service.install({ hd: false }, () => {}, new AbortController().signal);
  assert.equal(mw.readStatus(a.env).installed, true);
  assert.equal(fs.existsSync(path.join(a.gameRoot, 'game/halb')), false);
  // With a game the script aborts (like the original), the files stay.
  fs.writeFileSync(path.join(a.gameRoot, 'game/eigene-datei'), 'x');
  await assert.rejects(a.service.install({ hd: false }, () => {}, new AbortController().signal), (e) => e.problem === 'error');
  assert.equal(fs.readFileSync(path.join(a.gameRoot, 'game/eigene-datei'), 'utf8'), 'x');
});

test('M7 A still-running setup from an earlier Rollout blocks a new one; the leftovers are then not touched', async () => {
  const a = setup();
  fs.mkdirSync(path.join(a.gameRoot, 'game/halb'), { recursive: true });
  fs.writeFileSync(path.join(a.home, 'state/mywhoosh-setup.pid'), `${process.pid}\n`);
  await assert.rejects(a.service.install({ hd: false }, () => {}, new AbortController().signal), (e) => e.problem === 'error' && /still running/.test(e.message));
  assert.equal(fs.existsSync(path.join(a.gameRoot, 'game/halb')), true);
  assert.deepEqual(a.calls(), []);
  fs.writeFileSync(path.join(a.home, 'state/mywhoosh-setup.pid'), '999999999\n');
  await a.service.install({ hd: false }, () => {}, new AbortController().signal);
  assert.equal(mw.readStatus(a.env).installed, true, 'stale pid file does not block');
});

test('M8 Update: new version, update runs through rollout-run; errors carry their reason', async () => {
  const a = setup();
  placeGame(a.gameRoot);
  const percents = [];
  await a.service.update((p) => percents.push(p), new AbortController().signal);
  assert.equal(mw.readStatus(a.env).version, '6.3.0.0');
  assert.deepEqual(a.calls(), ['update']);
  const bad = new mw.RealMywhoosh({ home: a.home, env: { ...a.env, FAKE_FAIL: 'download failed: x' }, pollMs: 50 });
  await assert.rejects(bad.update(() => {}, new AbortController().signal), (e) => e.problem === 'net');
});

test('M9 Removal via SimBackend: directory gone, no longer installed, overrides back; errors stay visible and nothing is lost', async () => {
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
  // If uninstall fails, MyWhoosh stays installed and the card names the problem.
  const b = setup({ extra: { FAKE_UNINSTALL_FAIL: '1' } });
  placeGame(b.gameRoot);
  const { backend: b2 } = backendWith(b.service);
  await b2.getSnapshot();
  await b2.remove('mywhoosh');
  const kept = await b2.getSnapshot();
  assert.equal(kept.apps.mywhoosh.installed, true);
  assert.equal(kept.apps.mywhoosh.problem, 'error');
});

test('M10 Start: Bluetooth, Updates, Starting, Running (phases from the output), progress never decreases; quitting stops game and grandchildren', async () => {
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
  assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1] || seen[i] === 'updates'), 'progress never decreases (except on the switch from Bluetooth to Updates)');
  assert.equal(backend.hasRunningGame(), true);
  assert.deepEqual(a.calls(), ['run']);
  await backend.launch('mywhoosh'); // second start does not begin
  assert.deepEqual(a.calls(), ['run']);
  assert.match(fs.readFileSync(path.join(a.home, 'state/run.pid'), 'utf8'), /^\d+$/m);
  const grandchild = Number(fs.readFileSync(path.join(a.home, 'child.pid'), 'utf8'));
  assert.ok(alive(grandchild));
  const stopping = backend.stopLaunch();
  assert.equal(snaps.at(-1).launch.phase, 'stopping');
  await stopping;
  assert.equal((await backend.getSnapshot()).launch, null);
  assert.equal(backend.hasRunningGame(), false);
  assert.ok(await until(() => !alive(grandchild)), 'grandchild (Wine) is gone');
  assert.equal(fs.existsSync(path.join(a.home, 'state/run.pid')), false);
  assert.equal((await backend.getSnapshot()).apps.mywhoosh.installed, true);
});

test('M11 Bluetooth before the start: without adapter "bterror" and no start; "Start anyway" starts; abort during the check discards the answer', async () => {
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
  // Quitting during the check: the late answer starts nothing.
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
  assert.deepEqual(a.calls(), [], 'the late answer started nothing');
  assert.equal(slow.backend.hasRunningGame(), false);
});

test('M12 Start ends: exit 0 = ended, error shortly after start = crash, missing starter = "cannot start"; after an update during the start the version is right', async () => {
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
  await b2.backend.stopLaunch(); // the crash view keeps the display ticker running: clean up
  const missing = setup({ extra: { ROLLOUT_RUN_UPSTREAM: '' } });
  placeGame(missing.gameRoot);
  const b3 = backendWith(missing.service);
  await b3.backend.getSnapshot();
  await b3.backend.launch('mywhoosh');
  const failed = await settle(b3.backend, (s) => s.launch?.phase === 'failed');
  assert.equal(failed.launch.problem, 'error');
  await b3.backend.stopLaunch();
  const none = new mw.RealMywhoosh({ home: path.join(work, 'leer'), env: ok.env });
  assert.equal(await none.start(() => {}).done, 127, 'without rollout-run');
});

test('M13 Quitting Rollout during setup: aborts, the script and its children are gone, no problem on the card', async () => {
  const a = setup({ extra: { RUN_MODE: 'slow' } });
  const { backend } = backendWith(a.service);
  await backend.getSnapshot();
  await backend.install('mywhoosh', { steam: false, hd: false });
  assert.ok(await until(() => fs.existsSync(path.join(a.home, 'started'))), 'setup is running');
  assert.equal(backend.hasRunningGame(), true, 'counts as running: Rollout waits on quit');
  await backend.stopLaunch();
  const snap = await backend.getSnapshot();
  assert.equal(snap.job, null);
  assert.equal(snap.apps.mywhoosh.installed, false);
  assert.equal(snap.apps.mywhoosh.problem, '', 'abort is not an error');
  assert.equal(backend.hasRunningGame(), false);
  assert.equal(fs.existsSync(path.join(a.home, 'state/mywhoosh-setup.pid')), false);
});

test('M14 Bluetooth state in the snapshot comes fresh from the service on every query', async () => {
  const a = setup();
  let state = 'ready';
  const { backend } = backendWith(a.service, { adapter: async () => state });
  assert.equal((await backend.getSnapshot()).bluetooth.state, 'ready');
  state = 'problem';
  assert.equal((await backend.getSnapshot()).bluetooth.state, 'problem');
  state = 'ready';
  assert.equal((await backend.getSnapshot()).bluetooth.state, 'ready');
});

test('M15 chooseMywhooshMode: real as soon as starter and script exist; explicit choice wins; otherwise simulation. Without a service MyWhoosh stays simulated', async () => {
  const c = mw.chooseMywhooshMode;
  assert.equal(c({ mode: undefined, runnerExists: true, scriptExists: true }), 'real');
  assert.equal(c({ mode: undefined, runnerExists: false, scriptExists: true }), 'sim');
  assert.equal(c({ mode: undefined, runnerExists: true, scriptExists: false }), 'sim');
  assert.equal(c({ mode: 'sim', runnerExists: true, scriptExists: true }), 'sim');
  assert.equal(c({ mode: 'real', runnerExists: false, scriptExists: false }), 'real');
  const plain = backendWith(null).backend;
  const first = await plain.getSnapshot();
  assert.equal(first.apps.mywhoosh.installed, true, 'simulation: installed from the start');
  await plain.remove('mywhoosh');
  assert.equal((await plain.getSnapshot()).apps.mywhoosh.installed, false);
});

test('M16 Bundled files: vendor/ matches the checksums in upstreams.json, is executable and has its licence', () => {
  const pin = upstreams.mywhoosh;
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  assert.equal(pin.repo, 'Parapeth962/mywhoosh-linux-installer');
  assert.deepEqual(Object.keys(pin.files).sort(), ['ble-bridge.py', 'mywhoosh.sh'], 'install copies ble-bridge.py, without it it aborts');
  for (const [name, sha] of Object.entries(pin.files)) {
    const file = path.join(root, 'vendor', name);
    assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), sha, name);
    assert.ok(fs.statSync(file).mode & 0o100, `${name} executable`);
  }
  assert.match(fs.readFileSync(path.join(root, 'vendor/LICENSE-mywhoosh-linux-installer'), 'utf8'), /MIT License/);
  assert.equal(spawnSync('bash', ['-n', path.join(root, 'vendor/mywhoosh.sh')]).status, 0);
  // The script's help text names exactly the commands the adapter uses.
  const help = fs.readFileSync(path.join(root, 'vendor/mywhoosh.sh'), 'utf8');
  for (const cmd of ['install', 'run', 'update', 'uninstall']) assert.match(help, new RegExp(`mywhoosh\\.sh ${cmd}`));
  assert.equal(mw.percentForLine('[mywhoosh] preparing Windows environment (x)'), 92);
  assert.equal(mw.percentForLine('irgendwas'), 0);
});

// --- Game window and controller in Gaming Mode (M17, M18) ---------------------------------------------------------------------
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

test('M17 Window and controller: forwarding starts only when the MyWhoosh window is in focus; it stops on loss and at the end; never set STEAM_GAME', async () => {
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
  assert.deepEqual(events, [], 'no forwarding without a game window (A would be a click in Rollout)');
  state.tree = TREE(WIN('0x1', 'Rollout', 'rollout', '1280x800'), WIN('0x4200005', 'MyWhoosh', 'MyWhoosh-Win64-Shipping.exe', '1912x1046'));
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(events, [], 'window present, but not in focus yet');
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
  assert.ok(calls.every((c) => c.startsWith('xwininfo') || c.startsWith('xprop -root')), 'read only');
  const n = calls.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.length, n, 'no more queries after the end');
});

test('M18 Without `windows`, start touches no X server and starts no forwarding; ROLLOUT_MYWHOOSH_PAD=off switches off only the controller', async () => {
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
  assert.ok(notes.some((n) => /window watching on/.test(n)));
  assert.ok(!notes.some((n) => /Gamepad bridge active/.test(n)), 'controller off');
});

test('M19 Round pointer: theme as Xcursor files, passed to the game via XCURSOR_*; ROLLOUT_MYWHOOSH_CURSOR=off and a missing directory leave the normal pointer', async () => {
  const cur = await (async () => {
    await build({ entryPoints: [path.join(root, 'src/main/xcursor.ts')], bundle: true, platform: 'node', format: 'esm', outfile: path.join(work, 'xcursor.mjs'), logLevel: 'error' });
    return import(path.join(work, 'xcursor.mjs'));
  })();
  const file = cur.cursorFile();
  assert.equal(file.readUInt32LE(0), 0x72756358, 'Xcur');
  assert.equal(file.readUInt32LE(12), 1, 'one image');
  const at = file.readUInt32LE(24);
  assert.deepEqual([file.readUInt32LE(at + 16), file.readUInt32LE(at + 20), file.readUInt32LE(at + 24), file.readUInt32LE(at + 28)], [48, 48, 24, 24], 'size and hotspot in the centre');
  assert.equal(file.length, at + 36 + 48 * 48 * 4);
  const px = (x, y) => file.readUInt32LE(at + 36 + (y * 48 + x) * 4);
  assert.equal(px(0, 0) >>> 24, 0, 'Ecke durchsichtig');
  assert.equal(px(24, 24) >>> 24, 255, 'Mitte deckend');
  assert.ok(((px(24, 24) >>> 16) & 255) < 100 && (px(24, 24) & 255) > 200, 'blaue Mitte');
  assert.ok((px(24, 8) & 255) > 240 && ((px(24, 8) >>> 16) & 255) > 240, 'white ring');

  const a = setup({ extra: { RUN_MODE: 'exit 0' } });
  placeGame(a.gameRoot);
  const dir = path.join(a.home, 'state/cursors');
  const on = new mw.RealMywhoosh({ home: a.home, env: a.env, cursorDir: dir });
  assert.equal(await on.start(() => {}).done, 0);
  assert.ok(fs.existsSync(path.join(dir, 'rollout-dot/index.theme')));
  assert.ok(fs.existsSync(path.join(dir, 'rollout-dot/cursors/left_ptr')));
  assert.deepEqual(fs.readFileSync(path.join(a.home, 'cursor.log'), 'utf8').trim().split('\n'), [`cursor=rollout-dot size=48 path=${dir}`]);
  for (const [name, svc] of [['off', new mw.RealMywhoosh({ home: a.home, env: { ...a.env, ROLLOUT_MYWHOOSH_CURSOR: 'off' }, cursorDir: dir })], ['without directory', new mw.RealMywhoosh({ home: a.home, env: a.env })]]) {
    fs.rmSync(path.join(a.home, 'cursor.log'));
    assert.equal(await svc.start(() => {}).done, 0);
    assert.deepEqual(fs.readFileSync(path.join(a.home, 'cursor.log'), 'utf8').trim().split('\n'), ['cursor= size= path='], name);
  }
  // A directory that cannot be created does not prevent the start.
  fs.writeFileSync(path.join(a.home, 'datei'), '');
  fs.rmSync(path.join(a.home, 'cursor.log'));
  assert.equal(await new mw.RealMywhoosh({ home: a.home, env: a.env, cursorDir: path.join(a.home, 'datei/x') }).start(() => {}).done, 0);
});

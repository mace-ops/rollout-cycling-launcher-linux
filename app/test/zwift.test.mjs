// Checks the Zwift adapter (src/main/zwift.ts) and its connection to SimBackend (Z1 to Z12) in throwaway directories.
// No real Steam, no real container, no network: the download is a function, podman and docker are fakes on PATH
// (as in run.test.mjs). Only Z13 uses the network and runs only with ROLLOUT_ZWIFT_NET=1.
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
// Never the real config.toml of the test machine.
process.env.ROLLOUT_CONFIG_HOME = path.join(work, 'cfg-default');
for (const name of ['zwift', 'zwift-window', 'sim', 'config']) {
  await build({ entryPoints: [path.join(root, `src/main/${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile: path.join(work, `${name}.mjs`), logLevel: 'error' });
}
const zwift = await import(path.join(work, 'zwift.mjs'));
const zwin = await import(path.join(work, 'zwift-window.mjs'));
const sim = await import(path.join(work, 'sim.mjs'));
const config = await import(path.join(work, 'config.mjs'));

const BODY = '#!/usr/bin/env bash\necho "zwift.sh fake"\n';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const COMMIT = 'a'.repeat(40);
const pin = (over = {}) => ({ repo: 'netbrain/zwift', commit: COMMIT, path: 'src/zwift.sh', sha256: sha(BODY), image: 'docker.io/netbrain/zwift', tag: '1.2.3', ...over });

let counter = 0;
const makeHome = () => { counter += 1; const home = path.join(work, `h${counter}`); fs.mkdirSync(home, { recursive: true }); return home; };
/** Download fake: writes `body`, counts calls and remembers the URL. */
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

test('Z1 Download: the pinned script is placed atomically under zwift/<commit>/zwift.sh, executable, without leftovers; a second run downloads nothing', async () => {
  const home = makeHome();
  const dl = downloader();
  assert.equal(await zwift.installScript({ home, pin: pin(), download: dl }), true);
  const file = path.join(home, 'zwift', COMMIT, 'zwift.sh');
  assert.equal(fs.readFileSync(file, 'utf8'), BODY);
  assert.equal(fs.statSync(file).mode & 0o777, 0o755);
  assert.deepEqual(leftovers(home), [COMMIT]);
  assert.equal(dl.calls.length, 1);
  assert.equal(dl.calls[0].url, `https://raw.githubusercontent.com/netbrain/zwift/${COMMIT}/src/zwift.sh`);
  assert.ok(dl.calls[0].options.maxBytes <= 1024 * 1024, 'size limit set');
  assert.equal(zwift.scriptReady(home, pin()), true);
  assert.equal(await zwift.installScript({ home, pin: pin(), download: dl }), false);
  assert.equal(dl.calls.length, 1, 'second run does not download again');
});

test('Z2 wrong checksum: nothing is stored, an existing good script stays, no leftovers', async () => {
  const home = makeHome();
  await expectError(zwift.installScript({ home, pin: pin(), download: downloader('#!/bin/sh\nrm -rf ~\n') }), 'verify');
  assert.deepEqual(leftovers(home), [], 'neither target nor staging');
  assert.equal(zwift.scriptReady(home, pin()), false);
  // A good script is in place; a replacement with wrong content (different pin hash) leaves it untouched.
  await zwift.installScript({ home, pin: pin(), download: downloader() });
  await expectError(zwift.installScript({ home, pin: pin({ sha256: 'f'.repeat(64) }), download: downloader() }), 'verify');
  assert.equal(fs.readFileSync(path.join(home, 'zwift', COMMIT, 'zwift.sh'), 'utf8'), BODY);
  assert.deepEqual(leftovers(home), [COMMIT]);
});

test('Z3 network error and abort: dedicated error code, no leftovers, the target is not created', async () => {
  const home = makeHome();
  const failing = async () => { throw Object.assign(new Error('Verbindung'), { kind: 'net' }); };
  await expectError(zwift.installScript({ home, pin: pin(), download: failing }), 'net');
  const aborting = async () => { throw Object.assign(new Error('abgebrochen'), { kind: 'abort' }); };
  await expectError(zwift.installScript({ home, pin: pin(), download: aborting }), 'abort');
  const silent = async () => {}; // schreibt nichts
  await expectError(zwift.installScript({ home, pin: pin(), download: silent }), 'net');
  assert.deepEqual(leftovers(home), []);
});

test('Z4 oversized or empty file is rejected', async () => {
  const home = makeHome();
  await expectError(zwift.installScript({ home, pin: pin(), download: downloader('x'.repeat(zwift.MAX_SCRIPT_BYTES + 1)) }), 'verify');
  await expectError(zwift.installScript({ home, pin: pin(), download: downloader('') }), 'verify');
  assert.deepEqual(leftovers(home), []);
});

test('Z5 modified script is replaced, scripts of earlier pins disappear, foreign files stay', async () => {
  const home = makeHome();
  const oldCommit = 'b'.repeat(40);
  fs.mkdirSync(path.join(home, 'zwift', oldCommit), { recursive: true });
  fs.writeFileSync(path.join(home, 'zwift', oldCommit, 'zwift.sh'), 'alt');
  fs.mkdirSync(path.join(home, 'zwift', 'eigenes'));
  fs.mkdirSync(path.join(home, 'zwift', COMMIT));
  fs.writeFileSync(path.join(home, 'zwift', COMMIT, 'zwift.sh'), 'modified', { mode: 0o755 });
  fs.mkdirSync(path.join(home, 'zwift', '.staging-alt'));
  assert.equal(zwift.scriptReady(home, pin()), false, 'hash does not match');
  assert.equal(await zwift.installScript({ home, pin: pin(), download: downloader() }), true);
  assert.equal(fs.readFileSync(path.join(home, 'zwift', COMMIT, 'zwift.sh'), 'utf8'), BODY);
  assert.deepEqual(leftovers(home).sort(), [COMMIT, 'eigenes'].sort());
  // Not executable does not count as ready.
  fs.chmodSync(path.join(home, 'zwift', COMMIT, 'zwift.sh'), 0o644);
  assert.equal(zwift.scriptReady(home, pin()), false);
  // Neither does a symlink instead of a file.
  fs.rmSync(path.join(home, 'zwift', COMMIT, 'zwift.sh'));
  fs.writeFileSync(path.join(home, 'ziel.sh'), BODY, { mode: 0o755 });
  fs.symlinkSync(path.join(home, 'ziel.sh'), path.join(home, 'zwift', COMMIT, 'zwift.sh'));
  assert.equal(zwift.scriptReady(home, pin()), false);
});

test('Z6 the pin is checked strictly (it goes into URL and path)', () => {
  assert.deepEqual(zwift.checkPin(pin()), pin());
  const bad = [
    { commit: '../../etc' }, { commit: 'A'.repeat(40) }, { commit: 'a'.repeat(39) }, { repo: 'netbrain' }, { repo: 'a/b/c' }, { repo: '../x/y' },
    { path: '../zwift.sh' }, { path: '/abs/zwift.sh' }, { path: 'src//zwift.sh' }, { sha256: 'abc' }, { sha256: 'G'.repeat(64) },
    { image: '../x' }, { image: 'UPPER/x' }, { tag: 'latest!' }, { tag: '-x' }, { tag: '' }
  ];
  for (const over of bad) assert.throws(() => zwift.checkPin(pin(over)), (e) => e.problem === 'verify', JSON.stringify(over));
  assert.throws(() => zwift.checkPin(null));
  assert.throws(() => zwift.checkPin({ ...pin(), repo: 7 }));
  // The real pin from upstreams.json passes the check.
  const real = JSON.parse(fs.readFileSync(path.join(root, 'upstreams.json'), 'utf8')).zwift;
  assert.deepEqual(zwift.checkPin(real), real);
  assert.notEqual(real.tag, 'latest');
});

// --- RealZwift with the real rollout-run and container fakes -----------------------------------------------------------
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

test('Z7 RealZwift.status: script, runtime, image and consent from rollout-run --zwift-status', async () => {
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
  assert.equal(containerLog(home).filter((l) => / pull /.test(l)).length, 0, 'status never pulls');
});

test('Z8 RealZwift.status: missing runtime and missing tag are told apart, without starter there is an error', async () => {
  const home = runtimeHome({ image: true });
  assert.equal((await realZwift(home, { FAKE_INFO_FAIL: 'Cannot connect to the Docker daemon' }).status()).problem, 'runtime');
  assert.equal((await realZwift(home, { ROLLOUT_ZWIFT_TAG: '' }).status()).problem, 'tag');
  const bare = makeHome();
  assert.equal((await realZwift(bare).status()).problem, 'error');
  // No tag set (environment without the variable, no config.toml): state for the pinned image, runtime known.
  const noTag = realZwift(home, {});
  delete noTag.o.env.ROLLOUT_ZWIFT_TAG;
  assert.deepEqual(await noTag.status(), { script: false, runtime: 'podman', image: true, consent: false, ref: 'docker.io/netbrain/zwift:1.2.3', problem: '' });
});

test('Z9 RealZwift.pullImage: pulls via rollout-run, reports lines, remembers consent; errors carry their code', async () => {
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
    if (Date.now() > end) throw new Error('Timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('Z10 Installation via RealZwift: load script, enter tag, pull image, progress, finally installed and image present', async () => {
  const home = runtimeHome();
  // rollout-run reads the same config.toml as the store: same config directory, and the tag comes only from this file.
  const cfgHome = path.join(work, 'cfg-z10');
  const z = realZwift(home, { ROLLOUT_ZWIFT_TAG: undefined, ROLLOUT_CONFIG_HOME: cfgHome });
  const b = backendWith(z, { cfg: cfgHome });
  const first = await b.backend.getSnapshot();
  assert.equal(first.apps.zwift.installed, false);
  assert.equal(first.apps.zwift.problem, '', 'no tag before the installation is not an error');
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
  assert.ok(progress.some((p) => p > 5 && p < 100), 'layers count too');
  assert.deepEqual([...progress].sort((x, y) => x - y), progress, 'progress never decreases');
});

test('Z11 state comes from the runtime: script and image present = installed; image gone = no longer installed', async () => {
  const home = runtimeHome({ image: true });
  const z = realZwift(home);
  await z.installScript(new AbortController().signal);
  const { backend } = backendWith(z);
  assert.equal((await backend.getSnapshot()).apps.zwift.installed, true);
  fs.rmSync(path.join(home, 'image-present'));
  await new Promise((r) => setTimeout(r, 5200)); // state cache expires (5 s)
  const snap = await backend.getSnapshot();
  assert.equal(snap.apps.zwift.installed, false);
});

test('Z11b image present, script missing: Rollout quietly reloads the script and shows Zwift as installed', async () => {
  const home = runtimeHome({ image: true });
  const z = realZwift(home);
  const { backend } = backendWith(z);
  assert.equal((await backend.getSnapshot()).apps.zwift.installed, true);
  assert.equal((await z.status()).script, true);
});

test('Z12 failures appear as a problem on the card, nothing hangs; MyWhoosh stays untouched', async () => {
  for (const [mode, problem] of [['nonet', 'net'], ['nopull', 'pull'], ['norun', 'runtime']]) {
    const { backend } = backendWith(new zwift.FakeZwift(mode, 5));
    await backend.install('zwift', { steam: false, hd: false });
    const snap = await settle(backend, (s) => !s.job && s.apps.zwift.problem !== '');
    assert.equal(snap.apps.zwift.problem, problem, mode);
    assert.equal(snap.apps.zwift.installed, false, mode);
    assert.equal(snap.finished, null, mode);
    assert.equal(snap.apps.mywhoosh.problem, '');
  }
  // After an error a new attempt works (fake "ready" after installation).
  const { backend } = backendWith(new zwift.FakeZwift('', 5));
  await backend.install('zwift', { steam: true, hd: false });
  const snap = await settle(backend, (s) => !s.job && s.apps.zwift.installed);
  assert.equal(snap.apps.zwift.steam, true);
  assert.equal(snap.apps.zwift.problem, '');
  // Without a service Zwift stays simulated as before (progress in 120 ms steps).
  const sim0 = backendWith(null);
  await sim0.backend.install('zwift', { steam: false, hd: false });
  assert.equal(sim0.snaps.at(-1).job.app, 'zwift');
  await sim0.backend.remove('mywhoosh');
});

// --- Start, Beenden, Entfernen (Z14 bis Z21) --------------------------------------------------------------------------------------
/** Upstream fake for `rollout-run zwift` (ROLLOUT_RUN_UPSTREAM): replaces zwift.sh, no container is ever started. */
function stubUpstream(home, body) {
  const file = path.join(home, 'up.sh');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { ROLLOUT_RUN_UPSTREAM: file, ROLLOUT_RUN_NO_INHIBIT: '1' };
}
const STUB_OK = `printf '\\033[34m[*] Preparing to launch Zwift\\033[0m\\n'
echo "env tool=$CONTAINER_TOOL image=$IMAGE version=$VERSION fg=$ZWIFT_FG noupdate=$DONT_UPDATE"
printf '\\033[34m[*] Launching Zwift\\033[0m\\n'`;
const collect = (z) => { const lines = []; return { lines, run: z.start((l) => lines.push(l)) }; };

test('Z14 RealZwift.start: output line by line without colour codes, the start line is recognised, environment for zwift.sh, exit 0', async () => {
  const home = runtimeHome({ image: true });
  const { lines, run } = collect(realZwift(home, stubUpstream(home, STUB_OK)));
  assert.equal(await run.done, 0);
  assert.deepEqual(lines, ['[*] Preparing to launch Zwift', 'env tool=podman image=docker.io/netbrain/zwift version=1.2.3 fg=1 noupdate=1', '[*] Launching Zwift']);
  assert.deepEqual(lines.map(zwift.isStartLine), [false, false, true]);
  assert.equal(zwift.isStartLine('[*] Preparing to launch Zwift'), false);
  assert.equal(zwift.isRunningLine('[podman|✓] Zwift started using wine'), true);
  assert.equal(zwift.isRunningLine('[podman|*] Starting Zwift using wine'), false);
  assert.equal(containerLog(home).filter((l) => / (pull|run|rmi) /.test(l)).length, 0, 'only checked, nothing pulled or started');
});

test('Z15 RealZwift.start: exit codes of rollout-run carry their reason (runtime, tag, image missing, starter missing)', async () => {
  const exitOf = async (home, extra) => collect(realZwift(home, { ...stubUpstream(home, 'exit 0'), ...extra })).run.done;
  assert.equal(await exitOf(runtimeHome({ image: true }), { FAKE_INFO_FAIL: 'Cannot connect' }), 10);
  assert.equal(await exitOf(runtimeHome({ image: true }), { ROLLOUT_ZWIFT_TAG: '' }), 11);
  assert.equal(await exitOf(runtimeHome(), {}), 12, 'image missing and no consent: nothing is pulled');
  assert.equal(await collect(realZwift(makeHome())).run.done, 127, 'without starter');
  const bare = runtimeHome({ image: true });
  assert.equal(await exitOf(bare, { ROLLOUT_RUN_UPSTREAM: path.join(bare, 'fehlt.sh') }), 127);
  assert.deepEqual(zwift.RUN_PROBLEM, { 10: 'runtime', 11: 'tag', 12: 'pull', 127: 'error' });
  assert.equal(containerLog(bare).filter((l) => / pull /.test(l)).length, 0);
});

test('Z16 RealZwift.start.stop: TERM goes to the starter, which halts the container with podman stop (not to the group: that left it running as an orphan); the wait ends', async () => {
  const home = runtimeHome({ image: true });
  const { lines, run } = collect(realZwift(home, { ...stubUpstream(home, `sleep 30 & echo $! > "$ROLLOUT_HOME/child.pid"\necho "Launching Zwift"\nwait`), USER: 'fahrer' }));
  const end = Date.now() + 5000;
  while (!lines.some(zwift.isStartLine) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.equal(containerLog(home).filter((l) => / stop /.test(l)).length, 0, 'running: no stop yet');
  run.stop();
  const code = await run.done;
  assert.notEqual(code, 0);
  assert.deepEqual(containerLog(home).filter((l) => / stop /.test(l)), ['podman stop -t 10 zwift-fahrer']);
  assert.equal(fs.existsSync(path.join(home, 'state/run.pid')), false, 'run.pid cleaned up');
  try { process.kill(Number(fs.readFileSync(path.join(home, 'child.pid'), 'utf8'))); } catch { /* already gone */ }
  // ZWIFT_RIDER determines the name, as in zwift.sh.
  const home2 = runtimeHome({ image: true });
  const second = collect(realZwift(home2, { ...stubUpstream(home2, `echo "Launching Zwift"\nsleep 30 &\nwait`), ZWIFT_RIDER: 'rollouttest', USER: 'fahrer' }));
  const end2 = Date.now() + 5000;
  while (!second.lines.some(zwift.isStartLine) && Date.now() < end2) await new Promise((r) => setTimeout(r, 20));
  second.run.stop();
  await second.run.done;
  assert.deepEqual(containerLog(home2).filter((l) => / stop /.test(l)), ['podman stop -t 10 zwift-rollouttest']);
});

test('Z17 RealZwift.removeImage: podman rmi for exactly image:tag, consent forgotten; without image also success; errors carry their reason', async () => {
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
  assert.equal(containerLog(home).filter((l) => / rmi /.test(l)).length, 1, 'without image no second rmi');
  assert.ok(containerLog(home).length > before - 1);
  const busy = runtimeHome({ image: true });
  await expectError(realZwift(busy, { FAKE_RMI_FAIL: '1' }).removeImage(new AbortController().signal), 'error');
  assert.equal(fs.existsSync(path.join(busy, 'image-present')), true, 'on error the image stays');
  await expectError(realZwift(runtimeHome({ image: true }), { FAKE_INFO_FAIL: 'Cannot connect' }).removeImage(new AbortController().signal), 'runtime');
  await expectError(realZwift(runtimeHome({ image: true }), { ROLLOUT_ZWIFT_TAG: '' }).removeImage(new AbortController().signal), 'tag');
  await expectError(realZwift(makeHome()).removeImage(new AbortController().signal), 'error');
});

const launchOf = async (backend, until, ms) => (await settle(backend, until, ms)).launch;
const READY = { ROLLOUT_ZWIFT_RUNNING_MS: '300' };

test('Z18 Start via SimBackend with RealZwift: phases from the output (Preparing, Starting, Running), quitting stops the game', async () => {
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
  assert.ok(!seen.includes('bluetooth'), 'Zwift does not check Bluetooth');
  const progress = snaps.filter((s) => s.launch).map((s) => s.launch.progress);
  assert.deepEqual([...progress].sort((a, b) => a - b), progress, 'progress never decreases');
  await backend.launch('zwift'); // second start does not begin
  const stopping = backend.stopLaunch();
  assert.equal(snaps.at(-1).launch.phase, 'stopping', 'quitting is visible while the container stops');
  await backend.launch('zwift'); // and a start during that time is rejected
  await stopping;
  const after = await backend.getSnapshot();
  assert.equal(after.launch, null);
  assert.equal(fs.existsSync(path.join(home, 'state/run.pid')), false);
  assert.equal(after.apps.zwift.installed, true);
});

test('Z23 "Running" from the container message instead of after the wait; without a start line it goes via "Starting Zwift"', async () => {
  const phasesFor = async (body) => {
    const home = runtimeHome({ image: true });
    const z = realZwift(home, stubUpstream(home, body));
    await z.installScript(new AbortController().signal);
    const { backend, snaps } = backendWith(z, { env: { ROLLOUT_ZWIFT_RUNNING_MS: '60000' } });
    await backend.getSnapshot();
    const t0 = Date.now();
    await backend.launch('zwift');
    await launchOf(backend, (s) => s.launch?.phase === 'running', 5000);
    assert.ok(Date.now() - t0 < 5000, 'well before the 60 s of the wait');
    const seen = [...new Set(snaps.filter((s) => s.launch).map((s) => s.launch.phase))];
    await backend.stopLaunch();
    return seen;
  };
  assert.deepEqual(await phasesFor('echo "[*] Launching Zwift"\nsleep 0.2\necho "[podman|✓] Zwift started using wine"\nsleep 30 &\nwait'), ['updates', 'starting', 'running']);
  assert.deepEqual(await phasesFor('echo "[podman|✓] Zwift started using wine"\nsleep 30 &\nwait'), ['updates', 'starting', 'running']);
});

test('Z19 Start ends: exit 0 = game ended; error shortly after start = crash; exit 10 to 12 and 127 = start failed with reason', async () => {
  const ended = async (body) => {
    const home = runtimeHome({ image: true });
    const z = realZwift(home, stubUpstream(home, body));
    await z.installScript(new AbortController().signal);
    const { backend } = backendWith(z, { env: READY });
    assert.equal((await backend.getSnapshot()).apps.zwift.installed, true);
    await backend.launch('zwift');
    const snap = await settle(backend, (s) => s.launch === null || ['crash', 'failed'].includes(s.launch.phase));
    await backend.stopLaunch(); // cleans up the state and the ticker
    assert.equal((await backend.getSnapshot()).launch, null, 'leaving the error view ends the start');
    return snap.launch;
  };
  assert.equal(await ended('echo "Launching Zwift"\nexit 0'), null);
  assert.equal((await ended('echo "Launching Zwift"\nexit 1')).phase, 'crash');
  for (const [code, problem] of [[10, 'runtime'], [11, 'tag'], [12, 'pull'], [127, 'error']]) {
    const launch = await ended(`exit ${code}`);
    assert.deepEqual([launch.phase, launch.problem], ['failed', problem], `Exit ${code}`);
  }
  // The fake: exit 12 (image missing) and exit 1 after the start line.
  for (const [mode, phase, problem] of [['runfail', 'failed', 'pull'], ['runcrash', 'crash', '']]) {
    const { backend } = backendWith(new zwift.FakeZwift(mode, 5));
    await backend.getSnapshot();
    await backend.launch('zwift');
    const launch = await launchOf(backend, (s) => s.launch && ['crash', 'failed'].includes(s.launch.phase));
    assert.deepEqual([launch.phase, launch.problem], [phase, problem], mode);
    await backend.stopLaunch();
  }
});

test('Z20 Removal via SimBackend: image gone, no longer installed, script stays, Steam entry gone; errors stay visible and nothing is lost', async () => {
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
  assert.ok(zwift.scriptReady(home, pin()), 'the verified script stays for a reinstall');
  // If rmi fails (container still running), Zwift stays installed and the card names the problem.
  const busy = runtimeHome({ image: true });
  const zb = realZwift(busy, { FAKE_RMI_FAIL: '1' });
  await zb.installScript(new AbortController().signal);
  const b2 = backendWith(zb).backend;
  await b2.getSnapshot();
  await b2.remove('zwift');
  const kept = await b2.getSnapshot();
  assert.equal(kept.apps.zwift.installed, true);
  assert.equal(kept.apps.zwift.problem, 'error');
  // Fake: the same.
  const { backend: fb } = backendWith(new zwift.FakeZwift('norem', 5));
  await fb.getSnapshot();
  await fb.remove('zwift');
  assert.equal((await fb.getSnapshot()).apps.zwift.problem, 'error');
  assert.equal((await fb.getSnapshot()).apps.zwift.installed, true);
  // Without a service, removal stays the simulation as with MyWhoosh.
  const plain = backendWith(null).backend;
  await plain.remove('zwift');
  assert.equal((await plain.getSnapshot()).apps.zwift.installed, false);
});

test('Z21 Tag for the consent dialog: empty without a service, otherwise environment before config.toml before the pin; installation progress stays stable', async () => {
  assert.equal((await backendWith(null).backend.getSnapshot()).zwiftTag, '');
  const fake = new zwift.FakeZwift('', 5);
  assert.equal((await backendWith(fake).backend.getSnapshot()).zwiftTag, '1.0.0', 'pin as default');
  const cfg = path.join(work, 'cfg-z21');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'config.toml'), 'zwift_tag = "2.0.0"\n');
  assert.equal((await backendWith(fake, { cfg }).backend.getSnapshot()).zwiftTag, '2.0.0', 'config.toml before the pin');
  assert.equal((await backendWith(fake, { cfg, env: { ROLLOUT_ZWIFT_TAG: '3.0.0' } }).backend.getSnapshot()).zwiftTag, '3.0.0', 'Umgebung vor config.toml');
});

test('Z22 chooseZwiftMode: real as soon as rollout-run exists and the pin is valid; explicit choice wins; otherwise simulation', () => {
  const good = pin();
  const mode = (m, runnerExists, p = good) => zwift.chooseZwiftMode({ mode: m, runnerExists, pin: p });
  assert.equal(mode(undefined, true), 'real');
  assert.equal(mode(undefined, false), 'sim');
  assert.equal(mode(undefined, true, { ...good, sha256: 'x' }), 'sim', 'invalid pin');
  assert.equal(mode('', true), 'real');
  assert.equal(mode('sim', true), 'sim');
  assert.equal(mode('real', false), 'real');
  assert.equal(mode('fake', false), 'fake');
  assert.equal(mode('unsinn', true), 'sim');
  const real = JSON.parse(fs.readFileSync(path.join(root, 'upstreams.json'), 'utf8')).zwift;
  assert.equal(mode(undefined, true, real), 'real', 'the real pin from upstreams.json');
});

// --- Visibility in Gaming Mode (Z24 to Z28): never a real X server, the tools are a function --------------------------

const TREE = (...windows) => `\nxwininfo: Window id: 0x3d9 (the root window) (has no name)\n\n  Root window id: 0x3d9 (the root window) (has no name)\n  Parent window id: 0x0 (none)\n     ${windows.length} children:\n${windows.join('\n')}\n`;
const WIN = (id, name, cls, size) => `     ${id} "${name}": ("${cls}" "${cls}")  ${size}+4+30  +4+30`;
const CHILD = (id) => `        ${id} (has no name): ()  1912x1046+0+0  +4+30`;
const focusOut = (id) => (id === null ? 'GAMESCOPE_FOCUSED_WINDOW:  not found.\n' : `GAMESCOPE_FOCUSED_WINDOW(CARDINAL) = ${id}\n`);

test('Z24 AppID from the process tree: reaper SteamLaunch AppId=<N> as ancestor; otherwise null', () => {
  const proc = path.join(work, 'proc1');
  const put = (pid, ppid, comm, argv) => {
    fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} 1 1 0 -1 0\n`);
    fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), argv.join('\0') + '\0');
  };
  put(1, 0, 'init', ['/sbin/init']);
  put(100, 1, 'steam', ['/usr/bin/steam']);
  put(200, 100, 'reaper', ['/home/u/.steam/ubuntu12_32/reaper', 'SteamLaunch', 'AppId=4070058561', '--', '/x/rollout/bin/rollout']);
  put(300, 200, 'bash (x) y', ['bash', '/x/rollout/bin/rollout']); // name with parentheses and spaces
  put(400, 300, 'electron', ['electron', '.']);
  assert.equal(zwin.appIdFromAncestors(400, proc), '4070058561');
  assert.equal(zwin.appIdFromAncestors(200, proc), '4070058561');
  assert.equal(zwin.appIdFromAncestors(100, proc), null, 'Steam itself is not an entry');
  put(201, 100, 'reaper', ['reaper', 'SteamLaunch', 'AppId=99999999999', '--', 'x']); // too large for an AppID
  put(401, 201, 'x', ['x']);
  assert.equal(zwin.appIdFromAncestors(401, proc), null);
  assert.equal(zwin.appIdFromAncestors(999, proc), null, 'unbekannter Prozess');
});

test('Z25 Window detection: top-level game window; helper windows and foreign ones do not count; focus from GAMESCOPE_FOCUSED_WINDOW', () => {
  const tree = TREE(
    WIN('0x4200006', 'Default IME', 'zwiftapp.exe', '1x1'),
    WIN('0x3e00004', '', 'explorer.exe', '1912x1046'),
    WIN('0x4200005', 'Zwift', 'zwiftapp.exe', '1912x1046'), CHILD('0x4200009'),
    WIN('0x4200010', 'Zwift Launcher', 'ZwiftApp.exe', '800x600'));
  assert.deepEqual(zwin.findZwiftWindow(tree), { id: 0x4200005, hex: '0x4200005', width: 1912, height: 1046 }, 'the largest window');
  assert.equal(zwin.findZwiftWindow(TREE(WIN('0x1', 'Rollout', 'rollout', '1280x800'))), null);
  assert.equal(zwin.findZwiftWindow(TREE(WIN('0x2', 'x', 'zwiftapp.exe', '1x1'))), null);
  assert.equal(zwin.findZwiftWindow(''), null);
  assert.equal(zwin.parseFocusedWindow(focusOut(67108869)), 67108869);
  assert.equal(zwin.parseFocusedWindow(focusOut(null)), null);
});

/** X fake: `state.tree` and `state.focus` are mutable, all calls end up in `calls`. */
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
const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('Timeout'); await new Promise((r) => setTimeout(r, 5)); } };

test('Z26 Watcher: mark windows (once per window), "visible" only on focus, loss and new window are detected', async () => {
  const state = { tree: TREE(WIN('0x3e00004', '', 'explorer.exe', '160x20')), focus: 6291459 };
  const { exec, calls } = fakeX(state);
  const events = [];
  const w = zwin.watchZwiftWindow({ exec, appId: '4070058561', onVisible: (v) => events.push(v), intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(events, [], 'no window: nothing reported');
  assert.equal(calls.filter((c) => c.startsWith('xprop -id')).length, 0, 'nichts gekennzeichnet');

  state.tree = TREE(WIN('0x4200006', 'IME', 'zwiftapp.exe', '1x1'), WIN('0x4200005', 'Zwift', 'zwiftapp.exe', '1912x1046'));
  await until(() => state.tagged);
  assert.equal(state.tagged, '4070058561');
  assert.ok(calls.includes('xprop -id 0x4200005 -f STEAM_GAME 32c -set STEAM_GAME 4070058561'), 'exactly the call from test T3');
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(events, [], 'marked, but Rollout still has the focus: not visible');

  state.focus = 0x4200005;
  await until(() => events.length === 1);
  assert.deepEqual(events, [true]);
  assert.equal(w.visible, true);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.filter((c) => c.startsWith('xprop -id')).length, 1, 'set only once per window');

  state.focus = 6291459; // Steam overlay or jump back
  await until(() => events.length === 2);
  assert.deepEqual(events, [true, false]);

  state.tree = TREE(WIN('0x4200099', 'Zwift', 'zwiftapp.exe', '1920x1080')); // launcher is replaced by the game
  state.focus = 0x4200099;
  await until(() => events.length === 3);
  assert.deepEqual(events, [true, false, true]);
  assert.equal(calls.filter((c) => c.startsWith('xprop -id')).length, 2, 'the new window is marked again');

  state.down = true; // X server briefly gone: the watcher stays alive
  await new Promise((r) => setTimeout(r, 40));
  state.down = false;
  state.tree = TREE();
  await until(() => events.length === 4);
  assert.deepEqual(events, [true, false, true, false]);

  w.stop();
  const n = calls.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.length, n, 'no more queries after stop()');
});

test('Z27 Watcher without AppID (not started from Steam): nothing set, nothing reported, one note', async () => {
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

test('Z28 Start with RealZwift and window: visible in the snapshot, reset at the end; xhost +local: is revoked only if it was missing before', async () => {
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
    assert.notEqual(snaps.at(-1).launch.visible, true, 'not in focus yet');
    state.focus = 0x4200005;
    await settle(backend, (s) => s.launch?.visible === true);
    await backend.stopLaunch();
    const after = await backend.getSnapshot();
    assert.equal(after.launch, null);
    assert.equal(snaps.some((s) => s.launch?.visible === false), true, 'reset on quit');
    const revoked = calls.includes('xhost -local:');
    assert.equal(revoked, !hadLocal, hadLocal ? 'existing xhost entry stays' : 'access opened by zwift.sh is closed');
    assert.equal(state.local, hadLocal);
    const n = calls.length;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls.length, n, 'no more queries after the end');
  }
});

test('Z29 without `windows`, RealZwift.start touches no X server (xwininfo, xprop and xhost on PATH would be traps)', async () => {
  const home = runtimeHome({ image: true });
  for (const tool of ['xwininfo', 'xprop', 'xhost']) fs.writeFileSync(path.join(home, 'fakebin', tool), `#!/bin/sh\necho "$0" >> "${path.join(home, 'x-called')}"\n`, { mode: 0o755 });
  const { lines, run } = collect(realZwift(home, stubUpstream(home, STUB_OK)));
  assert.equal(await run.done, 0);
  assert.equal(lines.length, 3);
  assert.equal(fs.existsSync(path.join(home, 'x-called')), false);
});

test('Z13 real network (only with ROLLOUT_ZWIFT_NET=1): the pinned zwift.sh from GitHub has the checksum from upstreams.json', { skip: process.env.ROLLOUT_ZWIFT_NET !== '1' }, async () => {
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

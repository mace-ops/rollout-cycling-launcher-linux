// Checks the watcher scripts/bin-rollout.sh (W1 to W12) and the migration by scripts/install.sh (M1) in throwaway directories.
// Electron is a shell script that reads its behaviour from the `mode` file of the started version (one line per start,
// the last one keeps applying) and logs its calls to calls.log. Runs with bash and, if present, dash.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/bin-rollout.sh');
const install = path.join(root, 'scripts/install.sh');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-boot-test-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));

// `bash --posix` stands for /bin/sh on the Ally (where sh is bash). dash is not available everywhere.
const shells = ['bash', 'bash --posix', 'dash'].filter((sh) => spawnSync(sh.split(' ')[0], ['-c', 'exit 0']).status === 0);
if (!shells.includes('dash')) console.log('# dash missing, W1 to W12 run only with bash and bash --posix');
const argv = (sh, ...rest) => [sh.split(' ')[0], [...sh.split(' ').slice(1), ...rest]];

// Never real Steam: the fakes are fixed in the environment of every run; the watcher passes them on to Electron.
const FORCED = { ROLLOUT_SIM_STEAM: 'fake', ROLLOUT_BT: 'fake', ROLLOUT_SELFUPDATE: 'fake' };

const FAKE_ELECTRON = `#!/bin/sh
app=$1; shift
ver=$(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "$app/package.json")
fd9=closed; [ -e /proc/$$/fd/9 ] && fd9=open
echo "start $ver rt=$(basename "$(dirname "$0")") args=$* preload=\${LD_PRELOAD+set} libpath=\${LD_LIBRARY_PATH+set} sup=\${ROLLOUT_SUPERVISED-unset} home=$ROLLOUT_HOME fd9=$fd9 steam=$ROLLOUT_SIM_STEAM bt=$ROLLOUT_BT selfupdate=$ROLLOUT_SELFUPDATE" >> "$ROLLOUT_HOME/calls.log"
n=$(cat "$app/runs" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "$app/runs"
mode=$(sed -n "\${n}p" "$app/mode" 2>/dev/null)
[ -n "$mode" ] || mode=$(tail -n 1 "$app/mode" 2>/dev/null)
[ -n "$mode" ] || mode='exit 0'
case $mode in
  exit\\ *) exit "\${mode#exit }" ;;
  healthy) echo "$ver" > "$ROLLOUT_HOME/state/healthy"; sleep 3; exit 0 ;;
  hang) sleep 20 >/dev/null 2>&1 & s=$!; trap 'kill $s; echo term >> "$ROLLOUT_HOME/calls.log"; exit 0' TERM; wait $s ;;
  hangkill) trap '' TERM; sleep 20 >/dev/null 2>&1 & s=$!; while kill -0 $s 2>/dev/null; do sleep 1; done ;;
  term42) sleep 20 >/dev/null 2>&1 & s=$!; trap 'kill $s; echo term >> "$ROLLOUT_HOME/calls.log"; exit 42' TERM; : > "$ROLLOUT_HOME/started"; wait $s ;;
esac
`;

let counter = 0;
function makeHome() {
  counter += 1;
  const home = path.join(work, `h${counter}`);
  for (const dir of ['bin', 'versions', 'electron', 'state']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  fs.copyFileSync(script, path.join(home, 'bin/rollout'));
  fs.chmodSync(path.join(home, 'bin/rollout'), 0o755);
  return home;
}

function addElectron(home, rt) {
  const dir = path.join(home, 'electron', rt);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'electron'), FAKE_ELECTRON, { mode: 0o755 });
}

function addVersion(home, ver, { rt = '45.0.0', mode = 'exit 0' } = {}) {
  if (!fs.existsSync(path.join(home, 'electron', rt))) addElectron(home, rt);
  const dir = path.join(home, 'versions', ver);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'rollout', version: ver }));
  fs.writeFileSync(path.join(dir, 'runtime'), `${rt}\n`);
  fs.writeFileSync(path.join(dir, 'mode'), `${mode}\n`);
}

const link = (home, name, ver) => {
  fs.rmSync(path.join(home, name), { force: true });
  fs.symlinkSync(`versions/${ver}`, path.join(home, name));
};
const target = (home, name) => { try { return path.basename(fs.readlinkSync(path.join(home, name))); } catch { return null; } };
const stateFile = (home, name) => { try { return fs.readFileSync(path.join(home, 'state', name), 'utf8'); } catch { return null; } };
const calls = (home) => { try { return fs.readFileSync(path.join(home, 'calls.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const starts = (home) => calls(home).filter((l) => l.startsWith('start ')).map((l) => l.split(' ')[1]);

/** Fresh directory with old version 1.2.0 as `current` and, if given, 1.3.0 as pending. */
function scenario({ old = 'exit 0', next = 'exit 0', pending = true } = {}) {
  const home = makeHome();
  addVersion(home, '1.2.0', { mode: old });
  link(home, 'current', '1.2.0');
  if (next) addVersion(home, '1.3.0', { mode: next });
  if (pending) fs.writeFileSync(path.join(home, 'state/pending'), '1.3.0\n');
  return home;
}

function run(sh, home, { args = [], env = {}, timeout = 60000 } = {}) {
  assert.ok(home.startsWith(os.tmpdir()), 'Test runs only in a throwaway directory');
  const out = fs.openSync(path.join(home, 'wrapper.out'), 'a');
  const childEnv = {
    PATH: process.env.PATH, HOME: home, LD_PRELOAD: '', LD_LIBRARY_PATH: '/nonexistent',
    ROLLOUT_BOOT_TIMEOUT: '2', ROLLOUT_BOOT_GRACE: '1', ...env, ...FORCED
  };
  const [cmd, cmdArgs] = argv(sh, path.join(home, 'bin/rollout'), ...args);
  const child = spawn(cmd, cmdArgs, { env: childEnv, stdio: ['ignore', out, out] });
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('KILL'); resolve({ code: 'timeout' }); }, timeout);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  return Object.assign(done, { child });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(100); } return false; };

for (const sh of shells) {
  test(`W1 normaler Start (${sh}): richtiges Electron, Argumente, Umgebung, Exit-Code`, async () => {
    const home = makeHome();
    addVersion(home, '1.2.0', { rt: '45.0.0', mode: 'exit 0' });
    addVersion(home, '1.2.1', { rt: '45.2.2', mode: 'exit 7' });
    link(home, 'current', '1.2.1');
    const result = await run(sh, home, { args: ['--fullscreen', 'x y'] });
    assert.equal(result.code, 7);
    const [line] = calls(home);
    assert.match(line, /^start 1\.2\.1 rt=45\.2\.2 args=--fullscreen x y /);
    assert.doesNotMatch(line, /preload=set/);
    assert.doesNotMatch(line, /libpath=set/);
    assert.match(line, /sup=1 /);
    assert.ok(line.includes(`home=${home} `));
    assert.match(line, /fd9=closed/);
    assert.match(line, /steam=fake bt=fake selfupdate=fake$/);
    assert.equal(stateFile(home, 'trial'), null);
  });

  test(`W2 pending is applied (${sh})`, async () => {
    const home = scenario();
    const result = await run(sh, home);
    assert.equal(result.code, 0);
    assert.equal(target(home, 'current'), '1.3.0');
    assert.equal(target(home, 'previous'), '1.2.0');
    assert.equal(stateFile(home, 'trial'), '1.3.0\n0\n');
    assert.equal(stateFile(home, 'pending'), null);
    assert.deepEqual(starts(home), ['1.3.0']);
  });

  test(`W3 abort after each single step of the swap (${sh})`, async () => {
    for (let step = 0; step <= 3; step += 1) {
      const home = scenario();
      // State left behind by an abort after step n: trial, previous, current.
      if (step >= 1) fs.writeFileSync(path.join(home, 'state/trial'), '1.3.0\n0\n');
      if (step >= 2) link(home, 'previous', '1.2.0');
      if (step >= 3) link(home, 'current', '1.3.0');
      const result = await run(sh, home);
      assert.equal(result.code, 0, `Schritt ${step}`);
      assert.equal(target(home, 'current'), '1.3.0', `Schritt ${step}`);
      assert.equal(target(home, 'previous'), '1.2.0', `Schritt ${step}`);
      assert.notEqual(target(home, 'previous'), target(home, 'current'));
      assert.equal(stateFile(home, 'pending'), null, `Schritt ${step}`);
      assert.equal(stateFile(home, 'trial'), '1.3.0\n0\n', `Schritt ${step}`);
    }
  });

  test(`W4 healthy ends the trial (${sh})`, async () => {
    const home = scenario({ next: 'healthy' });
    const result = await run(sh, home);
    assert.equal(result.code, 0);
    assert.equal(stateFile(home, 'trial'), null);
    assert.equal(stateFile(home, 'healthy'), null);
    assert.equal(target(home, 'current'), '1.3.0');
  });

  test(`W5 zweimal Exit 1: Rollback (${sh})`, async () => {
    const home = scenario({ next: 'exit 1' });
    const result = await run(sh, home);
    assert.equal(result.code, 0);
    assert.deepEqual(starts(home), ['1.3.0', '1.3.0', '1.2.0']);
    assert.equal(target(home, 'current'), '1.2.0');
    assert.equal(stateFile(home, 'bad'), '1.3.0\n');
    assert.equal(stateFile(home, 'notice'), '1.3.0\n');
    assert.equal(stateFile(home, 'trial'), null);
    assert.equal(stateFile(home, 'pending'), null);
    assert.equal(target(home, 'previous'), null, 'previous does not point to current after the rollback');
  });

  for (const mode of ['hang', 'hangkill']) {
    test(`W6 hangs twice, ${mode === 'hang' ? 'TERM suffices' : 'TERM is ignored, then KILL'} (${sh})`, async () => {
      const home = scenario({ next: mode });
      const result = await run(sh, home);
      assert.equal(result.code, 0);
      assert.deepEqual(starts(home), ['1.3.0', '1.3.0', '1.2.0']);
      if (mode === 'hang') assert.equal(calls(home).filter((l) => l === 'term').length, 2);
      assert.equal(target(home, 'current'), '1.2.0');
      assert.equal(stateFile(home, 'bad'), '1.3.0\n');
      assert.equal(stateFile(home, 'trial'), null);
    });
  }

  test(`W7 exit 0 before healthy is not a failure (${sh})`, async () => {
    const home = scenario({ next: 'exit 0' });
    const result = await run(sh, home);
    assert.equal(result.code, 0);
    assert.equal(target(home, 'current'), '1.3.0');
    assert.equal(stateFile(home, 'trial'), '1.3.0\n0\n');
    assert.equal(stateFile(home, 'bad'), null);
    assert.deepEqual(starts(home), ['1.3.0']);
  });

  test(`W8 Exit 75 (${sh})`, async () => {
    const withTrial = scenario({ next: 'exit 75\nhealthy' });
    assert.equal((await run(sh, withTrial)).code, 0);
    assert.deepEqual(starts(withTrial), ['1.3.0', '1.3.0'], 'restart with a running trial');
    assert.equal(stateFile(withTrial, 'trial'), null);

    const swapped = scenario({ old: 'exit 75', next: 'exit 0' });
    assert.equal((await run(sh, swapped)).code, 0);
    assert.deepEqual(starts(swapped), ['1.3.0'], 'pending is applied immediately');

    const restart = scenario({ old: 'exit 75', next: 'exit 0', pending: false });
    fs.writeFileSync(path.join(restart, 'versions/1.2.0/mode'), 'exit 75\n');
    assert.equal((await run(sh, restart)).code, 75, 'without pending and without a trial the watcher ends');
    assert.deepEqual(starts(restart), ['1.2.0']);
  });

  test(`W9 second instance when the lock is held (${sh})`, async () => {
    const home = scenario();
    const holder = spawn('flock', [path.join(home, 'state/lock'), 'sleep', '8'], { stdio: 'ignore' });
    try {
      await sleep(400);
      const result = await run(sh, home);
      assert.equal(result.code, 0);
      assert.deepEqual(starts(home), ['1.2.0']);
      assert.match(calls(home)[0], /sup=unset /);
      assert.match(calls(home)[0], /fd9=closed/);
      assert.equal(stateFile(home, 'pending'), '1.3.0\n');
      assert.equal(stateFile(home, 'trial'), null);
      assert.equal(target(home, 'current'), '1.2.0');
    } finally { holder.kill(); }
  });

  test(`W10 invalid pending is discarded, the old version starts (${sh})`, async () => {
    const missing = scenario({ next: null });
    const noElectron = scenario();
    fs.rmSync(path.join(noElectron, 'electron/45.0.0'), { recursive: true });
    addElectron(noElectron, '44.0.0');
    fs.writeFileSync(path.join(noElectron, 'versions/1.2.0/runtime'), '44.0.0\n');
    fs.writeFileSync(path.join(noElectron, 'versions/1.3.0/runtime'), '45.0.0\n');
    const bad = scenario();
    fs.writeFileSync(path.join(bad, 'state/bad'), '1.3.0\n');
    const traversal = scenario();
    fs.writeFileSync(path.join(traversal, 'state/pending'), '../versions/1.3.0\n');
    for (const [name, home] of Object.entries({ missing, noElectron, bad, traversal })) {
      const result = await run(sh, home);
      assert.equal(result.code, 0, name);
      assert.equal(stateFile(home, 'pending'), null, name);
      assert.equal(target(home, 'current'), '1.2.0', name);
      assert.equal(target(home, 'previous'), null, name);
      assert.equal(stateFile(home, 'trial'), null, name);
      assert.deepEqual(starts(home), ['1.2.0'], name);
    }
  });

  test(`W11 proven version fails: no rollback. Without previous neither (${sh})`, async () => {
    const proven = scenario({ old: 'exit 1', pending: false });
    link(proven, 'previous', '1.3.0');
    assert.equal((await run(sh, proven)).code, 1);
    assert.deepEqual(starts(proven), ['1.2.0']);
    assert.equal(target(proven, 'current'), '1.2.0');
    assert.equal(stateFile(proven, 'bad'), null);

    const noPrevious = scenario({ old: 'exit 1', next: null, pending: false });
    fs.writeFileSync(path.join(noPrevious, 'state/trial'), '1.2.0\n0\n');
    assert.equal((await run(sh, noPrevious)).code, 1);
    assert.equal(target(noPrevious, 'current'), '1.2.0');
    assert.equal(stateFile(noPrevious, 'bad'), null);
    assert.equal(stateFile(noPrevious, 'trial'), null);
    assert.deepEqual(starts(noPrevious), ['1.2.0', '1.2.0', '1.2.0']);

    const previousBad = scenario({ next: 'exit 1' });
    fs.writeFileSync(path.join(previousBad, 'state/bad'), '1.2.0\n');
    assert.equal((await run(sh, previousBad)).code, 1);
    assert.equal(target(previousBad, 'current'), '1.3.0', 'previous is itself listed in bad');
  });

  test(`W12 TERM reaches the child, exit code is kept, self-test starts nothing (${sh})`, async () => {
    const home = scenario({ next: 'term42' });
    const running = run(sh, home);
    assert.ok(await waitFor(() => fs.existsSync(path.join(home, 'started'))), 'Electron is running');
    running.child.kill('SIGTERM');
    const result = await running;
    assert.equal(result.code, 42);
    assert.ok(calls(home).includes('term'));
    assert.equal(stateFile(home, 'bad'), null, 'quitting does not count as a failure');
    assert.equal(stateFile(home, 'trial'), '1.3.0\n0\n');

    const selftest = scenario();
    const [cmd, cmdArgs] = argv(sh, path.join(selftest, 'bin/rollout'), '--bootstrap-selftest');
    const check = spawnSync(cmd, cmdArgs, { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(check.status, 0);
    assert.match(check.stdout, /^rollout-bootstrap 1 flock=(ja|nein)\n$/);
    assert.deepEqual(calls(selftest), []);
    assert.equal(stateFile(selftest, 'pending'), '1.3.0\n');
  });

  test(`Syntax check (${sh} -n)`, () => {
    const [cmd, cmdArgs] = argv(sh, '-n', script);
    assert.equal(spawnSync(cmd, cmdArgs).status, 0);
  });
}

test('M1 install.sh migrates an old layout and keeps Electron and bin/rollout', { skip: !fs.existsSync(path.join(root, 'dist')) && 'dist/ is missing, run npm run build first' }, async () => {
  const home = path.join(work, 'alt');
  fs.mkdirSync(path.join(home, 'app/electron'), { recursive: true });
  fs.mkdirSync(path.join(home, 'app/dist'), { recursive: true });
  fs.mkdirSync(path.join(home, 'bin'));
  fs.mkdirSync(path.join(home, 'state'));
  fs.writeFileSync(path.join(home, 'app/electron/electron'), FAKE_ELECTRON, { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'app/electron/version'), '44.9.9\n');
  fs.writeFileSync(path.join(home, 'app/electron/zusatz.pak'), 'x');
  fs.writeFileSync(path.join(home, 'app/dist/alt.txt'), 'alt');
  fs.writeFileSync(path.join(home, 'app/package.json'), '{"version":"0.0.1"}');
  fs.writeFileSync(path.join(home, 'bin/rollout'), '#!/bin/sh\necho alt\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'state/gast'), 'bleibt');
  fs.writeFileSync(path.join(home, 'icon.png'), 'alt');
  const env = { PATH: process.env.PATH, HOME: home, ROLLOUT_HOME: home };
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  for (const round of [1, 2]) {
    const result = spawnSync('sh', [install], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(home, 'electron/44.9.9/electron')), `Electron behalten (Lauf ${round})`);
    assert.ok(fs.existsSync(path.join(home, 'electron/44.9.9/zusatz.pak')));
    assert.equal(fs.existsSync(path.join(home, 'app')), false, 'alter Aufbau entfernt');
    assert.equal(target(home, 'current'), version);
    assert.equal(fs.readFileSync(path.join(home, `versions/${version}/runtime`), 'utf8'), '44.9.9\n');
    assert.ok(fs.existsSync(path.join(home, `versions/${version}/dist/main/main.js`)));
    assert.deepEqual(fs.readFileSync(path.join(home, 'bin/rollout')), fs.readFileSync(script));
    assert.deepEqual(fs.readFileSync(path.join(home, `versions/${version}/bootstrap/rollout`)), fs.readFileSync(script));
    assert.deepEqual(fs.readFileSync(path.join(home, 'bin/rollout-run')), fs.readFileSync(path.join(root, 'scripts/bin-rollout-run.sh')));
    assert.equal(fs.statSync(path.join(home, 'bin/rollout-run')).mode & 0o111, 0o111, 'rollout-run is executable');
    assert.ok(fs.existsSync(path.join(home, `versions/${version}/bootstrap/rollout-run`)));
    assert.equal(fs.readFileSync(path.join(home, 'state/gast'), 'utf8'), 'bleibt');
    assert.notEqual(fs.readFileSync(path.join(home, 'icon.png'), 'utf8'), 'alt');
  }
  const start = await run('sh', home);
  assert.equal(start.code, 0);
  assert.match(calls(home)[0], /^start \S+ rt=44\.9\.9 /);
});

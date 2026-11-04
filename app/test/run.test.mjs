// Prüft den Spielstarter scripts/bin-rollout-run.sh (R1 bis R6) in Wegwerf-Ordnern, mit bash, `bash --posix` und, falls vorhanden, dash.
// Der Upstream ist ein Shell-Skript (ROLLOUT_RUN_UPSTREAM), das sein Verhalten aus RUN_MODE liest und in calls.log protokolliert.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/bin-rollout-run.sh');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-run-test-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));

const shells = ['bash', 'bash --posix', 'dash'].filter((sh) => spawnSync(sh.split(' ')[0], ['-c', 'exit 0']).status === 0);
if (!shells.includes('dash')) console.log('# dash fehlt, R1 bis R6 laufen nur mit bash und bash --posix');
const argv = (sh, ...rest) => [sh.split(' ')[0], [...sh.split(' ').slice(1), ...rest]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UPSTREAM = `#!/bin/sh
echo "start args=$* preload=\${LD_PRELOAD+set} libpath=\${LD_LIBRARY_PATH+set} pidfile=$(cat "$ROLLOUT_HOME/state/run.pid" 2>/dev/null) parent=$PPID" >> "$ROLLOUT_HOME/calls.log"
case $RUN_MODE in
  exit*) exit "\${RUN_MODE#exit }" ;;
  wait) : > "$ROLLOUT_HOME/started"; sleep 20 >/dev/null 2>&1 & s=$!; wait $s ;;
  term42) sleep 20 >/dev/null 2>&1 & s=$!; trap 'kill $s; echo term >> "$ROLLOUT_HOME/calls.log"; exit 42' TERM; : > "$ROLLOUT_HOME/started"; wait $s ;;
esac
`;

let counter = 0;
function makeHome() {
  counter += 1;
  const home = path.join(work, `h${counter}`);
  for (const dir of ['bin', 'state']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  fs.copyFileSync(script, path.join(home, 'bin/rollout-run'));
  fs.chmodSync(path.join(home, 'bin/rollout-run'), 0o755);
  fs.writeFileSync(path.join(home, 'upstream.sh'), UPSTREAM, { mode: 0o755 });
  return home;
}

const env = (home, extra = {}) => ({
  ...process.env, ROLLOUT_HOME: home, ROLLOUT_RUN_UPSTREAM: path.join(home, 'upstream.sh'), ROLLOUT_RUN_NO_INHIBIT: '1', ...extra
});
const run = (sh, home, args, extra) => spawnSync(...argv(sh, path.join(home, 'bin/rollout-run'), ...args), { env: env(home, extra), encoding: 'utf8' });
const start = (sh, home, args, extra) => spawn(...argv(sh, path.join(home, 'bin/rollout-run'), ...args), { env: env(home, extra), stdio: 'ignore' });
const calls = (home) => { try { return fs.readFileSync(path.join(home, 'calls.log'), 'utf8').trim().split('\n'); } catch { return []; } };
const pidFile = (home) => { try { return fs.readFileSync(path.join(home, 'state/run.pid'), 'utf8').trim(); } catch { return null; } };
const exited = (child) => new Promise((resolve) => { if (child.exitCode !== null) resolve(child.exitCode); else child.once('exit', (code, signal) => resolve(code ?? signal)); });
async function until(fn, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (fn()) return true; await sleep(50); }
  return false;
}

for (const sh of shells) {
  test(`R1 Start (${sh}): Umgebung bereinigt, run.pid nennt den Starter, Exit-Code und Aufräumen`, () => {
    const home = makeHome();
    const r = run(sh, home, ['mywhoosh', '--demo'], { RUN_MODE: 'exit 7', LD_PRELOAD: '/x.so', LD_LIBRARY_PATH: '/x' });
    assert.equal(r.status, 7);
    const [line] = calls(home);
    const m = /args=run --demo preload= libpath= pidfile=(\d+) parent=(\d+)$/.exec(line);
    assert.ok(m, line);
    assert.equal(m[1], m[2], 'run.pid nennt den Starter, den Elternprozess des Upstreams');
    assert.equal(pidFile(home), null, 'run.pid nach dem Ende weg');
    const zwift = run(sh, home, ['zwift', '-x'], { RUN_MODE: 'exit 0' });
    assert.equal(zwift.status, 0);
    assert.match(calls(home)[1], /args=-x preload=/);
  });

  test(`R2 zweite Instanz (${sh}) wird abgewiesen, die erste behält run.pid`, async () => {
    const home = makeHome();
    const first = start(sh, home, ['zwift'], { RUN_MODE: 'wait' });
    assert.ok(await until(() => fs.existsSync(path.join(home, 'started'))), 'erste Instanz läuft');
    const pid = pidFile(home);
    assert.match(pid, /^\d+$/);
    const second = run(sh, home, ['mywhoosh'], { RUN_MODE: 'exit 0' });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /läuft schon/);
    assert.equal(pidFile(home), pid, 'run.pid der ersten Instanz bleibt');
    assert.equal(calls(home).length, 1, 'die zweite startet nichts');
    first.kill('SIGTERM');
    await exited(first);
    assert.equal(pidFile(home), null);
  });

  test(`R3 veraltete run.pid (${sh}) wird ersetzt`, () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'state/run.pid'), '999999999\n');
    const r = run(sh, home, ['zwift'], { RUN_MODE: 'exit 0' });
    assert.equal(r.status, 0);
    assert.match(calls(home)[0], /pidfile=\d+ /);
    assert.notEqual(calls(home)[0].match(/pidfile=(\d+)/)[1], '999999999');
    assert.equal(pidFile(home), null);
  });

  test(`R4 TERM erreicht das Spiel (${sh}), sein Exit-Code bleibt, run.pid verschwindet`, async () => {
    const home = makeHome();
    const child = start(sh, home, ['zwift'], { RUN_MODE: 'term42' });
    assert.ok(await until(() => fs.existsSync(path.join(home, 'started'))));
    child.kill('SIGTERM');
    assert.equal(await exited(child), 42);
    assert.ok(calls(home).includes('term'));
    assert.equal(pidFile(home), null);
  });

  test(`R5 unbekannte App und fehlender Upstream (${sh}) starten nichts und hinterlassen keine run.pid`, () => {
    const home = makeHome();
    const unknown = run(sh, home, ['nichts'], { RUN_MODE: 'exit 0' });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Aufruf: rollout-run/);
    const missing = run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', ROLLOUT_RUN_UPSTREAM: path.join(home, 'gibt-es-nicht') });
    assert.equal(missing.status, 127);
    assert.match(missing.stderr, /nicht installiert/);
    assert.equal(run(sh, home, ['mywhoosh'], { RUN_MODE: 'exit 0', ROLLOUT_RUN_UPSTREAM: '' }).status, 127, 'ohne vendor/mywhoosh.sh');
    assert.equal(calls(home).length, 0);
    assert.equal(pidFile(home), null);
  });

  test(`R6 Selbsttest (${sh}) nennt die Nummer und startet nichts`, () => {
    const home = makeHome();
    const r = run(sh, home, ['--bootstrap-selftest'], { RUN_MODE: 'exit 0' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'rollout-bootstrap 1 run');
    assert.equal(calls(home).length, 0);
    assert.equal(pidFile(home), null);
  });

  test(`Syntaxprüfung (${sh} -n)`, () => {
    const [cmd, args] = argv(sh, '-n', script);
    assert.equal(spawnSync(cmd, args).status, 0);
  });
}

// systemd-inhibit als Attrappe im PATH: R8 prüft, dass die Sperre benutzt wird, und dass ein Fehler der Sperre das Spiel nicht verhindert.
for (const sh of shells) {
  test(`R8 Bildschirmsperre (${sh}): benutzt, wenn sie geht, übersprungen, wenn sie verweigert wird`, () => {
    const home = makeHome();
    const bin = path.join(home, 'fakebin');
    fs.mkdirSync(bin);
    const fake = (body) => fs.writeFileSync(path.join(bin, 'systemd-inhibit'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const extra = { RUN_MODE: 'exit 4', ROLLOUT_RUN_NO_INHIBIT: '', PATH: `${bin}:${process.env.PATH}` };
    fake('echo "inhibit $*" >> "$ROLLOUT_HOME/calls.log"\nwhile case $1 in --*) true ;; *) false ;; esac; do shift; done\nexec "$@"');
    assert.equal(run(sh, home, ['zwift'], extra).status, 4);
    assert.ok(calls(home).some((l) => l.startsWith('inhibit --what=idle:sleep --who=Rollout ')), 'Sperre benutzt');
    assert.ok(calls(home).some((l) => l.startsWith('start ')), 'Spiel gestartet');
    fs.rmSync(path.join(home, 'calls.log'));
    fake('echo "inhibit $*" >> "$ROLLOUT_HOME/calls.log"\nexit 1');
    assert.equal(run(sh, home, ['zwift'], extra).status, 4, 'Spiel läuft trotz verweigerter Sperre, sein Exit-Code bleibt');
    assert.deepEqual(calls(home).filter((l) => l.startsWith('start ')).length, 1);
    assert.equal(pidFile(home), null);
  });
}

test('R7 mywhoosh und zwift finden ihren Upstream ohne Überschreibung', () => {
  const home = makeHome();
  const vendor = path.join(home, 'current/vendor');
  fs.mkdirSync(vendor, { recursive: true });
  fs.copyFileSync(path.join(home, 'upstream.sh'), path.join(vendor, 'mywhoosh.sh'));
  fs.chmodSync(path.join(vendor, 'mywhoosh.sh'), 0o755);
  const zwiftDir = path.join(home, 'upstream/zwift/abc123');
  fs.mkdirSync(zwiftDir, { recursive: true });
  fs.copyFileSync(path.join(home, 'upstream.sh'), path.join(zwiftDir, 'zwift.sh'));
  fs.chmodSync(path.join(zwiftDir, 'zwift.sh'), 0o755);
  const bare = { ...process.env, ROLLOUT_HOME: home, ROLLOUT_RUN_NO_INHIBIT: '1', RUN_MODE: 'exit 0' };
  delete bare.ROLLOUT_RUN_UPSTREAM;
  for (const app of ['mywhoosh', 'zwift']) assert.equal(spawnSync('sh', [path.join(home, 'bin/rollout-run'), app], { env: bare }).status, 0, app);
  assert.match(calls(home)[0], /args=run /);
  assert.equal(calls(home).length, 2);
});

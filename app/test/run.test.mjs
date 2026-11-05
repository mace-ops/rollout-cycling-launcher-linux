// Prüft den Spielstarter scripts/bin-rollout-run.sh (R1 bis R19) in Wegwerf-Ordnern, mit bash, `bash --posix` und, falls vorhanden, dash.
// Der Upstream ist ein Shell-Skript (ROLLOUT_RUN_UPSTREAM), das sein Verhalten aus RUN_MODE liest und in calls.log protokolliert.
// Podman und Docker sind Attrappen im PATH (fakebin/), die ihre Aufrufe in containers.log schreiben: Es startet nie ein echter Container.
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
echo "\${USER-}" > "$ROLLOUT_HOME/user.log"
echo "tool=$CONTAINER_TOOL image=$IMAGE version=$VERSION fg=\${ZWIFT_FG-} noupdate=\${DONT_UPDATE-}" > "$ROLLOUT_HOME/env.log"
echo "start args=$* preload=\${LD_PRELOAD+set} libpath=\${LD_LIBRARY_PATH+set} pidfile=$(cat "$ROLLOUT_HOME/state/run.pid" 2>/dev/null) parent=$PPID" >> "$ROLLOUT_HOME/calls.log"
case $RUN_MODE in
  exit*) exit "\${RUN_MODE#exit }" ;;
  wait) : > "$ROLLOUT_HOME/started"; sleep 20 >/dev/null 2>&1 & s=$!; wait $s ;;
  term42) sleep 20 >/dev/null 2>&1 & s=$!; trap 'kill $s; echo term >> "$ROLLOUT_HOME/calls.log"; exit 42' TERM; : > "$ROLLOUT_HOME/started"; wait $s ;;
esac
`;

// Attrappe für podman und docker. FAKE_INFO_FAIL (Meldung) lässt `info` scheitern, FAKE_PULL_FAIL=1 lässt `pull` scheitern,
// FAKE_REPODIGEST ist der Digest, den das lokale Image meldet. Das Image gilt als geladen, solange die Datei image-present liegt.
const FAKE_TOOL = `#!/bin/sh
name=\${0##*/}
echo "$name $*" >> "$ROLLOUT_HOME/containers.log"
case $1 in
  info) [ -n "\${FAKE_INFO_FAIL:-}" ] && { echo "$FAKE_INFO_FAIL" >&2; exit 125; }; exit 0 ;;
  image) [ -f "$ROLLOUT_HOME/image-present" ] || exit 1; [ "$2 $3" = "inspect --format" ] && echo "[\"\${FAKE_REPODIGEST:-}\"]"; exit 0 ;;
  pull) [ -n "\${FAKE_PULL_FAIL:-}" ] && exit 1; : > "$ROLLOUT_HOME/image-present"; exit 0 ;;
  rmi) [ -n "\${FAKE_RMI_FAIL:-}" ] && { echo "image is in use" >&2; exit 2; }; rm -f "$ROLLOUT_HOME/image-present"; exit 0 ;;
  tag) exit 0 ;;
esac
exit 0
`;

let counter = 0;
function makeHome() {
  counter += 1;
  const home = path.join(work, `h${counter}`);
  for (const dir of ['bin', 'state']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  fs.copyFileSync(script, path.join(home, 'bin/rollout-run'));
  fs.chmodSync(path.join(home, 'bin/rollout-run'), 0o755);
  fs.writeFileSync(path.join(home, 'upstream.sh'), UPSTREAM, { mode: 0o755 });
  fs.mkdirSync(path.join(home, 'fakebin'));
  for (const tool of ['podman', 'docker']) fs.writeFileSync(path.join(home, 'fakebin', tool), FAKE_TOOL, { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'image-present'), '');
  return home;
}

// Feste Umgebung der Läufe: Attrappen vorn im PATH, eigener Config-Ordner (nie die echte config.toml), Zwift-Tag gesetzt.
// Eine Umgebung des Prüfrechners (ROLLOUT_ZWIFT_*, CONTAINER_TOOL, FAKE_*) wirkt nie hinein.
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ROLLOUT_(ZWIFT|CONTAINER)|FAKE_|CONTAINER_TOOL$|IMAGE$|VERSION$|DONT_UPDATE$|ZWIFT_FG$)/.test(k)));
const env = (home, extra = {}) => ({
  ...clean(), ROLLOUT_HOME: home, ROLLOUT_CONFIG_HOME: path.join(home, 'cfg'), ROLLOUT_ZWIFT_TAG: '1.2.3',
  ROLLOUT_RUN_UPSTREAM: path.join(home, 'upstream.sh'), ROLLOUT_RUN_NO_INHIBIT: '1',
  PATH: `${path.join(home, 'fakebin')}:${process.env.PATH}`, ...extra
});
const run = (sh, home, args, extra) => spawnSync(...argv(sh, path.join(home, 'bin/rollout-run'), ...args), { env: env(home, extra), encoding: 'utf8' });
const start = (sh, home, args, extra) => spawn(...argv(sh, path.join(home, 'bin/rollout-run'), ...args), { env: env(home, extra), stdio: 'ignore' });
const containers = (home) => { try { return fs.readFileSync(path.join(home, 'containers.log'), 'utf8').trim().split('\n'); } catch { return []; } };
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
    assert.equal(r.stdout.trim(), 'rollout-bootstrap 4 run');
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
  const zwiftDir = path.join(home, 'zwift/abc123');
  fs.mkdirSync(zwiftDir, { recursive: true });
  fs.copyFileSync(path.join(home, 'upstream.sh'), path.join(zwiftDir, 'zwift.sh'));
  fs.chmodSync(path.join(zwiftDir, 'zwift.sh'), 0o755);
  const bare = env(home, { RUN_MODE: 'exit 0' });
  delete bare.ROLLOUT_RUN_UPSTREAM;
  for (const app of ['mywhoosh', 'zwift']) assert.equal(spawnSync('sh', [path.join(home, 'bin/rollout-run'), app], { env: bare }).status, 0, app);
  assert.match(calls(home)[0], /args=run /);
  assert.equal(calls(home).length, 2);
});

// --- Container-Laufzeit und Zwift-Image (R9 bis R19) ---------------------------------------------------------------------------
const userLog = (home) => fs.readFileSync(path.join(home, 'user.log'), 'utf8').trim();
const envLog = (home) => fs.readFileSync(path.join(home, 'env.log'), 'utf8').trim();
// PATH ohne podman und docker des Prüfrechners: nur die Werkzeuge, die der Starter braucht, und die Shells.
function bareTools(home) {
  const dir = path.join(home, 'tools');
  if (fs.existsSync(dir)) return dir;
  fs.mkdirSync(dir);
  for (const name of ['sh', 'bash', 'dash', 'dirname', 'sed', 'ls', 'head', 'cut', 'mkdir', 'rm', 'mv', 'kill', 'cat']) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
    if (found) fs.symlinkSync(found, path.join(dir, name));
  }
  return dir;
}
const zwiftScript = (home) => {
  fs.mkdirSync(path.join(home, 'zwift/abc123'), { recursive: true });
  fs.copyFileSync(path.join(home, 'upstream.sh'), path.join(home, 'zwift/abc123/zwift.sh'));
  fs.chmodSync(path.join(home, 'zwift/abc123/zwift.sh'), 0o755);
};

for (const sh of shells) {
  test(`R9 Laufzeit (${sh}): Podman hat Vorrang vor Docker, Docker ist der Rückfall`, () => {
    const home = makeHome();
    assert.equal(run(sh, home, ['zwift'], { RUN_MODE: 'exit 0' }).status, 0);
    assert.match(envLog(home), /^tool=podman /);
    assert.deepEqual(containers(home).filter((l) => l.startsWith('docker')), [], 'Docker wird gar nicht gefragt');
    const home2 = makeHome();
    // Rückfall: podman durch eine kaputte Attrappe ersetzen.
    fs.writeFileSync(path.join(home2, 'fakebin/podman'), '#!/bin/sh\necho "podman $*" >> "$ROLLOUT_HOME/containers.log"\necho "Error: cannot find newuidmap" >&2\nexit 125\n', { mode: 0o755 });
    fs.rmSync(path.join(home2, 'env.log'), { force: true });
    assert.equal(run(sh, home2, ['zwift'], { RUN_MODE: 'exit 0' }).status, 0);
    assert.match(envLog(home2), /^tool=docker /);
  });

  test(`R10 ROLLOUT_CONTAINER_TOOL (${sh}) legt die Wahl fest, Unsinn wird abgewiesen`, () => {
    const home = makeHome();
    assert.equal(run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', ROLLOUT_CONTAINER_TOOL: 'docker' }).status, 0);
    assert.match(envLog(home), /^tool=docker /);
    const bad = run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', ROLLOUT_CONTAINER_TOOL: 'rm' });
    assert.equal(bad.status, 10);
    assert.match(bad.stderr, /muss podman oder docker sein/);
  });

  test(`R11 keine Laufzeit (${sh}): verständliche Meldung, Exit 10, nichts gestartet, keine run.pid`, () => {
    const home = makeHome();
    fs.rmSync(path.join(home, 'fakebin'), { recursive: true });
    const r = run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', PATH: bareTools(home) });
    assert.equal(r.status, 10);
    assert.match(r.stderr, /keine nutzbare Container-Laufzeit/);
    assert.match(r.stderr, /podman ist nicht installiert/);
    assert.match(r.stderr, /docker ist nicht installiert/);
    assert.match(r.stderr, /Podman \(empfohlen\) oder Docker/);
    assert.equal(calls(home).length, 0);
    assert.equal(pidFile(home), null);
    const check = run(sh, home, ['--container-check'], { PATH: path.join(home, 'tools') });
    assert.equal(check.status, 10);
    assert.equal(check.stdout, '');
  });

  test(`R12 Fehlerarten (${sh}): Rechte, Dienst und Sonstiges werden unterschieden`, () => {
    const home = makeHome();
    const cases = [
      ['permission denied while trying to connect to the Docker daemon socket', /keine Berechtigung/],
      ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', /Dienst läuft nicht/],
      ['Error: cannot find newuidmap: exec: "newuidmap": executable file not found', /subuid\/subgid/],
      ['irgendwas ging schief\nzweite Zeile', /meldet aber einen Fehler: irgendwas ging schief$/m]
    ];
    for (const [fail, pattern] of cases) {
      const r = run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', FAKE_INFO_FAIL: fail });
      assert.equal(r.status, 10, fail);
      assert.match(r.stderr, pattern, fail);
      assert.doesNotMatch(r.stderr, /zweite Zeile/);
    }
    assert.equal(calls(home).length, 0, 'bei keiner Laufzeit startet das Spiel nie');
  });

  test(`R13 Start (${sh}): zwift.sh bekommt Laufzeit, Image, DONT_UPDATE=1 und ZWIFT_FG=1, MyWhoosh bekommt nichts davon`, () => {
    const home = makeHome();
    assert.equal(run(sh, home, ['zwift'], { RUN_MODE: 'exit 0' }).status, 0);
    assert.equal(envLog(home), 'tool=podman image=docker.io/netbrain/zwift version=1.2.3 fg=1 noupdate=1');
    assert.deepEqual(containers(home).filter((l) => l.startsWith('podman pull')), [], 'vorhandenes Image wird nicht gezogen');
    const vendor = path.join(home, 'current/vendor');
    fs.mkdirSync(vendor, { recursive: true });
    fs.copyFileSync(path.join(home, 'upstream.sh'), path.join(vendor, 'mywhoosh.sh'));
    assert.equal(run(sh, home, ['mywhoosh'], { RUN_MODE: 'exit 0', PATH: bareTools(home) }).status, 0);
    assert.equal(envLog(home), 'tool= image= version= fg= noupdate=', 'MyWhoosh braucht keine Container-Laufzeit');
  });

  test(`R14 Image-Einstellung (${sh}): Tag Pflicht und nie latest, Digest streng, config.toml wird gelesen`, () => {
    const home = makeHome();
    const bad = (extra, pattern) => {
      const r = run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', ...extra });
      assert.equal(r.status, 11, JSON.stringify(extra));
      assert.match(r.stderr, pattern);
    };
    bad({ ROLLOUT_ZWIFT_TAG: '' }, /Kein Zwift-Image eingestellt/);
    bad({ ROLLOUT_ZWIFT_TAG: 'latest' }, /nie „latest“/);
    bad({ ROLLOUT_ZWIFT_TAG: '-x' }, /nicht zulässig/);
    bad({ ROLLOUT_ZWIFT_TAG: 'a b' }, /nicht zulässig/);
    bad({ ROLLOUT_ZWIFT_DIGEST: 'sha256:abc' }, /sha256:<64 Hex-Zeichen>/);
    bad({ ROLLOUT_ZWIFT_DIGEST: `md5:${'a'.repeat(64)}` }, /sha256:<64 Hex-Zeichen>/);
    bad({ ROLLOUT_ZWIFT_DIGEST: `sha256:${'G'.repeat(64)}` }, /sha256:<64 Hex-Zeichen>/);
    bad({ ROLLOUT_ZWIFT_IMAGE: '../x' }, /ROLLOUT_ZWIFT_IMAGE ist ungültig/);
    assert.equal(calls(home).length, 0);
    fs.mkdirSync(path.join(home, 'cfg'));
    fs.writeFileSync(path.join(home, 'cfg/config.toml'), 'theme = "light"\nzwift_tag = "9.8.7"  # fest\n');
    const ok = run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', ROLLOUT_ZWIFT_TAG: undefined });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(envLog(home), /version=9\.8\.7 /);
  });

  test(`R15 Image fehlt (${sh}): ohne Zustimmung nichts ziehen und nichts starten, mit Zustimmung für genau diese Angabe ziehen`, () => {
    const home = makeHome();
    fs.rmSync(path.join(home, 'image-present'));
    const no = run(sh, home, ['zwift'], { RUN_MODE: 'exit 0' });
    assert.equal(no.status, 12);
    assert.match(no.stderr, /noch nicht geladen/);
    assert.match(no.stderr, /--zwift-pull/);
    assert.deepEqual(containers(home).filter((l) => / pull /.test(l)), [], 'ohne Zustimmung kein pull');
    assert.equal(calls(home).length, 0);
    assert.equal(pidFile(home), null);
    // Zustimmung für einen anderen Tag gilt nicht.
    fs.writeFileSync(path.join(home, 'state/zwift-image-ok'), 'docker.io/netbrain/zwift:0.0.1\n');
    assert.equal(run(sh, home, ['zwift'], { RUN_MODE: 'exit 0' }).status, 12);
    fs.writeFileSync(path.join(home, 'state/zwift-image-ok'), 'docker.io/netbrain/zwift:1.2.3\n');
    assert.equal(run(sh, home, ['zwift'], { RUN_MODE: 'exit 0' }).status, 0);
    assert.ok(containers(home).includes('podman pull docker.io/netbrain/zwift:1.2.3'));
    assert.equal(calls(home).length, 1, 'danach startet das Spiel');
    // Ziehen scheitert: Exit 12, Spiel startet nicht.
    const home2 = makeHome();
    fs.rmSync(path.join(home2, 'image-present'));
    fs.writeFileSync(path.join(home2, 'state/zwift-image-ok'), 'docker.io/netbrain/zwift:1.2.3\n');
    const fail = run(sh, home2, ['zwift'], { RUN_MODE: 'exit 0', FAKE_PULL_FAIL: '1' });
    assert.equal(fail.status, 12);
    assert.match(fail.stderr, /nicht geladen werden/);
    assert.equal(calls(home2).length, 0);
  });

  test(`R16 --zwift-pull (${sh}): zieht, merkt die Zustimmung, bei Digest per Digest und mit lokalem Tag`, () => {
    const home = makeHome();
    fs.rmSync(path.join(home, 'image-present'));
    const r = run(sh, home, ['--zwift-pull'], {});
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(containers(home).filter((l) => / pull /.test(l)), ['podman pull docker.io/netbrain/zwift:1.2.3']);
    assert.equal(fs.readFileSync(path.join(home, 'state/zwift-image-ok'), 'utf8'), 'docker.io/netbrain/zwift:1.2.3\n');
    assert.equal(calls(home).length, 0, 'startet kein Spiel');
    const digest = `sha256:${'ab'.repeat(32)}`;
    const home2 = makeHome();
    fs.rmSync(path.join(home2, 'image-present'));
    const d = run(sh, home2, ['--zwift-pull'], { ROLLOUT_ZWIFT_DIGEST: digest });
    assert.equal(d.status, 0, d.stderr);
    const log = containers(home2);
    assert.ok(log.includes(`podman pull docker.io/netbrain/zwift@${digest}`));
    assert.ok(log.includes(`podman tag docker.io/netbrain/zwift@${digest} docker.io/netbrain/zwift:1.2.3`));
    assert.equal(fs.readFileSync(path.join(home2, 'state/zwift-image-ok'), 'utf8'), `docker.io/netbrain/zwift:1.2.3@${digest}\n`);
    // Fehlende Einstellung und fehlende Laufzeit liefern ihre eigenen Exit-Codes.
    assert.equal(run(sh, home2, ['--zwift-pull'], { ROLLOUT_ZWIFT_TAG: '' }).status, 11);
    assert.equal(run(sh, home2, ['--zwift-pull'], { FAKE_INFO_FAIL: 'Cannot connect' }).status, 10);
    assert.equal(run(sh, home2, ['--zwift-pull'], { FAKE_PULL_FAIL: '1' }).status, 12);
  });

  test(`R17 fester Digest (${sh}): ein lokales Image mit anderem Digest gilt als fehlend`, () => {
    const home = makeHome();
    const digest = `sha256:${'cd'.repeat(32)}`;
    const extra = { RUN_MODE: 'exit 0', ROLLOUT_ZWIFT_DIGEST: digest };
    const other = run(sh, home, ['zwift'], { ...extra, FAKE_REPODIGEST: `docker.io/netbrain/zwift@sha256:${'00'.repeat(32)}` });
    assert.equal(other.status, 12, 'falscher Digest ohne Zustimmung');
    assert.equal(calls(home).length, 0);
    const same = run(sh, home, ['zwift'], { ...extra, FAKE_REPODIGEST: `docker.io/netbrain/zwift@${digest}` });
    assert.equal(same.status, 0, same.stderr);
    assert.equal(calls(home).length, 1);
  });

  test(`R18 --zwift-status (${sh}): meldet Laufzeit, Image, Bild und Zustimmung, ohne zu ziehen oder zu starten`, () => {
    const home = makeHome();
    const lines = (r) => r.stdout.trim().split('\n');
    const a = run(sh, home, ['--zwift-status'], {});
    assert.equal(a.status, 0, a.stderr);
    assert.deepEqual(lines(a), ['runtime=podman', 'ref=docker.io/netbrain/zwift:1.2.3', 'image=present', 'consent=no']);
    fs.writeFileSync(path.join(home, 'state/zwift-image-ok'), 'docker.io/netbrain/zwift:1.2.3\n');
    fs.rmSync(path.join(home, 'image-present'));
    assert.deepEqual(lines(run(sh, home, ['--zwift-status'], {})), ['runtime=podman', 'ref=docker.io/netbrain/zwift:1.2.3', 'image=missing', 'consent=yes']);
    assert.equal(containers(home).filter((l) => / pull /.test(l)).length, 0, 'zieht nie');
    assert.equal(calls(home).length, 0, 'startet kein Spiel');
    assert.equal(pidFile(home), null);
    assert.equal(run(sh, home, ['--zwift-status'], { ROLLOUT_ZWIFT_TAG: '' }).status, 11);
    assert.equal(run(sh, home, ['--zwift-status'], { FAKE_INFO_FAIL: 'Cannot connect' }).status, 10);
    // Mit festem Digest zählt nur genau dieser.
    const digest = `sha256:${'ef'.repeat(32)}`;
    fs.writeFileSync(path.join(home, 'image-present'), '');
    const other = run(sh, home, ['--zwift-status'], { ROLLOUT_ZWIFT_DIGEST: digest, FAKE_REPODIGEST: 'x' });
    assert.match(other.stdout, /image=missing/);
    const same = run(sh, home, ['--zwift-status'], { ROLLOUT_ZWIFT_DIGEST: digest, FAKE_REPODIGEST: `docker.io/netbrain/zwift@${digest}` });
    assert.match(same.stdout, /image=present/);
  });

  test(`R19 USER (${sh}): fehlt USER, setzt der Starter es für zwift.sh (das sonst mit „unbound variable“ abbricht); ein vorhandenes bleibt`, () => {
    const home = makeHome();
    zwiftScript(home);
    assert.equal(run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', USER: undefined }).status, 0);
    assert.equal(userLog(home), os.userInfo().username);
    assert.equal(run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', USER: 'fahrer' }).status, 0);
    assert.equal(userLog(home), 'fahrer');
  });

  test(`R20 --zwift-remove (${sh}): rmi für genau Image:Tag, Zustimmung vergessen, ohne Image ebenfalls Erfolg, Fehler als Exit 10, 11, 13`, () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'state/zwift-image-ok'), 'docker.io/netbrain/zwift:1.2.3\n');
    const a = run(sh, home, ['--zwift-remove'], {});
    assert.equal(a.status, 0, a.stderr);
    assert.ok(containers(home).includes('podman rmi docker.io/netbrain/zwift:1.2.3'));
    assert.equal(fs.existsSync(path.join(home, 'image-present')), false);
    assert.equal(fs.existsSync(path.join(home, 'state/zwift-image-ok')), false);
    const again = run(sh, home, ['--zwift-remove'], {});
    assert.equal(again.status, 0);
    assert.equal(containers(home).filter((l) => / rmi /.test(l)).length, 1, 'ohne Image kein rmi');
    const busy = makeHome();
    fs.writeFileSync(path.join(busy, 'state/zwift-image-ok'), 'x\n');
    const failed = run(sh, busy, ['--zwift-remove'], { FAKE_RMI_FAIL: '1' });
    assert.equal(failed.status, 13);
    assert.match(failed.stderr, /konnte nicht entfernt werden/);
    assert.equal(fs.existsSync(path.join(busy, 'image-present')), true);
    assert.equal(fs.existsSync(path.join(busy, 'state/zwift-image-ok')), true, 'bei Fehler bleibt die Zustimmung');
    assert.equal(run(sh, makeHome(), ['--zwift-remove'], { FAKE_INFO_FAIL: 'Cannot connect' }).status, 10);
    assert.equal(run(sh, makeHome(), ['--zwift-remove'], { ROLLOUT_ZWIFT_TAG: '' }).status, 11);
    assert.equal(calls(home).length, 0, 'startet kein Spiel');
    assert.equal(pidFile(home), null);
  });

  test(`--container-check (${sh}) nennt die Laufzeit auf stdout`, () => {
    const home = makeHome();
    const r = run(sh, home, ['--container-check'], {});
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'podman\n');
    assert.equal(calls(home).length, 0);
    assert.equal(pidFile(home), null);
  });
}

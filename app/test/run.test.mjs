// Checks the game starter scripts/bin-rollout-run.sh (R1 to R39) in throwaway directories, with bash, `bash --posix` and, if present, dash.
// The upstream is a shell script (ROLLOUT_RUN_UPSTREAM) that reads its behaviour from RUN_MODE and logs to calls.log.
// Podman and Docker are fakes on PATH (fakebin/) that write their calls to containers.log: a real container is never started.
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
if (!shells.includes('dash')) console.log('# dash missing, R1 to R6 run only with bash and bash --posix');
const argv = (sh, ...rest) => [sh.split(' ')[0], [...sh.split(' ').slice(1), ...rest]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UPSTREAM = `#!/bin/sh
echo "\${USER-}" > "$ROLLOUT_HOME/user.log"
echo "tool=$CONTAINER_TOOL image=$IMAGE version=$VERSION fg=\${ZWIFT_FG-} noupdate=\${DONT_UPDATE-}" > "$ROLLOUT_HOME/env.log"
echo "extra=\${CONTAINER_EXTRA_ARGS-unset}" > "$ROLLOUT_HOME/extra.log"
echo "start args=$* preload=\${LD_PRELOAD+set} libpath=\${LD_LIBRARY_PATH+set} pidfile=$(cat "$ROLLOUT_HOME/state/run.pid" 2>/dev/null) parent=$PPID" >> "$ROLLOUT_HOME/calls.log"
case $RUN_MODE in
  exit*) exit "\${RUN_MODE#exit }" ;;
  wait) : > "$ROLLOUT_HOME/started"; sleep 20 >/dev/null 2>&1 & s=$!; wait $s ;;
  talk) echo "out line"; echo "err line" >&2; exit 3 ;;
  termtalk) echo "before term"; sleep 20 >/dev/null 2>&1 & s=$!; trap 'kill $s; echo "after term"; exit 42' TERM; : > "$ROLLOUT_HOME/started"; wait $s ;;
  term42) sleep 20 >/dev/null 2>&1 & s=$!; trap 'kill $s; echo term >> "$ROLLOUT_HOME/calls.log"; exit 42' TERM; : > "$ROLLOUT_HOME/started"; wait $s ;;
esac
`;

// Fake for podman and docker. FAKE_INFO_FAIL (message) makes `info` fail, FAKE_PULL_FAIL=1 makes `pull` fail,
// FAKE_REPODIGEST is the digest the local image reports. The image counts as pulled as long as the file image-present exists.
const FAKE_TOOL = `#!/bin/sh
name=\${0##*/}
echo "$name $*" >> "$ROLLOUT_HOME/containers.log"
case $1 in
  info) [ -n "\${FAKE_INFO_FAIL:-}" ] && { echo "$FAKE_INFO_FAIL" >&2; exit 125; }; exit 0 ;;
  image) [ -f "$ROLLOUT_HOME/image-present" ] || exit 1; [ "$2 $3" = "inspect --format" ] && echo "[\"\${FAKE_REPODIGEST:-}\"]"; exit 0 ;;
  pull) [ -n "\${FAKE_PULL_FAIL:-}" ] && exit 1; : > "$ROLLOUT_HOME/image-present"; exit 0 ;;
  rmi) [ -n "\${FAKE_RMI_FAIL:-}" ] && { echo "image is in use" >&2; exit 2; }; rm -f "$ROLLOUT_HOME/image-present"; exit 0 ;;
  tag) exit 0 ;;
  ps) [ -f "$ROLLOUT_HOME/running" ] && echo abc123; exit 0 ;;
  exec) case "$*" in
    *"taskkill /f "*) [ -z "\${FAKE_FORCE_IGNORED:-}" ] && rm -f "$ROLLOUT_HOME/running" ;;
    *"taskkill /im"*) [ -n "\${FAKE_POLITE_KILLS:-}" ] && rm -f "$ROLLOUT_HOME/running" ;;
  esac; exit 0 ;;
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

// Fixed environment of the runs: fakes at the front of PATH, own config directory (never the real config.toml), Zwift tag set.
// An environment of the test machine (ROLLOUT_ZWIFT_*, CONTAINER_TOOL, FAKE_*) never leaks in.
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ROLLOUT_(ZWIFT|CONTAINER)|FAKE_|CONTAINER_TOOL$|CONTAINER_EXTRA_ARGS$|IMAGE$|VERSION$|DONT_UPDATE$|ZWIFT_FG$)/.test(k)));
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
  test(`R1 Start (${sh}): environment cleaned, run.pid names the starter, exit code and cleanup`, () => {
    const home = makeHome();
    const r = run(sh, home, ['mywhoosh', '--demo'], { RUN_MODE: 'exit 7', LD_PRELOAD: '/x.so', LD_LIBRARY_PATH: '/x' });
    assert.equal(r.status, 7);
    const [line] = calls(home);
    const m = /args=run --demo preload= libpath= pidfile=(\d+) parent=(\d+)$/.exec(line);
    assert.ok(m, line);
    assert.equal(m[1], m[2], 'run.pid names the starter, the parent process of the upstream');
    assert.equal(pidFile(home), null, 'run.pid gone after the end');
    const zwift = run(sh, home, ['zwift', '-x'], { RUN_MODE: 'exit 0' });
    assert.equal(zwift.status, 0);
    assert.match(calls(home)[1], /args=-x preload=/);
  });

  test(`R2 second instance (${sh}) is rejected, the first keeps run.pid`, async () => {
    const home = makeHome();
    const first = start(sh, home, ['zwift'], { RUN_MODE: 'wait' });
    assert.ok(await until(() => fs.existsSync(path.join(home, 'started'))), 'first instance is running');
    const pid = pidFile(home);
    assert.match(pid, /^\d+$/);
    const second = run(sh, home, ['mywhoosh'], { RUN_MODE: 'exit 0' });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already running/);
    assert.equal(pidFile(home), pid, 'run.pid of the first instance stays');
    assert.equal(calls(home).length, 1, 'the second starts nothing');
    first.kill('SIGTERM');
    await exited(first);
    assert.equal(pidFile(home), null);
  });

  test(`R3 stale run.pid (${sh}) is replaced`, () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'state/run.pid'), '999999999\n');
    const r = run(sh, home, ['zwift'], { RUN_MODE: 'exit 0' });
    assert.equal(r.status, 0);
    assert.match(calls(home)[0], /pidfile=\d+ /);
    assert.notEqual(calls(home)[0].match(/pidfile=(\d+)/)[1], '999999999');
    assert.equal(pidFile(home), null);
  });

  test(`R4 TERM reaches the game (${sh}), its exit code is kept, run.pid disappears`, async () => {
    const home = makeHome();
    const child = start(sh, home, ['zwift'], { RUN_MODE: 'term42' });
    assert.ok(await until(() => fs.existsSync(path.join(home, 'started'))));
    child.kill('SIGTERM');
    assert.equal(await exited(child), 42);
    assert.ok(calls(home).includes('term'));
    assert.equal(pidFile(home), null);
  });

  test(`R5 unknown app and missing upstream (${sh}) start nothing and leave no run.pid`, () => {
    const home = makeHome();
    const unknown = run(sh, home, ['nichts'], { RUN_MODE: 'exit 0' });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Usage: rollout-run/);
    const missing = run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', ROLLOUT_RUN_UPSTREAM: path.join(home, 'does-not-exist') });
    assert.equal(missing.status, 127);
    assert.match(missing.stderr, /not installed/);
    assert.equal(run(sh, home, ['mywhoosh'], { RUN_MODE: 'exit 0', ROLLOUT_RUN_UPSTREAM: '' }).status, 127, 'without vendor/mywhoosh.sh');
    assert.equal(calls(home).length, 0);
    assert.equal(pidFile(home), null);
  });

  test(`R6 self-test (${sh}) names the number and starts nothing`, () => {
    const home = makeHome();
    const r = run(sh, home, ['--bootstrap-selftest'], { RUN_MODE: 'exit 0' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'rollout-bootstrap 9 run');
    assert.equal(calls(home).length, 0);
    assert.equal(pidFile(home), null);
  });

  test(`Syntax check (${sh} -n)`, () => {
    const [cmd, args] = argv(sh, '-n', script);
    assert.equal(spawnSync(cmd, args).status, 0);
  });
}

// systemd-inhibit as a fake on PATH: R8 checks that the inhibitor is used and that a failure of the inhibitor does not prevent the game.
for (const sh of shells) {
  test(`R8 screen inhibitor (${sh}): used when it works, skipped when it is refused`, () => {
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
    assert.equal(run(sh, home, ['zwift'], extra).status, 4, 'game runs despite a refused inhibitor, its exit code is kept');
    assert.deepEqual(calls(home).filter((l) => l.startsWith('start ')).length, 1);
    assert.equal(pidFile(home), null);
  });
}

test('R7 mywhoosh and zwift find their upstream without an override', () => {
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

// --- Container runtime and Zwift image (R9 to R19) ---------------------------------------------------------------------------
const userLog = (home) => fs.readFileSync(path.join(home, 'user.log'), 'utf8').trim();
const envLog = (home) => fs.readFileSync(path.join(home, 'env.log'), 'utf8').trim();
// PATH without the test machine's podman and docker: only the tools the starter needs, and the shells.
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
  test(`R9 runtime (${sh}): Podman takes precedence over Docker, Docker is the fallback`, () => {
    const home = makeHome();
    assert.equal(run(sh, home, ['zwift'], { RUN_MODE: 'exit 0' }).status, 0);
    assert.match(envLog(home), /^tool=podman /);
    assert.deepEqual(containers(home).filter((l) => l.startsWith('docker')), [], 'Docker is not even asked');
    const home2 = makeHome();
    // Fallback: replace podman with a broken fake.
    fs.writeFileSync(path.join(home2, 'fakebin/podman'), '#!/bin/sh\necho "podman $*" >> "$ROLLOUT_HOME/containers.log"\necho "Error: cannot find newuidmap" >&2\nexit 125\n', { mode: 0o755 });
    fs.rmSync(path.join(home2, 'env.log'), { force: true });
    assert.equal(run(sh, home2, ['zwift'], { RUN_MODE: 'exit 0' }).status, 0);
    assert.match(envLog(home2), /^tool=docker /);
  });

  test(`R10 ROLLOUT_CONTAINER_TOOL (${sh}) fixes the choice, nonsense is rejected`, () => {
    const home = makeHome();
    assert.equal(run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', ROLLOUT_CONTAINER_TOOL: 'docker' }).status, 0);
    assert.match(envLog(home), /^tool=docker /);
    const bad = run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', ROLLOUT_CONTAINER_TOOL: 'rm' });
    assert.equal(bad.status, 10);
    assert.match(bad.stderr, /must be podman or docker/);
  });

  test(`R11 no runtime (${sh}): understandable message, exit 10, nothing started, no run.pid`, () => {
    const home = makeHome();
    fs.rmSync(path.join(home, 'fakebin'), { recursive: true });
    const r = run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', PATH: bareTools(home) });
    assert.equal(r.status, 10);
    assert.match(r.stderr, /no usable container runtime/);
    assert.match(r.stderr, /podman is not installed/);
    assert.match(r.stderr, /docker is not installed/);
    assert.match(r.stderr, /Podman \(recommended\) or Docker/);
    assert.equal(calls(home).length, 0);
    assert.equal(pidFile(home), null);
    const check = run(sh, home, ['--container-check'], { PATH: path.join(home, 'tools') });
    assert.equal(check.status, 10);
    assert.equal(check.stdout, '');
  });

  test(`R12 error kinds (${sh}): permissions, service and other are told apart`, () => {
    const home = makeHome();
    const cases = [
      ['permission denied while trying to connect to the Docker daemon socket', /no permission/],
      ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', /service is not running/],
      ['Error: cannot find newuidmap: exec: "newuidmap": executable file not found', /subuid\/subgid/],
      ['something went wrong\nsecond line', /reports an error: something went wrong$/m]
    ];
    for (const [fail, pattern] of cases) {
      const r = run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', FAKE_INFO_FAIL: fail });
      assert.equal(r.status, 10, fail);
      assert.match(r.stderr, pattern, fail);
      assert.doesNotMatch(r.stderr, /zweite Zeile/);
    }
    assert.equal(calls(home).length, 0, 'with no runtime the game never starts');
  });

  test(`R13 Start (${sh}): zwift.sh gets runtime, image, DONT_UPDATE=1 and ZWIFT_FG=1, MyWhoosh gets none of it`, () => {
    const home = makeHome();
    assert.equal(run(sh, home, ['zwift'], { RUN_MODE: 'exit 0' }).status, 0);
    assert.equal(envLog(home), 'tool=podman image=docker.io/netbrain/zwift version=1.2.3 fg=1 noupdate=1');
    assert.deepEqual(containers(home).filter((l) => l.startsWith('podman pull')), [], 'existing image is not pulled');
    const vendor = path.join(home, 'current/vendor');
    fs.mkdirSync(vendor, { recursive: true });
    fs.copyFileSync(path.join(home, 'upstream.sh'), path.join(vendor, 'mywhoosh.sh'));
    assert.equal(run(sh, home, ['mywhoosh'], { RUN_MODE: 'exit 0', PATH: bareTools(home) }).status, 0);
    assert.equal(envLog(home), 'tool= image= version= fg= noupdate=', 'MyWhoosh needs no container runtime');
  });

  test(`R14 image setting (${sh}): tag mandatory and never latest, digest strict, config.toml is read`, () => {
    const home = makeHome();
    const bad = (extra, pattern) => {
      const r = run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', ...extra });
      assert.equal(r.status, 11, JSON.stringify(extra));
      assert.match(r.stderr, pattern);
    };
    bad({ ROLLOUT_ZWIFT_TAG: '' }, /No Zwift image configured/);
    bad({ ROLLOUT_ZWIFT_TAG: 'latest' }, /never "latest"/);
    bad({ ROLLOUT_ZWIFT_TAG: '-x' }, /not allowed/);
    bad({ ROLLOUT_ZWIFT_TAG: 'a b' }, /not allowed/);
    bad({ ROLLOUT_ZWIFT_DIGEST: 'sha256:abc' }, /sha256:<64 hex characters>/);
    bad({ ROLLOUT_ZWIFT_DIGEST: `md5:${'a'.repeat(64)}` }, /sha256:<64 hex characters>/);
    bad({ ROLLOUT_ZWIFT_DIGEST: `sha256:${'G'.repeat(64)}` }, /sha256:<64 hex characters>/);
    bad({ ROLLOUT_ZWIFT_IMAGE: '../x' }, /ROLLOUT_ZWIFT_IMAGE is invalid/);
    assert.equal(calls(home).length, 0);
    fs.mkdirSync(path.join(home, 'cfg'));
    fs.writeFileSync(path.join(home, 'cfg/config.toml'), 'theme = "light"\nzwift_tag = "9.8.7"  # fest\n');
    const ok = run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', ROLLOUT_ZWIFT_TAG: undefined });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(envLog(home), /version=9\.8\.7 /);
  });

  test(`R15 image missing (${sh}): without consent pull nothing and start nothing, with consent pull exactly this reference`, () => {
    const home = makeHome();
    fs.rmSync(path.join(home, 'image-present'));
    const no = run(sh, home, ['zwift'], { RUN_MODE: 'exit 0' });
    assert.equal(no.status, 12);
    assert.match(no.stderr, /has not been pulled yet/);
    assert.match(no.stderr, /--zwift-pull/);
    assert.deepEqual(containers(home).filter((l) => / pull /.test(l)), [], 'no pull without consent');
    assert.equal(calls(home).length, 0);
    assert.equal(pidFile(home), null);
    // Consent for a different tag does not count.
    fs.writeFileSync(path.join(home, 'state/zwift-image-ok'), 'docker.io/netbrain/zwift:0.0.1\n');
    assert.equal(run(sh, home, ['zwift'], { RUN_MODE: 'exit 0' }).status, 12);
    fs.writeFileSync(path.join(home, 'state/zwift-image-ok'), 'docker.io/netbrain/zwift:1.2.3\n');
    assert.equal(run(sh, home, ['zwift'], { RUN_MODE: 'exit 0' }).status, 0);
    assert.ok(containers(home).includes('podman pull docker.io/netbrain/zwift:1.2.3'));
    assert.equal(calls(home).length, 1, 'afterwards the game starts');
    // Pull fails: exit 12, the game does not start.
    const home2 = makeHome();
    fs.rmSync(path.join(home2, 'image-present'));
    fs.writeFileSync(path.join(home2, 'state/zwift-image-ok'), 'docker.io/netbrain/zwift:1.2.3\n');
    const fail = run(sh, home2, ['zwift'], { RUN_MODE: 'exit 0', FAKE_PULL_FAIL: '1' });
    assert.equal(fail.status, 12);
    assert.match(fail.stderr, /could not be pulled/);
    assert.equal(calls(home2).length, 0);
  });

  test(`R16 --zwift-pull (${sh}): pulls, remembers the consent, by digest when a digest is set and with a local tag`, () => {
    const home = makeHome();
    fs.rmSync(path.join(home, 'image-present'));
    const r = run(sh, home, ['--zwift-pull'], {});
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(containers(home).filter((l) => / pull /.test(l)), ['podman pull docker.io/netbrain/zwift:1.2.3']);
    assert.equal(fs.readFileSync(path.join(home, 'state/zwift-image-ok'), 'utf8'), 'docker.io/netbrain/zwift:1.2.3\n');
    assert.equal(calls(home).length, 0, 'starts no game');
    const digest = `sha256:${'ab'.repeat(32)}`;
    const home2 = makeHome();
    fs.rmSync(path.join(home2, 'image-present'));
    const d = run(sh, home2, ['--zwift-pull'], { ROLLOUT_ZWIFT_DIGEST: digest });
    assert.equal(d.status, 0, d.stderr);
    const log = containers(home2);
    assert.ok(log.includes(`podman pull docker.io/netbrain/zwift@${digest}`));
    assert.ok(log.includes(`podman tag docker.io/netbrain/zwift@${digest} docker.io/netbrain/zwift:1.2.3`));
    assert.equal(fs.readFileSync(path.join(home2, 'state/zwift-image-ok'), 'utf8'), `docker.io/netbrain/zwift:1.2.3@${digest}\n`);
    // Missing setting and missing runtime return their own exit codes.
    assert.equal(run(sh, home2, ['--zwift-pull'], { ROLLOUT_ZWIFT_TAG: '' }).status, 11);
    assert.equal(run(sh, home2, ['--zwift-pull'], { FAKE_INFO_FAIL: 'Cannot connect' }).status, 10);
    assert.equal(run(sh, home2, ['--zwift-pull'], { FAKE_PULL_FAIL: '1' }).status, 12);
  });

  test(`R17 fixed digest (${sh}): a local image with a different digest counts as missing`, () => {
    const home = makeHome();
    const digest = `sha256:${'cd'.repeat(32)}`;
    const extra = { RUN_MODE: 'exit 0', ROLLOUT_ZWIFT_DIGEST: digest };
    const other = run(sh, home, ['zwift'], { ...extra, FAKE_REPODIGEST: `docker.io/netbrain/zwift@sha256:${'00'.repeat(32)}` });
    assert.equal(other.status, 12, 'wrong digest without consent');
    assert.equal(calls(home).length, 0);
    const same = run(sh, home, ['zwift'], { ...extra, FAKE_REPODIGEST: `docker.io/netbrain/zwift@${digest}` });
    assert.equal(same.status, 0, same.stderr);
    assert.equal(calls(home).length, 1);
  });

  test(`R18 --zwift-status (${sh}): reports runtime, image and consent without pulling or starting`, () => {
    const home = makeHome();
    const lines = (r) => r.stdout.trim().split('\n');
    const a = run(sh, home, ['--zwift-status'], {});
    assert.equal(a.status, 0, a.stderr);
    assert.deepEqual(lines(a), ['runtime=podman', 'ref=docker.io/netbrain/zwift:1.2.3', 'image=present', 'consent=no']);
    fs.writeFileSync(path.join(home, 'state/zwift-image-ok'), 'docker.io/netbrain/zwift:1.2.3\n');
    fs.rmSync(path.join(home, 'image-present'));
    assert.deepEqual(lines(run(sh, home, ['--zwift-status'], {})), ['runtime=podman', 'ref=docker.io/netbrain/zwift:1.2.3', 'image=missing', 'consent=yes']);
    assert.equal(containers(home).filter((l) => / pull /.test(l)).length, 0, 'never pulls');
    assert.equal(calls(home).length, 0, 'starts no game');
    assert.equal(pidFile(home), null);
    assert.equal(run(sh, home, ['--zwift-status'], { ROLLOUT_ZWIFT_TAG: '' }).status, 11);
    assert.equal(run(sh, home, ['--zwift-status'], { FAKE_INFO_FAIL: 'Cannot connect' }).status, 10);
    // With a fixed digest only exactly that one counts.
    const digest = `sha256:${'ef'.repeat(32)}`;
    fs.writeFileSync(path.join(home, 'image-present'), '');
    const other = run(sh, home, ['--zwift-status'], { ROLLOUT_ZWIFT_DIGEST: digest, FAKE_REPODIGEST: 'x' });
    assert.match(other.stdout, /image=missing/);
    const same = run(sh, home, ['--zwift-status'], { ROLLOUT_ZWIFT_DIGEST: digest, FAKE_REPODIGEST: `docker.io/netbrain/zwift@${digest}` });
    assert.match(same.stdout, /image=present/);
  });

  test(`R19 USER (${sh}): if USER is missing, the starter sets it for zwift.sh (which otherwise aborts with "unbound variable"); an existing one stays`, () => {
    const home = makeHome();
    zwiftScript(home);
    assert.equal(run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', USER: undefined }).status, 0);
    assert.equal(userLog(home), os.userInfo().username);
    assert.equal(run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', USER: 'fahrer' }).status, 0);
    assert.equal(userLog(home), 'fahrer');
  });

  test(`R20 --zwift-remove (${sh}): rmi for exactly image:tag, consent forgotten, success without an image too, errors as exit 10, 11, 13`, () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'state/zwift-image-ok'), 'docker.io/netbrain/zwift:1.2.3\n');
    const a = run(sh, home, ['--zwift-remove'], {});
    assert.equal(a.status, 0, a.stderr);
    assert.ok(containers(home).includes('podman rmi docker.io/netbrain/zwift:1.2.3'));
    assert.equal(fs.existsSync(path.join(home, 'image-present')), false);
    assert.equal(fs.existsSync(path.join(home, 'state/zwift-image-ok')), false);
    const again = run(sh, home, ['--zwift-remove'], {});
    assert.equal(again.status, 0);
    assert.equal(containers(home).filter((l) => / rmi /.test(l)).length, 1, 'without image no rmi');
    const busy = makeHome();
    fs.writeFileSync(path.join(busy, 'state/zwift-image-ok'), 'x\n');
    const failed = run(sh, busy, ['--zwift-remove'], { FAKE_RMI_FAIL: '1' });
    assert.equal(failed.status, 13);
    assert.match(failed.stderr, /could not be removed/);
    assert.equal(fs.existsSync(path.join(busy, 'image-present')), true);
    assert.equal(fs.existsSync(path.join(busy, 'state/zwift-image-ok')), true, 'on error the consent stays');
    assert.equal(run(sh, makeHome(), ['--zwift-remove'], { FAKE_INFO_FAIL: 'Cannot connect' }).status, 10);
    assert.equal(run(sh, makeHome(), ['--zwift-remove'], { ROLLOUT_ZWIFT_TAG: '' }).status, 11);
    assert.equal(calls(home).length, 0, 'starts no game');
    assert.equal(pidFile(home), null);
  });

  test(`R21 Quit (${sh}): TERM stops the Zwift container by name (zwift-<ZWIFT_RIDER or USER>), MyWhoosh and an early abort stop nothing`, async () => {
    const home = makeHome();
    zwiftScript(home);
    const child = start(sh, home, ['zwift'], { RUN_MODE: 'wait', USER: 'fahrer' });
    assert.ok(await until(() => fs.existsSync(path.join(home, 'started'))), 'game is running');
    assert.equal(containers(home).filter((l) => / stop /.test(l)).length, 0);
    child.kill('SIGTERM');
    await exited(child);
    assert.deepEqual(containers(home).filter((l) => / stop /.test(l)), ['podman stop -t 10 zwift-fahrer']);
    assert.equal(pidFile(home), null);
    const home2 = makeHome();
    zwiftScript(home2);
    const rider = start(sh, home2, ['zwift'], { RUN_MODE: 'wait', USER: 'fahrer', ZWIFT_RIDER: 'rollouttest' });
    assert.ok(await until(() => fs.existsSync(path.join(home2, 'started'))));
    rider.kill('SIGTERM');
    await exited(rider);
    assert.deepEqual(containers(home2).filter((l) => / stop /.test(l)), ['podman stop -t 10 zwift-rollouttest']);
    // MyWhoosh has no container: no stop.
    const home3 = makeHome();
    const vendor = path.join(home3, 'current/vendor');
    fs.mkdirSync(vendor, { recursive: true });
    fs.copyFileSync(path.join(home3, 'upstream.sh'), path.join(vendor, 'mywhoosh.sh'));
    fs.chmodSync(path.join(vendor, 'mywhoosh.sh'), 0o755);
    const bare = env(home3, { RUN_MODE: 'wait' });
    delete bare.ROLLOUT_RUN_UPSTREAM;
    const mw = spawn(...argv(sh, path.join(home3, 'bin/rollout-run'), 'mywhoosh'), { env: bare, stdio: 'ignore' });
    assert.ok(await until(() => fs.existsSync(path.join(home3, 'started'))));
    mw.kill('SIGTERM');
    await exited(mw);
    assert.equal(containers(home3).filter((l) => / stop /.test(l)).length, 0);
  });

  test(`--container-check (${sh}) names the runtime on stdout`, () => {
    const home = makeHome();
    const r = run(sh, home, ['--container-check'], {});
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'podman\n');
    assert.equal(calls(home).length, 0);
    assert.equal(pidFile(home), null);
  });
}

// --- MyWhoosh via rollout-run (R30 to R33) -------------------------------------------------------------------------------------
// No real MyWhoosh: the upstream is the fake upstream.sh, HOME points to a throwaway directory (the edition detection reads ~/Games).
function mywhooshHome(edition) {
  const home = makeHome();
  const fakeHome = path.join(home, 'userhome');
  if (edition) {
    fs.mkdirSync(path.join(fakeHome, 'Games', edition === 'hd' ? 'mywhoosh-hd-linux' : 'mywhoosh-linux'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, 'Games', edition === 'hd' ? 'mywhoosh-hd-linux' : 'mywhoosh-linux', 'edition'), `${edition === 'hd' ? 'hd' : 'standard'}\n`);
  } else fs.mkdirSync(fakeHome, { recursive: true });
  return { home, extra: { HOME: fakeHome, MYWHOOSH_ROOT: undefined } };
}
const argsOf = (home) => calls(home).map((l) => /args=(.*?) preload=/.exec(l)?.[1]);

for (const sh of shells) {
  test(`R30 --mywhoosh (${sh}): install, update and uninstall run through the upstream, without run.pid; --hd only for an HD-only installation; unknown action is exit 2`, () => {
    const std = mywhooshHome('standard');
    for (const act of ['install', 'update', 'uninstall']) assert.equal(run(sh, std.home, ['--mywhoosh', act], { RUN_MODE: 'exit 0', ...std.extra }).status, 0, act);
    assert.deepEqual(argsOf(std.home), ['install', 'update', 'uninstall']);
    assert.ok(calls(std.home).every((l) => /pidfile= /.test(l)), 'setup does not take run.pid');
    assert.equal(pidFile(std.home), null);
    const hd = mywhooshHome('hd');
    for (const act of ['update', 'uninstall']) run(sh, hd.home, ['--mywhoosh', act], { RUN_MODE: 'exit 0', ...hd.extra });
    run(sh, hd.home, ['--mywhoosh', 'install', '--hd'], { RUN_MODE: 'exit 0', ...hd.extra });
    run(sh, hd.home, ['mywhoosh'], { RUN_MODE: 'exit 0', ...hd.extra });
    assert.deepEqual(argsOf(hd.home), ['update --hd', 'uninstall --hd', 'install --hd', 'run --hd']);
    const none = mywhooshHome();
    run(sh, none.home, ['mywhoosh'], { RUN_MODE: 'exit 0', ...none.extra });
    run(sh, none.home, ['--mywhoosh', 'install'], { RUN_MODE: 'exit 0', ...none.extra });
    assert.deepEqual(argsOf(none.home), ['run', 'install']);
    const bad = run(sh, none.home, ['--mywhoosh', 'doctor'], { RUN_MODE: 'exit 0', ...none.extra });
    assert.equal(bad.status, 2);
    assert.equal(run(sh, none.home, ['--mywhoosh'], { RUN_MODE: 'exit 0', ...none.extra }).status, 2);
    assert.equal(calls(none.home).length, 2, 'unbekannte Aktion startet nichts');
  });

  test(`R31 --mywhoosh (${sh}): the script's exit code comes through, missing upstream is 127, a running game blocks setup (exit 1)`, () => {
    const m = mywhooshHome('standard');
    assert.equal(run(sh, m.home, ['--mywhoosh', 'install'], { RUN_MODE: 'exit 7', ...m.extra }).status, 7);
    assert.equal(run(sh, m.home, ['--mywhoosh', 'update'], { RUN_MODE: 'exit 0', ROLLOUT_RUN_UPSTREAM: '', ...m.extra }).status, 127, 'without vendor/mywhoosh.sh');
    // A live process in run.pid (here this test itself) means: a game is running.
    fs.writeFileSync(path.join(m.home, 'state/run.pid'), `${process.pid}\n`);
    const before = calls(m.home).length;
    const busy = run(sh, m.home, ['--mywhoosh', 'uninstall'], { RUN_MODE: 'exit 0', ...m.extra });
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /an app is already running/);
    assert.equal(calls(m.home).length, before, 'uninstall was not started');
    assert.equal(pidFile(m.home), String(process.pid), 'fremde run.pid bleibt');
  });
}

// Quit: TERM goes to the game's whole session (Wine and helpers are not tied to the script), whatever ignores TERM gets KILL later.
const TREE_UPSTREAM = `#!/bin/sh
case $RUN_MODE in
  tree) sleep 30 >/dev/null 2>&1 & echo $! > "$ROLLOUT_HOME/child.pid"; : > "$ROLLOUT_HOME/started"; wait ;;
  stubborn) trap '' TERM; sleep 30 >/dev/null 2>&1 & echo $! > "$ROLLOUT_HOME/child.pid"; : > "$ROLLOUT_HOME/started"; while :; do sleep 1; done ;;
esac
`;
const alivePid = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const hasSetsid = spawnSync('setsid', ['--version']).status === 0;
for (const sh of shells) {
  test(`R32 Quitting MyWhoosh (${sh}): TERM also hits the script's grandchildren, no orphans, run.pid gone`, { skip: !hasSetsid && 'setsid missing' }, async () => {
    const m = mywhooshHome('standard');
    fs.writeFileSync(path.join(m.home, 'upstream.sh'), TREE_UPSTREAM, { mode: 0o755 });
    const child = start(sh, m.home, ['mywhoosh'], { RUN_MODE: 'tree', ...m.extra });
    assert.ok(await until(() => fs.existsSync(path.join(m.home, 'started'))), 'game is running');
    const grandchild = Number(fs.readFileSync(path.join(m.home, 'child.pid'), 'utf8'));
    assert.ok(alivePid(grandchild));
    child.kill('SIGTERM');
    assert.equal(await exited(child), 143);
    assert.ok(await until(() => !alivePid(grandchild), 3000), 'grandchild is gone');
    assert.equal(pidFile(m.home), null);
  });

  test(`R33 Quitting MyWhoosh (${sh}): whatever ignores TERM gets KILL after ROLLOUT_RUN_KILL_AFTER s; the starter ends only then`, { skip: !hasSetsid && 'setsid missing' }, async () => {
    const m = mywhooshHome('standard');
    fs.writeFileSync(path.join(m.home, 'upstream.sh'), TREE_UPSTREAM, { mode: 0o755 });
    const child = start(sh, m.home, ['mywhoosh'], { RUN_MODE: 'stubborn', ROLLOUT_RUN_KILL_AFTER: '1', ...m.extra });
    assert.ok(await until(() => fs.existsSync(path.join(m.home, 'started'))));
    const grandchild = Number(fs.readFileSync(path.join(m.home, 'child.pid'), 'utf8'));
    const t0 = Date.now();
    child.kill('SIGTERM');
    const code = await exited(child);
    assert.ok(code === 137 || code === 143 || code === 'SIGKILL' || code > 128, `Exit ${code}`);
    assert.ok(Date.now() - t0 >= 900, 'only after the deadline');
    assert.ok(await until(() => !alivePid(grandchild), 3000), 'grandchild is gone');
    assert.equal(pidFile(m.home), null);
  });
}

// --- Hide the gamepad from MyWhoosh (R34) ---------------------------------------------------------------------------------------
test('R34 MyWhoosh: the Steam gamepad is hidden from Wine, but only with xdotool, never with ROLLOUT_MYWHOOSH_PAD=off, a user-set value wins; Zwift and setup stay untouched', () => {
  const probe = (home, extra) => {
    fs.writeFileSync(path.join(home, 'upstream.sh'), '#!/bin/sh\necho "sdl=${SDL_GAMECONTROLLER_IGNORE_DEVICES-unset}" >> "$ROLLOUT_HOME/sdl.log"\n', { mode: 0o755 });
    return extra;
  };
  const sdl = (home) => fs.readFileSync(path.join(home, 'sdl.log'), 'utf8').trim().split('\n');
  const withXdotool = (home) => { fs.writeFileSync(path.join(home, 'fakebin/xdotool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); };
  const m = mywhooshHome('standard');
  withXdotool(m.home);
  probe(m.home);
  assert.equal(run('bash', m.home, ['mywhoosh'], { ...m.extra, SDL_GAMECONTROLLER_IGNORE_DEVICES: undefined }).status, 0);
  run('bash', m.home, ['mywhoosh'], { ...m.extra, ROLLOUT_MYWHOOSH_PAD: 'off' });
  run('bash', m.home, ['mywhoosh'], { ...m.extra, SDL_GAMECONTROLLER_IGNORE_DEVICES: '0x1/0x2' });
  run('bash', m.home, ['--mywhoosh', 'update'], m.extra);
  assert.deepEqual(sdl(m.home), ['sdl=0x045e/0x028e', 'sdl=unset', 'sdl=0x1/0x2', 'sdl=unset']);
  // Without xdotool the game would have no input at all: then hide nothing. PATH with only the bare essentials.
  const bare = mywhooshHome('standard');
  probe(bare.home);
  const tools = path.join(bare.home, 'tools');
  fs.mkdirSync(tools);
  for (const t of ['sed', 'dirname', 'mkdir', 'cat', 'rm', 'mv', 'ls', 'head', 'sleep', 'echo', 'bash', 'sh', 'env', 'kill', 'setsid', 'id']) {
    const found = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
    if (found) fs.symlinkSync(found, path.join(tools, t));
  }
  run('bash', bare.home, ['mywhoosh'], { ...bare.extra, PATH: tools });
  assert.deepEqual(sdl(bare.home), ['sdl=unset']);
});

// --- Quit Zwift in an orderly way (R35): first politely, then hard, then stop; that is how netbrain's script copies the login into the volume ----------
for (const sh of shells) {
  test(`R35 Quitting Zwift (${sh}): taskkill politely, hard if needed, then always podman stop; short deadlines in the test`, async () => {
    const cases = [
      // [Umgebung, erwartete Aufrufe vor stop]
      [{ FAKE_POLITE_KILLS: '1' }, ['exec --user user zwift-fahrer wine taskkill /im ZwiftApp.exe']],
      [{}, ['exec --user user zwift-fahrer wine taskkill /im ZwiftApp.exe', 'exec --user user zwift-fahrer wine taskkill /f /im ZwiftApp.exe']],
      [{ FAKE_FORCE_IGNORED: '1' }, ['exec --user user zwift-fahrer wine taskkill /im ZwiftApp.exe', 'exec --user user zwift-fahrer wine taskkill /f /im ZwiftApp.exe']]
    ];
    for (const [extra, expected] of cases) {
      const home = makeHome();
      zwiftScript(home);
      fs.writeFileSync(path.join(home, 'running'), '');
      const child = start(sh, home, ['zwift'], { RUN_MODE: 'wait', USER: 'fahrer', ROLLOUT_ZWIFT_QUIT_WAIT: '1', ROLLOUT_ZWIFT_KILL_WAIT: '1', ...extra });
      assert.ok(await until(() => fs.existsSync(path.join(home, 'started'))));
      child.kill('SIGTERM');
      await exited(child);
      const log = containers(home).map((l) => l.replace(/^(podman|docker) /, '')).filter((l) => /^(exec|stop) /.test(l));
      assert.deepEqual(log, [...expected, 'stop -t 10 zwift-fahrer'], JSON.stringify(extra));
      assert.equal(pidFile(home), null);
    }
  });
}

// --- Output log for Zwift (R36, R37): the container runs with --rm, a copy of its output goes to state/zwift-run.log --------------------------
const runLog = (home, suffix = '') => { try { return fs.readFileSync(path.join(home, `state/zwift-run.log${suffix}`), 'utf8'); } catch { return null; } };
for (const sh of shells) {
  test(`R36 Zwift output log (${sh}): stdout and stderr in the file and still on stdout, exit code kept, two older runs kept, off switch, MyWhoosh untouched`, () => {
    const home = makeHome();
    zwiftScript(home);
    for (let i = 1; i <= 4; i += 1) {
      const r = run(sh, home, ['zwift', `--run${i}`], { RUN_MODE: 'talk', USER: 'fahrer' });
      assert.equal(r.status, 3);
      assert.match(r.stdout, /out line/);
      assert.match(r.stdout, /err line/);
    }
    const now = runLog(home);
    assert.match(now, /^\S+Z rollout-run zwift --run4 \(runtime podman, image docker\.io\/netbrain\/zwift:1\.2\.3\)\n/);
    assert.match(now, /^out line$/m);
    assert.match(now, /^err line$/m);
    assert.match(now, /rollout-run: exit code 3\n$/);
    assert.match(runLog(home, '.1'), /--run3 /);
    assert.match(runLog(home, '.2'), /--run2 /);
    assert.equal(runLog(home, '.3'), null, 'at most three runs');
    assert.equal(fs.existsSync(path.join(home, 'state/zwift-run.fifo')), false, 'no FIFO left behind');
    const off = makeHome();
    zwiftScript(off);
    const r = run(sh, off, ['zwift'], { RUN_MODE: 'talk', USER: 'fahrer', ROLLOUT_ZWIFT_LOG: 'off' });
    assert.equal(r.status, 3);
    assert.match(r.stdout, /out line/);
    assert.match(r.stderr, /err line/, 'without the log stderr stays stderr');
    assert.equal(runLog(off), null);
    const mw = makeHome();
    assert.equal(run(sh, mw, ['mywhoosh'], { RUN_MODE: 'talk' }).status, 3);
    assert.equal(runLog(mw), null);
  });

  test(`R37 Zwift output log on quit (${sh}): TERM and INT do not end the copy, output after the signal still arrives, exit code of the game`, async () => {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      const home = makeHome();
      zwiftScript(home);
      const child = spawn(...argv(sh, path.join(home, 'bin/rollout-run'), 'zwift'), { env: env(home, { RUN_MODE: 'termtalk', USER: 'fahrer', ROLLOUT_ZWIFT_QUIT_WAIT: '1', ROLLOUT_ZWIFT_KILL_WAIT: '1' }), stdio: 'ignore', detached: true });
      assert.ok(await until(() => fs.existsSync(path.join(home, 'started'))));
      assert.ok(await until(() => /before term/.test(runLog(home) ?? '')), 'output arrives while the game runs');
      // Like Ctrl+C in a terminal: the signal hits the whole process group, also tee. The starter turns INT into TERM for the game.
      process.kill(-child.pid, signal);
      assert.equal(await exited(child), 42, signal);
      const text = runLog(home);
      assert.match(text, /^after term$/m, signal);
      assert.match(text, /rollout-run: exit code 42\n$/, signal);
      assert.equal(pidFile(home), null);
    }
  });
}

// --- Zwift's data directory (R38): Zwift 1.124.0 writes to Documents/Zwift, netbrain syncs only ZWIFT_DATA_DIR with the volume ------------------------
for (const sh of shells) {
  test(`R38 Zwift data directory (${sh}): ZWIFT_DATA_DIR points at Documents/Zwift via CONTAINER_EXTRA_ARGS, a user string is kept, appdata leaves it alone, MyWhoosh untouched`, () => {
    const docs = '-e ZWIFT_DATA_DIR=/home/user/.wine/drive_c/users/user/Documents/Zwift';
    const extra = (home) => fs.readFileSync(path.join(home, 'extra.log'), 'utf8').trim();
    const cases = [[{}, `extra=${docs}`], [{ CONTAINER_EXTRA_ARGS: '--cpus 2' }, `extra=${docs} --cpus 2`], [{ ROLLOUT_ZWIFT_DATA: 'appdata' }, 'extra=unset'],
      [{ ROLLOUT_ZWIFT_DATA: 'appdata', CONTAINER_EXTRA_ARGS: '--cpus 2' }, 'extra=--cpus 2']];
    for (const [more, expected] of cases) {
      const home = makeHome();
      zwiftScript(home);
      assert.equal(run(sh, home, ['zwift'], { RUN_MODE: 'exit 0', USER: 'fahrer', ...more }).status, 0);
      assert.equal(extra(home), expected, JSON.stringify(more));
    }
    const mw = makeHome();
    assert.equal(run(sh, mw, ['mywhoosh'], { RUN_MODE: 'exit 0' }).status, 0);
    assert.equal(extra(mw), 'extra=unset');
  });
}

// --- Zwift data into the volume while it runs (R39): "Exit game" in Steam ends the container at once, netbrain's copy at the end never happens ---------
for (const sh of shells) {
  test(`R39 Zwift periodic copy (${sh}): rsync in the container every ROLLOUT_ZWIFT_SYNC_EVERY s while it runs, never after the end, 0 switches it off, not for MyWhoosh`, async () => {
    const syncs = (home) => containers(home).filter((l) => /exec --user user zwift-fahrer sh -c .*rsync -qau/.test(l));
    const home = makeHome();
    zwiftScript(home);
    fs.writeFileSync(path.join(home, 'running'), '');
    const child = start(sh, home, ['zwift'], { RUN_MODE: 'wait', USER: 'fahrer', ROLLOUT_ZWIFT_SYNC_EVERY: '1', ROLLOUT_ZWIFT_QUIT_WAIT: '1', ROLLOUT_ZWIFT_KILL_WAIT: '1', FAKE_POLITE_KILLS: '1' });
    assert.ok(await until(() => syncs(home).length >= 2, 6000), 'copies while running');
    // Container gone (e.g. between start and ready): no copy, but the loop keeps waiting.
    fs.rmSync(path.join(home, 'running'));
    const before = syncs(home).length;
    await sleep(2300);
    assert.equal(syncs(home).length, before, 'no copy without a running container');
    child.kill('SIGTERM');
    await exited(child);
    const after = syncs(home).length;
    await sleep(1500);
    assert.equal(syncs(home).length, after, 'no copy after the end');
    // Off, and a game that ends by itself: the starter does not wait for the loop (spawnSync would hang if it held stdout).
    for (const every of ['0', '']) {
      const off = makeHome();
      zwiftScript(off);
      fs.writeFileSync(path.join(off, 'running'), '');
      const r = run(sh, off, ['zwift'], { RUN_MODE: 'exit 0', USER: 'fahrer', ROLLOUT_ZWIFT_SYNC_EVERY: every });
      assert.equal(r.status, 0);
      if (every === '0') assert.equal(syncs(off).length, 0);
    }
    const quick = makeHome();
    zwiftScript(quick);
    const t0 = Date.now();
    assert.equal(run(sh, quick, ['zwift'], { RUN_MODE: 'exit 0', USER: 'fahrer' }).status, 0);
    assert.ok(Date.now() - t0 < 5000, 'the default 30 s loop does not delay the end');
    const mw = makeHome();
    fs.writeFileSync(path.join(mw, 'running'), '');
    assert.equal(run(sh, mw, ['mywhoosh'], { RUN_MODE: 'exit 0', USER: 'fahrer', ROLLOUT_ZWIFT_SYNC_EVERY: '1' }).status, 0);
    assert.equal(syncs(mw).length, 0);
  });
}

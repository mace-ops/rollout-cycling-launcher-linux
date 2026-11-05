// Launcher update run with real Electron and the bin/rollout watcher (S5 to S8, release probe, A1 to A3).
// Only with a test key and throwaway directories. The candidate is re-signed with a test key; its archive stays unchanged.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bumpVersion, electronVersionOf, manifestFor, packApp, packElectron, signManifest } from '../scripts/release.mjs';
import { failureCount, root, session, sleep, testKey } from './harness.mjs';

export const stateFile = (home, name) => { try { return fs.readFileSync(path.join(home, 'state', name), 'utf8'); } catch { return null; } };
export const linkOf = (home, name) => { try { return path.basename(fs.readlinkSync(path.join(home, name))); } catch { return null; } };
export const ownVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

/** Creates an installation in a throwaway directory with scripts/install.sh. The real installation stays untouched. */
export function installBase({ home, electronDir }) {
  if (!home.startsWith(os.tmpdir())) throw new Error('Wegwerf-Ordner erwartet');
  execFileSync('sh', [path.join(root, 'scripts/install.sh')], { env: { ...process.env, ROLLOUT_HOME: home, ELECTRON_DIR: electronDir }, stdio: 'pipe' });
}

/** Puts a release into the fake directory: app archive from `dist`, manifest signed with the test key. `mutate` changes the content before packing. */
export function publish({ feedDir, key, version, distDir = path.join(root, 'dist'), mutate, runtime, channel = 'stable' }) {
  fs.mkdirSync(feedDir, { recursive: true });
  const app = packApp({ distDir, bootstrap: path.join(root, 'scripts/bin-rollout.sh'), version, outFile: path.join(feedDir, `rollout-${version}-app.tar.gz`), mutate });
  const manifest = { ...manifestFor({ version, app, runtime }), channel };
  fs.writeFileSync(path.join(feedDir, channel === 'beta' ? 'rollout-update-beta.json' : 'rollout-update.json'), signManifest(manifest, key.privateKey, 'test'));
  return manifest;
}

/** Runtime block for a manifest that does not require a new Electron (not downloaded because the installed one suffices). */
export const keepRuntime = (electronVersion) => ({
  electron: electronVersion, min: electronVersion, url: 'https://github.com/mace-ops/rollout-cycling-launcher-linux/releases/download/v0.0.0/unused.tar.gz',
  size: 1000, unpacked: 1000, sha256: 'b'.repeat(64)
});

/** With watcher, test key and short time limits. Home and feed belong to the caller and are kept. */
export const withHome = (name, home, feedDir, key, extra, steps) => session(name, { ROLLOUT_BOOT_TIMEOUT: '6', ROLLOUT_BOOT_GRACE: '2', ...extra.env }, steps, {
  home, feedDir, key: key.publicB64, launcher: path.join(home, 'bin/rollout'), config: extra.config, shots: extra.shots
});

/** Check and download through the API (no clicks) until the update is ready. Returns `null` or an error message. */
export async function stageUpdate(t) {
  const poll = async (fn, ms = 30000) => t.waitUntil(async () => fn((await t.snapshot()).selfUpdate), ms);
  await t.eval('window.rollout.checkSelfUpdate()');
  if (!(await poll((s) => s.status === 'available' || s.status === 'ready'))) return `Update not found (${(await t.snapshot()).selfUpdate.status})`;
  if ((await t.snapshot()).selfUpdate.status === 'available') await t.eval('window.rollout.downloadSelfUpdate()');
  if (!(await poll((s) => s.status === 'ready'))) return `Update not ready (${(await t.snapshot()).selfUpdate.status})`;
  return null;
}

/** Check, download, restart. Waits until the new version runs and the trial has passed. */
export async function driveUpdate(t, expected) {
  const problem = await stageUpdate(t);
  if (problem) return problem;
  await t.eval('void window.rollout.restartForUpdate(); true');
  await t.reattach(60000);
  if (!(await t.waitUntil(async () => (await t.snapshot()).selfUpdate.version === expected, 15000))) return `not running on ${expected}`;
  if (!(await t.waitUntil(() => stateFile(t.home, 'trial') === null, 20000))) return 'Trial not passed (trial remains)';
  return null;
}

/**
 * Release probe (concept 6.3, step 2): previous release to the candidate, then the candidate to an artificial version +1.
 * The candidate comes from release-out/ (archive unchanged, manifest re-signed with the test key).
 */
export async function runCheck(opts) {
  const electronDir = path.resolve(opts.electron ?? path.join(root, 'node_modules/electron/dist'));
  if (!fs.existsSync(path.join(electronDir, 'electron'))) throw new Error(`Electron not found: ${electronDir} (--electron <dir>)`);
  const out = path.join(root, 'release-out');
  const candidateManifest = JSON.parse(JSON.parse(fs.readFileSync(path.join(out, 'rollout-update.json'), 'utf8')).signed);
  const candidate = candidateManifest.version;
  const key = testKey();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-check-'));
  try {
    const previousArchive = opts.previous && path.resolve(opts.previous);
    const home = path.join(work, 'home');
    const feed = path.join(work, 'feed');
    const ev = electronVersionOf(electronDir);
    fs.mkdirSync(feed, { recursive: true });
    for (const name of fs.readdirSync(out)) if (name.endsWith('.tar.gz')) fs.copyFileSync(path.join(out, name), path.join(feed, name));
    fs.writeFileSync(path.join(feed, 'rollout-update.json'), signManifest({ ...candidateManifest, runtime: { ...candidateManifest.runtime, electron: ev, min: ev } }, key.privateKey, 'test'));

    // 1. Previous release from the archive. Without --previous (first release) there is no predecessor and the probe is skipped.
    if (previousArchive) {
      installFromArchive({ home, archive: previousArchive, electronDir });
      const start = linkOf(home, 'current');
      console.log(`Probe 1: ${start} → ${candidate}`);
      await withHome('check-1', home, feed, key, { env: {} }, async (t) => {
        const problem = await driveUpdate(t, candidate);
        await t.expect(Promise.resolve(problem === null), `Update from ${start} to ${candidate}${problem ? `: ${problem}` : ''}`);
      });
    } else {
      console.log('Probe 1 skipped: no --previous given (first release)');
      installBase({ home, electronDir });
    }

    // 2. Candidate to version +1, built from the installed candidate.
    const next = bumpVersion(candidate);
    publish({ feedDir: feed, key, version: next, distDir: path.join(home, 'versions', candidate, 'dist'), runtime: keepRuntime(ev) });
    console.log(`Probe 2: ${candidate} → ${next}`);
    await withHome('check-2', home, feed, key, { env: {} }, async (t) => {
      const problem = await driveUpdate(t, next);
      await t.expect(Promise.resolve(problem === null), `Update from ${candidate} to ${next}${problem ? `: ${problem}` : ''}`);
    });
    if (failureCount()) throw new Error('Release probe failed, do not upload');
    console.log('Release-Probe bestanden.');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    await sleep(0);
  }
}

/** Installation from an app archive of an earlier release (instead of from the working tree). */
export function installFromArchive({ home, archive, electronDir }) {
  const ev = electronVersionOf(electronDir);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-prev-'));
  try {
    execFileSync('tar', ['-xzf', archive, '-C', stage]);
    const version = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8')).version;
    for (const d of ['bin', 'versions', 'electron', 'state']) fs.mkdirSync(path.join(home, d), { recursive: true });
    fs.cpSync(electronDir, path.join(home, 'electron', ev), { recursive: true });
    fs.writeFileSync(path.join(stage, 'runtime'), `${ev}\n`);
    fs.renameSync(stage, path.join(home, 'versions', version));
    fs.symlinkSync(`versions/${version}`, path.join(home, 'current'));
    fs.copyFileSync(path.join(home, 'versions', version, 'bootstrap/rollout'), path.join(home, 'bin/rollout'));
    fs.chmodSync(path.join(home, 'bin/rollout'), 0o755);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

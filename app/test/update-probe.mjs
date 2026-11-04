// Durchlauf des Launcher-Updates mit echtem Electron und dem Wächter bin/rollout (S5 bis S8, Release-Probe, A1 bis A3).
// Nur mit Testschlüssel und Wegwerf-Ordnern. Der Kandidat wird mit einem Testschlüssel neu signiert, sein Archiv bleibt unverändert.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bumpVersion, electronVersionOf, manifestFor, packApp, packElectron, signManifest } from '../scripts/release.mjs';
import { failureCount, root, session, sleep, testKey } from './harness.mjs';

export const stateFile = (home, name) => { try { return fs.readFileSync(path.join(home, 'state', name), 'utf8'); } catch { return null; } };
export const linkOf = (home, name) => { try { return path.basename(fs.readlinkSync(path.join(home, name))); } catch { return null; } };
export const ownVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

/** Legt mit scripts/install.sh eine Installation in einen Wegwerf-Ordner. Die echte Installation bleibt unberührt. */
export function installBase({ home, electronDir }) {
  if (!home.startsWith(os.tmpdir())) throw new Error('Wegwerf-Ordner erwartet');
  execFileSync('sh', [path.join(root, 'scripts/install.sh')], { env: { ...process.env, ROLLOUT_HOME: home, ELECTRON_DIR: electronDir }, stdio: 'pipe' });
}

/** Ein Release in den Attrappen-Ordner: App-Archiv aus `dist`, Manifest mit Testschlüssel signiert. `mutate` ändert den Inhalt vor dem Packen. */
export function publish({ feedDir, key, version, distDir = path.join(root, 'dist'), mutate, runtime, channel = 'stable' }) {
  fs.mkdirSync(feedDir, { recursive: true });
  const app = packApp({ distDir, bootstrap: path.join(root, 'scripts/bin-rollout.sh'), version, outFile: path.join(feedDir, `rollout-${version}-app.tar.gz`), mutate });
  const manifest = { ...manifestFor({ version, app, runtime }), channel };
  fs.writeFileSync(path.join(feedDir, channel === 'beta' ? 'rollout-update-beta.json' : 'rollout-update.json'), signManifest(manifest, key.privateKey, 'test'));
  return manifest;
}

/** Runtime-Block für ein Manifest, das kein neues Electron verlangt (wird nicht geladen, weil das installierte reicht). */
export const keepRuntime = (electronVersion) => ({
  electron: electronVersion, min: electronVersion, url: 'https://github.com/mace-ops/rollout-cycling-launcher-linux/releases/download/v0.0.0/unused.tar.gz',
  size: 1000, unpacked: 1000, sha256: 'b'.repeat(64)
});

/** Mit Wächter, Testschlüssel und kurzen Zeitlimits. Home und Feed gehören dem Aufrufer und bleiben stehen. */
export const withHome = (name, home, feedDir, key, extra, steps) => session(name, { ROLLOUT_BOOT_TIMEOUT: '6', ROLLOUT_BOOT_GRACE: '2', ...extra.env }, steps, {
  home, feedDir, key: key.publicB64, launcher: path.join(home, 'bin/rollout'), config: extra.config, shots: extra.shots
});

/** Prüfen und laden per Schnittstelle (ohne Klicks), bis das Update bereit ist. Gibt `null` oder eine Fehlermeldung zurück. */
export async function stageUpdate(t) {
  const poll = async (fn, ms = 30000) => t.waitUntil(async () => fn((await t.snapshot()).selfUpdate), ms);
  await t.eval('window.rollout.checkSelfUpdate()');
  if (!(await poll((s) => s.status === 'available' || s.status === 'ready'))) return `Update nicht gefunden (${(await t.snapshot()).selfUpdate.status})`;
  if ((await t.snapshot()).selfUpdate.status === 'available') await t.eval('window.rollout.downloadSelfUpdate()');
  if (!(await poll((s) => s.status === 'ready'))) return `Update nicht bereit (${(await t.snapshot()).selfUpdate.status})`;
  return null;
}

/** Prüfen, laden, neu starten. Wartet, bis die neue Version läuft und die Probe bestanden ist. */
export async function driveUpdate(t, expected) {
  const problem = await stageUpdate(t);
  if (problem) return problem;
  await t.eval('void window.rollout.restartForUpdate(); true');
  await t.reattach(60000);
  if (!(await t.waitUntil(async () => (await t.snapshot()).selfUpdate.version === expected, 15000))) return `läuft nicht auf ${expected}`;
  if (!(await t.waitUntil(() => stateFile(t.home, 'trial') === null, 20000))) return 'Probe nicht bestanden (trial bleibt)';
  return null;
}

/**
 * Release-Probe (Konzept 6.3, Schritt 2): vorheriges Release auf den Kandidaten, dann den Kandidaten auf eine künstliche Version +1.
 * Der Kandidat kommt aus release-out/ (Archiv unverändert, Manifest mit Testschlüssel neu signiert).
 */
export async function runCheck(opts) {
  const electronDir = path.resolve(opts.electron ?? path.join(root, 'node_modules/electron/dist'));
  if (!fs.existsSync(path.join(electronDir, 'electron'))) throw new Error(`Electron nicht gefunden: ${electronDir} (--electron <Ordner>)`);
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

    // 1. Vorheriges Release aus dem Archiv. Ohne --previous (erstes Release) gibt es keinen Vorgänger, die Probe entfällt.
    if (previousArchive) {
      installFromArchive({ home, archive: previousArchive, electronDir });
      const start = linkOf(home, 'current');
      console.log(`Probe 1: ${start} → ${candidate}`);
      await withHome('check-1', home, feed, key, { env: {} }, async (t) => {
        const problem = await driveUpdate(t, candidate);
        await t.expect(Promise.resolve(problem === null), `Update von ${start} auf ${candidate}${problem ? `: ${problem}` : ''}`);
      });
    } else {
      console.log('Probe 1 entfällt: kein --previous angegeben (erstes Release)');
      installBase({ home, electronDir });
    }

    // 2. Kandidat auf Version +1, gebaut aus dem installierten Kandidaten.
    const next = bumpVersion(candidate);
    publish({ feedDir: feed, key, version: next, distDir: path.join(home, 'versions', candidate, 'dist'), runtime: keepRuntime(ev) });
    console.log(`Probe 2: ${candidate} → ${next}`);
    await withHome('check-2', home, feed, key, { env: {} }, async (t) => {
      const problem = await driveUpdate(t, next);
      await t.expect(Promise.resolve(problem === null), `Update von ${candidate} auf ${next}${problem ? `: ${problem}` : ''}`);
    });
    if (failureCount()) throw new Error('Release-Probe fehlgeschlagen, nicht hochladen');
    console.log('Release-Probe bestanden.');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    await sleep(0);
  }
}

/** Installation aus einem App-Archiv eines früheren Releases (statt aus dem Arbeitsbaum). */
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

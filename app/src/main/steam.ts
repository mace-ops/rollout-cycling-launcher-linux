// Steam integration: adds Rollout to shortcuts.vdf as a non-Steam game or removes it.
// Writing happens only while Steam is closed, with a backup, verification and atomic rename.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  shortcutAppId, addShortcut, hasShortcut, parseVdf, removeShortcut, serializeVdf, type ShortcutSpec, type VdfMap
} from './vdf';

export type SteamState = 'in' | 'out' | 'unavailable';
export type SteamStatus = 'done' | 'steam-running' | 'unavailable' | 'error';
export interface SteamInfo { state: SteamState; steamRunning: boolean; message: string }

const STEAM_ID64_BASE = 76561197960265728n;
const BACKUPS_KEPT = 3;

export const rolloutHome = (): string => process.env.ROLLOUT_HOME || path.join(os.homedir(), '.local/share/rollout');

export function rolloutShortcut(): ShortcutSpec {
  const home = rolloutHome();
  const icon = path.join(home, 'icon.png');
  return {
    name: 'Rollout',
    exe: path.join(home, 'bin/rollout'),
    startDir: path.join(home, 'bin'),
    icon: fs.existsSync(icon) ? icon : '',
    launchOptions: ''
  };
}

const exists = (p: string): boolean => { try { return fs.existsSync(p); } catch { return false; } };

/** Steam directory: native installation. Flatpak and Snap are not supported. */
export function findSteamRoot(): string | null {
  const home = os.homedir();
  const candidates = [path.join(home, '.local/share/Steam'), path.join(home, '.steam/steam')];
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      if (exists(path.join(real, 'userdata'))) return real;
    } catch { /* next candidate */ }
  }
  return null;
}

/** Account of the last login from loginusers.vdf, otherwise the most recently modified userdata directory. */
export function findAccountDir(root: string): string | null {
  const userdata = path.join(root, 'userdata');
  let best: { id: string; time: number } | null = null;
  try {
    const text = fs.readFileSync(path.join(root, 'config/loginusers.vdf'), 'utf8');
    for (const match of text.matchAll(/"(7656\d{13})"\s*\{([^}]*)\}/g)) {
      const block = match[2];
      const recent = /"MostRecent"\s+"1"/.test(block);
      const stamp = Number(/"timestamp"\s+"(\d+)"/.exec(block)?.[1] ?? 0) + (recent ? 1e12 : 0);
      const id = String(BigInt(match[1]) - STEAM_ID64_BASE);
      if (exists(path.join(userdata, id)) && (!best || stamp > best.time)) best = { id, time: stamp };
    }
  } catch { /* without loginusers.vdf continue with the directory state */ }
  if (best) return path.join(userdata, best.id);
  const dirs = fs.readdirSync(userdata).filter((d) => /^\d+$/.test(d) && d !== '0');
  dirs.sort((a, b) => fs.statSync(path.join(userdata, b)).mtimeMs - fs.statSync(path.join(userdata, a)).mtimeMs);
  return dirs.length ? path.join(userdata, dirs[0]) : null;
}

export function isSteamRunning(): boolean {
  return spawnSync('pgrep', ['-x', 'steam']).status === 0;
}

const gamingMode = (): boolean => process.env.XDG_CURRENT_DESKTOP === 'gamescope' || !!process.env.GAMESCOPE_WAYLAND_DISPLAY;

function readRoot(file: string): VdfMap {
  if (!exists(file)) return [{ key: 'shortcuts', value: [] }];
  return parseVdf(fs.readFileSync(file));
}

/** Directory and AppID of the Rollout entry in the active Steam account, otherwise `null`. */
export function rolloutSteamPaths(): { configDir: string; appId: number } | null {
  const root = findSteamRoot();
  const dir = root && findAccountDir(root);
  if (!dir) return null;
  const spec = rolloutShortcut();
  return { configDir: path.join(dir, 'config'), appId: shortcutAppId(`"${spec.exe}"`, spec.name) };
}

/** Files in config/grid that belong to the entry: portrait, landscape, background, logo. */
export const artworkFiles = (configDir: string, appId: number): string[] =>
  ['p', '', '_hero', '_logo'].map((suffix) => path.join(configDir, 'grid', `${appId}${suffix}.png`));

export function removeArtwork(configDir: string, appId: number): void {
  for (const file of artworkFiles(configDir, appId)) fs.rmSync(file, { force: true });
}

export function status(): SteamInfo {
  const running = isSteamRunning();
  const root = findSteamRoot();
  if (!root) return { state: 'unavailable', steamRunning: running, message: 'no native Steam found' };
  try {
    const dir = findAccountDir(root);
    if (!dir) return { state: 'unavailable', steamRunning: running, message: 'no Steam account found' };
    const tree = readRoot(path.join(dir, 'config/shortcuts.vdf'));
    return { state: hasShortcut(tree, rolloutShortcut()) ? 'in' : 'out', steamRunning: running, message: '' };
  } catch (error) {
    return { state: 'unavailable', steamRunning: running, message: (error as Error).message };
  }
}

/** Writes the file only if the verification passes: old entries unchanged, round trip matches. */
export function writeShortcuts(file: string, change: (tree: VdfMap) => boolean): boolean {
  const original = exists(file) ? fs.readFileSync(file) : null;
  const tree = original ? parseVdf(original) : [{ key: 'shortcuts', value: [] } as const] as VdfMap;
  if (original && !serializeVdf(parseVdf(original)).equals(original)) throw new Error('shortcuts.vdf cannot be read losslessly, nothing changed');
  if (!change(tree)) return false;
  const bytes = serializeVdf(tree);
  if (!serializeVdf(parseVdf(bytes)).equals(bytes)) throw new Error('Verification of the new shortcuts.vdf failed, nothing changed');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (original) {
    fs.writeFileSync(`${file}.rollout-backup-${Date.now()}`, original);
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('shortcuts.vdf.rollout-backup-')).sort();
    for (const old of backups.slice(0, -BACKUPS_KEPT)) fs.rmSync(path.join(path.dirname(file), old));
  }
  const temp = `${file}.rollout-tmp`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, file);
  return true;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function restartSteam(change: () => void): Promise<void> {
  spawn('steam', ['-shutdown'], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 80 && isSteamRunning(); i += 1) await sleep(500);
  if (isSteamRunning()) throw new Error('Steam did not close in time');
  try {
    change();
  } finally {
    const env = { ...process.env };
    delete env.LD_PRELOAD;
    spawn('steam', [], { detached: true, stdio: 'ignore', env }).unref();
  }
}

export async function setRolloutInSteam(
  on: boolean,
  restart: boolean,
  artwork?: (configDir: string, appId: number) => Promise<unknown>
): Promise<{ status: SteamStatus; message: string }> {
  if (gamingMode()) return { status: 'unavailable', message: 'Gaming Mode' };
  const root = findSteamRoot();
  const dir = root && findAccountDir(root);
  if (!dir) return { status: 'unavailable', message: 'no native Steam found' };
  const file = path.join(dir, 'config/shortcuts.vdf');
  const spec = rolloutShortcut();
  const configDir = path.dirname(file);
  const appId = shortcutAppId(`"${spec.exe}"`, spec.name);
  const apply = (): void => { writeShortcuts(file, (tree) => (on ? addShortcut(tree, spec) : removeShortcut(tree, spec))); };
  try {
    if (isSteamRunning()) {
      if (!restart) return { status: 'steam-running', message: '' };
      await restartSteam(apply);
    } else {
      apply();
    }
    // Images are cosmetic: failure changes nothing about the result.
    if (on) await artwork?.(configDir, appId).catch(() => undefined);
    else removeArtwork(configDir, appId);
    return { status: 'done', message: '' };
  } catch (error) {
    return { status: 'error', message: (error as Error).message };
  }
}

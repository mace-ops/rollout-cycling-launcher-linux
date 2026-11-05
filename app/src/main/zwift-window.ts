// Visibility of Zwift in Gaming Mode (gamescope), "path A": the Zwift window comes from the container and carries no `STEAM_GAME`;
// gamescope therefore does not add it to `GAMESCOPE_FOCUSABLE_WINDOWS`, and Steam never focuses it. Here Rollout detects the window on
// the host (xwininfo), sets `STEAM_GAME` to the AppID of its own Steam entry (xprop) and reports "visible" only when
// `GAMESCOPE_FOCUSED_WINDOW` is the Zwift window. Confirmed on the Ally with test T3.
// No Electron, no hard binding to X: the tool calls and the process tree come in as functions.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Runs an X tool (`xprop`, `xwininfo`, `xhost`) and returns stdout; throws on error or timeout. */
export type XExec = (file: string, args: string[]) => Promise<string>;

export const WINDOW_CLASS = 'zwiftapp.exe';
/** Smaller windows (input method, Wine helper windows: 1x1) are not the game window. */
const MIN_SIDE = 200;
const MAX_APP_ID = 4_294_967_295;

export function realXExec(display: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 3000): XExec {
  return (file, args) => new Promise((resolve, reject) => {
    execFile(file, args, { env: { ...env, DISPLAY: display }, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/**
 * AppID of the own Steam entry from the process tree: Steam starts every entry under `reaper SteamLaunch AppId=<N> -- …`
 * (the cgroup does not show it). Returns `null` if Rollout was not started from Steam.
 */
export function appIdFromAncestors(startPid: number, procRoot = '/proc'): string | null {
  const parentOf = (pid: number): number => {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    // The name is in parentheses and may contain spaces and parentheses: read from the last parenthesis.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(rest[1]);
  };
  let pid = startPid;
  for (let hops = 0; hops < 64 && pid > 1; hops += 1) {
    try {
      const argv = fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8').split('\0');
      if (path.basename(argv[0] ?? '') === 'reaper') {
        const at = argv.indexOf('SteamLaunch');
        const m = at >= 0 ? /^AppId=(\d{1,10})$/.exec(argv[at + 1] ?? '') : null;
        if (m && Number(m[1]) > 0 && Number(m[1]) <= MAX_APP_ID) return m[1];
      }
      pid = parentOf(pid);
    } catch {
      return null;
    }
    if (!Number.isFinite(pid)) return null;
  }
  return null;
}

export interface XWindow { id: number; hex: string; width: number; height: number }

const WINDOW_LINE = /^(\s+)(0x[0-9a-f]+)\s+(?:"[^"]*"|\(has no name\)):\s+\("([^"]*)" "([^"]*)"\)\s+(\d+)x(\d+)[+-]/;

/** Game window from `xwininfo -root -tree`: top level, WM_CLASS `zwiftapp.exe`, not tiny; with several, the largest. */
export function findZwiftWindow(tree: string, windowClass: string | RegExp = WINDOW_CLASS): XWindow | null {
  const lines = tree.split('\n').map((l) => WINDOW_LINE.exec(l)).filter((m): m is RegExpExecArray => m !== null);
  if (!lines.length) return null;
  const top = Math.min(...lines.map((m) => m[1].length));
  let best: XWindow | null = null;
  for (const m of lines) {
    if (m[1].length !== top) continue;
    const matches = (name: string): boolean => (typeof windowClass === 'string' ? name.toLowerCase() === windowClass : windowClass.test(name));
    if (!matches(m[3]) && !matches(m[4])) continue;
    const width = Number(m[5]);
    const height = Number(m[6]);
    if (width < MIN_SIDE || height < MIN_SIDE) continue;
    if (!best || width * height > best.width * best.height) best = { id: Number.parseInt(m[2], 16), hex: m[2], width, height };
  }
  return best;
}

/** `GAMESCOPE_FOCUSED_WINDOW(CARDINAL) = 67108869` → 67108869; `null` if the property is missing. */
export function parseFocusedWindow(out: string): number | null {
  const m = /GAMESCOPE_FOCUSED_WINDOW\(CARDINAL\)\s*=\s*(\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

export interface WindowWatcherOptions {
  exec: XExec;
  /** Reads `GAMESCOPE_FOCUSED_WINDOW`: the property lives on the root window of the primary gamescope X server (`:0`), the game windows on the game's X server (usually `:1` for Rollout). Default: `exec`. */
  focusExec?: XExec;
  /** AppID of the Rollout entry; `null` = not started from Steam, then nothing is set and nothing reported */
  appId: string | null;
  /** Called on every change between visible and not visible (at the start: not visible) */
  onVisible: (visible: boolean) => void;
  /** Notes for the log (e.g. AppID set, tool errors) */
  onNote?: (text: string) => void;
  intervalMs?: number;
  /** WM_CLASS of the game window (default `zwiftapp.exe`); a RegExp matches instance or class */
  windowClass?: string | RegExp;
  /** Set `STEAM_GAME` on the window (default yes). MyWhoosh starts under Steam and already carries it; then just observe without an AppID. */
  tag?: boolean;
}

export interface WindowWatcher {
  stop(): void;
  /** The Zwift window is the focused window. */
  readonly visible: boolean;
}

/**
 * Queries the X server (gamescope Xwayland `:0`) regularly until `stop()` arrives: if it finds the Zwift window, it sets
 * `STEAM_GAME=<AppID>` (once per window; Zwift's launcher windows are replaced by the game window, then again),
 * and reports "visible" only when gamescope has focused that window. Runs never overlap, errors of single queries
 * (server not ready yet, window gone) let the watching continue.
 */
export function watchZwiftWindow(opts: WindowWatcherOptions): WindowWatcher {
  const { exec, appId } = opts;
  const tag = opts.tag !== false;
  const focusExec = opts.focusExec ?? exec;
  let stopped = false;
  let visible = false;
  let tagged = 0;
  let timer: NodeJS.Timeout | null = null;
  let lastNote = '';
  const note = (text: string): void => { if (text !== lastNote) { lastNote = text; opts.onNote?.(text); } };
  const setVisible = (value: boolean): void => { if (value !== visible && !stopped) { visible = value; opts.onVisible(value); } };

  const tick = async (): Promise<void> => {
    const win = findZwiftWindow(await exec('xwininfo', ['-root', '-tree']), opts.windowClass);
    if (!win) { tagged = 0; note('no game window found'); setVisible(false); return; }
    if (tag && tagged !== win.id) {
      await exec('xprop', ['-id', win.hex, '-f', 'STEAM_GAME', '32c', '-set', 'STEAM_GAME', appId as string]);
      tagged = win.id;
      note(`STEAM_GAME=${appId} set on window ${win.hex}`);
    }
    setVisible(parseFocusedWindow(await focusExec('xprop', ['-root', 'GAMESCOPE_FOCUSED_WINDOW'])) === win.id);
  };

  const loop = async (): Promise<void> => {
    try { await tick(); } catch (e) { note(`Fensterabfrage: ${(e as Error).message.split('\n')[0]}`); }
    if (!stopped) timer = setTimeout(() => { void loop(); }, opts.intervalMs ?? 1000);
  };

  if (appId || !tag) void loop();
  else note('Rollout is not running under Steam (no AppID in the process tree): Zwift window stays without STEAM_GAME');
  return {
    stop: () => { stopped = true; if (timer) clearTimeout(timer); },
    get visible() { return visible; }
  };
}

/**
 * Container access to X: netbrain's zwift.sh calls `xhost +local:` and never revokes it. Whoever had no
 * `LOCAL:` entry before gets it reset after the game. Both are best effort (without `xhost` nothing happens).
 */
export async function xhostSnapshot(exec: XExec): Promise<boolean | null> {
  try { return /^LOCAL:/m.test(await exec('xhost', [])); } catch { return null; }
}

export async function xhostRestore(exec: XExec, hadLocal: boolean | null): Promise<boolean> {
  if (hadLocal !== false) return false;
  try {
    if (!/^LOCAL:/m.test(await exec('xhost', []))) return false;
    await exec('xhost', ['-local:']);
    return true;
  } catch { return false; }
}

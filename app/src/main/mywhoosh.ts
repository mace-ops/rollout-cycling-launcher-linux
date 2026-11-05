// MyWhoosh adapter (concept 5.1 to 5.3): setup, update, removal and start go through `bin/rollout-run` and our own
// copy of `mywhoosh.sh` (vendor/, based on Parapeth962/mywhoosh-linux-installer). The state comes from disk (game directory and
// AppxManifest.xml), not from the session's memory. This module knows nothing about Electron.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppProblem } from '../shared/api';
import { startPadBridge, type PadBridge } from './gamepad-bridge';
import { realXExec, watchZwiftWindow, type XExec } from './zwift-window';
import { writeCursorTheme } from './xcursor';
import { feedLines } from './zwift';

/** Edition of the game: standard or "Better Graphics" (HD). Both have their own directories under ~/Games. */
export type Edition = 'standard' | 'hd';

export interface MywhooshStatus {
  installed: boolean;
  /** e.g. `6.2.3.0`, empty if not installed or not readable */
  version: string;
  edition: Edition;
}

export class MywhooshError extends Error {
  constructor(public readonly problem: Exclude<AppProblem, ''> | 'abort', message: string) { super(message); }
}

/** A running start via `rollout-run mywhoosh`. Same shape as for Zwift. */
export interface MywhooshRun {
  /** Resolves when the starter ends: its exit code, `null` on a signal. */
  done: Promise<number | null>;
  /** Quits the game: TERM to `rollout-run`, which ends the whole session; after a deadline KILL to its group. */
  stop(): void;
}

/** Exit codes of `rollout-run mywhoosh` that carry a reason. Everything else is a crash of the game or an error of `mywhoosh.sh`. */
export const MYWHOOSH_RUN_PROBLEM: Record<number, Exclude<AppProblem, ''>> = { 127: 'error' };

const EXE_REL = 'MyWhoosh/Binaries/Win64/MyWhoosh-Win64-Shipping.exe';
const ROOT_NAME: Record<Edition, string> = { standard: 'mywhoosh-linux', hd: 'mywhoosh-hd-linux' };
/** Rough total amount a setup writes (package and unpacked files, Proton only the first time): for progress and the disk space check. */
const EXPECTED_BYTES: Record<Edition, number> = { standard: 9e9, hd: 31e9 };
/** At least this much space must be free before setup begins (game, package, Proton, prefix with Steam runtime). */
const NEEDED_BYTES: Record<Edition, number> = { standard: 14e9, hd: 38e9 };
const POLL_MS = 2000;

export const mywhooshRoot = (edition: Edition, env: NodeJS.ProcessEnv = process.env): string =>
  env.MYWHOOSH_ROOT || path.join(env.HOME || os.homedir(), 'Games', ROOT_NAME[edition]);

/** Reads the state from disk. Without a game directory: not installed. If only the HD edition exists, it applies. */
export function readStatus(env: NodeJS.ProcessEnv = process.env): MywhooshStatus {
  for (const edition of ['standard', 'hd'] as const) {
    const root = mywhooshRoot(edition, env);
    if (!fs.existsSync(path.join(root, 'game', EXE_REL))) continue;
    let version = '';
    try { version = /Identity[^>]*Version="([0-9.]+)"/.exec(fs.readFileSync(path.join(root, 'game/AppxManifest.xml'), 'utf8'))?.[1] ?? ''; } catch { /* version stays empty */ }
    return { installed: true, version, edition: env.MYWHOOSH_ROOT ? 'standard' : edition };
  }
  return { installed: false, version: '', edition: 'standard' };
}

function dirSize(dir: string): number {
  let sum = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const file = path.join(dir, e.name);
    try { sum += e.isDirectory() ? dirSize(file) : e.isFile() ? fs.statSync(file).size : 0; } catch { /* file vanished */ }
  }
  return sum;
}

/** Progress from lines of `mywhoosh.sh`: minimum value per recognised phase. Unknown lines change nothing. */
export function percentForLine(line: string): number {
  if (/preparing Windows environment/.test(line)) return 92;
  if (/shortcuts added/.test(line)) return 97;
  if (/installed$/.test(line) && /\[mywhoosh\] MyWhoosh/.test(line)) return 90;
  return 0;
}

/** Maps a failure of `mywhoosh.sh` to a reason (the output is English, the UI translates the reason). */
export function problemFromOutput(_code: number | null, tail: string): Exclude<AppProblem, ''> {
  if (/checksum mismatch|digest mismatch/i.test(tail)) return 'verify';
  if (/download failed|could not resolve|network|curl: \(/i.test(tail)) return 'net';
  if (/no space left|disk quota|not enough space/i.test(tail)) return 'disk';
  return 'error';
}

export interface MywhooshService {
  /** State from disk, without a process and without network */
  status(): MywhooshStatus;
  /** Sets up MyWhoosh (`mywhoosh.sh install`). `onPercent` receives the estimated progress, never backwards. */
  install(options: { hd: boolean }, onPercent: (percent: number) => void, signal: AbortSignal): Promise<void>;
  /** Installs a newer version if there is one (`mywhoosh.sh update`). */
  update(onPercent: (percent: number) => void, signal: AbortSignal): Promise<void>;
  /** Removes game, prefix and login (`mywhoosh.sh uninstall`); Proton stays. The UI asks for confirmation. */
  uninstall(signal: AbortSignal): Promise<void>;
  /**
   * Starts the game (`rollout-run mywhoosh`). `onLine` receives the output line by line without colour codes, `onVisible` reports whether the
   * game window is in focus in Gaming Mode (gamescope) (only with `windows`).
   */
  start(onLine: (line: string) => void, onVisible?: (visible: boolean) => void): MywhooshRun;
}

export interface RealMywhooshOptions {
  home: string;
  /** Spielstarter, Vorgabe `<home>/bin/rollout-run` */
  runner?: string;
  env?: NodeJS.ProcessEnv;
  /** Deadline between TERM and KILL on quit in ms, default 35000 */
  stopGraceMs?: number;
  /** Interval of the progress measurement in ms */
  pollMs?: number;
  /** Check the free space needed in addition to `mywhoosh.sh`? Tests switch it off. Default: yes */
  checkSpace?: boolean;
  /**
   * Game window and controller in Gaming Mode. Without this option `start` never touches the X server (tests). `display` is the game's X server
   * (the display Rollout itself inherited), `focusDisplay` the primary gamescope server with `GAMESCOPE_FOCUSED_WINDOW` (default `:0`).
   * While the window is visible, Rollout forwards the Steam gamepad as keyboard and mouse (A = left click, see gamepad-bridge.ts).
   */
  /** Directory for the pointer theme (a round, clearly visible dot, xcursor.ts); without it or with ROLLOUT_MYWHOOSH_CURSOR=off the normal pointer stays */
  cursorDir?: string;
  windows?: { display: string; focusDisplay?: string; exec?: XExec; focusExec?: XExec; intervalMs?: number; onNote?: (text: string) => void; pad?: (display: string) => PadBridge | null };
}

/** WM_CLASS of the game window under Wine: the executable's name, `MyWhoosh-Win64-Shipping.exe`. */
export const WINDOW_CLASS = /mywhoosh/i;

export class RealMywhoosh implements MywhooshService {
  private readonly runner: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly o: RealMywhooshOptions) {
    this.runner = o.runner ?? path.join(o.home, 'bin/rollout-run');
    this.env = o.env ?? process.env;
  }

  status(): MywhooshStatus { return readStatus(this.env); }

  private spawnRunner(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
    return spawn(this.runner, args, { env: { ...this.env, ROLLOUT_HOME: this.o.home, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  }

  /** Environment for the game's pointer; empty if switched off or if the theme cannot be created. */
  private cursorEnv(): NodeJS.ProcessEnv {
    if (!this.o.cursorDir || this.env.ROLLOUT_MYWHOOSH_CURSOR === 'off') return {};
    try { return writeCursorTheme(this.o.cursorDir); } catch { return {}; }
  }

  private logFile(): string { return path.join(this.o.home, 'state/mywhoosh.log'); }
  private pidFile(): string { return path.join(this.o.home, 'state/mywhoosh-setup.pid'); }

  /** Is a setup from an earlier Rollout, which has since quit, still running? Then touch nothing. */
  private setupBusy(): boolean {
    try {
      const pid = Number(fs.readFileSync(this.pidFile(), 'utf8').trim());
      if (!pid) return false;
      process.kill(pid, 0);
      return true;
    } catch { return false; }
  }

  /**
   * Runs `rollout-run --mywhoosh <action>`. The output goes line by line to state/mywhoosh.log (for the help file) and to
   * `onLine`; `measure` is called every `pollMs`. If the script fails, the error carries the reason from its output.
   */
  private async runSetup(args: string[], signal: AbortSignal, onLine: (line: string) => void, measure?: () => void): Promise<void> {
    if (signal.aborted) throw new MywhooshError('abort', 'abgebrochen');
    if (!fs.existsSync(this.runner)) throw new MywhooshError('error', 'rollout-run fehlt');
    if (this.setupBusy()) throw new MywhooshError('error', 'An earlier setup is still running');
    fs.mkdirSync(path.join(this.o.home, 'state'), { recursive: true });
    try { fs.writeFileSync(this.logFile(), `${new Date().toISOString()} rollout-run ${args.join(' ')}\n`); } catch { /* log is a bonus */ }
    const child = this.spawnRunner(args);
    if (child.pid) { try { fs.writeFileSync(this.pidFile(), `${child.pid}\n`); } catch { /* without the file the protection does not apply */ } }
    let tail = '';
    const take = (line: string): void => {
      tail = `${tail}\n${line}`.slice(-2000);
      try { fs.appendFileSync(this.logFile(), `${line}\n`); } catch { /* log is a bonus */ }
      onLine(line);
    };
    feedLines(child.stdout, take);
    feedLines(child.stderr, take);
    const timer = measure ? setInterval(measure, this.o.pollMs ?? POLL_MS) : null;
    const onAbort = (): void => { try { child.kill('SIGTERM'); } catch { /* already exited */ } };
    signal.addEventListener('abort', onAbort);
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(null));
      child.on('close', (c) => resolve(c));
    });
    signal.removeEventListener('abort', onAbort);
    if (timer) clearInterval(timer);
    try { fs.rmSync(this.pidFile(), { force: true }); } catch { /* nothing */ }
    if (signal.aborted) throw new MywhooshError('abort', 'abgebrochen');
    if (code !== 0) throw new MywhooshError(problemFromOutput(code, tail), `rollout-run --mywhoosh ${args[1] ?? ''} ended with ${code ?? 'error'}: ${tail.trim().split('\n').pop() ?? ''}`);
  }

  /** Progress as a measurement: bytes written in the cache and in the game directory against the expected amount, with minimum values from lines. */
  private progress(edition: Edition, onPercent: (percent: number) => void, baseline: () => number): { measure: () => void; line: (l: string) => void } {
    const root = mywhooshRoot(edition, this.env);
    let best = 0;
    const emit = (value: number): void => { if (value > best) { best = Math.min(99, value); onPercent(best); } };
    return {
      measure: () => {
        const bytes = dirSize(path.join(root, 'cache')) + dirSize(path.join(root, 'game')) + dirSize(path.join(root, 'game.new')) - baseline();
        emit(Math.floor(Math.max(0, bytes) / EXPECTED_BYTES[edition] * 90));
      },
      line: (l) => { const p = percentForLine(l); if (p) emit(p); }
    };
  }

  private checkSpace(edition: Edition): void {
    if (this.o.checkSpace === false) return;
    const root = mywhooshRoot(edition, this.env);
    let dir = root;
    while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    try {
      const s = fs.statfsSync(dir);
      if (s.bavail * s.bsize < NEEDED_BYTES[edition]) throw new MywhooshError('disk', `Zu wenig freier Platz in ${dir}`);
    } catch (e) {
      if (e instanceof MywhooshError) throw e;
    }
  }

  async install(options: { hd: boolean }, onPercent: (percent: number) => void, signal: AbortSignal): Promise<void> {
    const edition: Edition = options.hd ? 'hd' : 'standard';
    if (this.setupBusy()) throw new MywhooshError('error', 'An earlier setup is still running');
    this.checkSpace(edition);
    // An earlier, aborted attempt leaves a game directory without a game behind; mywhoosh.sh then aborts. A directory with a game is never touched.
    const game = path.join(mywhooshRoot(edition, this.env), 'game');
    if (fs.existsSync(game) && !fs.existsSync(path.join(game, EXE_REL))) fs.rmSync(game, { recursive: true, force: true });
    const p = this.progress(edition, onPercent, () => 0);
    await this.runSetup(['--mywhoosh', 'install', ...(options.hd ? ['--hd'] : [])], signal, p.line, p.measure);
    if (!readStatus(this.env).installed) throw new MywhooshError('error', 'MyWhoosh not found after setup');
  }

  async update(onPercent: (percent: number) => void, signal: AbortSignal): Promise<void> {
    const { edition } = readStatus(this.env);
    const root = mywhooshRoot(edition, this.env);
    const start = dirSize(path.join(root, 'game'));
    // When updating only game.new grows, the old game stays until the swap: it does not count.
    const p = this.progress(edition, onPercent, () => start);
    await this.runSetup(['--mywhoosh', 'update'], signal, p.line, p.measure);
  }

  async uninstall(signal: AbortSignal): Promise<void> {
    await this.runSetup(['--mywhoosh', 'uninstall'], signal, () => {});
    if (readStatus(this.env).installed) throw new MywhooshError('error', 'MyWhoosh is still there after removal');
  }

  start(onLine: (line: string) => void, onVisible?: (visible: boolean) => void): MywhooshRun {
    if (!fs.existsSync(this.runner)) return { done: Promise.resolve(127), stop: () => {} };
    // Own process group: the KILL after the deadline hits everything attached to the starter. The starter ends the game's session itself.
    const child = this.spawnRunner(['mywhoosh'], this.cursorEnv());
    feedLines(child.stdout, onLine);
    feedLines(child.stderr, onLine);
    let killer: NodeJS.Timeout | null = null;
    // Controller: while the game window is visible, Rollout forwards the gamepad as keyboard and mouse. MyWhoosh then no longer gets the real
    // gamepad (rollout-run hides it from Wine): its UI shows no focus when navigating by gamepad.
    const w = this.o.windows;
    let pad: PadBridge | null = null;
    const stopPad = (): void => { pad?.stop(); pad = null; };
    const startPad = w?.pad ?? ((d: string) => (this.env.ROLLOUT_MYWHOOSH_PAD === 'off' ? null : startPadBridge({ display: d, env: this.env, onNote: w?.onNote, pointer: true })));
    const exec = w ? (w.exec ?? realXExec(w.display, this.env)) : null;
    w?.onNote?.(`Start: window watching ${w ? 'on' : 'off'}, display ${w?.display ?? '-'}`);
    const watcher = w && exec
      ? watchZwiftWindow({
        exec, focusExec: w.focusExec ?? (w.exec ? undefined : realXExec(w.focusDisplay ?? ':0', this.env)), appId: null, tag: false, windowClass: WINDOW_CLASS,
        intervalMs: w.intervalMs, onNote: w.onNote,
        onVisible: (v) => {
          if (v && !pad) pad = startPad(w.display);
          else if (!v) stopPad();
          onVisible?.(v);
        }
      })
      : null;
    const done = new Promise<number | null>((resolve) => {
      const finish = (code: number | null): void => {
        if (killer) clearTimeout(killer);
        stopPad();
        if (watcher) { const was = watcher.visible; watcher.stop(); if (was) onVisible?.(false); }
        resolve(code);
      };
      child.on('error', () => finish(127));
      child.on('close', (code) => finish(code));
    });
    return {
      done,
      stop: () => {
        try { child.kill('SIGTERM'); } catch { /* already exited */ }
        killer ??= setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } } }, this.o.stopGraceMs ?? 35_000);
      }
    };
  }
}

/**
 * When MyWhoosh runs for real: without an explicit choice (`ROLLOUT_MYWHOOSH`) real as soon as `rollout-run` and the bundled
 * `mywhoosh.sh` exist, otherwise simulated. `real` and `sim` force the choice.
 */
export function chooseMywhooshMode(opts: { mode: string | undefined; runnerExists: boolean; scriptExists: boolean }): 'real' | 'sim' {
  if (opts.mode === 'real') return 'real';
  if (opts.mode) return 'sim';
  return opts.runnerExists && opts.scriptExists ? 'real' : 'sim';
}

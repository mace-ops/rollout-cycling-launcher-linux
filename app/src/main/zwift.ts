// Zwift adapter (concept 5.1, E7): downloads the start script `zwift.sh` from netbrain/zwift at a fixed commit, verifies its
// SHA-256 and places it atomically at $ROLLOUT_HOME/zwift/<commit>/zwift.sh. The image is pulled by `rollout-run --zwift-pull`, here only
// after the user's consent (the caller asks). This module knows nothing about Electron: the network comes in as a function.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AppProblem } from '../shared/api';
import type { DownloadOptions } from './selfupdate';
import { startPadBridge, type PadBridge } from './gamepad-bridge';
import { appIdFromAncestors, realXExec, watchZwiftWindow, xhostRestore, xhostSnapshot, type XExec } from './zwift-window';

/** Pin from `upstreams.json`: exactly this script at exactly this commit; nothing newer is ever run automatically. */
export interface ZwiftPin {
  repo: string;
  commit: string;
  path: string;
  sha256: string;
  image: string;
  /** Default for `zwift_tag` as long as the user has not entered one */
  tag: string;
}

export const MAX_SCRIPT_BYTES = 256 * 1024;

export class ZwiftError extends Error {
  constructor(public readonly problem: Exclude<AppProblem, ''> | 'abort', message: string) { super(message); }
}

/** Checks the pin strictly because it goes into a URL and a path. */
export function checkPin(value: unknown): ZwiftPin {
  const bad = (what: string): never => { throw new ZwiftError('verify', `Invalid pin: ${what}`); };
  const pin = (value ?? {}) as Record<string, unknown>;
  const text = (key: string, re: RegExp): string => (typeof pin[key] === 'string' && re.test(pin[key] as string) ? (pin[key] as string) : bad(key));
  return {
    repo: text('repo', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    commit: text('commit', /^[0-9a-f]{40}$/),
    path: text('path', /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/),
    sha256: text('sha256', /^[0-9a-f]{64}$/),
    image: text('image', /^[a-z0-9][a-z0-9./_:-]*$/),
    tag: text('tag', /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/)
  };
}

export const scriptUrl = (pin: ZwiftPin): string => `https://raw.githubusercontent.com/${pin.repo}/${pin.commit}/${pin.path}`;
export const scriptDir = (home: string, pin: ZwiftPin): string => path.join(home, 'zwift', pin.commit);
export const scriptFile = (home: string, pin: ZwiftPin): string => path.join(scriptDir(home, pin), 'zwift.sh');

const sha256Of = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Is the pinned script there, unchanged and executable? */
export function scriptReady(home: string, pin: ZwiftPin): boolean {
  const file = scriptFile(home, pin);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES || (stat.mode & 0o100) === 0) return false;
    return sha256Of(file) === pin.sha256;
  } catch {
    return false;
  }
}

export type Download = (url: string, dest: string, options: DownloadOptions) => Promise<void>;

/**
 * Downloads the pinned script. It is created under `zwift/.staging-*` (same partition), checked against size and SHA-256 and
 * moved into place by rename: a half or modified script is never under `zwift/<commit>/`. Afterwards
 * scripts of other commits disappear. Returns `false` if everything was already there.
 */
export async function installScript(opts: { home: string; pin: ZwiftPin; download: Download; signal?: AbortSignal }): Promise<boolean> {
  const { home, download } = opts;
  const pin = checkPin(opts.pin);
  const root = path.join(home, 'zwift');
  fs.mkdirSync(root, { recursive: true });
  for (const name of fs.readdirSync(root)) if (name.startsWith('.staging-')) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  if (scriptReady(home, pin)) { prune(root, pin); return false; }

  const stage = path.join(root, `.staging-${randomBytes(6).toString('hex')}`);
  fs.mkdirSync(stage);
  try {
    const file = path.join(stage, 'zwift.sh');
    try {
      await download(scriptUrl(pin), file, { maxBytes: MAX_SCRIPT_BYTES, signal: opts.signal ?? new AbortController().signal, onBytes: () => {} });
    } catch (e) {
      const kind = (e as { kind?: string }).kind;
      throw new ZwiftError(kind === 'abort' ? 'abort' : 'net', `Download of zwift.sh failed: ${(e as Error).message}`);
    }
    let size: number;
    try { size = fs.statSync(file).size; } catch { throw new ZwiftError('net', 'zwift.sh was not written'); }
    if (size === 0 || size > MAX_SCRIPT_BYTES) throw new ZwiftError('verify', `zwift.sh has an invalid size (${size} bytes)`);
    if (sha256Of(file) !== pin.sha256) throw new ZwiftError('verify', 'The checksum of zwift.sh differs from the pin');
    fs.chmodSync(file, 0o755);
    const target = scriptDir(home, pin);
    // An existing but modified target is moved aside first, then the rename replaces it in one step.
    const old = path.join(root, `.staging-old-${randomBytes(4).toString('hex')}`);
    const hadOld = fs.existsSync(target);
    if (hadOld) fs.renameSync(target, old);
    try {
      fs.renameSync(stage, target);
    } catch (e) {
      if (hadOld) fs.renameSync(old, target);
      throw new ZwiftError('disk', `zwift.sh could not be stored: ${(e as Error).message}`);
    }
    fs.rmSync(old, { recursive: true, force: true });
    prune(root, pin);
    return true;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** Removes scripts of earlier pins. A running start keeps its open file; rename and unlink do not disturb it. */
function prune(root: string, pin: ZwiftPin): void {
  for (const name of fs.readdirSync(root)) {
    if (/^[0-9a-f]{40}$/.test(name) && name !== pin.commit) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

// ---------- Service for the UI and state ----------

export interface ZwiftStatus {
  /** pinned `zwift.sh` is there unchanged */
  script: boolean;
  /** `podman`, `docker` or empty if there is no usable runtime */
  runtime: string;
  /** the configured image exists locally */
  image: boolean;
  /** the user confirmed pulling exactly this image */
  consent: boolean;
  /** image:tag of the setting, empty if none is set */
  ref: string;
  /** why `image` could not be judged: no runtime, no tag, other error */
  problem: AppProblem;
}

/** A running start via `rollout-run zwift`. */
export interface ZwiftRun {
  /** Resolves when the starter ends: its exit code, `null` on a signal. */
  done: Promise<number | null>;
  /** Quits the game: TERM to `rollout-run`, which halts the container with `podman stop`; after a deadline KILL to the whole process group. */
  stop(): void;
}

/** Exit codes of `rollout-run zwift` that carry a reason (concept 5.2). Everything else is a crash of the game or of `zwift.sh`. */
export const RUN_PROBLEM: Record<number, Exclude<AppProblem, ''>> = { 10: 'runtime', 11: 'tag', 12: 'pull', 127: 'error' };

/** Recognises in the output of `zwift.sh` the line from which the container starts (phase "Game starting"). Colour codes are already stripped. */
export const isStartLine = (line: string): boolean => /\bLaunching Zwift\b/.test(line);

/**
 * Message of the container (netbrain's entry script) once ZwiftApp.exe has started: "[podman|✓] Zwift started using wine". On the Ally it arrived
 * about 5 s after the container started. It replaces the wait until "Running"; if it is missing, the timer still applies (ROLLOUT_ZWIFT_RUNNING_MS).
 */
export const isRunningLine = (line: string): boolean => /Zwift started using wine/.test(line);

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** Splits an output stream into lines (also at `\r`), strips colour codes and truncates to 300 characters. */
export function feedLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let rest = '';
  const emit = (raw: string): void => { const line = raw.replace(ANSI, '').trim(); if (line) onLine(line.slice(0, 300)); };
  stream.on('data', (d: Buffer) => {
    const parts = (rest + d.toString()).split(/\r?\n|\r/);
    rest = parts.pop() ?? '';
    for (const line of parts) emit(line);
  });
  stream.on('end', () => emit(rest));
}

export interface ZwiftService {
  status(): Promise<ZwiftStatus>;
  /** Downloads and verifies `zwift.sh`. */
  installScript(signal: AbortSignal): Promise<void>;
  /** Pulls the configured image (`rollout-run --zwift-pull`). Call only after confirmation by the user. `onLine` receives the output line by line. */
  pullImage(onLine: (line: string) => void, signal: AbortSignal): Promise<void>;
  /**
   * Starts the game (`rollout-run zwift`). `onLine` receives the output line by line, without colour codes. `onVisible` reports whether the
   * Zwift window is in focus in Gaming Mode (gamescope), i.e. really visible (path A, see zwift-window.ts).
   */
  start(onLine: (line: string) => void, onVisible?: (visible: boolean) => void): ZwiftRun;
  /** Removes the image (`rollout-run --zwift-remove`, i.e. `podman rmi`) and the remembered consent. Call only after asking the user. */
  removeImage(signal: AbortSignal): Promise<void>;
  /** Default for the image tag */
  readonly defaultTag: string;
}

const EXIT_PROBLEM: Record<number, Exclude<AppProblem, ''>> = { 10: 'runtime', 11: 'tag', 12: 'pull' };

export interface RealZwiftOptions {
  home: string;
  pin: unknown;
  download: Download;
  /** Spielstarter, Vorgabe `<home>/bin/rollout-run` */
  runner?: string;
  env?: NodeJS.ProcessEnv;
  /** Time limit for `--zwift-status` in ms */
  statusTimeoutMs?: number;
  /** Deadline between TERM and KILL when quitting the game in ms, default 60000 (the starter first quits Zwift politely and then hard, up to 8 and 15 s respectively, then `podman stop` up to 20 s) */
  stopGraceMs?: number;
  /**
   * Window visibility in Gaming Mode (zwift-window.ts). Without this option `start` never touches the X server (tests). `display` default
   * `:0` (the gamescope Xwayland), `exec` replaces xwininfo/xprop/xhost, `appId` replaces the search in the process tree.
   */
  windows?: { display?: string; focusDisplay?: string; exec?: XExec; focusExec?: XExec; appId?: string | null; intervalMs?: number; onNote?: (text: string) => void; pad?: (display: string) => PadBridge | null };
}

export class RealZwift implements ZwiftService {
  private readonly pin: ZwiftPin;
  private readonly runner: string;
  readonly defaultTag: string;

  constructor(private readonly o: RealZwiftOptions) {
    this.pin = checkPin(o.pin);
    this.runner = o.runner ?? path.join(o.home, 'bin/rollout-run');
    this.defaultTag = this.pin.tag;
  }

  private spawnRunner(arg: string, detached = false, extraEnv: NodeJS.ProcessEnv = {}) {
    return spawn(this.runner, [arg], { env: { ...(this.o.env ?? process.env), ROLLOUT_HOME: this.o.home, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached });
  }

  async status(): Promise<ZwiftStatus> {
    const script = scriptReady(this.o.home, this.pin);
    const none: ZwiftStatus = { script, runtime: '', image: false, consent: false, ref: '', problem: '' };
    if (!fs.existsSync(this.runner)) return { ...none, problem: 'error' };
    const ask = async (extraEnv: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> => {
      const child = this.spawnRunner('--zwift-status', false, extraEnv);
      let text = '';
      child.stdout.on('data', (d: Buffer) => { text += d.toString(); });
      child.stderr.resume();
      const timer = setTimeout(() => child.kill('SIGKILL'), this.o.statusTimeoutMs ?? 60_000);
      const result = await new Promise<number | null>((resolve) => {
        child.on('error', () => resolve(null));
        child.on('close', (c) => resolve(c));
      });
      clearTimeout(timer);
      return { code: result, out: text };
    };
    let { code, out } = await ask({});
    // No tag in config.toml yet (before the first installation): query the state for the pinned image so the runtime
    // and an already existing image are recognised. Nothing is pulled in the process.
    if (code === 11 && (this.o.env ?? process.env).ROLLOUT_ZWIFT_TAG === undefined) {
      ({ code, out } = await ask({ ROLLOUT_ZWIFT_TAG: this.pin.tag }));
    }
    if (code !== 0) return { ...none, problem: code === 10 ? 'runtime' : code === 11 ? 'tag' : 'error' };
    const kv = Object.fromEntries(out.split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)).filter((p) => p.length === 2));
    return { script, runtime: kv.runtime ?? '', image: kv.image === 'present', consent: kv.consent === 'yes', ref: kv.ref ?? '', problem: '' };
  }

  async installScript(signal: AbortSignal): Promise<void> {
    await installScript({ home: this.o.home, pin: this.pin, download: this.o.download, signal });
  }

  async pullImage(onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new ZwiftError('abort', 'abgebrochen');
    const child = this.spawnRunner('--zwift-pull');
    feedLines(child.stdout, onLine);
    feedLines(child.stderr, onLine);
    const onAbort = (): void => { child.kill('SIGTERM'); };
    signal.addEventListener('abort', onAbort);
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(null));
      child.on('close', (c) => resolve(c));
    });
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted) throw new ZwiftError('abort', 'abgebrochen');
    if (code !== 0) throw new ZwiftError(code !== null && EXIT_PROBLEM[code] ? EXIT_PROBLEM[code] : 'pull', `rollout-run --zwift-pull ended with ${code ?? 'error'}`);
  }

  start(onLine: (line: string) => void, onVisible?: (visible: boolean) => void): ZwiftRun {
    if (!fs.existsSync(this.runner)) return { done: Promise.resolve(127), stop: () => {} };
    const w = this.o.windows;
    const exec = w ? (w.exec ?? realXExec(w.display ?? ':0', this.o.env ?? process.env)) : null;
    // Remember before the start whether `xhost` already knows `LOCAL:`: zwift.sh opens it and never closes it.
    const hadLocal = exec ? xhostSnapshot(exec) : null;
    // Own process group so the KILL after the deadline hits everything attached to the starter.
    const child = this.spawnRunner('zwift', true);
    feedLines(child.stdout, onLine);
    feedLines(child.stderr, onLine);
    let killer: NodeJS.Timeout | null = null;
    const signalGroup = (sig: NodeJS.Signals): void => {
      try { if (child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch { try { child.kill(sig); } catch { /* already exited */ } }
    };
    // Controller: while the Zwift window is visible, Rollout forwards the Steam gamepad as keyboard and mouse (gamepad-bridge.ts).
    let pad: PadBridge | null = null;
    const display = w?.display ?? ':0';
    const startPad = w?.pad ?? ((d: string) => ((this.o.env ?? process.env).ROLLOUT_ZWIFT_PAD === 'off' ? null : startPadBridge({ display: d, env: this.o.env, onNote: w?.onNote })));
    const stopPad = (): void => { pad?.stop(); pad = null; };
    w?.onNote?.(`Start: window watching ${w ? 'on' : 'off'}, display ${display}, AppID ${w ? (w.appId === undefined ? appIdFromAncestors(process.pid) : w.appId) : '-'}`);
    const watcher = w && exec
      ? watchZwiftWindow({
        exec, focusExec: w.focusExec ?? (w.exec ? undefined : realXExec(w.focusDisplay ?? ':0', this.o.env ?? process.env)), appId: w.appId === undefined ? appIdFromAncestors(process.pid) : w.appId, intervalMs: w.intervalMs, onNote: w.onNote,
        onVisible: (v) => {
          if (v && !pad) pad = startPad(display);
          else if (!v) stopPad();
          onVisible?.(v);
        }
      })
      : null;
    const finish = async (code: number | null): Promise<number | null> => {
      if (killer) clearTimeout(killer);
      stopPad();
      if (watcher) {
        const was = watcher.visible;
        watcher.stop();
        if (was) onVisible?.(false);
      }
      if (exec && hadLocal) {
        const restored = await xhostRestore(exec, await hadLocal);
        if (restored) w?.onNote?.('xhost -local: revoked');
      }
      return code;
    };
    const done = new Promise<number | null>((resolve) => {
      child.on('error', () => { void finish(127).then(resolve); });
      child.on('close', (code) => { void finish(code).then(resolve); });
    });
    return {
      done,
      stop: () => {
        // Only the starter gets TERM: it stops the container itself (podman stop, see rollout-run). A TERM to the whole group
        // would also hit `podman run` and leave the container running as an orphan (observed on the Ally).
        try { child.kill('SIGTERM'); } catch { /* already exited */ }
        killer ??= setTimeout(() => signalGroup('SIGKILL'), this.o.stopGraceMs ?? 60_000);
      }
    };
  }

  async removeImage(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new ZwiftError('abort', 'abgebrochen');
    if (!fs.existsSync(this.runner)) throw new ZwiftError('error', 'rollout-run fehlt');
    const child = this.spawnRunner('--zwift-remove');
    let last = '';
    feedLines(child.stdout, (l) => { last = l; });
    feedLines(child.stderr, (l) => { last = l; });
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(null));
      child.on('close', (c) => resolve(c));
    });
    if (code !== 0) throw new ZwiftError(code === 10 ? 'runtime' : code === 11 ? 'tag' : 'error', `rollout-run --zwift-remove ended with ${code ?? 'error'}: ${last}`);
  }
}

/**
 * When Zwift runs for real (concept 5.2): without an explicit choice (`ROLLOUT_ZWIFT`) real as soon as `rollout-run` exists and the pin is valid,
 * otherwise simulated as before. `fake` and `real` force the service, `sim` the simulation.
 */
export function chooseZwiftMode(opts: { mode: string | undefined; runnerExists: boolean; pin: unknown }): 'real' | 'fake' | 'sim' {
  if (opts.mode === 'fake') return 'fake';
  if (opts.mode === 'real') return 'real';
  if (opts.mode) return 'sim';
  if (!opts.runnerExists) return 'sim';
  try { checkPin(opts.pin); } catch { return 'sim'; }
  return 'real';
}

/**
 * Fake for the UI and tests (ROLLOUT_ZWIFT=fake): no network, no container. `mode` selects the state:
 * empty = nothing there, `ready` = script and image there, `norun` = no runtime, `nonet` = download fails, `nopull` = pull fails,
 * `runcrash` = like `ready`, but the start aborts with exit 1 after the messages, `runfail` = like `ready`, but the start reports exit 12
 * (image missing), `norem` = like `ready`, but the removal fails.
 */
export class FakeZwift implements ZwiftService {
  readonly defaultTag = '1.0.0';
  private script: boolean;
  private image: boolean;

  constructor(private readonly mode: string = '', private readonly stepMs = 150) {
    const ready = ['ready', 'runcrash', 'runfail', 'norem'].includes(mode);
    this.script = ready;
    this.image = ready;
  }

  async status(): Promise<ZwiftStatus> {
    const runtime = this.mode === 'norun' ? '' : 'podman';
    return { script: this.script, runtime, image: this.image, consent: this.image, ref: `docker.io/netbrain/zwift:${this.defaultTag}`, problem: runtime ? '' : 'runtime' };
  }

  async installScript(): Promise<void> {
    await new Promise((r) => setTimeout(r, this.stepMs));
    if (this.mode === 'nonet') throw new ZwiftError('net', 'Fake: no network');
    this.script = true;
  }

  async pullImage(onLine: (line: string) => void): Promise<void> {
    if (this.mode === 'norun') throw new ZwiftError('runtime', 'Fake: no runtime');
    for (let i = 1; i <= 4; i += 1) {
      await new Promise((r) => setTimeout(r, this.stepMs));
      onLine(`Copying blob ${i} done`);
    }
    if (this.mode === 'nopull') throw new ZwiftError('pull', 'Fake: pull failed');
    this.image = true;
  }

  start(onLine: (line: string) => void, onVisible?: (visible: boolean) => void): ZwiftRun {
    let finish: (code: number | null) => void = () => {};
    const done = new Promise<number | null>((resolve) => { finish = resolve; });
    const timers: NodeJS.Timeout[] = [];
    let stopped = false;
    const at = (n: number, fn: () => void): void => { timers.push(setTimeout(fn, n * this.stepMs)); };
    if (this.mode === 'runfail') at(1, () => finish(12));
    else {
      at(1, () => onLine('Preparing to launch Zwift'));
      at(2, () => onLine('Looking for container tool'));
      at(3, () => onLine('Launching Zwift'));
      if (this.mode === 'runcrash') at(4, () => finish(1));
      else at(5, () => onVisible?.(true));
    }
    // Quitting takes a moment, as with the real container: visible as phase "stopping".
    return { done, stop: () => { if (stopped) return; stopped = true; timers.forEach(clearTimeout); timers.length = 0; onVisible?.(false); at(4, () => finish(143)); } };
  }

  async removeImage(): Promise<void> {
    await new Promise((r) => setTimeout(r, this.stepMs));
    if (this.mode === 'norem') throw new ZwiftError('error', 'Fake: removal failed');
    this.image = false;
  }
}

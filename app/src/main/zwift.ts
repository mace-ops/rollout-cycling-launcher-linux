// Zwift-Adapter (Konzept 5.1, E7): lädt das Startskript `zwift.sh` von netbrain/zwift auf einen festen Commit, prüft die
// SHA-256 und legt es atomar nach $ROLLOUT_HOME/zwift/<commit>/zwift.sh. Das Image zieht `rollout-run --zwift-pull`, hier nur
// nach Zustimmung des Nutzers (der Aufrufer fragt). Dieses Modul kennt kein Electron: Das Netz kommt als Funktion herein.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AppProblem } from '../shared/api';
import type { DownloadOptions } from './selfupdate';

/** Pin aus `upstreams.json`: genau dieses Skript auf genau diesem Commit, nichts Neueres wird je automatisch ausgeführt. */
export interface ZwiftPin {
  repo: string;
  commit: string;
  path: string;
  sha256: string;
  image: string;
  /** Voreinstellung für `zwift_tag`, solange der Nutzer keinen eigenen einträgt */
  tag: string;
}

export const MAX_SCRIPT_BYTES = 256 * 1024;

export class ZwiftError extends Error {
  constructor(public readonly problem: Exclude<AppProblem, ''> | 'abort', message: string) { super(message); }
}

/** Prüft den Pin streng, weil er in eine URL und einen Pfad eingeht. */
export function checkPin(value: unknown): ZwiftPin {
  const bad = (what: string): never => { throw new ZwiftError('verify', `Pin ungültig: ${what}`); };
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

/** Liegt das gepinnte Skript da, unverändert und ausführbar? */
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
 * Lädt das gepinnte Skript. Es entsteht unter `zwift/.staging-*` (gleiche Partition), wird gegen Größe und SHA-256 geprüft und
 * per rename an seinen Platz gesetzt: Ein halbes oder verändertes Skript liegt nie unter `zwift/<commit>/`. Danach verschwinden
 * Skripte anderer Commits. Gibt `false` zurück, wenn schon alles da war.
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
      throw new ZwiftError(kind === 'abort' ? 'abort' : 'net', `Download von zwift.sh gescheitert: ${(e as Error).message}`);
    }
    let size: number;
    try { size = fs.statSync(file).size; } catch { throw new ZwiftError('net', 'zwift.sh wurde nicht geschrieben'); }
    if (size === 0 || size > MAX_SCRIPT_BYTES) throw new ZwiftError('verify', `zwift.sh hat eine unzulässige Größe (${size} Bytes)`);
    if (sha256Of(file) !== pin.sha256) throw new ZwiftError('verify', 'Die Prüfsumme von zwift.sh weicht vom Pin ab');
    fs.chmodSync(file, 0o755);
    const target = scriptDir(home, pin);
    // Ein vorhandenes, aber verändertes Ziel wird erst beiseite gelegt, dann ersetzt der rename in einem Schritt.
    const old = path.join(root, `.staging-old-${randomBytes(4).toString('hex')}`);
    const hadOld = fs.existsSync(target);
    if (hadOld) fs.renameSync(target, old);
    try {
      fs.renameSync(stage, target);
    } catch (e) {
      if (hadOld) fs.renameSync(old, target);
      throw new ZwiftError('disk', `zwift.sh konnte nicht abgelegt werden: ${(e as Error).message}`);
    }
    fs.rmSync(old, { recursive: true, force: true });
    prune(root, pin);
    return true;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** Entfernt Skripte früherer Pins. Ein laufender Start behält seine geöffnete Datei, rename und unlink stören ihn nicht. */
function prune(root: string, pin: ZwiftPin): void {
  for (const name of fs.readdirSync(root)) {
    if (/^[0-9a-f]{40}$/.test(name) && name !== pin.commit) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

// ---------- Dienst für Oberfläche und Zustand ----------

export interface ZwiftStatus {
  /** gepinntes `zwift.sh` liegt unverändert da */
  script: boolean;
  /** `podman`, `docker` oder leer, wenn keine nutzbare Laufzeit da ist */
  runtime: string;
  /** das eingestellte Image liegt lokal */
  image: boolean;
  /** der Nutzer hat das Ziehen genau dieses Images bestätigt */
  consent: boolean;
  /** Image:Tag der Einstellung, leer wenn keines eingestellt ist */
  ref: string;
  /** warum `image` nicht beurteilt werden konnte: keine Laufzeit, kein Tag, anderer Fehler */
  problem: AppProblem;
}

export interface ZwiftService {
  status(): Promise<ZwiftStatus>;
  /** Lädt und prüft `zwift.sh`. */
  installScript(signal: AbortSignal): Promise<void>;
  /** Zieht das eingestellte Image (`rollout-run --zwift-pull`). Nur nach Bestätigung durch den Nutzer aufrufen. `onLine` bekommt die Ausgabe zeilenweise. */
  pullImage(onLine: (line: string) => void, signal: AbortSignal): Promise<void>;
  /** Voreinstellung für den Image-Tag */
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
  /** Zeitgrenze für `--zwift-status` in ms */
  statusTimeoutMs?: number;
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

  private spawnRunner(arg: string) {
    return spawn(this.runner, [arg], { env: { ...(this.o.env ?? process.env), ROLLOUT_HOME: this.o.home }, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  async status(): Promise<ZwiftStatus> {
    const script = scriptReady(this.o.home, this.pin);
    const none: ZwiftStatus = { script, runtime: '', image: false, consent: false, ref: '', problem: '' };
    if (!fs.existsSync(this.runner)) return { ...none, problem: 'error' };
    const child = this.spawnRunner('--zwift-status');
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), this.o.statusTimeoutMs ?? 60_000);
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(null));
      child.on('close', (c) => resolve(c));
    });
    clearTimeout(timer);
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
    const feed = (stream: NodeJS.ReadableStream): void => {
      let rest = '';
      stream.on('data', (d: Buffer) => {
        const parts = (rest + d.toString()).split(/\r?\n|\r/);
        rest = parts.pop() ?? '';
        for (const line of parts) if (line.trim()) onLine(line.trim().slice(0, 300));
      });
      stream.on('end', () => { if (rest.trim()) onLine(rest.trim().slice(0, 300)); });
    };
    feed(child.stdout);
    feed(child.stderr);
    const onAbort = (): void => { child.kill('SIGTERM'); };
    signal.addEventListener('abort', onAbort);
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(null));
      child.on('close', (c) => resolve(c));
    });
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted) throw new ZwiftError('abort', 'abgebrochen');
    if (code !== 0) throw new ZwiftError(code !== null && EXIT_PROBLEM[code] ? EXIT_PROBLEM[code] : 'pull', `rollout-run --zwift-pull endete mit ${code ?? 'Fehler'}`);
  }
}

/**
 * Attrappe für Oberfläche und Tests (ROLLOUT_ZWIFT=fake): kein Netz, kein Container. `mode` wählt den Zustand:
 * leer = nichts da, `ready` = Skript und Image da, `norun` = keine Laufzeit, `nonet` = Download scheitert, `nopull` = Ziehen scheitert.
 */
export class FakeZwift implements ZwiftService {
  readonly defaultTag = '1.0.0';
  private script: boolean;
  private image: boolean;

  constructor(private readonly mode: string = '', private readonly stepMs = 150) {
    this.script = mode === 'ready';
    this.image = mode === 'ready';
  }

  async status(): Promise<ZwiftStatus> {
    const runtime = this.mode === 'norun' ? '' : 'podman';
    return { script: this.script, runtime, image: this.image, consent: this.image, ref: `docker.io/netbrain/zwift:${this.defaultTag}`, problem: runtime ? '' : 'runtime' };
  }

  async installScript(): Promise<void> {
    await new Promise((r) => setTimeout(r, this.stepMs));
    if (this.mode === 'nonet') throw new ZwiftError('net', 'Attrappe: kein Netz');
    this.script = true;
  }

  async pullImage(onLine: (line: string) => void): Promise<void> {
    if (this.mode === 'norun') throw new ZwiftError('runtime', 'Attrappe: keine Laufzeit');
    for (let i = 1; i <= 4; i += 1) {
      await new Promise((r) => setTimeout(r, this.stepMs));
      onLine(`Copying blob ${i} done`);
    }
    if (this.mode === 'nopull') throw new ZwiftError('pull', 'Attrappe: Ziehen gescheitert');
    this.image = true;
  }
}

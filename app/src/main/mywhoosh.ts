// MyWhoosh-Adapter (Konzept 5.1 bis 5.3): Einrichten, Aktualisieren, Entfernen und Starten laufen über `bin/rollout-run` und die eigene
// Kopie von `mywhoosh.sh` (vendor/, Vorlage Parapeth962/mywhoosh-linux-installer). Der Zustand kommt von der Platte (Spielordner und
// AppxManifest.xml), nicht aus dem Gedächtnis der Sitzung. Dieses Modul kennt kein Electron.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppProblem } from '../shared/api';
import { startPadBridge, type PadBridge } from './gamepad-bridge';
import { realXExec, watchZwiftWindow, type XExec } from './zwift-window';
import { writeCursorTheme } from './xcursor';
import { feedLines } from './zwift';

/** Ausgabe des Spiels: Standard oder „Bessere Grafik“ (HD). Beide haben eigene Ordner unter ~/Games. */
export type Edition = 'standard' | 'hd';

export interface MywhooshStatus {
  installed: boolean;
  /** z. B. `6.2.3.0`, leer wenn nicht installiert oder nicht lesbar */
  version: string;
  edition: Edition;
}

export class MywhooshError extends Error {
  constructor(public readonly problem: Exclude<AppProblem, ''> | 'abort', message: string) { super(message); }
}

/** Ein laufender Start über `rollout-run mywhoosh`. Gleiche Form wie bei Zwift. */
export interface MywhooshRun {
  /** Endet, wenn der Starter endet: sein Exit-Code, bei einem Signal `null`. */
  done: Promise<number | null>;
  /** Beendet das Spiel: TERM an `rollout-run`, das die ganze Sitzung beendet; nach einer Frist KILL an dessen Gruppe. */
  stop(): void;
}

/** Exit-Codes von `rollout-run mywhoosh`, die einen Grund tragen. Alles andere ist ein Absturz des Spiels oder ein Fehler von `mywhoosh.sh`. */
export const MYWHOOSH_RUN_PROBLEM: Record<number, Exclude<AppProblem, ''>> = { 127: 'error' };

const EXE_REL = 'MyWhoosh/Binaries/Win64/MyWhoosh-Win64-Shipping.exe';
const ROOT_NAME: Record<Edition, string> = { standard: 'mywhoosh-linux', hd: 'mywhoosh-hd-linux' };
/** Grobe Gesamtmenge, die eine Einrichtung schreibt (Paket und entpackte Dateien, Proton nur beim ersten Mal): für Fortschritt und Platzprüfung. */
const EXPECTED_BYTES: Record<Edition, number> = { standard: 9e9, hd: 31e9 };
/** Mindestens so viel Platz muss frei sein, bevor die Einrichtung beginnt (Spiel, Paket, Proton, Prefix mit Steam-Laufzeit). */
const NEEDED_BYTES: Record<Edition, number> = { standard: 14e9, hd: 38e9 };
const POLL_MS = 2000;

export const mywhooshRoot = (edition: Edition, env: NodeJS.ProcessEnv = process.env): string =>
  env.MYWHOOSH_ROOT || path.join(env.HOME || os.homedir(), 'Games', ROOT_NAME[edition]);

/** Liest den Zustand von der Platte. Ohne Spielordner: nicht installiert. Ist nur die HD-Ausgabe da, gilt sie. */
export function readStatus(env: NodeJS.ProcessEnv = process.env): MywhooshStatus {
  for (const edition of ['standard', 'hd'] as const) {
    const root = mywhooshRoot(edition, env);
    if (!fs.existsSync(path.join(root, 'game', EXE_REL))) continue;
    let version = '';
    try { version = /Identity[^>]*Version="([0-9.]+)"/.exec(fs.readFileSync(path.join(root, 'game/AppxManifest.xml'), 'utf8'))?.[1] ?? ''; } catch { /* Version bleibt leer */ }
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
    try { sum += e.isDirectory() ? dirSize(file) : e.isFile() ? fs.statSync(file).size : 0; } catch { /* Datei verschwand */ }
  }
  return sum;
}

/** Fortschritt aus Zeilen von `mywhoosh.sh`: Mindestwert je erkannter Phase. Unbekannte Zeilen ändern nichts. */
export function percentForLine(line: string): number {
  if (/preparing Windows environment/.test(line)) return 92;
  if (/shortcuts added/.test(line)) return 97;
  if (/installed$/.test(line) && /\[mywhoosh\] MyWhoosh/.test(line)) return 90;
  return 0;
}

/** Ordnet einen Fehlschlag von `mywhoosh.sh` einem Grund zu (die Ausgabe ist englisch, die Oberfläche übersetzt den Grund). */
export function problemFromOutput(_code: number | null, tail: string): Exclude<AppProblem, ''> {
  if (/checksum mismatch|digest mismatch/i.test(tail)) return 'verify';
  if (/download failed|could not resolve|network|curl: \(/i.test(tail)) return 'net';
  if (/no space left|disk quota|not enough space/i.test(tail)) return 'disk';
  return 'error';
}

export interface MywhooshService {
  /** Zustand von der Platte, ohne Prozess und ohne Netz */
  status(): MywhooshStatus;
  /** Richtet MyWhoosh ein (`mywhoosh.sh install`). `onPercent` bekommt den geschätzten Fortschritt, nie rückwärts. */
  install(options: { hd: boolean }, onPercent: (percent: number) => void, signal: AbortSignal): Promise<void>;
  /** Installiert eine neuere Version, falls es eine gibt (`mywhoosh.sh update`). */
  update(onPercent: (percent: number) => void, signal: AbortSignal): Promise<void>;
  /** Entfernt Spiel, Prefix und Anmeldung (`mywhoosh.sh uninstall`); Proton bleibt. Die Rückfrage stellt die Oberfläche. */
  uninstall(signal: AbortSignal): Promise<void>;
  /**
   * Startet das Spiel (`rollout-run mywhoosh`). `onLine` bekommt die Ausgabe zeilenweise ohne Farbcodes, `onVisible` meldet, ob das
   * Spielfenster im Spielmodus (gamescope) im Fokus ist (nur mit `windows`).
   */
  start(onLine: (line: string) => void, onVisible?: (visible: boolean) => void): MywhooshRun;
}

export interface RealMywhooshOptions {
  home: string;
  /** Spielstarter, Vorgabe `<home>/bin/rollout-run` */
  runner?: string;
  env?: NodeJS.ProcessEnv;
  /** Frist zwischen TERM und KILL beim Beenden in ms, Vorgabe 35000 */
  stopGraceMs?: number;
  /** Abstand der Fortschrittsmessung in ms */
  pollMs?: number;
  /** Zusätzlich zu `mywhoosh.sh` benötigter freier Platz prüfen? Tests schalten es ab. Vorgabe: ja */
  checkSpace?: boolean;
  /**
   * Spielfenster und Controller im Spielmodus. Ohne diese Angabe berührt `start` den X-Server nie (Tests). `display` ist der X-Server des
   * Spiels (die Anzeige, die Rollout selbst geerbt hat), `focusDisplay` der primäre gamescope-Server mit `GAMESCOPE_FOCUSED_WINDOW` (Vorgabe `:0`).
   * Solange das Fenster zu sehen ist, gibt Rollout das Steam-Gamepad als Tastatur und Maus weiter (A = Linksklick, siehe gamepad-bridge.ts).
   */
  /** Ordner für das Zeiger-Thema (ein runder, gut sichtbarer Punkt, xcursor.ts); ohne Angabe oder mit ROLLOUT_MYWHOOSH_CURSOR=off bleibt der normale Zeiger */
  cursorDir?: string;
  windows?: { display: string; focusDisplay?: string; exec?: XExec; focusExec?: XExec; intervalMs?: number; onNote?: (text: string) => void; pad?: (display: string) => PadBridge | null };
}

/** WM_CLASS des Spielfensters unter Wine: der Name der Programmdatei, `MyWhoosh-Win64-Shipping.exe`. */
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

  /** Umgebung für den Zeiger des Spiels; leer, wenn abgeschaltet oder das Thema nicht angelegt werden kann. */
  private cursorEnv(): NodeJS.ProcessEnv {
    if (!this.o.cursorDir || this.env.ROLLOUT_MYWHOOSH_CURSOR === 'off') return {};
    try { return writeCursorTheme(this.o.cursorDir); } catch { return {}; }
  }

  private logFile(): string { return path.join(this.o.home, 'state/mywhoosh.log'); }
  private pidFile(): string { return path.join(this.o.home, 'state/mywhoosh-setup.pid'); }

  /** Läuft noch eine Einrichtung von einem früheren Rollout, das beendet wurde? Dann nichts anfassen. */
  private setupBusy(): boolean {
    try {
      const pid = Number(fs.readFileSync(this.pidFile(), 'utf8').trim());
      if (!pid) return false;
      process.kill(pid, 0);
      return true;
    } catch { return false; }
  }

  /**
   * Führt `rollout-run --mywhoosh <aktion>` aus. Die Ausgabe geht zeilenweise nach state/mywhoosh.log (für die Hilfedatei) und in
   * `onLine`; `measure` wird alle `pollMs` aufgerufen. Scheitert das Skript, trägt der Fehler den Grund aus seiner Ausgabe.
   */
  private async runSetup(args: string[], signal: AbortSignal, onLine: (line: string) => void, measure?: () => void): Promise<void> {
    if (signal.aborted) throw new MywhooshError('abort', 'abgebrochen');
    if (!fs.existsSync(this.runner)) throw new MywhooshError('error', 'rollout-run fehlt');
    if (this.setupBusy()) throw new MywhooshError('error', 'Eine frühere Einrichtung läuft noch');
    fs.mkdirSync(path.join(this.o.home, 'state'), { recursive: true });
    try { fs.writeFileSync(this.logFile(), `${new Date().toISOString()} rollout-run ${args.join(' ')}\n`); } catch { /* Protokoll ist Zugabe */ }
    const child = this.spawnRunner(args);
    if (child.pid) { try { fs.writeFileSync(this.pidFile(), `${child.pid}\n`); } catch { /* ohne Datei gilt der Schutz nicht */ } }
    let tail = '';
    const take = (line: string): void => {
      tail = `${tail}\n${line}`.slice(-2000);
      try { fs.appendFileSync(this.logFile(), `${line}\n`); } catch { /* Protokoll ist Zugabe */ }
      onLine(line);
    };
    feedLines(child.stdout, take);
    feedLines(child.stderr, take);
    const timer = measure ? setInterval(measure, this.o.pollMs ?? POLL_MS) : null;
    const onAbort = (): void => { try { child.kill('SIGTERM'); } catch { /* schon beendet */ } };
    signal.addEventListener('abort', onAbort);
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(null));
      child.on('close', (c) => resolve(c));
    });
    signal.removeEventListener('abort', onAbort);
    if (timer) clearInterval(timer);
    try { fs.rmSync(this.pidFile(), { force: true }); } catch { /* nichts */ }
    if (signal.aborted) throw new MywhooshError('abort', 'abgebrochen');
    if (code !== 0) throw new MywhooshError(problemFromOutput(code, tail), `rollout-run --mywhoosh ${args[1] ?? ''} endete mit ${code ?? 'Fehler'}: ${tail.trim().split('\n').pop() ?? ''}`);
  }

  /** Fortschritt als Messung: geschriebene Bytes im Zwischenspeicher und im Spielordner gegen die erwartete Menge, mit Mindestwerten aus Zeilen. */
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
    if (this.setupBusy()) throw new MywhooshError('error', 'Eine frühere Einrichtung läuft noch');
    this.checkSpace(edition);
    // Ein früherer, abgebrochener Versuch lässt einen Spielordner ohne Spiel zurück; mywhoosh.sh bricht dann ab. Ein Ordner mit Spiel wird nie angefasst.
    const game = path.join(mywhooshRoot(edition, this.env), 'game');
    if (fs.existsSync(game) && !fs.existsSync(path.join(game, EXE_REL))) fs.rmSync(game, { recursive: true, force: true });
    const p = this.progress(edition, onPercent, () => 0);
    await this.runSetup(['--mywhoosh', 'install', ...(options.hd ? ['--hd'] : [])], signal, p.line, p.measure);
    if (!readStatus(this.env).installed) throw new MywhooshError('error', 'MyWhoosh nach der Einrichtung nicht gefunden');
  }

  async update(onPercent: (percent: number) => void, signal: AbortSignal): Promise<void> {
    const { edition } = readStatus(this.env);
    const root = mywhooshRoot(edition, this.env);
    const start = dirSize(path.join(root, 'game'));
    // Beim Aktualisieren wächst nur game.new, das alte game bleibt bis zum Tausch: Es zählt nicht mit.
    const p = this.progress(edition, onPercent, () => start);
    await this.runSetup(['--mywhoosh', 'update'], signal, p.line, p.measure);
  }

  async uninstall(signal: AbortSignal): Promise<void> {
    await this.runSetup(['--mywhoosh', 'uninstall'], signal, () => {});
    if (readStatus(this.env).installed) throw new MywhooshError('error', 'MyWhoosh ist nach dem Entfernen noch da');
  }

  start(onLine: (line: string) => void, onVisible?: (visible: boolean) => void): MywhooshRun {
    if (!fs.existsSync(this.runner)) return { done: Promise.resolve(127), stop: () => {} };
    // Eigene Prozessgruppe: Der KILL nach der Frist trifft alles, was am Starter hängt. Der Starter beendet die Sitzung des Spiels selbst.
    const child = this.spawnRunner(['mywhoosh'], this.cursorEnv());
    feedLines(child.stdout, onLine);
    feedLines(child.stderr, onLine);
    let killer: NodeJS.Timeout | null = null;
    // Controller: Solange das Spielfenster zu sehen ist, gibt Rollout das Gamepad als Tastatur und Maus weiter. MyWhoosh bekommt das echte
    // Gamepad dann nicht mehr (rollout-run blendet es für Wine aus): Dessen Oberfläche zeigt beim Navigieren per Gamepad keinen Fokus.
    const w = this.o.windows;
    let pad: PadBridge | null = null;
    const stopPad = (): void => { pad?.stop(); pad = null; };
    const startPad = w?.pad ?? ((d: string) => (this.env.ROLLOUT_MYWHOOSH_PAD === 'off' ? null : startPadBridge({ display: d, env: this.env, onNote: w?.onNote, pointer: true })));
    const exec = w ? (w.exec ?? realXExec(w.display, this.env)) : null;
    w?.onNote?.(`Start: Fensterüberwachung ${w ? 'an' : 'aus'}, Anzeige ${w?.display ?? '-'}`);
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
        try { child.kill('SIGTERM'); } catch { /* schon beendet */ }
        killer ??= setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* schon beendet */ } } }, this.o.stopGraceMs ?? 35_000);
      }
    };
  }
}

/**
 * Wann MyWhoosh echt läuft: ohne ausdrückliche Wahl (`ROLLOUT_MYWHOOSH`) echt, sobald `rollout-run` und die mitgelieferte
 * `mywhoosh.sh` da sind, sonst simuliert. `real` und `sim` erzwingen die Wahl.
 */
export function chooseMywhooshMode(opts: { mode: string | undefined; runnerExists: boolean; scriptExists: boolean }): 'real' | 'sim' {
  if (opts.mode === 'real') return 'real';
  if (opts.mode) return 'sim';
  return opts.runnerExists && opts.scriptExists ? 'real' : 'sim';
}

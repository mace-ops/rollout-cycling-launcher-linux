// Sichtbarkeit von Zwift im Spielmodus (gamescope), „Weg A“: Das Zwift-Fenster kommt aus dem Container und trägt kein `STEAM_GAME`;
// gamescope nimmt es deshalb nicht in `GAMESCOPE_FOCUSABLE_WINDOWS` auf, Steam fokussiert es nie. Hier erkennt Rollout das Fenster auf
// dem Host (xwininfo), setzt `STEAM_GAME` auf die AppID des eigenen Steam-Eintrags (xprop) und meldet „sichtbar“ erst, wenn
// `GAMESCOPE_FOCUSED_WINDOW` das Zwift-Fenster ist. Belegt am Ally mit Test T3 (docs/notizen-bazzite-container.md).
// Kein Electron, keine feste Anbindung an X: Die Werkzeugaufrufe und der Prozessbaum kommen als Funktionen herein.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Führt ein X-Werkzeug (`xprop`, `xwininfo`, `xhost`) aus und gibt stdout zurück; wirft bei Fehler oder Zeitüberschreitung. */
export type XExec = (file: string, args: string[]) => Promise<string>;

export const WINDOW_CLASS = 'zwiftapp.exe';
/** Kleinere Fenster (Eingabemethode, Wine-Hilfsfenster: 1x1) sind nicht das Spielfenster. */
const MIN_SIDE = 200;
const MAX_APP_ID = 4_294_967_295;

export function realXExec(display: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 3000): XExec {
  return (file, args) => new Promise((resolve, reject) => {
    execFile(file, args, { env: { ...env, DISPLAY: display }, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/**
 * AppID des eigenen Steam-Eintrags aus dem Prozessbaum: Steam startet jeden Eintrag unter `reaper SteamLaunch AppId=<N> -- …`
 * (die cgroup zeigt sie nicht). Gibt `null` zurück, wenn Rollout nicht aus Steam gestartet wurde.
 */
export function appIdFromAncestors(startPid: number, procRoot = '/proc'): string | null {
  const parentOf = (pid: number): number => {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    // Der Name steht in Klammern und kann Leerzeichen und Klammern enthalten: ab der letzten Klammer lesen.
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

/** Spielfenster aus `xwininfo -root -tree`: oberste Ebene, WM_CLASS `zwiftapp.exe`, nicht winzig; bei mehreren das größte. */
export function findZwiftWindow(tree: string): XWindow | null {
  const lines = tree.split('\n').map((l) => WINDOW_LINE.exec(l)).filter((m): m is RegExpExecArray => m !== null);
  if (!lines.length) return null;
  const top = Math.min(...lines.map((m) => m[1].length));
  let best: XWindow | null = null;
  for (const m of lines) {
    if (m[1].length !== top) continue;
    if (m[3].toLowerCase() !== WINDOW_CLASS && m[4].toLowerCase() !== WINDOW_CLASS) continue;
    const width = Number(m[5]);
    const height = Number(m[6]);
    if (width < MIN_SIDE || height < MIN_SIDE) continue;
    if (!best || width * height > best.width * best.height) best = { id: Number.parseInt(m[2], 16), hex: m[2], width, height };
  }
  return best;
}

/** `GAMESCOPE_FOCUSED_WINDOW(CARDINAL) = 67108869` → 67108869; `null`, wenn die Eigenschaft fehlt. */
export function parseFocusedWindow(out: string): number | null {
  const m = /GAMESCOPE_FOCUSED_WINDOW\(CARDINAL\)\s*=\s*(\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

export interface WindowWatcherOptions {
  exec: XExec;
  /** Liest `GAMESCOPE_FOCUSED_WINDOW`: Die Eigenschaft liegt am Wurzelfenster des primären gamescope-X-Servers (`:0`), die Spielfenster dagegen am X-Server des Spiels (bei Rollout meist `:1`). Vorgabe: `exec`. */
  focusExec?: XExec;
  /** AppID des Rollout-Eintrags; `null` = nicht aus Steam gestartet, dann wird nichts gesetzt und nichts gemeldet */
  appId: string | null;
  /** Wird bei jedem Wechsel zwischen sichtbar und nicht sichtbar gerufen (am Anfang: nicht sichtbar) */
  onVisible: (visible: boolean) => void;
  /** Hinweise für das Protokoll (z. B. gesetzte AppID, Werkzeugfehler) */
  onNote?: (text: string) => void;
  intervalMs?: number;
}

export interface WindowWatcher {
  stop(): void;
  /** Das Zwift-Fenster ist das fokussierte Fenster. */
  readonly visible: boolean;
}

/**
 * Fragt regelmäßig den X-Server (gamescope-Xwayland `:0`) ab, bis `stop()` kommt: Findet es das Zwift-Fenster, trägt es
 * `STEAM_GAME=<AppID>` ein (einmal je Fenster; die Launcher-Fenster von Zwift werden durch das Spielfenster ersetzt, dann wieder),
 * und meldet „sichtbar“ erst, wenn gamescope dieses Fenster fokussiert hat. Läufe nie überlappend, Fehler einzelner Abfragen
 * (Server noch nicht bereit, Fenster weg) lassen die Überwachung weiterlaufen.
 */
export function watchZwiftWindow(opts: WindowWatcherOptions): WindowWatcher {
  const { exec, appId } = opts;
  const focusExec = opts.focusExec ?? exec;
  let stopped = false;
  let visible = false;
  let tagged = 0;
  let timer: NodeJS.Timeout | null = null;
  let lastNote = '';
  const note = (text: string): void => { if (text !== lastNote) { lastNote = text; opts.onNote?.(text); } };
  const setVisible = (value: boolean): void => { if (value !== visible && !stopped) { visible = value; opts.onVisible(value); } };

  const tick = async (): Promise<void> => {
    const win = findZwiftWindow(await exec('xwininfo', ['-root', '-tree']));
    if (!win) { tagged = 0; note('kein Zwift-Fenster gefunden'); setVisible(false); return; }
    if (tagged !== win.id) {
      await exec('xprop', ['-id', win.hex, '-f', 'STEAM_GAME', '32c', '-set', 'STEAM_GAME', appId as string]);
      tagged = win.id;
      note(`STEAM_GAME=${appId} an Fenster ${win.hex} gesetzt`);
    }
    setVisible(parseFocusedWindow(await focusExec('xprop', ['-root', 'GAMESCOPE_FOCUSED_WINDOW'])) === win.id);
  };

  const loop = async (): Promise<void> => {
    try { await tick(); } catch (e) { note(`Fensterabfrage: ${(e as Error).message.split('\n')[0]}`); }
    if (!stopped) timer = setTimeout(() => { void loop(); }, opts.intervalMs ?? 1000);
  };

  if (appId) void loop();
  else note('Rollout läuft nicht unter Steam (keine AppID im Prozessbaum): Zwift-Fenster bleibt ohne STEAM_GAME');
  return {
    stop: () => { stopped = true; if (timer) clearTimeout(timer); },
    get visible() { return visible; }
  };
}

/**
 * Zugriff des Containers auf X: netbrains zwift.sh ruft `xhost +local:` auf und nimmt es nie zurück. Wer vorher keinen
 * `LOCAL:`-Eintrag hatte, bekommt ihn nach dem Spiel zurückgesetzt. Beides ist Best Effort (ohne `xhost` passiert nichts).
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

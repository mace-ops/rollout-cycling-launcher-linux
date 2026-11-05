// Vertrag zwischen Oberfläche und Hauptprozess. Der Hauptprozess liefert den Zustand,
// die Oberfläche zeichnet ihn und löst nur Befehle aus.

export type AppId = 'mywhoosh' | 'zwift';
export const APP_IDS: readonly AppId[] = ['mywhoosh', 'zwift'];
export const APP_NAMES: Record<AppId, string> = { mywhoosh: 'MyWhoosh', zwift: 'Zwift' };

/**
 * Warum eine Installation oder Prüfung nicht klappte (leer = kein Problem). `net` Download, `verify` Prüfsumme oder Pin,
 * `disk` Ablegen, `runtime` keine nutzbare Container-Laufzeit, `tag` kein Image eingestellt, `pull` Ziehen des Images, `error` sonst.
 */
export type AppProblem = '' | 'net' | 'verify' | 'disk' | 'runtime' | 'tag' | 'pull' | 'error';

export interface AppInfo {
  installed: boolean;
  /** Version des installierten Spiels, wenn bekannt (echtes MyWhoosh: aus dem Spielordner), sonst leer */
  version: string;
  steam: boolean;
  updateAvailable: boolean;
  problem: AppProblem;
}

export type GraphicsOutput = 'auto' | 'wayland' | 'x11';

export interface Overrides {
  mode: 'rec' | 'custom';
  version: string;
  graphics: GraphicsOutput;
}

export interface Job {
  app: AppId;
  kind: 'install' | 'update';
  progress: number;
  steam: boolean;
  hd: boolean;
}

/**
 * `failed`: der Start kam nicht zustande, `Launch.problem` nennt den Grund (nur bei echtem Zwift).
 * `stopping`: Zwift wird beendet (der Container braucht dafür bis zu etwa 12 s), ein neuer Start ist so lange gesperrt.
 */
export type LaunchPhase = 'updates' | 'bluetooth' | 'starting' | 'running' | 'bterror' | 'crash' | 'failed' | 'stopping';

export interface Launch {
  app: AppId;
  phase: LaunchPhase;
  progress: number;
  /** Grund bei `phase === 'failed'`, sonst leer */
  problem: AppProblem;
  /** Nur Zwift im Spielmodus: Das Spielfenster ist im Fokus, also zu sehen (sonst fehlt das Feld oder ist `false`) */
  visible?: boolean;
}

export interface Sensor {
  kind: 'trainer' | 'heartrate';
  /** Die letzten vier Stellen der Adresse */
  id: string;
  name: string;
}

export interface Scan {
  running: boolean;
  found: Sensor[];
}

export interface Finished {
  seq: number;
  app: AppId;
  kind: 'install' | 'update';
}

export type UpdateChannel = 'stable' | 'beta';

/**
 * Zustand des Launcher-Updates (Konzept 6.1). `none`: ohne Wächter oder auf anderer Architektur, die Oberfläche zeigt nichts.
 * `next` und `mb` gelten für available, downloading und ready, `progress` nur beim Laden.
 */
export type SelfUpdateStatus =
  | 'none' | 'current' | 'checking' | 'checkFailed' | 'available' | 'downloading' | 'ready' | 'invalid' | 'noSpace' | 'manual';

export interface SelfUpdate {
  status: SelfUpdateStatus;
  /** Laufende Version */
  version: string;
  next: string;
  mb: number;
  progress: number;
  /** Spiel oder Installation läuft: Neustart gesperrt */
  blocked: boolean;
  /** Vorherige Version, leer wenn es keine gibt oder sie gesperrt ist */
  previous: string;
  /** Version, die zurückgenommen wurde, leer wenn kein Hinweis offen ist */
  notice: string;
}

export type SteamState = 'in' | 'out' | 'unavailable';
export type SteamResult = 'done' | 'steam-running' | 'unavailable' | 'error';

/** Rollout als Nicht-Steam-Spiel in der Steam-Bibliothek */
export interface RolloutSteam {
  state: SteamState;
  steamRunning: boolean;
  busy: boolean;
  message: string;
}

export interface Snapshot {
  apps: Record<AppId, AppInfo>;
  job: Job | null;
  launch: Launch | null;
  scan: Scan;
  bluetooth: { state: 'ready' | 'problem' };
  autoUpdate: boolean;
  updateChannel: UpdateChannel;
  selfUpdate: SelfUpdate;
  rolloutSteam: RolloutSteam;
  /** „auto“ oder ein Sprachcode wie „en“ */
  language: string;
  theme: 'auto' | 'dark' | 'light';
  /** „auto“ oder Prozent, etwa „125“ */
  scale: string;
  /** Sprache des Systems, etwa „de-DE“ */
  systemLocale: string;
  overrides: Record<AppId, Overrides>;
  finished: Finished | null;
  /** Tag des Zwift-Images, das die Installation zieht (Zustimmungsdialog); leer, solange Zwift nur simuliert wird */
  zwiftTag: string;
  /** Gefundene Container-Laufzeit für Zwift: `podman`, `docker`, leer = keine nutzbare, `null` = unbekannt (noch nicht geprüft oder Zwift simuliert) */
  zwiftRuntime: string | null;
}

export interface InstallOptions {
  steam: boolean;
  hd: boolean;
}

export interface LaunchOptions {
  ignoreBluetooth?: boolean;
  safe?: boolean;
}

export interface RolloutApi {
  getSnapshot(): Promise<Snapshot>;
  install(app: AppId, options: InstallOptions): Promise<void>;
  startUpdate(app: AppId): Promise<void>;
  launch(app: AppId, options?: LaunchOptions): Promise<void>;
  stopLaunch(): Promise<void>;
  scanBluetooth(): Promise<void>;
  setSteam(app: AppId, on: boolean): Promise<void>;
  setAutoUpdate(on: boolean): Promise<void>;
  setUpdateChannel(channel: UpdateChannel): Promise<void>;
  /** Launcher-Update: von Hand prüfen, laden, Laden abbrechen, neu starten (Hauptprozess prüft „belegt“ erneut) */
  checkSelfUpdate(): Promise<void>;
  downloadSelfUpdate(): Promise<void>;
  cancelSelfUpdate(): Promise<void>;
  restartForUpdate(): Promise<void>;
  startPreviousVersion(): Promise<void>;
  dismissUpdateNotice(): Promise<void>;
  /** Meldet, dass die Oberfläche das erste Mal gezeichnet hat (Gesund-Meldung an den Wächter) */
  uiReady(): void;
  setLanguage(code: string): Promise<void>;
  setTheme(theme: 'auto' | 'dark' | 'light'): Promise<void>;
  setScale(scale: string): Promise<void>;
  /** Mit `restart` schließt Rollout Steam kurz und startet es wieder, sonst meldet es „steam-running“. */
  setRolloutInSteam(on: boolean, restart: boolean): Promise<SteamResult>;
  remove(app: AppId): Promise<void>;
  createReport(): Promise<void>;
  /** Öffnet die Seite von netbrain/zwift im Browser */
  openZwiftProject(): Promise<void>;
  setOverrides(app: AppId, patch: Partial<Overrides>): Promise<void>;
  resetOverrides(): Promise<void>;
  quit(): void;
  onSnapshot(listener: (snapshot: Snapshot) => void): void;
}

/** Namen der Befehle, die der Hauptprozess annimmt. Alles andere wird abgelehnt. */
export const COMMANDS = [
  'getSnapshot', 'install', 'startUpdate', 'launch', 'stopLaunch', 'scanBluetooth', 'setSteam',
  'setAutoUpdate', 'setUpdateChannel', 'checkSelfUpdate', 'downloadSelfUpdate', 'cancelSelfUpdate', 'restartForUpdate',
  'startPreviousVersion', 'dismissUpdateNotice', 'uiReady', 'setLanguage', 'setTheme', 'setScale', 'setRolloutInSteam', 'remove', 'createReport', 'openZwiftProject', 'setOverrides', 'resetOverrides'
] as const;
export type Command = (typeof COMMANDS)[number];

/**
 * Beispielwerte, bis die Adapter echte Größen liefern. Zwift: Docker Hub liefert für 1.124.0 etwa 6 GB, entpackt belegt das Image am Ally
 * (Podman 5.8.2, Stand 2026-11-05) 20,4 GB.
 */
export const download = (app: AppId, hd: boolean): number => (app === 'mywhoosh' ? (hd ? 15 : 4) : 6.2);
export const space = (app: AppId, hd: boolean): number => (app === 'mywhoosh' ? (hd ? 20 : 8) : 20.4);

export const RECOMMENDED_PROTON = 'GE-Proton11-9';
export const PROTON_VERSIONS = ['GE-Proton11-12', 'GE-Proton11-11', 'GE-Proton11-8'] as const;

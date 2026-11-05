// Contract between the UI and the main process. The main process delivers the state,
// the UI renders it and only triggers commands.

export type AppId = 'mywhoosh' | 'zwift';
export const APP_IDS: readonly AppId[] = ['mywhoosh', 'zwift'];
export const APP_NAMES: Record<AppId, string> = { mywhoosh: 'MyWhoosh', zwift: 'Zwift' };

/**
 * Why an installation or check failed (empty = no problem). `net` download, `verify` checksum or pin,
 * `disk` storing, `runtime` no usable container runtime, `tag` no image configured, `pull` pulling the image, `error` otherwise.
 */
export type AppProblem = '' | 'net' | 'verify' | 'disk' | 'runtime' | 'tag' | 'pull' | 'error';

export interface AppInfo {
  installed: boolean;
  /** Version of the installed game if known (real MyWhoosh: from the game directory), otherwise empty */
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
 * `failed`: the start did not happen, `Launch.problem` names the reason (real Zwift only).
 * `stopping`: Zwift is being quit (the container needs up to about 12 s for that), a new start is blocked until then.
 */
export type LaunchPhase = 'updates' | 'bluetooth' | 'starting' | 'running' | 'bterror' | 'crash' | 'failed' | 'stopping';

export interface Launch {
  app: AppId;
  phase: LaunchPhase;
  progress: number;
  /** Reason when `phase === 'failed'`, otherwise empty */
  problem: AppProblem;
  /** Zwift in Gaming Mode only: the game window is in focus, i.e. visible (otherwise the field is missing or `false`) */
  visible?: boolean;
}

export interface Sensor {
  kind: 'trainer' | 'heartrate';
  /** The last four digits of the address */
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
 * State of the launcher update (concept 6.1). `none`: without watcher or on a different architecture, the UI shows nothing.
 * `next` and `mb` apply to available, downloading and ready, `progress` only while downloading.
 */
export type SelfUpdateStatus =
  | 'none' | 'current' | 'checking' | 'checkFailed' | 'available' | 'downloading' | 'ready' | 'invalid' | 'noSpace' | 'manual';

export interface SelfUpdate {
  status: SelfUpdateStatus;
  /** Running version */
  version: string;
  next: string;
  mb: number;
  progress: number;
  /** Game or installation running: restart blocked */
  blocked: boolean;
  /** Previous version, empty if there is none or it is blocked */
  previous: string;
  /** Version that was rolled back, empty if no notice is pending */
  notice: string;
}

export type SteamState = 'in' | 'out' | 'unavailable';
export type SteamResult = 'done' | 'steam-running' | 'unavailable' | 'error';

/** Rollout as a non-Steam game in the Steam library */
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
  /** "auto" or a language code like "en" */
  language: string;
  theme: 'auto' | 'dark' | 'light';
  /** "auto" or a percentage, e.g. "125" */
  scale: string;
  /** Sprache des Systems, etwa „de-DE“ */
  systemLocale: string;
  overrides: Record<AppId, Overrides>;
  finished: Finished | null;
  /** Tag of the Zwift image the installation pulls (consent dialog); empty while Zwift is only simulated */
  zwiftTag: string;
  /** Detected container runtime for Zwift: `podman`, `docker`, empty = none usable, `null` = unknown (not checked yet or Zwift simulated) */
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
  /** Launcher update: check by hand, download, cancel download, restart (the main process checks "busy" again) */
  checkSelfUpdate(): Promise<void>;
  downloadSelfUpdate(): Promise<void>;
  cancelSelfUpdate(): Promise<void>;
  restartForUpdate(): Promise<void>;
  startPreviousVersion(): Promise<void>;
  dismissUpdateNotice(): Promise<void>;
  /** Reports that the UI has painted for the first time (healthy report to the watcher) */
  uiReady(): void;
  setLanguage(code: string): Promise<void>;
  setTheme(theme: 'auto' | 'dark' | 'light'): Promise<void>;
  setScale(scale: string): Promise<void>;
  /** With `restart` Rollout briefly closes Steam and starts it again, otherwise it reports "steam-running". */
  setRolloutInSteam(on: boolean, restart: boolean): Promise<SteamResult>;
  remove(app: AppId): Promise<void>;
  createReport(): Promise<void>;
  /** Opens the netbrain/zwift page in the browser */
  openZwiftProject(): Promise<void>;
  setOverrides(app: AppId, patch: Partial<Overrides>): Promise<void>;
  resetOverrides(): Promise<void>;
  quit(): void;
  onSnapshot(listener: (snapshot: Snapshot) => void): void;
}

/** Names of the commands the main process accepts. Everything else is rejected. */
export const COMMANDS = [
  'getSnapshot', 'install', 'startUpdate', 'launch', 'stopLaunch', 'scanBluetooth', 'setSteam',
  'setAutoUpdate', 'setUpdateChannel', 'checkSelfUpdate', 'downloadSelfUpdate', 'cancelSelfUpdate', 'restartForUpdate',
  'startPreviousVersion', 'dismissUpdateNotice', 'uiReady', 'setLanguage', 'setTheme', 'setScale', 'setRolloutInSteam', 'remove', 'createReport', 'openZwiftProject', 'setOverrides', 'resetOverrides'
] as const;
export type Command = (typeof COMMANDS)[number];

/**
 * Example values until the adapters deliver real sizes. Zwift: Docker Hub delivers about 6 GB for 1.124.0; unpacked, the image takes up on the Ally
 * (Podman 5.8.2, as of 2026-11-05) 20.4 GB.
 */
export const download = (app: AppId, hd: boolean): number => (app === 'mywhoosh' ? (hd ? 15 : 4) : 6.2);
export const space = (app: AppId, hd: boolean): number => (app === 'mywhoosh' ? (hd ? 20 : 8) : 20.4);

export const RECOMMENDED_PROTON = 'GE-Proton11-9';
export const PROTON_VERSIONS = ['GE-Proton11-12', 'GE-Proton11-11', 'GE-Proton11-8'] as const;

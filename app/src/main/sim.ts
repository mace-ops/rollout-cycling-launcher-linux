// Platzhalter für die echten Adapter: simuliert Installation, Start und Bluetooth-Suche,
// damit sich die Oberfläche vollständig bedienen lässt. Ersetzt wird nur diese Datei.
// Zustände für Tests über Umgebungsvariablen:
//   ROLLOUT_SIM_STATE=fresh      keine App installiert
//   ROLLOUT_SIM_UPDATE=1         für installierte Apps ist ein Update da
//   ROLLOUT_BT=fake              Bluetooth-Attrappe statt bluetoothctl (der Klicktest erzwingt das)
//   ROLLOUT_SIM_BT=problem       mit der Attrappe: Adapter meldet ein Problem, nichts wird gefunden
//   ROLLOUT_SIM_CRASH=1          Spiel beendet sich nach dem Start
//   ROLLOUT_SIM_LANG=de          Sprache fest wählen (sonst die gespeicherte oder „auto“ nach Systemsprache)
//   ROLLOUT_SIM_THEME=light      Aussehen fest wählen (dark oder light)
//   ROLLOUT_CONFIG_HOME=<Ordner> Ort der config.toml, im Test ein Wegwerf-Ordner
//   ROLLOUT_SIM_SELFUPDATE=<Zustand> Launcher-Update fest wählen, siehe selfupdate-fake.ts (kein Teil dieser Datei)
import type {
  AppId, InstallOptions, LaunchOptions, Overrides, RolloutApi, Snapshot, SteamResult, UpdateChannel
} from '../shared/api';
import type { BluetoothService } from './bluetooth';
import type { Settings, SettingsStore } from './config';
import type { SelfUpdateService } from './selfupdate';
import type { SteamInfo, SteamStatus } from './steam';

const TICK_MS = 120;
const LAUNCH_STEPS = 30;
const SCAN_SECONDS = 15;

const freshOverrides = (): Record<AppId, Overrides> => ({
  mywhoosh: { mode: 'rec', version: 'GE-Proton11-12', graphics: 'auto' },
  zwift: { mode: 'rec', version: 'GE-Proton11-12', graphics: 'auto' }
});

/** Zugriff auf Steam. Im Test ersetzt `FakeSteam` den echten Zugriff, damit keine Steam-Dateien angefasst werden. */
export interface SteamService {
  status(): SteamInfo;
  set(on: boolean, restart: boolean): Promise<{ status: SteamStatus; message: string }>;
}

export class FakeSteam implements SteamService {
  private in = false;
  constructor(private readonly running: boolean) {}
  status(): SteamInfo { return { state: this.in ? 'in' : 'out', steamRunning: this.running, message: '' }; }
  async set(on: boolean, restart: boolean): Promise<{ status: SteamStatus; message: string }> {
    if (this.running && !restart) return { status: 'steam-running', message: '' };
    this.in = on;
    return { status: 'done', message: '' };
  }
}

type Backend = Omit<RolloutApi, 'quit' | 'onSnapshot'>;

export class SimBackend implements Backend {
  private state: Snapshot;
  private launchOptions: LaunchOptions = {};
  private launchStep = 0;
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;
  private wasBusy = false;

  constructor(
    private readonly emit: (snapshot: Snapshot) => void,
    systemLocale: string,
    private readonly steam: SteamService,
    private readonly store: SettingsStore,
    private readonly bt: BluetoothService,
    private readonly updates: SelfUpdateService,
    env: NodeJS.ProcessEnv = process.env
  ) {
    const saved = store.load();
    const fresh = env.ROLLOUT_SIM_STATE === 'fresh';
    const update = env.ROLLOUT_SIM_UPDATE === '1';
    this.state = {
      apps: {
        mywhoosh: { installed: !fresh, steam: !fresh, updateAvailable: !fresh && update },
        zwift: { installed: false, steam: false, updateAvailable: false }
      },
      job: null,
      launch: null,
      scan: { running: false, found: [] },
      bluetooth: { state: 'ready' },
      autoUpdate: saved.autoUpdate,
      updateChannel: saved.updateChannel,
      selfUpdate: updates.snapshot(),
      rolloutSteam: { state: 'out', steamRunning: false, busy: false, message: '' },
      language: env.ROLLOUT_SIM_LANG || saved.language,
      scale: env.ROLLOUT_SIM_SCALE || saved.scale,
      theme: env.ROLLOUT_SIM_THEME === 'dark' || env.ROLLOUT_SIM_THEME === 'light' ? env.ROLLOUT_SIM_THEME : saved.theme,
      systemLocale,
      overrides: freshOverrides(),
      finished: null
    };
    this.crash = env.ROLLOUT_SIM_CRASH === '1';
  }

  private readonly crash: boolean;

  async getSnapshot(): Promise<Snapshot> {
    this.refreshSteam();
    this.state.bluetooth.state = await this.bt.adapter();
    return this.view();
  }

  private view(): Snapshot {
    this.state.selfUpdate = this.updates.snapshot();
    return structuredClone(this.state);
  }

  /** Spiel oder Installation läuft: Launcher-Updates werden dann weder geladen noch eingespielt. */
  busy(): boolean { return !!(this.state.job || this.state.launch); }

  /** Das Launcher-Update hat sich geändert, die Oberfläche bekommt den neuen Zustand. */
  refresh(): void { this.emit(this.view()); }

  settings(): { autoUpdate: boolean; channel: UpdateChannel } {
    return { autoUpdate: this.state.autoUpdate, channel: this.state.updateChannel };
  }

  async install(app: AppId, options: InstallOptions): Promise<void> {
    if (this.state.job || this.state.apps[app].installed) return;
    this.state.job = { app, kind: 'install', progress: 0, steam: options.steam, hd: options.hd };
    this.changed();
  }

  async startUpdate(app: AppId): Promise<void> {
    const info = this.state.apps[app];
    if (this.state.job || !info.installed || !info.updateAvailable) return;
    this.state.job = { app, kind: 'update', progress: 0, steam: info.steam, hd: false };
    this.changed();
  }

  async launch(app: AppId, options: LaunchOptions = {}): Promise<void> {
    if (!this.state.apps[app].installed) return;
    this.launchOptions = options;
    this.launchStep = 0;
    this.state.launch = { app, phase: 'updates', progress: 0 };
    this.changed();
  }

  async stopLaunch(): Promise<void> {
    this.state.launch = null;
    this.changed();
  }

  async scanBluetooth(): Promise<void> {
    if (this.state.scan.running) return;
    this.state.scan = { running: true, found: [] };
    this.changed();
    await this.bt.scan((sensor) => {
      if (!this.state.scan.found.some((s) => s.id === sensor.id)) this.state.scan.found.push(sensor);
      this.changed();
    }, SCAN_SECONDS);
    this.state.scan.running = false;
    this.state.bluetooth.state = await this.bt.adapter();
    this.changed();
  }

  async setSteam(app: AppId, on: boolean): Promise<void> {
    this.state.apps[app].steam = on;
    this.changed();
  }

  private persist(): void {
    const { language, theme, scale, autoUpdate, updateChannel } = this.state;
    const settings: Settings = { language, theme, scale, autoUpdate, updateChannel };
    this.store.save(settings);
  }

  async setAutoUpdate(on: boolean): Promise<void> {
    this.state.autoUpdate = on;
    this.persist();
    this.updates.settingsChanged();
    this.changed();
  }

  async setUpdateChannel(channel: UpdateChannel): Promise<void> {
    if (this.state.updateChannel === channel) return;
    this.state.updateChannel = channel;
    this.persist();
    this.updates.settingsChanged();
    this.changed();
  }

  async checkSelfUpdate(): Promise<void> { await this.updates.check(true); }
  async downloadSelfUpdate(): Promise<void> { await this.updates.download(); }
  async cancelSelfUpdate(): Promise<void> { this.updates.cancel(); }
  async restartForUpdate(): Promise<void> { this.updates.restart(); }
  async startPreviousVersion(): Promise<void> { this.updates.startPrevious(); }
  async dismissUpdateNotice(): Promise<void> { this.updates.dismissNotice(); }
  async uiReady(): Promise<void> { this.updates.uiReady(); }

  async setLanguage(code: string): Promise<void> {
    this.state.language = code;
    this.persist();
    this.changed();
  }

  async setScale(scale: string): Promise<void> {
    this.state.scale = scale;
    this.persist();
    this.changed();
  }

  currentScale(): string {
    return this.state.scale;
  }

  async setTheme(theme: 'auto' | 'dark' | 'light'): Promise<void> {
    this.state.theme = theme;
    this.persist();
    this.changed();
  }

  async setRolloutInSteam(on: boolean, restart: boolean): Promise<SteamResult> {
    this.state.rolloutSteam.busy = true;
    this.changed();
    const result = await this.steam.set(on, restart);
    this.refreshSteam();
    this.state.rolloutSteam.busy = false;
    this.state.rolloutSteam.message = result.status === 'error' ? result.message : '';
    this.changed();
    return result.status;
  }

  private refreshSteam(): void {
    const info = this.steam.status();
    Object.assign(this.state.rolloutSteam, { state: info.state, steamRunning: info.steamRunning });
    if (info.state === 'unavailable') this.state.rolloutSteam.message = info.message;
  }

  async remove(app: AppId): Promise<void> {
    if (this.state.job?.app === app || this.state.launch?.app === app) return;
    this.state.apps[app] = { installed: false, steam: false, updateAvailable: false };
    this.state.overrides[app] = freshOverrides()[app];
    this.changed();
  }

  async createReport(): Promise<void> {
    // Die echte Hilfedatei entsteht später im Adapter.
  }

  async setOverrides(app: AppId, patch: Partial<Overrides>): Promise<void> {
    Object.assign(this.state.overrides[app], patch);
    this.changed();
  }

  async resetOverrides(): Promise<void> {
    this.state.overrides = freshOverrides();
    if (this.state.updateChannel !== 'stable') {
      this.state.updateChannel = 'stable';
      this.persist();
      this.updates.settingsChanged();
    }
    this.changed();
  }

  private changed(): void {
    const busy = this.busy();
    if (busy !== this.wasBusy) {
      this.wasBusy = busy;
      this.updates.busyChanged();
    }
    this.emit(this.view());
    if (busy && !this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
    if (!busy && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const { job, launch } = this.state;
    if (job) {
      job.progress = Math.min(100, job.progress + 1);
      if (job.progress >= 100) {
        const info = this.state.apps[job.app];
        info.installed = true;
        info.steam = job.steam;
        info.updateAvailable = false;
        this.state.finished = { seq: (this.seq += 1), app: job.app, kind: job.kind };
        this.state.job = null;
      }
    }
    if (launch && launch.phase !== 'running' && launch.phase !== 'bterror' && launch.phase !== 'crash') {
      this.launchStep += 1;
      launch.progress = Math.round((this.launchStep / LAUNCH_STEPS) * 100);
      launch.phase = this.launchStep < 10 ? 'updates' : this.launchStep < 20 ? 'bluetooth' : 'starting';
      if (this.launchStep >= LAUNCH_STEPS) {
        if (this.state.bluetooth.state === 'problem' && !this.launchOptions.ignoreBluetooth) launch.phase = 'bterror';
        else if (this.crash && !this.launchOptions.safe) launch.phase = 'crash';
        else launch.phase = 'running';
      }
    }
    this.changed();
  }
}


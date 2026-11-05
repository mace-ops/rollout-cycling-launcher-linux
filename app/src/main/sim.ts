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
//   ROLLOUT_ZWIFT=real|fake      Zwift echt (zwift.sh laden, Image ziehen, Zustand aus der Container-Laufzeit) oder als Attrappe, siehe zwift.ts;
//                                ohne die Variable gilt Zwift als echt, sobald bin/rollout-run da ist (chooseZwiftMode in zwift.ts); ROLLOUT_ZWIFT=sim erzwingt die Simulation.
//                                Mit dem Dienst starten, beenden und entfernen auch Zwift echt (rollout-run zwift, podman rmi über rollout-run --zwift-remove).
//   ROLLOUT_ZWIFT_RUNNING_MS=<ms> Zeit vom Start des Containers bis „Läuft“ (Vorgabe 20000; Zwift meldet das nicht selbst)
import type {
  AppId, AppProblem, InstallOptions, Launch, LaunchOptions, Overrides, RolloutApi, Snapshot, SteamResult, UpdateChannel
} from '../shared/api';
import type { BluetoothService } from './bluetooth';
import type { Settings, SettingsStore } from './config';
import type { SelfUpdateService } from './selfupdate';
import type { SteamInfo, SteamStatus } from './steam';
import { RUN_PROBLEM, ZwiftError, isStartLine, type ZwiftRun, type ZwiftService } from './zwift';

const TICK_MS = 120;
const LAUNCH_STEPS = 30;
const SCAN_SECONDS = 15;
/** Beim echten Zwift-Zustand fragt die Oberfläche höchstens so oft nach der Container-Laufzeit. */
const ZWIFT_STATUS_TTL_MS = 5000;
/** Fortschritt beim Laden von zwift.sh und bei jeder fertigen Image-Schicht (Schätzung: die Gesamtzahl der Schichten ist unbekannt). */
const ZWIFT_SCRIPT_PERCENT = 5;
const ZWIFT_LAYER_PERCENT = 6;
const ZWIFT_MAX_PERCENT = 95;
/** Der Container meldet „läuft“ nicht; Rollout nimmt es an, wenn er so lange nach dem Start noch lebt. */
const ZWIFT_RUNNING_MS = 20_000;
/** Fehlt die Startzeile in der Ausgabe von zwift.sh (anderer Wortlaut), läuft die Anzeige nach dieser Zeit trotzdem weiter. */
const ZWIFT_START_FALLBACK_MS = 8000;
/** Endet der Start mit einem Fehler innerhalb dieser Zeit, gilt er als Absturz direkt nach dem Start. */
const ZWIFT_CRASH_WINDOW_MS = 90_000;
const LAYER_DONE = /Copying blob .* done|Pull complete|Already exists|already exists/i;

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
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly zwift: ZwiftService | null = null
  ) {
    const saved = store.load();
    const fresh = env.ROLLOUT_SIM_STATE === 'fresh';
    const update = env.ROLLOUT_SIM_UPDATE === '1';
    this.state = {
      apps: {
        mywhoosh: { installed: !fresh, steam: !fresh, updateAvailable: !fresh && update, problem: '' },
        zwift: { installed: false, steam: false, updateAvailable: false, problem: '' }
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
      finished: null,
      zwiftTag: ''
    };
    this.syncZwiftTag();
    this.crash = env.ROLLOUT_SIM_CRASH === '1';
  }

  private readonly crash: boolean;

  async getSnapshot(): Promise<Snapshot> {
    await this.refreshZwift();
    this.refreshSteam();
    this.state.bluetooth.state = await this.bt.adapter();
    return this.view();
  }

  private view(): Snapshot {
    this.state.selfUpdate = this.updates.snapshot();
    return structuredClone(this.state);
  }

  private realJob = false;
  private zwiftCheckedAt = 0;
  /** Fehler der letzten Installation und Befund der letzten Prüfung; die Karte zeigt zuerst den Installationsfehler. */
  private zwiftInstallProblem: AppProblem = '';
  private zwiftStatusProblem: AppProblem = '';
  private zwiftRemoveProblem: AppProblem = '';
  private zwiftRemoving = false;
  private zwiftRun: ZwiftRun | null = null;
  private zwiftStopping = false;
  private zwiftTimers: NodeJS.Timeout[] = [];
  private launchStartedAt = 0;
  private phaseStartedAt = 0;

  /** Tag, den „Installieren“ zieht: Umgebung vor config.toml vor dem Pin (so wählt es auch rollout-run). Leer ohne Dienst. */
  private syncZwiftTag(): void {
    this.state.zwiftTag = this.zwift ? this.env.ROLLOUT_ZWIFT_TAG || this.store.load().zwiftTag || this.zwift.defaultTag : '';
  }

  /**
   * Zwift gilt als installiert, wenn das gepinnte `zwift.sh` da ist und das eingestellte Image lokal liegt. Der Zustand kommt
   * aus der Container-Laufzeit, nicht aus dem Gedächtnis dieser Sitzung; während einer Installation bleibt er unberührt.
   */
  private async refreshZwift(force = false): Promise<void> {
    // Während Installation, Entfernen und Spiel fragt niemand die Laufzeit: Der Zustand gehört dann dem laufenden Vorgang.
    if (!this.zwift || this.realJob || this.zwiftRemoving || this.zwiftRun || (!force && Date.now() - this.zwiftCheckedAt < ZWIFT_STATUS_TTL_MS)) return;
    const status = await this.zwift.status();
    this.zwiftCheckedAt = Date.now();
    if (this.realJob || this.zwiftRemoving || this.zwiftRun) return;
    this.syncZwiftTag();
    const info = this.state.apps.zwift;
    info.installed = status.script && status.image;
    // „Kein Tag“ ist vor der ersten Installation normal und kein Fehler.
    this.zwiftStatusProblem = info.installed || status.problem === 'tag' ? '' : status.problem;
    if (info.installed) this.zwiftInstallProblem = '';
    else info.steam = false;
    info.problem = this.zwiftRemoveProblem || this.zwiftInstallProblem || this.zwiftStatusProblem;
  }

  private async installZwift(zwift: ZwiftService, steam: boolean): Promise<void> {
    const info = this.state.apps.zwift;
    this.zwiftInstallProblem = '';
    this.zwiftRemoveProblem = '';
    info.problem = this.zwiftStatusProblem;
    this.realJob = true;
    this.state.job = { app: 'zwift', kind: 'install', progress: 0, steam, hd: false };
    this.changed();
    const signal = new AbortController().signal;
    try {
      await zwift.installScript(signal);
      this.setJobProgress(ZWIFT_SCRIPT_PERCENT);
      // Die Bestätigung im Installieren-Dialog gilt für genau diese Version des Images: Ohne eigenen Eintrag trägt Rollout den Pin ein.
      const saved = this.store.load();
      if (!saved.zwiftTag) this.store.save({ ...saved, zwiftTag: zwift.defaultTag });
      this.syncZwiftTag();
      let layers = 0;
      await zwift.pullImage((line) => {
        if (LAYER_DONE.test(line)) { layers += 1; this.setJobProgress(Math.min(ZWIFT_MAX_PERCENT, ZWIFT_SCRIPT_PERCENT + layers * ZWIFT_LAYER_PERCENT)); }
      }, signal);
      const status = await zwift.status();
      if (!(status.script && status.image)) throw new ZwiftError('pull', 'Image nach dem Ziehen nicht gefunden');
      info.installed = true;
      info.steam = steam;
      info.updateAvailable = false;
      this.state.finished = { seq: (this.seq += 1), app: 'zwift', kind: 'install' };
    } catch (e) {
      // Über das Feld `problem` statt `instanceof`: Dienst und Backend können aus verschiedenen Bündeln stammen (Tests).
      const code = (e as { problem?: string }).problem;
      this.zwiftInstallProblem = code === 'abort' ? '' : (code as AppProblem | undefined) || 'error';
      info.problem = this.zwiftInstallProblem || this.zwiftStatusProblem;
    } finally {
      this.realJob = false;
      this.zwiftCheckedAt = 0;
      this.state.job = null;
      this.changed();
    }
  }

  private setJobProgress(percent: number): void {
    if (this.state.job) { this.state.job.progress = percent; this.changed(); }
  }

  /** Spiel oder Installation läuft: Launcher-Updates werden dann weder geladen noch eingespielt. */
  busy(): boolean { return !!(this.state.job || this.state.launch); }

  /** Das Launcher-Update hat sich geändert, die Oberfläche bekommt den neuen Zustand. */
  refresh(): void { this.emit(this.view()); }

  settings(): { autoUpdate: boolean; channel: UpdateChannel } {
    return { autoUpdate: this.state.autoUpdate, channel: this.state.updateChannel };
  }

  async install(app: AppId, options: InstallOptions): Promise<void> {
    if (this.state.job || this.state.apps[app].installed || (app === 'zwift' && this.zwiftRemoving)) return;
    if (app === 'zwift' && this.zwift) { void this.installZwift(this.zwift, options.steam); return; }
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
    if (app === 'zwift' && this.zwift) { this.launchZwift(this.zwift); return; }
    this.launchOptions = options;
    this.launchStep = 0;
    this.state.launch = { app, phase: 'updates', progress: 0, problem: '' };
    this.changed();
  }

  /**
   * Zwift echt starten: `rollout-run zwift` im Vordergrund. Die Phasen kommen aus seiner Ausgabe: „Vorbereiten“ bis zur Zeile, mit der
   * zwift.sh den Container startet, danach „Spiel startet“ und nach ZWIFT_RUNNING_MS „Läuft“. Bluetooth prüft Rollout hier nicht (Zwift
   * nimmt Sensoren über Telefon oder Direct Connect, Konzept 8).
   */
  private launchZwift(zwift: ZwiftService): void {
    if (this.zwiftRun || this.zwiftRemoving || this.realJob) return;
    this.launchStartedAt = Date.now();
    this.phaseStartedAt = this.launchStartedAt;
    this.state.launch = { app: 'zwift', phase: 'updates', progress: 5, problem: '' };
    this.zwiftStopping = false;
    const run: ZwiftRun = zwift.start((line) => { if (this.zwiftRun === run && isStartLine(line)) this.zwiftStarting(); });
    this.zwiftRun = run;
    this.zwiftTimers = [setTimeout(() => this.zwiftStarting(), ZWIFT_START_FALLBACK_MS)];
    void run.done.then((code) => this.zwiftEnded(run, code));
    this.changed();
  }

  private zwiftStarting(): void {
    const launch = this.state.launch;
    if (!this.zwiftRun || !launch || launch.phase !== 'updates') return;
    launch.phase = 'starting';
    this.phaseStartedAt = Date.now();
    const ms = Number(this.env.ROLLOUT_ZWIFT_RUNNING_MS) || ZWIFT_RUNNING_MS;
    this.zwiftTimers.push(setTimeout(() => {
      if (this.zwiftRun && this.state.launch?.phase === 'starting') { this.state.launch.phase = 'running'; this.state.launch.progress = 100; this.changed(); }
    }, ms));
    this.changed();
  }

  private zwiftEnded(run: ZwiftRun, code: number | null): void {
    if (this.zwiftRun !== run) return;
    this.zwiftRun = null;
    this.zwiftTimers.forEach(clearTimeout);
    this.zwiftTimers = [];
    this.zwiftCheckedAt = 0;
    const launch = this.state.launch;
    const stopped = this.zwiftStopping;
    this.zwiftStopping = false;
    if (!launch || stopped || code === 0) this.state.launch = null;
    else if (code !== null && RUN_PROBLEM[code]) Object.assign(launch, { phase: 'failed', problem: RUN_PROBLEM[code] });
    else if (Date.now() - this.launchStartedAt < ZWIFT_CRASH_WINDOW_MS) launch.phase = 'crash';
    else this.state.launch = null;
    this.changed();
  }

  /** Fortschritt des echten Zwift-Starts: weich gegen das Ende jeder Phase, nie rückwärts. */
  private stepZwiftLaunch(launch: Launch): void {
    if (launch.phase !== 'updates' && launch.phase !== 'starting') return;
    const seconds = (Date.now() - this.phaseStartedAt) / 1000;
    const [from, span, tau] = launch.phase === 'updates' ? [5, 45, 3] : [55, 40, 10];
    launch.progress = Math.max(launch.progress, Math.round(from + span * (1 - Math.exp(-seconds / tau))));
  }

  async stopLaunch(): Promise<void> {
    const run = this.zwiftRun;
    if (run) {
      // Das Spiel beenden und abwarten: Erst danach ist run.pid weg und ein neuer Start möglich.
      this.zwiftStopping = true;
      run.stop();
      await run.done;
      return;
    }
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
    // Zwift-Tag und -Digest pflegt der Nutzer von Hand in config.toml: Beim Speichern bleiben sie erhalten.
    const { zwiftTag, zwiftDigest } = this.store.load();
    const settings: Settings = { language, theme, scale, autoUpdate, updateChannel, zwiftTag, zwiftDigest };
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
    if (app === 'zwift' && this.zwift) { await this.removeZwift(this.zwift); return; }
    this.state.apps[app] = { installed: false, steam: false, updateAvailable: false, problem: '' };
    this.state.overrides[app] = freshOverrides()[app];
    this.changed();
  }

  /** Image entfernen (Konzept 5.3). Die Rückfrage stellt die Oberfläche. Das Skript und die Container-Laufzeit bleiben. */
  private async removeZwift(zwift: ZwiftService): Promise<void> {
    if (this.zwiftRemoving || this.realJob || this.zwiftRun) return;
    const info = this.state.apps.zwift;
    this.zwiftRemoving = true;
    this.zwiftRemoveProblem = '';
    try {
      await zwift.removeImage(new AbortController().signal);
      Object.assign(info, { installed: false, steam: false, updateAvailable: false });
      this.state.overrides.zwift = freshOverrides().zwift;
      this.zwiftInstallProblem = '';
    } catch (e) {
      const code = (e as { problem?: string }).problem;
      this.zwiftRemoveProblem = code === 'abort' ? '' : code === 'runtime' || code === 'tag' ? code : 'error';
    } finally {
      this.zwiftRemoving = false;
      this.zwiftCheckedAt = 0;
    }
    await this.refreshZwift(true);
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
    if (job && !this.realJob) {
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
    if (launch?.app === 'zwift' && this.zwift) this.stepZwiftLaunch(launch);
    else if (launch && launch.phase !== 'running' && launch.phase !== 'bterror' && launch.phase !== 'crash') {
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


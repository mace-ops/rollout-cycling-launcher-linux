// Placeholder for the real adapters: simulates installation, start and Bluetooth scan
// so the UI can be operated completely. Only this file is replaced.
// States for tests via environment variables:
//   ROLLOUT_SIM_STATE=fresh      no app installed
//   ROLLOUT_SIM_UPDATE=1         an update is available for installed apps
//   ROLLOUT_BT=fake              Bluetooth fake instead of bluetoothctl (the click test enforces this)
//   ROLLOUT_SIM_BT=problem       with the fake: adapter reports a problem, nothing is found
//   ROLLOUT_SIM_CRASH=1          game exits after the start
//   ROLLOUT_SIM_LANG=de          fix the language (otherwise the saved one or "auto" by system language)
//   ROLLOUT_SIM_THEME=light      fix the appearance (dark or light)
//   ROLLOUT_CONFIG_HOME=<dir> location of config.toml, a throwaway directory in tests
//   ROLLOUT_SIM_SELFUPDATE=<state> fix the launcher update, see selfupdate-fake.ts (not part of this file)
//   ROLLOUT_ZWIFT=real|fake      Zwift real (download zwift.sh, pull image, state from the container runtime) or as a fake, see zwift.ts;
//                                without the variable Zwift counts as real as soon as bin/rollout-run exists (chooseZwiftMode in zwift.ts); ROLLOUT_ZWIFT=sim forces the simulation.
//                                With the service, Zwift is also started, quit and removed for real (rollout-run zwift, podman rmi via rollout-run --zwift-remove).
//   ROLLOUT_ZWIFT_WINDOWS=off    do not detect the Zwift window in Gaming Mode and do not mark it for gamescope (zwift-window.ts); ROLLOUT_ZWIFT_DISPLAY=<:N> selects the X server (default :0)
//   ROLLOUT_ZWIFT_RUNNING_MS=<ms> time from the container start to "Running" (default 20000; Zwift does not report this itself)
//   ROLLOUT_MYWHOOSH=real|sim    MyWhoosh real (vendor/mywhoosh.sh via rollout-run, state from ~/Games/mywhoosh-linux) or simulated, see mywhoosh.ts;
//                                without the variable MyWhoosh counts as real as soon as bin/rollout-run and vendor/mywhoosh.sh exist (chooseMywhooshMode).
//                                MYWHOOSH_ROOT=<dir> moves the game directory (tests); ROLLOUT_MYWHOOSH_RUNNING_MS=<ms> time from the start to "Running" (default 20000).
import type {
  AppId, AppProblem, InstallOptions, Launch, LaunchOptions, Overrides, RolloutApi, Snapshot, SteamResult, UpdateChannel
} from '../shared/api';
import type { BluetoothService } from './bluetooth';
import type { Settings, SettingsStore } from './config';
import type { SelfUpdateService } from './selfupdate';
import type { SteamInfo, SteamStatus } from './steam';
import { MYWHOOSH_RUN_PROBLEM, type MywhooshRun, type MywhooshService } from './mywhoosh';
import { RUN_PROBLEM, ZwiftError, isRunningLine, isStartLine, type ZwiftRun, type ZwiftService } from './zwift';

const TICK_MS = 120;
const LAUNCH_STEPS = 30;
const SCAN_SECONDS = 15;
/** For the real Zwift state the UI asks the container runtime at most this often. */
const ZWIFT_STATUS_TTL_MS = 5000;
/** Progress when downloading zwift.sh and for each finished image layer (estimate: the total number of layers is unknown). */
const ZWIFT_SCRIPT_PERCENT = 5;
const ZWIFT_LAYER_PERCENT = 6;
const ZWIFT_MAX_PERCENT = 95;
/** The container does not report "running"; Rollout assumes it if it is still alive this long after the start. */
const ZWIFT_RUNNING_MS = 20_000;
/** If the start line is missing from zwift.sh's output (different wording), the display moves on after this time anyway. */
const ZWIFT_START_FALLBACK_MS = 8000;
/** If the start ends with an error within this time, it counts as a crash right after the start. */
const ZWIFT_CRASH_WINDOW_MS = 90_000;
/** MyWhoosh does not report "running"; Rollout assumes it if the game is still alive this long after the "starting" line (Wine and umu need a moment). */
const MYWHOOSH_RUNNING_MS = 20_000;
const LAYER_DONE = /Copying blob .* done|Pull complete|Already exists|already exists/i;

const freshOverrides = (): Record<AppId, Overrides> => ({
  mywhoosh: { mode: 'rec', version: 'GE-Proton11-12', graphics: 'auto' },
  zwift: { mode: 'rec', version: 'GE-Proton11-12', graphics: 'auto' }
});

/** Access to Steam. In tests `FakeSteam` replaces the real access so no Steam files are touched. */
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
    private readonly zwift: ZwiftService | null = null,
    private readonly mywhoosh: MywhooshService | null = null
  ) {
    const saved = store.load();
    const fresh = env.ROLLOUT_SIM_STATE === 'fresh';
    const update = env.ROLLOUT_SIM_UPDATE === '1';
    this.state = {
      apps: {
        mywhoosh: { installed: !fresh && !mywhoosh, version: '', steam: !fresh && !mywhoosh, updateAvailable: !fresh && !mywhoosh && update, problem: '' },
        zwift: { installed: false, version: '', steam: false, updateAvailable: false, problem: '' }
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
      zwiftTag: '',
      zwiftRuntime: null
    };
    this.syncZwiftTag();
    this.crash = env.ROLLOUT_SIM_CRASH === '1';
    // Real MyWhoosh: the state comes from disk, even the first snapshot shows it.
    this.refreshMywhoosh();
  }

  private readonly crash: boolean;

  async getSnapshot(): Promise<Snapshot> {
    await this.refreshZwift();
    this.refreshMywhoosh();
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
  /** Error of the last installation and result of the last check; the card shows the installation error first. */
  private zwiftInstallProblem: AppProblem = '';
  private zwiftStatusProblem: AppProblem = '';
  private zwiftRemoveProblem: AppProblem = '';
  private zwiftRemoving = false;
  private zwiftRun: ZwiftRun | null = null;
  private zwiftStopping = false;
  private zwiftTimers: NodeJS.Timeout[] = [];
  private launchStartedAt = 0;
  private phaseStartedAt = 0;

  /** Tag that "Install" pulls: environment before config.toml before the pin (rollout-run chooses the same way). Empty without a service. */
  private syncZwiftTag(): void {
    this.state.zwiftTag = this.zwift ? this.env.ROLLOUT_ZWIFT_TAG || this.store.load().zwiftTag || this.zwift.defaultTag : '';
  }

  /**
   * Zwift counts as installed when the pinned `zwift.sh` is there and the configured image exists locally. The state comes
   * from the container runtime, not from this session's memory; during an installation it stays untouched.
   */
  private async refreshZwift(force = false): Promise<void> {
    // During installation, removal and game nobody queries the runtime: the state then belongs to the running operation.
    if (!this.zwift || this.realJob || this.zwiftRemoving || this.zwiftRun || (!force && Date.now() - this.zwiftCheckedAt < ZWIFT_STATUS_TTL_MS)) return;
    let status = await this.zwift.status();
    // The image is already there (for example pulled by hand), only the small verified start script is missing: reload it quietly instead of
    // showing "Install". If that fails (no network), it stays "not installed" and the next check tries again.
    if (status.image && !status.script) {
      try { await this.zwift.installScript(new AbortController().signal); status = await this.zwift.status(); } catch { /* next check */ }
    }
    this.zwiftCheckedAt = Date.now();
    if (this.realJob || this.zwiftRemoving || this.zwiftRun) return;
    this.syncZwiftTag();
    // Empty means "missing" only if the runtime is really missing (exit 10); for other errors it is unknown.
    this.state.zwiftRuntime = status.runtime || (status.problem === 'runtime' ? '' : null);
    const info = this.state.apps.zwift;
    info.installed = status.script && status.image;
    // "No tag" is normal before the first installation and not an error.
    this.zwiftStatusProblem = info.installed || status.problem === 'tag' ? '' : status.problem;
    if (info.installed) this.zwiftInstallProblem = '';
    else info.steam = false;
    info.problem = this.zwiftRemoveProblem || this.zwiftInstallProblem || this.zwiftStatusProblem;
  }

  // ---------- MyWhoosh echt (mywhoosh.ts) ----------

  private mwInstallProblem: AppProblem = '';
  private mwRemoveProblem: AppProblem = '';
  /** Setup, update or removal is running; `abort` cancels it (Rollout quitting). */
  private mwJob: { abort: AbortController; done: Promise<void> } | null = null;
  private mwRun: MywhooshRun | null = null;
  private mwStopping = false;
  private mwTimers: NodeJS.Timeout[] = [];

  /** State from the game directory. During an operation or a game it belongs to that operation. */
  private refreshMywhoosh(): void {
    if (!this.mywhoosh || this.mwJob || this.mwRun) return;
    const status = this.mywhoosh.status();
    const info = this.state.apps.mywhoosh;
    info.installed = status.installed;
    info.version = status.version;
    if (!status.installed) Object.assign(info, { steam: false, updateAvailable: false });
    else this.mwInstallProblem = '';
    info.problem = this.mwRemoveProblem || (status.installed ? '' : this.mwInstallProblem);
  }

  /** Runs `work` as setup or update of MyWhoosh; a failure shows up as a problem on the card, nothing hangs. */
  private async runMywhooshJob(kind: 'install' | 'update', steam: boolean, hd: boolean, work: (svc: MywhooshService, onPercent: (p: number) => void, signal: AbortSignal) => Promise<void>): Promise<void> {
    const svc = this.mywhoosh;
    if (!svc) return;
    const info = this.state.apps.mywhoosh;
    this.mwInstallProblem = '';
    this.mwRemoveProblem = '';
    info.problem = '';
    const abort = new AbortController();
    this.state.job = { app: 'mywhoosh', kind, progress: 0, steam, hd };
    const run = (async (): Promise<void> => {
      try {
        await work(svc, (p) => this.setJobProgress(p), abort.signal);
        const status = svc.status();
        info.installed = status.installed;
        info.version = status.version;
        info.steam = status.installed && steam;
        info.updateAvailable = false;
        this.state.finished = { seq: (this.seq += 1), app: 'mywhoosh', kind };
      } catch (e) {
        const code = (e as { problem?: string }).problem;
        this.mwInstallProblem = code === 'abort' ? '' : (code as AppProblem | undefined) || 'error';
        info.problem = this.mwInstallProblem;
      } finally {
        this.mwJob = null;
        this.state.job = null;
        this.refreshMywhoosh();
        this.changed();
      }
    })();
    this.mwJob = { abort, done: run };
    this.changed();
    await run;
  }

  private launchMywhoosh(mywhoosh: MywhooshService, options: LaunchOptions): void {
    if (this.mwRun || this.mwJob) return;
    this.launchStartedAt = Date.now();
    this.phaseStartedAt = this.launchStartedAt;
    this.mwStopping = false;
    // Bluetooth first: without an adapter the game starts but finds no trainer. "Start anyway" skips the check.
    this.state.launch = { app: 'mywhoosh', phase: 'bluetooth', progress: 3, problem: '' };
    this.changed();
    const token = this.launchStartedAt;
    void this.bt.adapter().then((adapter) => {
      this.state.bluetooth.state = adapter;
      if (this.state.launch?.app !== 'mywhoosh' || this.launchStartedAt !== token || this.mwStopping) return;
      if (adapter === 'problem' && !options.ignoreBluetooth) {
        this.state.launch = { app: 'mywhoosh', phase: 'bterror', progress: 20, problem: '' };
        this.changed();
        return;
      }
      this.startMywhooshRun(mywhoosh);
    });
  }

  private startMywhooshRun(mywhoosh: MywhooshService): void {
    this.phaseStartedAt = Date.now();
    this.state.launch = { app: 'mywhoosh', phase: 'updates', progress: 5, problem: '' };
    const run: MywhooshRun = mywhoosh.start((line) => {
      if (this.mwRun !== run) return;
      if (/\[mywhoosh\] starting MyWhoosh/.test(line)) this.mywhooshStarting();
    }, (visible) => {
      if (this.mwRun !== run || this.state.launch?.app !== 'mywhoosh') return;
      this.state.launch.visible = visible;
      this.changed();
    });
    this.mwRun = run;
    void run.done.then((code) => this.mywhooshEnded(run, code));
    this.changed();
  }

  private mywhooshStarting(): void {
    const launch = this.state.launch;
    if (!this.mwRun || !launch || launch.phase !== 'updates') return;
    launch.phase = 'starting';
    this.phaseStartedAt = Date.now();
    const ms = Number(this.env.ROLLOUT_MYWHOOSH_RUNNING_MS) || MYWHOOSH_RUNNING_MS;
    this.mwTimers.push(setTimeout(() => {
      const l = this.state.launch;
      if (!this.mwRun || l?.app !== 'mywhoosh' || l.phase !== 'starting') return;
      l.phase = 'running';
      l.progress = 100;
      this.changed();
    }, ms));
    this.changed();
  }

  private mywhooshEnded(run: MywhooshRun, code: number | null): void {
    if (this.mwRun !== run) return;
    this.mwRun = null;
    this.mwTimers.forEach(clearTimeout);
    this.mwTimers = [];
    const launch = this.state.launch;
    const stopped = this.mwStopping;
    this.mwStopping = false;
    if (launch) launch.visible = false;
    // An update during the start may have changed the version.
    this.refreshMywhoosh();
    if (!launch || stopped || code === 0) this.state.launch = null;
    else if (code !== null && MYWHOOSH_RUN_PROBLEM[code]) Object.assign(launch, { phase: 'failed', problem: MYWHOOSH_RUN_PROBLEM[code] });
    else if (Date.now() - this.launchStartedAt < ZWIFT_CRASH_WINDOW_MS) launch.phase = 'crash';
    else this.state.launch = null;
    this.changed();
  }

  private async removeMywhoosh(mywhoosh: MywhooshService): Promise<void> {
    if (this.mwJob || this.mwRun) return;
    const info = this.state.apps.mywhoosh;
    this.mwRemoveProblem = '';
    const abort = new AbortController();
    const run = (async (): Promise<void> => {
      try {
        await mywhoosh.uninstall(abort.signal);
        Object.assign(info, { installed: false, version: '', steam: false, updateAvailable: false });
        this.state.overrides.mywhoosh = freshOverrides().mywhoosh;
        this.mwInstallProblem = '';
      } catch (e) {
        const code = (e as { problem?: string }).problem;
        this.mwRemoveProblem = code === 'abort' ? '' : 'error';
      } finally {
        this.mwJob = null;
        this.refreshMywhoosh();
        this.changed();
      }
    })();
    this.mwJob = { abort, done: run };
    this.changed();
    await run;
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
      // The confirmation in the install dialog applies to exactly this version of the image: without its own entry Rollout writes the pin.
      const saved = this.store.load();
      if (!saved.zwiftTag) this.store.save({ ...saved, zwiftTag: zwift.defaultTag });
      this.syncZwiftTag();
      let layers = 0;
      await zwift.pullImage((line) => {
        if (LAYER_DONE.test(line)) { layers += 1; this.setJobProgress(Math.min(ZWIFT_MAX_PERCENT, ZWIFT_SCRIPT_PERCENT + layers * ZWIFT_LAYER_PERCENT)); }
      }, signal);
      const status = await zwift.status();
      if (!(status.script && status.image)) throw new ZwiftError('pull', 'Image not found after pulling');
      info.installed = true;
      info.steam = steam;
      info.updateAvailable = false;
      this.state.finished = { seq: (this.seq += 1), app: 'zwift', kind: 'install' };
    } catch (e) {
      // Via the `problem` field instead of `instanceof`: service and backend may come from different bundles (tests).
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

  /** A game or installation is running: launcher updates are then neither downloaded nor applied. */
  busy(): boolean { return !!(this.state.job || this.state.launch); }

  /** The launcher update has changed, the UI receives the new state. */
  refresh(): void { this.emit(this.view()); }

  settings(): { autoUpdate: boolean; channel: UpdateChannel } {
    return { autoUpdate: this.state.autoUpdate, channel: this.state.updateChannel };
  }

  async install(app: AppId, options: InstallOptions): Promise<void> {
    if (this.state.job || this.state.apps[app].installed || (app === 'zwift' && this.zwiftRemoving)) return;
    if (app === 'zwift' && this.zwift) { void this.installZwift(this.zwift, options.steam); return; }
    if (app === 'mywhoosh' && this.mywhoosh) {
      if (this.mwJob || this.mwRun) return;
      void this.runMywhooshJob('install', options.steam, options.hd, (svc, onPercent, signal) => svc.install({ hd: options.hd }, onPercent, signal));
      return;
    }
    this.state.job = { app, kind: 'install', progress: 0, steam: options.steam, hd: options.hd };
    this.changed();
  }

  async startUpdate(app: AppId): Promise<void> {
    const info = this.state.apps[app];
    if (this.state.job || !info.installed || !info.updateAvailable) return;
    if (app === 'mywhoosh' && this.mywhoosh) {
      void this.runMywhooshJob('update', info.steam, false, (svc, onPercent, signal) => svc.update(onPercent, signal));
      return;
    }
    this.state.job = { app, kind: 'update', progress: 0, steam: info.steam, hd: false };
    this.changed();
  }

  async launch(app: AppId, options: LaunchOptions = {}): Promise<void> {
    if (!this.state.apps[app].installed) return;
    if (app === 'zwift' && this.zwift) { this.launchZwift(this.zwift); return; }
    if (app === 'mywhoosh' && this.mywhoosh) { this.launchMywhoosh(this.mywhoosh, options); return; }
    this.launchOptions = options;
    this.launchStep = 0;
    this.state.launch = { app, phase: 'updates', progress: 0, problem: '' };
    this.changed();
  }

  /**
   * Start Zwift for real: `rollout-run zwift` in the foreground. The phases come from its output: "Preparing" up to the line with which
   * zwift.sh starts the container, then "Game starting" and after ZWIFT_RUNNING_MS "Running". Rollout does not check Bluetooth here (Zwift
   * takes sensors via phone or Direct Connect, concept 8).
   */
  private launchZwift(zwift: ZwiftService): void {
    if (this.zwiftRun || this.zwiftRemoving || this.realJob) return;
    this.launchStartedAt = Date.now();
    this.phaseStartedAt = this.launchStartedAt;
    this.state.launch = { app: 'zwift', phase: 'updates', progress: 5, problem: '' };
    this.zwiftStopping = false;
    const run: ZwiftRun = zwift.start((line) => {
      if (this.zwiftRun !== run) return;
      if (isStartLine(line)) this.zwiftStarting();
      else if (isRunningLine(line)) this.zwiftRunning();
    }, (visible) => {
      if (this.zwiftRun !== run || this.state.launch?.app !== 'zwift') return;
      this.state.launch.visible = visible;
      this.changed();
    });
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
    this.zwiftTimers.push(setTimeout(() => this.zwiftRunning(), ms));
    this.changed();
  }

  /** "Running": message of the container, at the latest after ZWIFT_RUNNING_MS. If the start line did not come, it goes via "Starting Zwift". */
  private zwiftRunning(): void {
    if (this.state.launch?.phase === 'updates') this.zwiftStarting();
    const launch = this.state.launch;
    if (!this.zwiftRun || launch?.phase !== 'starting') return;
    launch.phase = 'running';
    launch.progress = 100;
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
    if (launch) launch.visible = false;
    if (!launch || stopped || code === 0) this.state.launch = null;
    else if (code !== null && RUN_PROBLEM[code]) Object.assign(launch, { phase: 'failed', problem: RUN_PROBLEM[code] });
    else if (Date.now() - this.launchStartedAt < ZWIFT_CRASH_WINDOW_MS) launch.phase = 'crash';
    else this.state.launch = null;
    this.changed();
  }

  /** Progress of the real Zwift start: soft towards the end of each phase, never backwards. */
  private stepZwiftLaunch(launch: Launch): void {
    if (launch.phase !== 'updates' && launch.phase !== 'starting') return;
    const seconds = (Date.now() - this.phaseStartedAt) / 1000;
    const [from, span, tau] = launch.phase === 'updates' ? [5, 45, 3] : [55, 40, 10];
    launch.progress = Math.max(launch.progress, Math.round(from + span * (1 - Math.exp(-seconds / tau))));
  }

  /** Is a real game running that must be quit when Rollout quits? */
  hasRunningGame(): boolean { return this.zwiftRun !== null || this.mwRun !== null || this.mwJob !== null; }

  async stopLaunch(): Promise<void> {
    const job = this.mwJob;
    if (job) {
      // Cancel setup or removal and wait: otherwise a half game would remain in the directory and the script would keep running as an orphan.
      job.abort.abort();
      await job.done;
      return;
    }
    const mw = this.mwRun;
    if (mw) {
      this.mwStopping = true;
      if (this.state.launch) { this.state.launch.phase = 'stopping'; this.changed(); }
      mw.stop();
      await mw.done;
      return;
    }
    // Abort during the Bluetooth check: nothing is running, the check's answer is discarded (marker launchStartedAt).
    if (this.state.launch?.app === 'mywhoosh' && this.state.launch.phase === 'bluetooth') this.launchStartedAt = 0;
    const run = this.zwiftRun;
    if (run) {
      // Quit the game and wait: only then is run.pid gone and a new start possible.
      this.zwiftStopping = true;
      if (this.state.launch) { this.state.launch.phase = 'stopping'; this.changed(); }
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
    // The user maintains the Zwift tag and digest by hand in config.toml: they are preserved when saving.
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
    if (app === 'mywhoosh' && this.mywhoosh) { await this.removeMywhoosh(this.mywhoosh); return; }
    this.state.apps[app] = { installed: false, version: '', steam: false, updateAvailable: false, problem: '' };
    this.state.overrides[app] = freshOverrides()[app];
    this.changed();
  }

  /** Remove the image (concept 5.3). The UI asks for confirmation. The script and the container runtime stay. */
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

  /** Opening in the browser is handled by the main process (main.ts); here only for the interface. */
  async openZwiftProject(): Promise<void> { /* nothing */ }

  async createReport(): Promise<void> {
    // The real help file is created later in the adapter.
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
    if (job && !this.realJob && !this.mwJob) {
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
    if ((launch?.app === 'zwift' && this.zwift) || (launch?.app === 'mywhoosh' && this.mywhoosh)) this.stepZwiftLaunch(launch);
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


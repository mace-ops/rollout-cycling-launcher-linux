import { app, BrowserWindow, ipcMain, nativeImage, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { APP_IDS, COMMANDS, type AppId, type Command, type Snapshot, type UpdateChannel } from '../shared/api';
import { FakeSteam, SimBackend, type SteamService } from './sim';
import { artworkComplete, writeArtwork } from './artwork';
import { FakeBluetooth, realBluetooth } from './bluetooth';
import { fileStore } from './config';
import { SelfUpdater, type SelfUpdateService } from './selfupdate';
import { FakeFeed, FakeSelfUpdate } from './selfupdate-fake';
import { UPDATE_KEYS } from './selfupdate-keys';
import { realFeed } from './selfupdate-net';
import upstreams from '../../upstreams.json';
import { RealMywhoosh, chooseMywhooshMode, type MywhooshService } from './mywhoosh';
import { FakeZwift, RealZwift, chooseZwiftMode, type ZwiftService } from './zwift';
import { zoomFor } from './zoom';
import * as steam from './steam';

let win: BrowserWindow | null = null;

/** From Steam and in Gaming Mode Rollout starts fullscreen. `--fullscreen` forces it, `--windowed` prevents it. */
const startsFullscreen = (): boolean => {
  if (process.argv.includes('--windowed')) return false;
  return process.argv.includes('--fullscreen') || !!process.env.SteamGameId || !!process.env.SteamAppId
    || !!process.env.GAMESCOPE_WAYLAND_DISPLAY || process.env.XDG_CURRENT_DESKTOP === 'gamescope';
};

const isApp = (value: unknown): value is AppId => APP_IDS.includes(value as AppId);

/** Version of this directory. `__dirname` points to the real version directory, `app.getAppPath()` only to the `current` symlink. */
const ownVersion = (): string => JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).version;

/**
 * The fake replaces the network with a directory and takes the key from the environment. It applies only with
 * ROLLOUT_HOME, ROLLOUT_SELFUPDATE_DIR and ROLLOUT_SELFUPDATE_KEY, otherwise the app aborts.
 */
function selfUpdateService(settings: () => { autoUpdate: boolean; channel: UpdateChannel }, busy: () => boolean): SelfUpdateService {
  const env = process.env;
  const version = ownVersion();
  if (env.ROLLOUT_SIM_SELFUPDATE) return new FakeSelfUpdate(env.ROLLOUT_SIM_SELFUPDATE, version);
  const fake = env.ROLLOUT_SELFUPDATE === 'fake';
  if (fake && !(env.ROLLOUT_HOME && env.ROLLOUT_SELFUPDATE_DIR && env.ROLLOUT_SELFUPDATE_KEY)) {
    console.error('ROLLOUT_SELFUPDATE=fake requires ROLLOUT_HOME, ROLLOUT_SELFUPDATE_DIR and ROLLOUT_SELFUPDATE_KEY');
    app.exit(2);
  }
  return new SelfUpdater({
    home: steam.rolloutHome(),
    version,
    keys: fake ? { test: env.ROLLOUT_SELFUPDATE_KEY ?? '' } : UPDATE_KEYS,
    feed: fake ? new FakeFeed(env.ROLLOUT_SELFUPDATE_DIR ?? '', Number(env.ROLLOUT_SELFUPDATE_DELAY_MS) || 0) : realFeed,
    supervised: env.ROLLOUT_SUPERVISED === '1',
    settings,
    busy,
    exit: (code) => app.exit(code),
    timing: fake ? { firstCheckMs: 300, healthyMs: 1000, intervalMs: 6 * 3600 * 1000 } : undefined
  });
}

// Single instance only: a second start brings the existing window to the front.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  let backend: SimBackend;
  const applyZoom = (): void => {
    if (!win || !backend) return;
    const [width, height] = win.getContentSize();
    win.webContents.setZoomFactor(zoomFor(backend.currentScale(), width, height));
  };
  const steamService = (): SteamService => process.env.ROLLOUT_SIM_STEAM === 'fake'
    ? new FakeSteam(process.env.ROLLOUT_SIM_STEAM_RUNNING === '1')
    : { status: steam.status, set: (on, restart) => steam.setRolloutInSteam(on, restart, (dir, id) => writeArtwork(dir, id, true)) };

  /**
   * Zwift real (`real`), as a fake (`fake`, state from ROLLOUT_SIM_ZWIFT) or simulated (`sim`). Without the variable `real` applies
   * as soon as bin/rollout-run exists and the pin in upstreams.json is valid (chooseZwiftMode); otherwise it stays simulated.
   */
  const zwiftService = (): ZwiftService | null => {
    const home = steam.rolloutHome();
    const mode = chooseZwiftMode({ mode: process.env.ROLLOUT_ZWIFT, runnerExists: fs.existsSync(path.join(home, 'bin/rollout-run')), pin: upstreams.zwift });
    if (mode === 'fake') return new FakeZwift(process.env.ROLLOUT_SIM_ZWIFT ?? '');
    // Window visibility in Gaming Mode (zwift-window.ts): detect the Zwift window on :0 and mark it for gamescope; ROLLOUT_ZWIFT_WINDOWS=off switches this off.
    if (mode === 'real') return new RealZwift({ home, pin: upstreams.zwift, download: realFeed.download, windows: process.env.ROLLOUT_ZWIFT_WINDOWS === 'off' ? undefined : { display: process.env.ROLLOUT_ZWIFT_DISPLAY || process.env.DISPLAY || ':0', onNote: (text) => {
      // Log for window and controller: <Rollout directory>/state/zwift-window.log
      try { fs.appendFileSync(path.join(home, 'state/zwift-window.log'), `${new Date().toISOString()} ${text}\n`); } catch { /* log is a bonus */ }
    } } });
    return null;
  };

  /**
   * MyWhoosh real (`real`: vendor/mywhoosh.sh via bin/rollout-run, state from the game directory) or simulated (`sim`). Without the variable
   * ROLLOUT_MYWHOOSH `real` applies as soon as bin/rollout-run and the bundled mywhoosh.sh exist. The file sits next to dist/ of the running version.
   */
  const mywhooshService = (): MywhooshService | null => {
    const home = steam.rolloutHome();
    const mode = chooseMywhooshMode({
      mode: process.env.ROLLOUT_MYWHOOSH,
      runnerExists: fs.existsSync(path.join(home, 'bin/rollout-run')),
      scriptExists: fs.existsSync(path.join(__dirname, '../../vendor/mywhoosh.sh'))
    });
    if (mode !== 'real') return null;
    // Window watching and controller in Gaming Mode (as with Zwift): ROLLOUT_MYWHOOSH_WINDOWS=off switches both off, ROLLOUT_MYWHOOSH_PAD=off only the controller.
    // Log: <Rollout directory>/state/mywhoosh-window.log
    const windows = process.env.ROLLOUT_MYWHOOSH_WINDOWS === 'off' ? undefined : {
      display: process.env.ROLLOUT_MYWHOOSH_DISPLAY || process.env.DISPLAY || ':0',
      onNote: (text: string) => { try { fs.appendFileSync(path.join(home, 'state/mywhoosh-window.log'), `${new Date().toISOString()} ${text}\n`); } catch { /* log is a bonus */ } }
    };
    return new RealMywhoosh({ home, windows, cursorDir: path.join(home, 'state/cursors') });
  };

  const handlers: Record<Command, (...args: unknown[]) => unknown> = {
    getSnapshot: () => backend.getSnapshot(),
    install: (id, options) => isApp(id) && backend.install(id, { steam: !!(options as { steam?: boolean })?.steam, hd: !!(options as { hd?: boolean })?.hd }),
    startUpdate: (id) => isApp(id) && backend.startUpdate(id),
    launch: (id, options) => isApp(id) && backend.launch(id, {
      ignoreBluetooth: !!(options as { ignoreBluetooth?: boolean } | undefined)?.ignoreBluetooth,
      safe: !!(options as { safe?: boolean } | undefined)?.safe
    }),
    stopLaunch: () => backend.stopLaunch(),
    scanBluetooth: () => backend.scanBluetooth(),
    setSteam: (id, on) => isApp(id) && backend.setSteam(id, !!on),
    setAutoUpdate: (on) => backend.setAutoUpdate(!!on),
    setUpdateChannel: (channel) => (channel === 'stable' || channel === 'beta') && backend.setUpdateChannel(channel),
    checkSelfUpdate: () => backend.checkSelfUpdate(),
    downloadSelfUpdate: () => backend.downloadSelfUpdate(),
    cancelSelfUpdate: () => backend.cancelSelfUpdate(),
    restartForUpdate: () => backend.restartForUpdate(),
    startPreviousVersion: () => backend.startPreviousVersion(),
    dismissUpdateNotice: () => backend.dismissUpdateNotice(),
    uiReady: () => backend.uiReady(),
    setScale: async (scale) => {
      if (typeof scale === 'string' && (scale === 'auto' || /^(1\d\d|200)$/.test(scale))) {
        await backend.setScale(scale);
        applyZoom();
      }
    },
    setTheme: (theme) => (theme === 'auto' || theme === 'dark' || theme === 'light') && backend.setTheme(theme),
    setRolloutInSteam: (on, restart) => backend.setRolloutInSteam(!!on, !!restart),
    setLanguage: (code) => typeof code === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$|^auto$/.test(code) && backend.setLanguage(code),
    remove: (id) => isApp(id) && backend.remove(id),
    createReport: () => backend.createReport(),
    // Fixed address, never determined by the renderer.
    openZwiftProject: () => shell.openExternal('https://github.com/netbrain/zwift'),
    setOverrides: (id, patch) => isApp(id) && backend.setOverrides(id, cleanPatch(patch)),
    resetOverrides: () => backend.resetOverrides()
  };

  const cleanPatch = (patch: unknown) => {
    const source = (patch ?? {}) as Record<string, unknown>;
    const result: Record<string, string> = {};
    if (source.mode === 'rec' || source.mode === 'custom') result.mode = source.mode;
    if (typeof source.version === 'string') result.version = source.version.slice(0, 40);
    if (source.graphics === 'auto' || source.graphics === 'wayland' || source.graphics === 'x11') result.graphics = source.graphics;
    return result;
  };

  ipcMain.handle('rollout', (_event, command: unknown, ...args: unknown[]) => {
    if (!COMMANDS.includes(command as Command)) throw new Error('unbekannter Befehl');
    return handlers[command as Command](...args);
  });
  /** If images are missing for an existing Steam entry, they are created at start. Steam shows them after its next start. */
  const ensureArtwork = async (): Promise<void> => {
    if (process.env.ROLLOUT_SIM_STEAM === 'fake') return;
    try {
      if (steam.status().state !== 'in') return;
      const paths = steam.rolloutSteamPaths();
      if (paths && !artworkComplete(paths.configDir, paths.appId)) await writeArtwork(paths.configDir, paths.appId, true);
    } catch { /* images are cosmetic */ }
  };

  ipcMain.on('rollout-quit', () => app.quit());

  // If Steam ends Rollout (quit game, window closed, signal), the running game must end with it: the container is not part of Rollout's
  // process tree and would otherwise keep running. The starter gets its TERM immediately; then we wait until the game is gone.
  let leaving = false;
  const leave = (): void => {
    if (leaving) return;
    if (!backend?.hasRunningGame()) { app.quit(); return; }
    leaving = true;
    void backend.stopLaunch().catch(() => {}).finally(() => app.exit(0));
  };
  app.on('before-quit', (event) => {
    if (leaving || !backend?.hasRunningGame()) return;
    event.preventDefault();
    leave();
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, leave);

  app.whenReady().then(async () => {
    // Tests only: generates the Steam images into a directory, writes a report and exits.
    if (process.env.ROLLOUT_ART_OUT) {
      const out = process.env.ROLLOUT_ART_OUT;
      await writeArtwork(out, 1, true);
      const report = fs.readdirSync(path.join(out, 'grid')).map((name) => {
        const image = nativeImage.createFromPath(path.join(out, 'grid', name));
        const { width, height } = image.getSize();
        return { name, width, height, cornerAlpha: image.toBitmap()[3] };
      });
      fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report));
      app.quit();
      return;
    }
    // The backend is created only afterwards and queries the service already in its constructor: until then "nothing busy" applies.
    const updates = selfUpdateService(() => (backend ? backend.settings() : { autoUpdate: true, channel: 'stable' }), () => (backend ? backend.busy() : false));
    backend = new SimBackend((snapshot: Snapshot) => win?.webContents.send('rollout-snapshot', snapshot), app.getLocale(), steamService(), fileStore, process.env.ROLLOUT_BT === 'fake' ? new FakeBluetooth(process.env.ROLLOUT_SIM_BT === 'problem') : realBluetooth, updates, process.env, zwiftService(), mywhooshService());
    updates.onChange(() => backend.refresh());
    updates.start();
    win = new BrowserWindow({
      title: 'Rollout',
      icon: path.join(__dirname, '../renderer/assets/brand/logo.png'),
      width: 1280,
      height: 800,
      minWidth: 1024,
      minHeight: 640,
      backgroundColor: '#08090E',
      autoHideMenuBar: true,
      fullscreen: startsFullscreen(),
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    win.removeMenu();
    // F11 toggles between fullscreen and windowed.
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F11' && win) {
        win.setFullScreen(!win.isFullScreen());
        event.preventDefault();
      }
    });
    // Local content only: no navigation, no new windows.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
    void ensureArtwork();
    win.webContents.on('did-finish-load', applyZoom);
    win.on('resize', applyZoom);
    win.on('closed', () => { win = null; });
  });

  // In image mode there is briefly no window between two images.
  app.on('window-all-closed', () => { if (!process.env.ROLLOUT_ART_OUT) app.quit(); });
}

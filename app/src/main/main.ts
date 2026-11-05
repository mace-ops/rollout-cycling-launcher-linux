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

/** Aus Steam und im Gaming Mode startet Rollout im Vollbild. `--fullscreen` erzwingt es, `--windowed` verhindert es. */
const startsFullscreen = (): boolean => {
  if (process.argv.includes('--windowed')) return false;
  return process.argv.includes('--fullscreen') || !!process.env.SteamGameId || !!process.env.SteamAppId
    || !!process.env.GAMESCOPE_WAYLAND_DISPLAY || process.env.XDG_CURRENT_DESKTOP === 'gamescope';
};

const isApp = (value: unknown): value is AppId => APP_IDS.includes(value as AppId);

/** Version dieses Ordners. `__dirname` zeigt auf den echten Versionsordner, `app.getAppPath()` nur auf den Symlink `current`. */
const ownVersion = (): string => JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).version;

/**
 * Die Attrappe ersetzt das Netz durch einen Ordner und nimmt den Schlüssel aus der Umgebung. Sie gilt nur mit
 * ROLLOUT_HOME, ROLLOUT_SELFUPDATE_DIR und ROLLOUT_SELFUPDATE_KEY, sonst bricht die App ab.
 */
function selfUpdateService(settings: () => { autoUpdate: boolean; channel: UpdateChannel }, busy: () => boolean): SelfUpdateService {
  const env = process.env;
  const version = ownVersion();
  if (env.ROLLOUT_SIM_SELFUPDATE) return new FakeSelfUpdate(env.ROLLOUT_SIM_SELFUPDATE, version);
  const fake = env.ROLLOUT_SELFUPDATE === 'fake';
  if (fake && !(env.ROLLOUT_HOME && env.ROLLOUT_SELFUPDATE_DIR && env.ROLLOUT_SELFUPDATE_KEY)) {
    console.error('ROLLOUT_SELFUPDATE=fake braucht ROLLOUT_HOME, ROLLOUT_SELFUPDATE_DIR und ROLLOUT_SELFUPDATE_KEY');
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

// Nur eine Instanz: Ein zweiter Start holt das vorhandene Fenster nach vorn.
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
   * Zwift echt (`real`), als Attrappe (`fake`, Zustand aus ROLLOUT_SIM_ZWIFT) oder simuliert (`sim`). Ohne die Variable gilt `real`,
   * sobald bin/rollout-run da ist und der Pin in upstreams.json stimmt (chooseZwiftMode); sonst bleibt es bei der Simulation.
   */
  const zwiftService = (): ZwiftService | null => {
    const home = steam.rolloutHome();
    const mode = chooseZwiftMode({ mode: process.env.ROLLOUT_ZWIFT, runnerExists: fs.existsSync(path.join(home, 'bin/rollout-run')), pin: upstreams.zwift });
    if (mode === 'fake') return new FakeZwift(process.env.ROLLOUT_SIM_ZWIFT ?? '');
    // Fenstersichtbarkeit im Spielmodus (zwift-window.ts): auf :0 das Zwift-Fenster erkennen und für gamescope kennzeichnen; ROLLOUT_ZWIFT_WINDOWS=off schaltet das ab.
    if (mode === 'real') return new RealZwift({ home, pin: upstreams.zwift, download: realFeed.download, windows: process.env.ROLLOUT_ZWIFT_WINDOWS === 'off' ? undefined : { display: process.env.ROLLOUT_ZWIFT_DISPLAY || process.env.DISPLAY || ':0', onNote: (text) => {
      // Protokoll für Fenster und Controller: <Rollout-Ordner>/state/zwift-window.log
      try { fs.appendFileSync(path.join(home, 'state/zwift-window.log'), `${new Date().toISOString()} ${text}\n`); } catch { /* Protokoll ist Zugabe */ }
    } } });
    return null;
  };

  /**
   * MyWhoosh echt (`real`: vendor/mywhoosh.sh über bin/rollout-run, Zustand aus dem Spielordner) oder simuliert (`sim`). Ohne die Variable
   * ROLLOUT_MYWHOOSH gilt `real`, sobald bin/rollout-run und die mitgelieferte mywhoosh.sh da sind. Die Datei liegt neben dist/ der laufenden Version.
   */
  const mywhooshService = (): MywhooshService | null => {
    const home = steam.rolloutHome();
    const mode = chooseMywhooshMode({
      mode: process.env.ROLLOUT_MYWHOOSH,
      runnerExists: fs.existsSync(path.join(home, 'bin/rollout-run')),
      scriptExists: fs.existsSync(path.join(__dirname, '../../vendor/mywhoosh.sh'))
    });
    if (mode !== 'real') return null;
    // Fensterüberwachung und Controller im Spielmodus (wie bei Zwift): ROLLOUT_MYWHOOSH_WINDOWS=off schaltet beides ab, ROLLOUT_MYWHOOSH_PAD=off nur den Controller.
    // Protokoll: <Rollout-Ordner>/state/mywhoosh-window.log
    const windows = process.env.ROLLOUT_MYWHOOSH_WINDOWS === 'off' ? undefined : {
      display: process.env.ROLLOUT_MYWHOOSH_DISPLAY || process.env.DISPLAY || ':0',
      onNote: (text: string) => { try { fs.appendFileSync(path.join(home, 'state/mywhoosh-window.log'), `${new Date().toISOString()} ${text}\n`); } catch { /* Protokoll ist Zugabe */ } }
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
    // Feste Adresse, nie vom Renderer bestimmt.
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
  /** Fehlen Bilder für einen vorhandenen Steam-Eintrag, entstehen sie beim Start. Steam zeigt sie nach seinem nächsten Start. */
  const ensureArtwork = async (): Promise<void> => {
    if (process.env.ROLLOUT_SIM_STEAM === 'fake') return;
    try {
      if (steam.status().state !== 'in') return;
      const paths = steam.rolloutSteamPaths();
      if (paths && !artworkComplete(paths.configDir, paths.appId)) await writeArtwork(paths.configDir, paths.appId, true);
    } catch { /* Bilder sind kosmetisch */ }
  };

  ipcMain.on('rollout-quit', () => app.quit());

  // Beendet Steam Rollout (Spiel beenden, Fenster zu, Signal), muss das laufende Spiel mit enden: Der Container hängt nicht an Rollouts
  // Prozessbaum und liefe sonst weiter. Der Starter bekommt sein TERM sofort; danach wird abgewartet, bis das Spiel weg ist.
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
    // Nur für Tests: erzeugt die Steam-Bilder in einen Ordner, schreibt einen Bericht und beendet sich.
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
    // Das Backend entsteht erst danach und fragt den Dienst schon im Konstruktor: bis dahin gilt „nichts belegt“.
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
    // F11 wechselt zwischen Vollbild und Fenster.
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F11' && win) {
        win.setFullScreen(!win.isFullScreen());
        event.preventDefault();
      }
    });
    // Nur lokale Inhalte: keine Navigation, keine neuen Fenster.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
    void ensureArtwork();
    win.webContents.on('did-finish-load', applyZoom);
    win.on('resize', applyZoom);
    win.on('closed', () => { win = null; });
  });

  // Im Bilder-Modus gibt es zwischen zwei Bildern kurz kein Fenster.
  app.on('window-all-closed', () => { if (!process.env.ROLLOUT_ART_OUT) app.quit(); });
}

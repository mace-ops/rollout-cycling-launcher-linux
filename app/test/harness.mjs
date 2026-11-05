// Shared frame for the click tests: starts Electron (directly or via bin/rollout) and drives the window over the debug protocol.
// Never real Steam: the fakes, a throwaway ROLLOUT_HOME and a throwaway ROLLOUT_CONFIG_HOME are fixed in the environment of the
// child process and can be overridden neither via `env` nor from outside. The fakes are checked before the start.
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
export const failureCount = () => failures;
export const electronBin = () => process.env.ELECTRON_BIN || require('electron');

/** Test key for the self-update: the private one stays in the test, the public one goes into the app's environment. */
export function testKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicB64: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };
}

/**
 * Starts the app and runs `steps`. `opts`:
 *   home      throwaway ROLLOUT_HOME (otherwise an empty new directory that disappears afterwards; a given one stays)
 *   launcher  path to bin/rollout instead of Electron directly (the watcher runs), then without `.` as app path
 *   feedDir, key  directory and public key (base64) for the update fake
 *   config    text for the config.toml of the throwaway directory (for example `auto_update = false`)
 *   shots     directory for screenshots
 *   userData, configHome, electron  fixed directories and program so two runs share the same profile (A3); they are kept
 */
export async function session(name, env, steps, opts = {}) {
  if (process.env.ROLLOUT_ONLY && !name.startsWith(process.env.ROLLOUT_ONLY)) return;
  const shots = opts.shots ?? process.env.ROLLOUT_SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const port = 9300 + Math.floor(Math.random() * 500);
  const stamp = `${process.pid}-${port}`;
  const home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), `rollout-smoke-home-${stamp}-`));
  const feedDir = opts.feedDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `rollout-smoke-feed-${stamp}-`));
  const childEnv = {
    ROLLOUT_SIM_LANG: 'en', ...process.env, ...env,
    // Zwift is simulated unless explicitly chosen: with a throwaway ROLLOUT_HOME without bin/rollout-run it would be anyway; the
    // setting also protects runs with their own home from the real container. `real` needs fakes (see below).
    ROLLOUT_ZWIFT: env.ROLLOUT_ZWIFT || 'sim',
    // Same for MyWhoosh: simulated unless explicitly chosen. `real` only with a fake as upstream and the game directory in the throwaway directory (checked below).
    ROLLOUT_MYWHOOSH: env.ROLLOUT_MYWHOOSH || 'sim',
    ROLLOUT_SIM_STEAM: 'fake', ROLLOUT_BT: env.ROLLOUT_BT === 'real' ? 'real' : 'fake', ROLLOUT_SELFUPDATE: 'fake',
    ROLLOUT_HOME: home, ROLLOUT_CONFIG_HOME: opts.configHome ?? path.join(os.tmpdir(), `rollout-smoke-cfg-${stamp}`),
    ROLLOUT_SELFUPDATE_DIR: feedDir, ROLLOUT_SELFUPDATE_KEY: opts.key ?? testKey().publicB64
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (opts.config) {
    fs.mkdirSync(childEnv.ROLLOUT_CONFIG_HOME, { recursive: true });
    fs.writeFileSync(path.join(childEnv.ROLLOUT_CONFIG_HOME, 'config.toml'), opts.config);
  }
  // Check before the start, not afterwards: otherwise an ineffective override would go unnoticed.
  const tmp = os.tmpdir();
  const forced = childEnv.ROLLOUT_SIM_STEAM === 'fake' && childEnv.ROLLOUT_SELFUPDATE === 'fake' && (childEnv.ROLLOUT_BT === 'fake' || env.ROLLOUT_BT === 'real')
    && childEnv.ROLLOUT_HOME.startsWith(tmp) && childEnv.ROLLOUT_CONFIG_HOME.startsWith(tmp);
  if (!forced) throw new Error('Fakes not enforced, test aborted');
  // Real Zwift (ROLLOUT_ZWIFT=real) only with container fakes: the first PATH directory contains podman and docker with the marker,
  // and rollout-run's upstream is replaced (never the real zwift.sh with a real container).
  if (childEnv.ROLLOUT_ZWIFT === 'real') {
    const first = (childEnv.PATH ?? '').split(':')[0];
    const marked = ['podman', 'docker'].every((tool) => { try { return fs.readFileSync(path.join(first, tool), 'utf8').includes('# rollout-test-attrappe'); } catch { return false; } });
    if (!first.startsWith(tmp) || !marked || !childEnv.ROLLOUT_RUN_UPSTREAM) throw new Error('Container fakes not enforced, test aborted');
  }
  if (childEnv.ROLLOUT_MYWHOOSH === 'real'
    && (!childEnv.ROLLOUT_RUN_UPSTREAM || !(childEnv.MYWHOOSH_ROOT ?? '').startsWith(tmp) || !(childEnv.HOME ?? '').startsWith(tmp))) throw new Error('MyWhoosh fake not enforced, test aborted');
  const userData = opts.userData ?? path.join(os.tmpdir(), `rollout-smoke-${stamp}`);
  const debug = `--remote-debugging-port=${port}`;
  const [cmd, args] = opts.launcher
    ? [opts.launcher, [debug, `--user-data-dir=${userData}`]]
    : [opts.electron ?? electronBin(), [debug, `--user-data-dir=${userData}`, '.']];
  const child = spawn(cmd, args, { env: childEnv, stdio: process.env.ROLLOUT_STDIO ? 'inherit' : 'ignore', cwd: root });
  const conn = { ws: null, id: 0, pending: new Map() };
  const attach = async (ms = 15000) => {
    let target;
    for (let i = 0; i < ms / 250 && !target; i += 1) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) })).json();
        target = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      } catch { /* app is still starting */ }
    }
    if (!target) throw new Error('Window not reachable');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && conn.pending.has(msg.id)) { conn.pending.get(msg.id)(msg); conn.pending.delete(msg.id); }
    };
    // If the app exits in the middle of a call (restart by the watcher), no answer ever arrives: answer open calls with an empty result.
    ws.onclose = () => { for (const resolve of conn.pending.values()) resolve({}); conn.pending.clear(); };
    conn.ws = ws;
  };
  try {
    await attach();
    const send = (method, params = {}) => new Promise((resolve) => { conn.id += 1; conn.pending.set(conn.id, resolve); conn.ws.send(JSON.stringify({ id: conn.id, method, params })); });
    const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

    const t = {
      home, feedDir, child, eval: evalJs,
      exited: (ms) => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve(true) : Promise.race([new Promise((r) => child.once('exit', () => r(true))), sleep(ms).then(() => false)])),
      text: async () => (await evalJs('document.getElementById("view")?.innerText ?? ""')) ?? '',
      has: async (needle) => (await t.text()).includes(needle),
      click: (label) => evalJs(`(() => {
        const els = [...document.querySelectorAll('#view button')].filter((b) => !b.disabled && b.offsetParent !== null);
        const el = els.find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})) || els.find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)});
        if (!el) return false; el.click(); return true; })()`),
      clickSel: (selector) => evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) return false; el.click(); return true; })()`),
      setSelect: (id, value) => evalJs(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) return false; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`),
      waitFor: async (needle, ms = 20000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await t.has(needle)) return true; await sleep(150); }
        return false;
      },
      waitUntil: async (fn, ms = 20000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await fn()) return true; await sleep(150); }
        return false;
      },
      snapshot: async () => JSON.parse((await evalJs('window.rollout.getSnapshot().then((s) => JSON.stringify(s))')) ?? 'null'),
      /** After a restart by the watcher: look for the new window on the same debug port. */
      reattach: async (ms = 40000) => { try { conn.ws.close(); } catch { /* already closed */ } await attach(ms); await t.waitFor('Rollout', 15000); },
      shot: async (label, wait = 700) => {
        if (!shots) return;
        await sleep(wait);
        const { result } = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(shots, `${name}-${label}.png`), Buffer.from(result.data, 'base64'));
      },
      /** Rendering size for screenshots, independent of the window manager (media queries and layout follow it). */
      viewport: (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
      expect: async (ok, message) => { if (!(await ok)) { failures += 1; console.log(`  ✗ ${message}`); } else console.log(`  ✓ ${message}`); },
      focus: () => evalJs('document.activeElement && (document.activeElement.textContent || document.activeElement.getAttribute("aria-label") || "").trim()')
    };
    console.log(name);
    await t.waitFor('Rollout', 15000);
    await steps(t);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${name}: ${error.message}`);
  } finally {
    try { conn.ws?.close(); } catch { /* already closed */ }
    child.kill();
    await sleep(500);
    for (const dir of [opts.userData ? null : userData, opts.configHome ? null : childEnv.ROLLOUT_CONFIG_HOME]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (!opts.home) fs.rmSync(home, { recursive: true, force: true });
    if (!opts.feedDir) fs.rmSync(feedDir, { recursive: true, force: true });
  }
}

export const failuresExit = () => { console.log(failures ? `${failures} failures` : 'all ok'); process.exit(failures ? 1 : 0); };

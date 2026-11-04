// Gemeinsamer Rahmen der Klicktests: startet Electron (direkt oder über bin/rollout) und steuert das Fenster über das Debug-Protokoll.
// Nie echtes Steam: Die Attrappen, ein Wegwerf-ROLLOUT_HOME und ein Wegwerf-ROLLOUT_CONFIG_HOME stehen fest in der Umgebung des
// Kindprozesses und lassen sich weder per `env` noch von außen überschreiben. Die Attrappen werden vor dem Start geprüft.
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

/** Testschlüssel für das Selbst-Update: der private bleibt im Test, der öffentliche geht in die Umgebung der App. */
export function testKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicB64: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };
}

/**
 * Startet die App und führt `steps` aus. `opts`:
 *   home      Wegwerf-ROLLOUT_HOME (sonst ein leerer neuer Ordner, der danach verschwindet; ein angegebener bleibt)
 *   launcher  Pfad zu bin/rollout statt Electron direkt (die Wächter-Läufe), dann ohne `.` als App-Pfad
 *   feedDir, key  Ordner und öffentlicher Schlüssel (Base64) für die Update-Attrappe
 *   config    Text für die config.toml des Wegwerf-Ordners (zum Beispiel `auto_update = false`)
 *   shots     Ordner für Screenshots
 *   userData, configHome, electron  feste Ordner und Programm, damit zwei Läufe dasselbe Profil teilen (A3); sie bleiben stehen
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
    ROLLOUT_SIM_STEAM: 'fake', ROLLOUT_BT: env.ROLLOUT_BT === 'real' ? 'real' : 'fake', ROLLOUT_SELFUPDATE: 'fake',
    ROLLOUT_HOME: home, ROLLOUT_CONFIG_HOME: opts.configHome ?? path.join(os.tmpdir(), `rollout-smoke-cfg-${stamp}`),
    ROLLOUT_SELFUPDATE_DIR: feedDir, ROLLOUT_SELFUPDATE_KEY: opts.key ?? testKey().publicB64
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (opts.config) {
    fs.mkdirSync(childEnv.ROLLOUT_CONFIG_HOME, { recursive: true });
    fs.writeFileSync(path.join(childEnv.ROLLOUT_CONFIG_HOME, 'config.toml'), opts.config);
  }
  // Prüfung vor dem Start, nicht erst danach: sonst bliebe ein wirkungsloses Überschreiben unbemerkt.
  const tmp = os.tmpdir();
  const forced = childEnv.ROLLOUT_SIM_STEAM === 'fake' && childEnv.ROLLOUT_SELFUPDATE === 'fake' && (childEnv.ROLLOUT_BT === 'fake' || env.ROLLOUT_BT === 'real')
    && childEnv.ROLLOUT_HOME.startsWith(tmp) && childEnv.ROLLOUT_CONFIG_HOME.startsWith(tmp);
  if (!forced) throw new Error('Attrappen nicht erzwungen, Test abgebrochen');
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
      } catch { /* App startet noch */ }
    }
    if (!target) throw new Error('Fenster nicht erreichbar');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && conn.pending.has(msg.id)) { conn.pending.get(msg.id)(msg); conn.pending.delete(msg.id); }
    };
    // Beendet sich die App mitten in einem Aufruf (Neustart durch den Wächter), kommt keine Antwort mehr: offene Aufrufe leer beantworten.
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
      /** Nach einem Neustart durch den Wächter: neues Fenster am selben Debug-Port suchen. */
      reattach: async (ms = 40000) => { try { conn.ws.close(); } catch { /* schon zu */ } await attach(ms); await t.waitFor('Rollout', 15000); },
      shot: async (label) => {
        if (!shots) return;
        await sleep(700);
        const { result } = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(shots, `${name}-${label}.png`), Buffer.from(result.data, 'base64'));
      },
      /** Darstellungsgröße für Screenshots, unabhängig vom Fenstermanager (Medienabfragen und Layout folgen ihr). */
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
    try { conn.ws?.close(); } catch { /* schon zu */ }
    child.kill();
    await sleep(500);
    for (const dir of [opts.userData ? null : userData, opts.configHome ? null : childEnv.ROLLOUT_CONFIG_HOME]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (!opts.home) fs.rmSync(home, { recursive: true, force: true });
    if (!opts.feedDir) fs.rmSync(feedDir, { recursive: true, force: true });
  }
}

export const failuresExit = () => { console.log(failures ? `${failures} Fehler` : 'alles ok'); process.exit(failures ? 1 : 0); };

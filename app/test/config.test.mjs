import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-config-test-'));
process.env.ROLLOUT_CONFIG_HOME = work;
for (const name of ['config', 'sim']) {
  await build({ entryPoints: [`src/main/${name}.ts`], bundle: true, platform: 'node', format: 'esm', outfile: path.join(work, `${name}.mjs`), logLevel: 'error' });
}
const config = await import(path.join(work, 'config.mjs'));
const sim = await import(path.join(work, 'sim.mjs'));

test('ohne Datei gelten die Vorgaben', () => {
  assert.deepEqual(config.fileStore.load(), config.DEFAULTS);
});

test('gespeichert werden nur Abweichungen', () => {
  config.fileStore.save({ ...config.DEFAULTS, language: 'de', theme: 'light' });
  const text = fs.readFileSync(config.configFile(), 'utf8');
  assert.match(text, /language = "de"/);
  assert.match(text, /theme = "light"/);
  assert.doesNotMatch(text, /auto_update/);
  assert.deepEqual(config.fileStore.load(), { ...config.DEFAULTS, language: 'de', theme: 'light' });
});

test('Vorgaben löschen die Datei', () => {
  config.fileStore.save({ ...config.DEFAULTS });
  assert.equal(fs.existsSync(config.configFile()), false);
});

test('ungültige Werte werden ignoriert', () => {
  const settings = config.parseConfig('language = "../../x"\ntheme = "neon"\nauto_update = maybe\nunbekannt = 1\n');
  assert.deepEqual(settings, config.DEFAULTS);
});

test('Größe wird gelesen und nur im gültigen Bereich angenommen', () => {
  assert.equal(config.parseConfig('scale = "125"\n').scale, '125');
  assert.equal(config.parseConfig('scale = "900"\n').scale, 'auto');
  assert.equal(config.parseConfig('scale = "abc"\n').scale, 'auto');
});

test('Kommentare und Leerzeilen stören nicht', () => {
  const settings = config.parseConfig('# Kommentar\n\nlanguage = "fr" # Französisch\nauto_update = false\n');
  assert.equal(settings.language, 'fr');
  assert.equal(settings.autoUpdate, false);
});

test('U5 update_channel: Vorgabe wird nicht gespeichert, Beta schon, Unsinn fällt zurück', () => {
  assert.equal(config.DEFAULTS.updateChannel, 'stable');
  assert.doesNotMatch(config.serializeConfig({ ...config.DEFAULTS }), /update_channel/);
  assert.match(config.serializeConfig({ ...config.DEFAULTS, updateChannel: 'beta' }), /update_channel = "beta"/);
  assert.equal(config.parseConfig('update_channel = "beta"\n').updateChannel, 'beta');
  for (const bad of ['"nightly"', '"BETA"', 'beta', '""', '1']) assert.equal(config.parseConfig(`update_channel = ${bad}\n`).updateChannel, 'stable', bad);
  config.fileStore.save({ ...config.DEFAULTS, updateChannel: 'beta' });
  assert.equal(config.fileStore.load().updateChannel, 'beta');
  config.fileStore.save({ ...config.DEFAULTS });
  assert.equal(fs.existsSync(config.configFile()), false);
});

test('U5 „Alles zurücksetzen“ setzt auch den Kanal zurück und löst eine Prüfung aus', async () => {
  let saved = { ...config.DEFAULTS, updateChannel: 'beta' };
  const store = { load: () => saved, save: (s) => { saved = s; } };
  let changes = 0;
  const updates = { snapshot: () => ({ status: 'current', version: '1.0.0', next: '', mb: 0, progress: 0, blocked: false, previous: '', notice: '' }), settingsChanged: () => { changes += 1; }, busyChanged() {} };
  const bt = { adapter: async () => 'ready', scan: async () => {} };
  const steam = { status: () => ({ state: 'out', steamRunning: false, message: '' }), set: async () => ({ status: 'done', message: '' }) };
  const backend = new sim.SimBackend(() => {}, 'en', steam, store, bt, updates, {});
  assert.equal((await backend.getSnapshot()).updateChannel, 'beta');
  await backend.resetOverrides();
  assert.equal((await backend.getSnapshot()).updateChannel, 'stable');
  assert.equal(saved.updateChannel, 'stable');
  assert.equal(changes, 1);
  await backend.setUpdateChannel('beta');
  assert.equal(saved.updateChannel, 'beta');
  assert.equal(changes, 2);
});

process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));

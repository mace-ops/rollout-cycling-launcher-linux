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

test('without a file the defaults apply', () => {
  assert.deepEqual(config.fileStore.load(), config.DEFAULTS);
});

test('only deviations are saved', () => {
  config.fileStore.save({ ...config.DEFAULTS, language: 'de', theme: 'light' });
  const text = fs.readFileSync(config.configFile(), 'utf8');
  assert.match(text, /language = "de"/);
  assert.match(text, /theme = "light"/);
  assert.doesNotMatch(text, /auto_update/);
  assert.deepEqual(config.fileStore.load(), { ...config.DEFAULTS, language: 'de', theme: 'light' });
});

test('defaults delete the file', () => {
  config.fileStore.save({ ...config.DEFAULTS });
  assert.equal(fs.existsSync(config.configFile()), false);
});

test('invalid values are ignored', () => {
  const settings = config.parseConfig('language = "../../x"\ntheme = "neon"\nauto_update = maybe\nunbekannt = 1\n');
  assert.deepEqual(settings, config.DEFAULTS);
});

test('size is read and accepted only within the valid range', () => {
  assert.equal(config.parseConfig('scale = "125"\n').scale, '125');
  assert.equal(config.parseConfig('scale = "900"\n').scale, 'auto');
  assert.equal(config.parseConfig('scale = "abc"\n').scale, 'auto');
});

test('comments and blank lines do not interfere', () => {
  const settings = config.parseConfig('# comment\n\nlanguage = "fr" # French\nauto_update = false\n');
  assert.equal(settings.language, 'fr');
  assert.equal(settings.autoUpdate, false);
});

test('U5 update_channel: the default is not saved, beta is, nonsense falls back', () => {
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

test('U5 "Reset all" also resets the channel and triggers a check', async () => {
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
  saved = { ...config.DEFAULTS, zwiftTag: '1.2.3' };
  await backend.setAutoUpdate(false);
  assert.equal(saved.zwiftTag, '1.2.3', 'Saving from the UI keeps the Zwift tag set by hand');
});

process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));

test('Zwift image: tag and digest are read, saved and accepted only if valid (never latest)', () => {
  const digest = `sha256:${'ab'.repeat(32)}`;
  assert.equal(config.DEFAULTS.zwiftTag, '');
  assert.doesNotMatch(config.serializeConfig({ ...config.DEFAULTS }), /zwift/);
  const text = config.serializeConfig({ ...config.DEFAULTS, zwiftTag: '1.2.3', zwiftDigest: digest });
  assert.match(text, /zwift_tag = "1\.2\.3"/);
  assert.match(text, new RegExp(`zwift_digest = "${digest}"`));
  const back = config.parseConfig(text);
  assert.equal(back.zwiftTag, '1.2.3');
  assert.equal(back.zwiftDigest, digest);
  for (const bad of ['latest', '-x', 'a b', '', '../x']) assert.equal(config.parseConfig(`zwift_tag = "${bad}"\n`).zwiftTag, '', bad);
  for (const bad of ['sha256:abc', `md5:${'a'.repeat(64)}`, `sha256:${'G'.repeat(64)}`, '']) assert.equal(config.parseConfig(`zwift_digest = "${bad}"\n`).zwiftDigest, '', bad);
  // Settings from the launcher must not lose the Zwift tag.
  config.fileStore.save({ ...config.DEFAULTS, zwiftTag: '1.2.3' });
  config.fileStore.save({ ...config.fileStore.load(), theme: 'light' });
  assert.equal(config.fileStore.load().zwiftTag, '1.2.3');
  config.fileStore.save({ ...config.DEFAULTS });
});

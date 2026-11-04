// Prüft die Steam-Anbindung gegen eine nachgebaute shortcuts.vdf in einem Wegwerf-Ordner. Echte Steam-Dateien werden nie angefasst.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-steam-test-'));
process.env.HOME = work;
process.env.ROLLOUT_HOME = path.join(work, 'rollout');
for (const name of ['vdf', 'steam']) {
  await build({ entryPoints: [`src/main/${name}.ts`], bundle: true, platform: 'node', format: 'esm', outfile: path.join(work, `${name}.mjs`), logLevel: 'error' });
}
const vdf = await import(path.join(work, 'vdf.mjs'));
const steam = await import(path.join(work, 'steam.mjs'));

const entry = (index, name, exe, extra = []) => ({
  key: String(index),
  value: [
    { key: 'appid', value: vdf.shortcutAppId(`"${exe}"`, name) },
    { key: 'appname', value: name },
    { key: 'exe', value: `"${exe}"` },
    { key: 'StartDir', value: '"/tmp/"' },
    { key: 'LastPlayTime', value: 1767000000 },
    { key: 'tags', value: [{ key: '0', value: 'Favorit Ä' }] },
    ...extra
  ]
});
const fixture = () => [{ key: 'shortcuts', value: [entry(0, 'Spiel Eins', '/opt/eins.sh'), entry(1, 'Zwei', '/opt/zwei.sh')] }];
const spec = { name: 'Rollout', exe: '/home/x/.local/share/rollout/bin/rollout', startDir: '/home/x/.local/share/rollout/bin', icon: '', launchOptions: '' };

test('AppID wie Steam: crc32 aus Exe mit Anführungszeichen und Name, höchstes Bit gesetzt', () => {
  // Wert aus einer echten Steam-Datei: Eintrag „Xenia“ eines Emulator-Starters
  assert.equal(vdf.shortcutAppId('"/var/home/mace/emudeck/Emulation/tools/launchers/xenia.sh"', 'Xenia'), 3728923498);
});

test('Lesen und Schreiben ist verlustfrei', () => {
  const bytes = vdf.serializeVdf(fixture());
  assert.ok(vdf.serializeVdf(vdf.parseVdf(bytes)).equals(bytes));
});

test('Hinzufügen ist einmalig, nummeriert weiter und lässt fremde Einträge unverändert', () => {
  const tree = fixture();
  assert.equal(vdf.addShortcut(tree, spec), true);
  assert.equal(vdf.addShortcut(tree, spec), false);
  const list = tree[0].value;
  assert.deepEqual(list.map((e) => e.key), ['0', '1', '2']);
  assert.deepEqual(list.slice(0, 2), fixture()[0].value);
  assert.equal(vdf.hasShortcut(tree, spec), true);
});

test('Entfernen stellt den Ausgangszustand wieder her', () => {
  const original = vdf.serializeVdf(fixture());
  const tree = vdf.parseVdf(original);
  vdf.addShortcut(tree, spec);
  assert.equal(vdf.removeShortcut(tree, spec), true);
  assert.ok(vdf.serializeVdf(tree).equals(original));
  assert.equal(vdf.removeShortcut(tree, spec), false);
});

test('Defekte Dateien werden abgelehnt', () => {
  assert.throws(() => vdf.parseVdf(Buffer.from([0, 0x73, 0])));
  assert.throws(() => vdf.parseVdf(Buffer.from([9, 0x61, 0, 8])));
});

test('Schreiben: Sicherung, atomar, nur drei Sicherungen', () => {
  const file = path.join(work, 'config/shortcuts.vdf');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = vdf.serializeVdf(fixture());
  fs.writeFileSync(file, original);
  for (let i = 0; i < 5; i += 1) {
    steam.writeShortcuts(file, (tree) => vdf.addShortcut(tree, { ...spec, name: `Rollout ${i}` }));
  }
  const names = fs.readdirSync(path.dirname(file));
  assert.equal(names.filter((n) => n.includes('rollout-backup')).length, 3);
  assert.ok(!names.some((n) => n.endsWith('rollout-tmp')));
  const result = vdf.parseVdf(fs.readFileSync(file));
  assert.equal(result[0].value.length, 7);
  assert.equal(steam.writeShortcuts(file, () => false), false);
});

test('Schreiben bricht ab, wenn die Datei nicht verlustfrei lesbar ist', () => {
  const file = path.join(work, 'broken/shortcuts.vdf');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from([0, 0x73, 0, 8, 8, 0xff]));
  assert.throws(() => steam.writeShortcuts(file, () => true));
  assert.deepEqual([...fs.readFileSync(file)], [0, 0x73, 0, 8, 8, 0xff]);
});

test('Konto: letzte Anmeldung gewinnt', () => {
  const root = path.join(work, 'Steam');
  fs.mkdirSync(path.join(root, 'userdata/100'), { recursive: true });
  fs.mkdirSync(path.join(root, 'userdata/200'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  const id64 = (n) => String(76561197960265728n + BigInt(n));
  fs.writeFileSync(path.join(root, 'config/loginusers.vdf'), `"users"\n{\n\t"${id64(100)}"\n\t{\n\t\t"timestamp"\t\t"1700000000"\n\t}\n\t"${id64(200)}"\n\t{\n\t\t"timestamp"\t\t"1800000000"\n\t}\n}\n`);
  assert.equal(steam.findAccountDir(root), path.join(root, 'userdata/200'));
});

test('Verknüpfung zeigt auf den festen Pfad', () => {
  const s = steam.rolloutShortcut();
  assert.equal(s.exe, path.join(work, 'rollout/bin/rollout'));
  assert.equal(s.name, 'Rollout');
});

process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));

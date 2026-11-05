import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-bt-test-'));
await build({ entryPoints: ['src/main/bluetooth.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(work, 'bluetooth.mjs'), logLevel: 'error' });
const bt = await import(path.join(work, 'bluetooth.mjs'));

// Output of `bluetoothctl info` for a smart trainer (shortened, address changed)
const trainer = `Device D1:19:E9:24:9A:C8 (random)
\tName: D500V2-2146
\tAlias: D500V2-2146
\tAppearance: 0x0480 (1152)
\tPaired: no
\tConnected: no
\tUUID: Fitness Machine           (00001826-0000-1000-8000-00805f9b34fb)
\tUUID: Cycling Power             (00001818-0000-1000-8000-00805f9b34fb)
\tUUID: Cycling Speed and Cadence (00001816-0000-1000-8000-00805f9b34fb)
\tRSSI: 0xffffffa9 (-87)
`;
const strap = trainer.replace(/UUID:.*\n/g, '').replace('\tRSSI', '\tUUID: Heart Rate                (0000180d-0000-1000-8000-00805f9b34fb)\n\tRSSI');
const lamp = 'Device C0:60:01:85:F6:FB (random)\n\tName: Hue Lamp\n\tUUID: Generic Access Profile    (00001800-0000-1000-8000-00805f9b34fb)\n\tRSSI: 0xffffffb8 (-72)\n';

test('smart trainer is recognised', () => {
  assert.deepEqual(bt.classify('D1:19:E9:24:9A:C8', trainer), { kind: 'trainer', id: '9AC8', name: 'D500V2-2146' });
});

test('heart-rate strap is recognised', () => {
  assert.equal(bt.classify('AA:BB:CC:DD:EE:01', strap)?.kind, 'heartrate');
});

test('foreign devices and devices without signal are ignored', () => {
  assert.equal(bt.classify('C0:60:01:85:F6:FB', lamp), null);
  assert.equal(bt.classify('D1:19:E9:24:9A:C8', trainer.replace(/\tRSSI.*\n/, '')), null);
});

test('device list is read, also with control characters', () => {
  const list = '\x1b[0mDevice D1:19:E9:24:9A:C8 D500V2-2146\nDevice c0:60:01:85:f6:fb Hue Lamp\nirgendwas\n';
  assert.deepEqual(bt.parseDevices(list), ['D1:19:E9:24:9A:C8', 'C0:60:01:85:F6:FB']);
});

process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));

// Bluetooth via bluetoothctl (BlueZ): check the adapter and find trainers and heart-rate straps nearby.
// Rollout pairs nothing here. What is found is whatever is currently broadcasting and offers a matching service.
import { spawn, spawnSync } from 'node:child_process';
import type { Sensor } from '../shared/api';

export interface BluetoothService {
  /** "ready" if a powered-on adapter exists */
  adapter(): Promise<'ready' | 'problem'>;
  /** Scans for `seconds` seconds and reports every find immediately. */
  scan(onFound: (sensor: Sensor) => void, seconds: number): Promise<void>;
}

const FTMS = '00001826';
const CYCLING_POWER = '00001818';
const HEART_RATE = '0000180d';

const strip = (text: string): string => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');

/** Addresses from the output of `bluetoothctl devices`. */
export function parseDevices(text: string): string[] {
  return [...strip(text).matchAll(/^Device ((?:[0-9A-F]{2}:){5}[0-9A-F]{2})/gim)].map((m) => m[1].toUpperCase());
}

/** Turns the output of `bluetoothctl info <address>` into a sensor, provided the device is currently broadcasting and fits. */
export function classify(address: string, info: string): Sensor | null {
  const text = strip(info);
  if (!/^\s*RSSI:/m.test(text)) return null;
  const uuids = [...text.matchAll(/UUID:.*\(([0-9a-f]{8})-/gi)].map((m) => m[1].toLowerCase());
  const kind = uuids.includes(FTMS) || uuids.includes(CYCLING_POWER) ? 'trainer' : uuids.includes(HEART_RATE) ? 'heartrate' : null;
  if (!kind) return null;
  const name = /^\s*Name:\s*(.+)$/m.exec(text)?.[1].trim() || /^\s*Alias:\s*(.+)$/m.exec(text)?.[1].trim() || address;
  return { kind, id: address.replace(/:/g, '').slice(-4), name: name.slice(0, 40) };
}

const ctl = (args: string[]): string => {
  const run = spawnSync('bluetoothctl', args, { encoding: 'utf8', timeout: 5000 });
  return run.status === 0 ? run.stdout : '';
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Like `ctl`, but without blocking the main process: the state is queried every time the app menu opens and before every start. */
const ctlAsync = (args: string[]): Promise<string> => new Promise((resolve) => {
  let out = '';
  const child = spawn('bluetoothctl', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
  child.on('error', () => { clearTimeout(timer); resolve(''); });
  child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out : ''); });
});

export const realBluetooth: BluetoothService = {
  async adapter() {
    return /Powered:\s*yes/.test(strip(await ctlAsync(['show']))) ? 'ready' : 'problem';
  },

  async scan(onFound, seconds) {
    if (/Powered:\s*no/.test(strip(ctl(['show'])))) ctl(['power', 'on']);
    const discovery = spawn('bluetoothctl', ['--timeout', String(seconds), 'scan', 'on'], { stdio: 'ignore' });
    const done = new Promise<void>((resolve) => { discovery.on('close', () => resolve()); discovery.on('error', () => resolve()); });
    const seen = new Map<string, string>();
    let finished = false;
    void done.then(() => { finished = true; });
    while (!finished) {
      await sleep(1500);
      for (const address of parseDevices(ctl(['devices']))) {
        const sensor = classify(address, ctl(['info', address]));
        const key = sensor ? `${sensor.kind}:${sensor.name}` : '';
        if (sensor && seen.get(address) !== key) {
          seen.set(address, key);
          onFound(sensor);
        }
      }
    }
  }
};

/** Fake for tests and the simulation: finds a trainer and a strap after a short time. */
export class FakeBluetooth implements BluetoothService {
  constructor(private readonly problem: boolean) {}
  async adapter(): Promise<'ready' | 'problem'> { return this.problem ? 'problem' : 'ready'; }
  async scan(onFound: (sensor: Sensor) => void, seconds: number): Promise<void> {
    const step = Math.min(seconds, 4) * 1000 / 4;
    await sleep(step);
    if (!this.problem) onFound({ kind: 'trainer', id: '4A2B', name: 'Test Trainer' });
    await sleep(step);
    if (!this.problem) onFound({ kind: 'heartrate', id: '91C0', name: 'Test Strap' });
    await sleep(step * 2);
  }
}

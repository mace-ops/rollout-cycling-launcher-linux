// Bluetooth über bluetoothctl (BlueZ): Adapter prüfen und Trainer sowie Herzfrequenz-Gurte in der Nähe finden.
// Rollout koppelt hier nichts. Gefunden wird, was gerade sendet und einen passenden Dienst anbietet.
import { spawn, spawnSync } from 'node:child_process';
import type { Sensor } from '../shared/api';

export interface BluetoothService {
  /** „ready“, wenn ein eingeschalteter Adapter da ist */
  adapter(): Promise<'ready' | 'problem'>;
  /** Sucht `seconds` Sekunden lang und meldet jeden Fund sofort. */
  scan(onFound: (sensor: Sensor) => void, seconds: number): Promise<void>;
}

const FTMS = '00001826';
const CYCLING_POWER = '00001818';
const HEART_RATE = '0000180d';

const strip = (text: string): string => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');

/** Adressen aus der Ausgabe von `bluetoothctl devices`. */
export function parseDevices(text: string): string[] {
  return [...strip(text).matchAll(/^Device ((?:[0-9A-F]{2}:){5}[0-9A-F]{2})/gim)].map((m) => m[1].toUpperCase());
}

/** Macht aus der Ausgabe von `bluetoothctl info <Adresse>` einen Sensor, sofern das Gerät gerade sendet und passt. */
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

/** Wie `ctl`, aber ohne den Hauptprozess zu blockieren: Der Zustand wird bei jedem Öffnen des App-Menüs und vor jedem Start abgefragt. */
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

/** Attrappe für Tests und die Simulation: findet nach kurzer Zeit einen Trainer und einen Gurt. */
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

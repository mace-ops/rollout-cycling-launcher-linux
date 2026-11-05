// Fakes for the self-update, modelled on FakeSteam. Used only with ROLLOUT_SELFUPDATE=fake or
// ROLLOUT_SIM_SELFUPDATE, never without these variables.
import fs from 'node:fs';
import path from 'node:path';
import type { SelfUpdate, SelfUpdateStatus, UpdateChannel } from '../shared/api';
import { FeedError, type DownloadOptions, type Feed, type SelfUpdateService } from './selfupdate';

const CHUNK = 64 * 1024;

/** Replaces the network with a directory: rollout-update.json (stable), rollout-update-beta.json and the archives by file name. */
export class FakeFeed implements Feed {
  constructor(private readonly dir: string, private readonly delayMs = 0) {}

  async manifest(channel: UpdateChannel): Promise<{ status: number; body?: Buffer }> {
    try {
      return { status: 200, body: fs.readFileSync(path.join(this.dir, channel === 'beta' ? 'rollout-update-beta.json' : 'rollout-update.json')) };
    } catch {
      return { status: 404 };
    }
  }

  async download(url: string, dest: string, { maxBytes, signal, onBytes }: DownloadOptions): Promise<void> {
    const source = path.join(this.dir, path.basename(new URL(url).pathname));
    let handle: fs.promises.FileHandle;
    try { handle = await fs.promises.open(source, 'r'); } catch { throw new FeedError('net', 'Quelle fehlt'); }
    const out = await fs.promises.open(dest, 'w');
    try {
      const buffer = Buffer.alloc(CHUNK);
      let total = 0;
      for (;;) {
        if (signal.aborted) throw new FeedError('abort', 'abgebrochen');
        const { bytesRead } = await handle.read(buffer, 0, CHUNK, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > maxBytes) throw new FeedError('size', 'more bytes than declared');
        await out.write(buffer, 0, bytesRead);
        onBytes(bytesRead);
        if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
    } finally {
      await handle.close();
      await out.close();
    }
  }
}

const STATUSES: readonly SelfUpdateStatus[] = [
  'none', 'current', 'checking', 'checkFailed', 'available', 'downloading', 'ready', 'invalid', 'noSpace', 'manual'
];

/**
 * Holds a fixed state for the click test (ROLLOUT_SIM_SELFUPDATE=<state>[,blocked][,fail][,previous=<v>][,notice=<v>][,next=<v>][,mb=<n>]).
 * Checking, downloading, restart and "Previous version" are simulated, without files and without a restart.
 */
export class FakeSelfUpdate implements SelfUpdateService {
  private info: SelfUpdate;
  private readonly listeners: (() => void)[] = [];
  private readonly failCheck: boolean;
  private timer: NodeJS.Timeout | null = null;

  constructor(spec: string, version: string) {
    const [first, ...flags] = spec.split(',');
    const status = STATUSES.includes(first as SelfUpdateStatus) ? (first as SelfUpdateStatus) : 'current';
    const flag = (name: string): string => flags.find((f) => f.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
    this.failCheck = flags.includes('fail');
    this.info = {
      status, version, next: flag('next') || (status === 'ready' || status === 'available' || status === 'downloading' ? '1.3.0' : ''),
      mb: Number(flag('mb')) || 5, progress: status === 'downloading' ? 42 : 0, blocked: flags.includes('blocked'),
      previous: flag('previous'), notice: flag('notice')
    };
  }

  private emit(): void { for (const l of this.listeners) l(); }
  private set(patch: Partial<SelfUpdate>): void { Object.assign(this.info, patch); this.emit(); }
  private later(ms: number, fn: () => void): void { this.timer = setTimeout(() => { this.timer = null; fn(); }, ms); }

  snapshot(): SelfUpdate { return { ...this.info }; }
  start(): void { /* no ticker */ }
  uiReady(): void { /* no healthy report */ }
  onChange(listener: () => void): void { this.listeners.push(listener); }
  settingsChanged(): void { this.emit(); }
  busyChanged(): void { this.emit(); }

  async check(): Promise<void> {
    if (this.info.status === 'none' || this.info.status === 'checking' || this.info.status === 'downloading') return;
    this.set({ status: 'checking' });
    this.later(700, () => this.set({ status: this.failCheck ? 'checkFailed' : 'current' }));
  }

  async download(): Promise<void> {
    if (this.info.status !== 'available') return;
    this.set({ status: 'downloading', progress: 0 });
    const tick = (): void => {
      if (this.info.status !== 'downloading') return;
      if (this.info.progress >= 100) { this.set({ status: 'ready', progress: 0 }); return; }
      this.set({ progress: Math.min(100, this.info.progress + 10) });
      this.later(150, tick);
    };
    this.later(150, tick);
  }

  cancel(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.info.status === 'downloading') this.set({ status: 'available', progress: 0 });
  }

  restart(): boolean {
    if (this.info.status !== 'ready' || this.info.blocked) { this.emit(); return false; }
    this.set({ status: 'current', previous: this.info.version, version: this.info.next, next: '' });
    return true;
  }

  startPrevious(): boolean {
    if (!this.info.previous || this.info.blocked) { this.emit(); return false; }
    this.set({ version: this.info.previous, previous: '' });
    return true;
  }

  dismissNotice(): void { this.set({ notice: '' }); }
}

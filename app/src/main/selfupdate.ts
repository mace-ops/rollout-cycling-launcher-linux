// Self-update of the launcher (concept 6.1 to 6.7): check the manifest, download, verify signature and checksum,
// stage as a new version. It is applied at the next start by the watcher (scripts/bin-rollout.sh).
// Independent of sim.ts. The network sits behind `Feed`; in tests `FakeFeed` replaces it with a directory.
import { execFile } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SelfUpdate, SelfUpdateStatus, UpdateChannel } from '../shared/api';

const run = promisify(execFile);

export const RELEASES = 'https://github.com/mace-ops/rollout-cycling-launcher-linux/releases';
export const URL_PREFIX = `${RELEASES}/download/`;
export const MANIFEST_FORMAT = 1;
export const LIMITS = { manifest: 64 * 1024, app: 64 * 1024 ** 2, runtime: 400 * 1024 ** 2 };
const SPACE_MARGIN = 50 * 1024 ** 2;
const CHECK_INTERVAL_MS = 6 * 3600 * 1000;
const MANIFEST_TIMEOUT_MS = 10_000;
const MB = 1e6;

// ---------- Reine Logik ----------

export interface Semver { major: number; minor: number; patch: number; pre: (string | number)[] }

export function parseSemver(version: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

/** SemVer ordering: 1.3.0-beta.9 < 1.3.0-beta.10 < 1.3.0 < 1.10.0. Invalid versions count as the lowest. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (const key of ['major', 'minor', 'patch'] as const) if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1;
    return typeof p === 'number' ? -1 : typeof q === 'number' ? 1 : p < q ? -1 : 1;
  }
  return x.pre.length === y.pre.length ? 0 : x.pre.length < y.pre.length ? -1 : 1;
}

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Ed25519 over the exact bytes of `signed`. Key: 32 bytes base64, signature: 64 bytes base64. */
export function verifySignature(signed: string, signatureB64: string, publicKeyB64: string): boolean {
  try {
    if (!BASE64.test(signatureB64) || !BASE64.test(publicKeyB64)) return false;
    const raw = Buffer.from(publicKeyB64, 'base64');
    const signature = Buffer.from(signatureB64, 'base64');
    if (raw.length !== 32 || signature.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(signed, 'utf8'), key, signature);
  } catch {
    return false;
  }
}

export interface Archive { url: string; size: number; unpacked: number; sha256: string }
export interface Manifest {
  format: number;
  product: 'rollout';
  channel: UpdateChannel;
  version: string;
  published: string;
  app: Archive;
  runtime: Archive & { electron: string; min: string };
}

/** `format`: newer manifest format, fresh install needed. `invalid`: signature or content wrong. `old`: not higher. `bad`: blocked. */
export type Rejection = 'format' | 'invalid' | 'old' | 'bad';
export type Verdict = { ok: true; manifest: Manifest } | { ok: false; reason: Rejection; detail: string };

export interface ManifestContext {
  keys: Record<string, string>;
  channel: UpdateChannel;
  current: string;
  bad: readonly string[];
}

const reject = (reason: Rejection, detail: string): Verdict => ({ ok: false, reason, detail });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function archiveOf(value: unknown, limit: number): Archive | null {
  if (!isRecord(value)) return null;
  const { url, size, unpacked, sha256 } = value;
  if (typeof url !== 'string' || !url.startsWith(URL_PREFIX)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.host !== 'github.com' || parsed.username || parsed.password || !parsed.href.startsWith(URL_PREFIX)) return null;
  } catch { return null; }
  if (!Number.isSafeInteger(size) || (size as number) <= 0 || (size as number) > limit) return null;
  if (!Number.isSafeInteger(unpacked) || (unpacked as number) <= 0 || (unpacked as number) > limit * 8) return null;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  return { url, size: size as number, unpacked: unpacked as number, sha256 };
}

/** Checks envelope, signature and content in this order. Nothing of the content is used before the signature. */
export function evaluateManifest(raw: Buffer | string, ctx: ManifestContext): Verdict {
  const bytes = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
  if (bytes > LIMITS.manifest) return reject('invalid', 'too large');
  let envelope: unknown;
  try { envelope = JSON.parse(raw.toString()); } catch { return reject('invalid', 'not JSON'); }
  if (!isRecord(envelope)) return reject('invalid', 'not an envelope');
  const { keyId, signature, signed } = envelope;
  if (typeof keyId !== 'string' || typeof signature !== 'string' || typeof signed !== 'string') return reject('invalid', 'envelope incomplete');
  if (!Object.hasOwn(ctx.keys, keyId)) return reject('invalid', 'unknown key');
  if (!verifySignature(signed, signature, ctx.keys[keyId])) return reject('invalid', 'Signatur falsch');
  let m: unknown;
  try { m = JSON.parse(signed); } catch { return reject('invalid', 'manifest is not JSON'); }
  if (!isRecord(m)) return reject('invalid', 'manifest is not an object');
  if (typeof m.format !== 'number') return reject('invalid', 'format fehlt');
  if (m.format > MANIFEST_FORMAT) return reject('format', `format ${m.format}`);
  if (m.format !== MANIFEST_FORMAT) return reject('invalid', 'format unbekannt');
  if (m.product !== 'rollout') return reject('invalid', 'falsches Produkt');
  if (m.channel !== ctx.channel) return reject('invalid', 'falscher Kanal');
  if (typeof m.version !== 'string' || !parseSemver(m.version)) return reject('invalid', 'invalid version');
  if (typeof m.published !== 'string') return reject('invalid', 'published fehlt');
  const app = archiveOf(m.app, LIMITS.app);
  const runtimeRaw = isRecord(m.runtime) ? m.runtime : null;
  const runtime = archiveOf(runtimeRaw, LIMITS.runtime);
  if (!app || !runtime || !runtimeRaw) return reject('invalid', 'invalid archive');
  const { electron, min } = runtimeRaw;
  if (typeof electron !== 'string' || typeof min !== 'string' || !parseSemver(electron) || !parseSemver(min) || compareSemver(min, electron) > 0) {
    return reject('invalid', 'invalid Electron details');
  }
  if (compareSemver(m.version, ctx.current) <= 0) return reject('old', 'not higher');
  if (ctx.bad.includes(m.version)) return reject('bad', 'gesperrt');
  return { ok: true, manifest: { format: m.format, product: 'rollout', channel: ctx.channel, version: m.version, published: m.published, app, runtime: { ...runtime, electron, min } } };
}

export interface ElectronPlan { use: string; download: boolean }

/** Download Electron again only if the running one is not enough: same major version and at least `min`. */
export function electronPlan(installed: readonly string[], currentRuntime: string, rt: { electron: string; min: string }): ElectronPlan {
  const cur = parseSemver(currentRuntime);
  const want = parseSemver(rt.electron);
  if (cur && want && cur.major === want.major && compareSemver(currentRuntime, rt.min) >= 0) return { use: currentRuntime, download: false };
  return { use: rt.electron, download: !installed.includes(rt.electron) };
}

export const downloadBytes = (m: Manifest, plan: ElectronPlan): number => m.app.size + (plan.download ? m.runtime.size : 0);
export const neededBytes = (m: Manifest, plan: ElectronPlan): number =>
  m.app.size + m.app.unpacked + (plan.download ? m.runtime.size + m.runtime.unpacked : 0) + SPACE_MARGIN;

// ---------- Netz ----------

export class FeedError extends Error {
  constructor(public readonly kind: 'abort' | 'size' | 'net', message: string) { super(message); }
}

export interface DownloadOptions { maxBytes: number; signal: AbortSignal; onBytes: (n: number) => void }

/** Network access. `manifest` returns the status and, on 200, the content; network errors throw. `download` throws `FeedError`. */
export interface Feed {
  manifest(channel: UpdateChannel, signal: AbortSignal): Promise<{ status: number; body?: Buffer }>;
  download(url: string, dest: string, options: DownloadOptions): Promise<void>;
}

// ---------- Dienst ----------

export interface SelfUpdateService {
  snapshot(): SelfUpdate;
  start(): void;
  uiReady(): void;
  check(manual: boolean): Promise<void>;
  download(): Promise<void>;
  cancel(): void;
  restart(): boolean;
  startPrevious(): boolean;
  dismissNotice(): void;
  /** Channel or the "Download updates automatically" switch was changed */
  settingsChanged(): void;
  /** A game or installation has started or ended */
  busyChanged(): void;
  onChange(listener: () => void): void;
}

export interface SelfUpdaterOptions {
  home: string;
  version: string;
  keys: Record<string, string>;
  feed: Feed;
  /** Only with an active watcher (ROLLOUT_SUPERVISED=1) is anything checked, downloaded and applied */
  supervised: boolean;
  arch?: string;
  settings: () => { autoUpdate: boolean; channel: UpdateChannel };
  /** Is a game or installation running? `state/run.pid` comes from `rollout-run` and is supplemented here. */
  busy: () => boolean;
  exit: (code: number) => void;
  freeBytes?: (dir: string) => number;
  now?: () => number;
  timing?: { firstCheckMs: number; healthyMs: number; intervalMs: number };
  /** Tests only: called before each step of staging */
  step?: (name: string) => void;
}

const readText = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const firstLine = (file: string): string => (readText(file) ?? '').split('\n')[0].trim();
const linkVersion = (file: string): string => { try { return path.basename(fs.readlinkSync(file)); } catch { return ''; } };
const exists = (file: string): boolean => fs.existsSync(file);

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export const bootstrapNumber = (file: string): number =>
  Number(/^# rollout-bootstrap: (\d+)$/m.exec((readText(file) ?? '').split('\n').slice(0, 5).join('\n'))?.[1] ?? 0);

class StageError extends Error {}

export class SelfUpdater implements SelfUpdateService {
  private status: SelfUpdateStatus;
  private next = '';
  private mb = 0;
  private progress = 0;
  private candidate: Manifest | null = null;
  private abort: AbortController | null = null;
  private readonly tried = new Set<string>();
  private readonly listeners: (() => void)[] = [];
  private readonly active: boolean;
  /** Channel at start, `null` until `start()` runs: the main process creates the service before the backend, so the settings are not readable yet. */
  private channel: UpdateChannel | null = null;
  private healthyDone = false;
  private readonly timing: { firstCheckMs: number; healthyMs: number; intervalMs: number };

  constructor(private readonly o: SelfUpdaterOptions) {
    this.active = o.supervised && (o.arch ?? process.arch) === 'x64';
    this.timing = o.timing ?? { firstCheckMs: 20_000, healthyMs: 10_000, intervalMs: CHECK_INTERVAL_MS };
    this.status = this.active ? 'current' : 'none';
    if (this.active) this.restorePending();
  }

  private dir = (...parts: string[]): string => path.join(this.o.home, ...parts);
  private now = (): number => (this.o.now ?? Date.now)();
  private step = (name: string): void => this.o.step?.(name);
  private emit(): void { for (const l of this.listeners) l(); }
  onChange(listener: () => void): void { this.listeners.push(listener); }

  private set(status: SelfUpdateStatus): void {
    this.status = status;
    if (status !== 'downloading') this.progress = 0;
    this.emit();
  }

  private runPidAlive(): boolean {
    const pid = Number(firstLine(this.dir('state/run.pid')));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  }

  private isBusy(): boolean { return this.o.busy() || this.runPidAlive(); }
  private badList(): string[] { return (readText(this.dir('state/bad')) ?? '').split('\n').map((l) => l.trim()).filter(Boolean); }
  private pending(): string { return firstLine(this.dir('state/pending')); }
  private runtimeOf(version: string): string { return firstLine(this.dir('versions', version, 'runtime')); }

  private previousVersion(): string {
    const prev = linkVersion(this.dir('previous'));
    if (!prev || prev === this.o.version || this.badList().includes(prev)) return '';
    const rt = this.runtimeOf(prev);
    return parseSemver(prev) && exists(this.dir('versions', prev, 'package.json')) && rt && exists(this.dir('electron', rt, 'electron')) ? prev : '';
  }

  snapshot(): SelfUpdate {
    const base = { status: this.status, version: this.o.version, next: this.next, mb: this.mb, progress: this.progress };
    if (!this.active) return { ...base, blocked: false, previous: '', notice: '' };
    return { ...base, blocked: this.isBusy(), previous: this.previousVersion(), notice: firstLine(this.dir('state/notice')) };
  }

  /** A previously staged update that has not been applied yet. */
  private restorePending(): void {
    const p = this.pending();
    if (parseSemver(p) && compareSemver(p, this.o.version) > 0 && exists(this.dir('versions', p, 'package.json'))) {
      this.status = 'ready';
      this.next = p;
    }
  }

  private baseStatus(): SelfUpdateStatus { return this.next && this.pending() === this.next ? 'ready' : 'current'; }

  start(): void {
    if (!this.active) return;
    this.channel = this.o.settings().channel;
    setTimeout(() => void this.check(false), this.timing.firstCheckMs).unref();
    setInterval(() => void this.check(false), this.timing.intervalMs).unref();
  }

  /** After the first paint: if the version on trial counts as healthy, the main process reports it to the watcher. */
  uiReady(): void {
    if (!this.active || this.healthyDone) return;
    this.healthyDone = true;
    setTimeout(() => {
      if (firstLine(this.dir('state/trial')) === this.o.version) writeAtomic(this.dir('state/healthy'), `${this.o.version}\n`);
      setTimeout(() => void this.housekeeping(), 3000).unref();
    }, this.timing.healthyMs).unref();
  }

  async check(manual: boolean): Promise<void> {
    if (!this.active || this.status === 'checking' || this.status === 'downloading') return;
    const { autoUpdate, channel } = this.o.settings();
    if (!Object.keys(this.o.keys).length) {
      if (manual) this.set('checkFailed');
      return;
    }
    if (!manual && this.isBusy()) return;
    const cache = this.readCache(channel);
    if (!manual && cache && this.now() - cache.at < this.timing.intervalMs) {
      await this.apply(cache.envelopes, false, autoUpdate);
      return;
    }
    const before = this.status;
    if (manual) this.set('checking');
    const channels: UpdateChannel[] = channel === 'beta' ? ['stable', 'beta'] : ['stable'];
    const signal = AbortSignal.timeout(MANIFEST_TIMEOUT_MS);
    const got: { channel: UpdateChannel; body: string }[] = [];
    try {
      for (const ch of channels) {
        const res = await this.o.feed.manifest(ch, signal);
        if (res.status === 200 && res.body) got.push({ channel: ch, body: res.body.toString('utf8') });
      }
    } catch {
      this.set(manual ? 'checkFailed' : before);
      return;
    }
    writeAtomic(this.dir('state/check.json'), JSON.stringify({ at: this.now(), channel, envelopes: got }));
    await this.apply(got, manual, autoUpdate);
  }

  private readCache(channel: UpdateChannel): { at: number; envelopes: { channel: UpdateChannel; body: string }[] } | null {
    try {
      const c = JSON.parse(readText(this.dir('state/check.json')) ?? '');
      if (c && c.channel === channel && typeof c.at === 'number' && Array.isArray(c.envelopes)) return c;
    } catch { /* no cache */ }
    return null;
  }

  private async apply(list: { channel: UpdateChannel; body: string }[], manual: boolean, auto: boolean): Promise<void> {
    const ctx = { keys: this.o.keys, current: this.o.version, bad: this.badList() };
    const verdicts = list.map((e) => evaluateManifest(e.body, { ...ctx, channel: e.channel }));
    const pending = this.pending();
    const best = verdicts.flatMap((v) => (v.ok ? [v.manifest] : [])).sort((a, b) => compareSemver(b.version, a.version))[0];
    if (best && (!pending || compareSemver(best.version, pending) > 0)) {
      const plan = this.planFor(best);
      this.candidate = best;
      this.next = best.version;
      this.mb = Math.max(1, Math.round(downloadBytes(best, plan) / MB));
      this.set('available');
      if (auto && !this.isBusy() && !this.tried.has(best.version)) {
        this.tried.add(best.version);
        await this.download();
      }
      return;
    }
    if (verdicts.some((v) => !v.ok && v.reason === 'format')) { this.set('manual'); return; }
    if (manual && !list.length) { this.set('checkFailed'); return; }
    if (manual && verdicts.some((v) => !v.ok && v.reason === 'invalid')) { this.set('invalid'); return; }
    this.set(this.baseStatus());
  }

  private installedElectron(): string[] {
    try { return fs.readdirSync(this.dir('electron')).filter((n) => parseSemver(n)); } catch { return []; }
  }

  private planFor(m: Manifest): ElectronPlan {
    return electronPlan(this.installedElectron(), this.runtimeOf(this.o.version), m.runtime);
  }

  async download(): Promise<void> {
    const m = this.candidate;
    if (!this.active || this.status !== 'available' || !m || this.isBusy()) return;
    const plan = this.planFor(m);
    const free = (this.o.freeBytes ?? ((d: string) => { const s = fs.statfsSync(d); return s.bavail * s.bsize; }))(this.o.home);
    if (free < neededBytes(m, plan)) { this.set('noSpace'); return; }
    this.tried.add(m.version);
    const abort = new AbortController();
    this.abort = abort;
    this.progress = 0;
    this.set('downloading');
    try {
      await this.fetchAndStage(m, plan, abort.signal);
      this.next = m.version;
      this.set('ready');
    } catch (error) {
      this.set(this.failureStatus(error, abort.signal));
    } finally {
      this.abort = null;
      fs.rmSync(this.dir('staging'), { recursive: true, force: true });
    }
  }

  private failureStatus(error: unknown, signal: AbortSignal): SelfUpdateStatus {
    if (signal.aborted || (error instanceof FeedError && error.kind === 'abort')) return 'available';
    if (error instanceof FeedError && error.kind === 'net') return 'available';
    if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC') return 'noSpace';
    return 'invalid';
  }

  cancel(): void { this.abort?.abort(); }
  busyChanged(): void { if (this.abort && this.isBusy()) this.abort.abort(); this.emit(); }

  settingsChanged(): void {
    if (!this.active) return;
    const { autoUpdate, channel } = this.o.settings();
    if (this.channel !== null && channel !== this.channel) {
      this.channel = channel;
      void this.check(true);
    } else if (autoUpdate && this.status === 'available' && !this.isBusy()) {
      void this.download();
    }
    this.emit();
  }

  private async fetchAndStage(m: Manifest, plan: ElectronPlan, signal: AbortSignal): Promise<void> {
    const staging = this.dir('staging');
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const total = downloadBytes(m, plan);
    let done = 0;
    const fetchOne = async (a: Archive, name: string): Promise<string> => {
      const file = path.join(staging, name);
      await this.o.feed.download(a.url, file, {
        maxBytes: a.size,
        signal,
        onBytes: (n) => {
          done += n;
          const pct = Math.min(99, Math.floor((done / total) * 100));
          if (pct !== this.progress) { this.progress = pct; this.emit(); }
        }
      });
      if (fs.statSync(file).size !== a.size) throw new StageError('size differs');
      if (await sha256Of(file) !== a.sha256) throw new StageError('checksum differs');
      return file;
    };
    const untar = async (file: string, to: string): Promise<void> => {
      fs.mkdirSync(to, { recursive: true });
      await run('tar', ['-xzf', file, '-C', to, '--no-same-owner'], { signal, timeout: 120_000 });
    };
    const runtimeFile = plan.download ? await fetchOne(m.runtime, 'electron.tar.gz') : null;
    const appFile = await fetchOne(m.app, 'app.tar.gz');

    const appDir = path.join(staging, 'app');
    await untar(appFile, appDir);
    let pkg: { version?: unknown } = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')); } catch { /* rejected below */ }
    if (pkg.version !== m.version) throw new StageError('package.json names a different version');
    for (const file of ['dist/main/main.js', 'dist/preload/preload.js', 'dist/renderer/index.html', 'bootstrap/rollout']) {
      if (!exists(path.join(appDir, file))) throw new StageError(`${file} fehlt`);
    }
    const electronDir = path.join(staging, 'electron');
    if (runtimeFile) {
      await untar(runtimeFile, electronDir);
      const out = await run(path.join(electronDir, 'electron'), ['-p', 'process.versions.electron'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20_000, signal
      });
      if (String(out.stdout).trim() !== m.runtime.electron) throw new StageError('Electron reports a different version');
    }

    // Commit: everything in place first, pending last. Without pending everything stays as before.
    const versionDir = this.dir('versions', m.version);
    const electronTarget = this.dir('electron', plan.use);
    const created: string[] = [];
    try {
      fs.writeFileSync(path.join(appDir, 'runtime'), `${plan.use}\n`);
      fs.mkdirSync(this.dir('versions'), { recursive: true });
      fs.mkdirSync(this.dir('electron'), { recursive: true });
      fs.rmSync(versionDir, { recursive: true, force: true });
      if (runtimeFile && !exists(electronTarget)) { this.step('electron'); fs.renameSync(electronDir, electronTarget); created.push(electronTarget); }
      this.step('app');
      fs.renameSync(appDir, versionDir);
      created.push(versionDir);
      await run('sync', ['-f', versionDir]).catch(() => undefined);
      this.step('pending');
      writeAtomic(this.dir('state/pending'), `${m.version}\n`);
    } catch (error) {
      for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** "Restart now". The main process checks again here whether anything is busy. */
  restart(): boolean {
    if (!this.active || this.status !== 'ready' || this.isBusy() || !this.pending()) { this.emit(); return false; }
    this.o.exit(75);
    return true;
  }

  /** "Previous version": blocks the running version and stages the previous one as pending. */
  startPrevious(): boolean {
    const prev = this.previousVersion();
    if (!this.active || !prev || this.isBusy()) { this.emit(); return false; }
    fs.appendFileSync(this.dir('state/bad'), `${this.o.version}\n`);
    writeAtomic(this.dir('state/pending'), `${prev}\n`);
    this.o.exit(75);
    return true;
  }

  dismissNotice(): void {
    fs.rmSync(this.dir('state/notice'), { force: true });
    this.emit();
  }

  /** After a passed trial: renew starter, renew icon, remove old versions and Electron directories. Only if nothing is busy. */
  async housekeeping(): Promise<void> {
    if (!this.active || this.isBusy() || this.abort || firstLine(this.dir('state/trial'))) return;
    const current = linkVersion(this.dir('current'));
    if (!current || !exists(this.dir('versions', current, 'package.json'))) return;
    await this.renewBootstrap(current);
    this.renewIcon(current);
    const keep = new Set([current, linkVersion(this.dir('previous')), this.pending(), this.o.version].filter(Boolean));
    const keepElectron = new Set([...keep].map((v) => this.runtimeOf(v)).filter(Boolean));
    for (const name of this.list('versions')) if (!keep.has(name)) fs.rmSync(this.dir('versions', name), { recursive: true, force: true });
    for (const name of this.list('electron')) if (!keepElectron.has(name)) fs.rmSync(this.dir('electron', name), { recursive: true, force: true });
    fs.rmSync(this.dir('staging'), { recursive: true, force: true });
  }

  private list(name: string): string[] { try { return fs.readdirSync(this.dir(name)); } catch { return []; } }

  private async renewBootstrap(version: string): Promise<void> {
    for (const name of ['rollout', 'rollout-run']) await this.renewStarter(version, name);
  }

  private async renewStarter(version: string, name: string): Promise<void> {
    const fresh = this.dir('versions', version, 'bootstrap', name);
    const installed = this.dir('bin', name);
    const n = bootstrapNumber(fresh);
    if (n <= bootstrapNumber(installed)) return;
    try {
      await run('sh', ['-n', fresh], { timeout: 10_000 });
      const out = await run('sh', [fresh, '--bootstrap-selftest'], { timeout: 10_000 });
      if (!String(out.stdout).startsWith(`rollout-bootstrap ${n} `)) return;
      const temp = this.dir('bin', `.${name}.new`);
      fs.copyFileSync(fresh, temp);
      fs.chmodSync(temp, 0o755);
      fs.renameSync(temp, installed);
    } catch { /* stays until the next start */ }
  }

  private renewIcon(version: string): void {
    try {
      const fresh = fs.readFileSync(this.dir('versions', version, 'dist/renderer/assets/brand/logo.png'));
      const old = (() => { try { return fs.readFileSync(this.dir('icon.png')); } catch { return null; } })();
      if (!old || !old.equals(fresh)) {
        const temp = this.dir('icon.png.tmp');
        fs.writeFileSync(temp, fresh);
        fs.renameSync(temp, this.dir('icon.png'));
      }
    } catch { /* icon is cosmetic */ }
  }
}

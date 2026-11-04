// Netzzugriff des Selbst-Updates über Electron (net.fetch): feste Asset-URLs von GitHub, keine REST-API, kein Token,
// keine Cookies. Nur der Hauptprozess spricht mit dem Netz (Konzept 6.1 SU5, 6.7).
import { net } from 'electron';
import fs from 'node:fs';
import type { UpdateChannel } from '../shared/api';
import { FeedError, LIMITS, RELEASES, type DownloadOptions, type Feed } from './selfupdate';

const STALL_MS = 30_000;
const HEADERS = { 'User-Agent': 'Rollout' };

const manifestUrl = (channel: UpdateChannel): string =>
  channel === 'beta' ? `${RELEASES}/download/beta/rollout-update.json` : `${RELEASES}/latest/download/rollout-update.json`;

const fetchOnce = (url: string, signal: AbortSignal): Promise<Response> =>
  net.fetch(url, { signal, headers: HEADERS, credentials: 'omit', redirect: 'follow' });

export const realFeed: Feed = {
  async manifest(channel, signal) {
    const res = await fetchOnce(manifestUrl(channel), signal);
    if (!res.ok || !res.body) return { status: res.status };
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > LIMITS.manifest) { await reader.cancel(); return { status: 413 }; }
      chunks.push(Buffer.from(value));
    }
    return { status: 200, body: Buffer.concat(chunks) };
  },

  async download(url, dest, { maxBytes, signal, onBytes }: DownloadOptions) {
    // Eigener Abbruch, damit der Abbruch von außen und die Überwachung auf denselben Weg gehen. 30 s ohne neue Daten gelten als hängend.
    const inner = new AbortController();
    const onAbort = (): void => inner.abort();
    signal.addEventListener('abort', onAbort);
    let stall = setTimeout(onAbort, STALL_MS);
    let out: fs.promises.FileHandle | null = null;
    try {
      let res: Response;
      try { res = await fetchOnce(url, inner.signal); } catch { throw new FeedError(signal.aborted ? 'abort' : 'net', 'Verbindung'); }
      if (!res.ok || !res.body) throw new FeedError('net', `HTTP ${res.status}`);
      out = await fs.promises.open(dest, 'w');
      const reader = res.body.getReader();
      let total = 0;
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); } catch { throw new FeedError(signal.aborted ? 'abort' : 'net', 'Verbindung abgebrochen'); }
        if (chunk.done) break;
        clearTimeout(stall);
        stall = setTimeout(onAbort, STALL_MS);
        total += chunk.value.length;
        if (total > maxBytes) { await reader.cancel(); throw new FeedError('size', 'mehr Bytes als angegeben'); }
        await out.write(chunk.value);
        onBytes(chunk.value.length);
      }
    } finally {
      clearTimeout(stall);
      signal.removeEventListener('abort', onAbort);
      await out?.close();
    }
  }
};

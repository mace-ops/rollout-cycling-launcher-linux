// Network access of the self-update through Electron (net.fetch): fixed asset URLs from GitHub, no REST API, no token,
// no cookies. Only the main process talks to the network (concept 6.1 SU5, 6.7).
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
    // Own abort so the external abort and the monitoring take the same path. 30 s without new data count as hanging.
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
        if (total > maxBytes) { await reader.cancel(); throw new FeedError('size', 'more bytes than declared'); }
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

// ~/.config/rollout/config.toml: stores only deviations from the defaults. Only what Rollout writes itself is supported.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UpdateChannel } from '../shared/api';

export interface Settings {
  language: string;
  theme: 'auto' | 'dark' | 'light';
  /** "auto" or percent of the reference size, 100 to 200 */
  scale: string;
  autoUpdate: boolean;
  updateChannel: UpdateChannel;
  /** Fixed tag of the Zwift image (netbrain/zwift), empty = not configured; never "latest". `rollout-run` reads it from the same file. */
  zwiftTag: string;
  /** Optional fixed digest of the Zwift image (`sha256:` and 64 hex characters), empty = only the tag counts */
  zwiftDigest: string;
}

export const DEFAULTS: Settings = { language: 'auto', theme: 'dark', scale: 'auto', autoUpdate: true, updateChannel: 'stable', zwiftTag: '', zwiftDigest: '' };

export interface SettingsStore {
  load(): Settings;
  save(settings: Settings): void;
}

export const configFile = (): string =>
  path.join(process.env.ROLLOUT_CONFIG_HOME || path.join(os.homedir(), '.config/rollout'), 'config.toml');

export function parseConfig(text: string): Settings {
  const result: Settings = { ...DEFAULTS };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const match = /^(\w+)\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    const str = /^"([^"]*)"$/.exec(value)?.[1];
    if (key === 'language' && str && /^(auto|[a-z]{2,3}(-[A-Za-z]{2,4})?)$/.test(str)) result.language = str;
    else if (key === 'theme' && (str === 'auto' || str === 'dark' || str === 'light')) result.theme = str;
    else if (key === 'scale' && str && (str === 'auto' || (/^\d{3}$/.test(str) && Number(str) >= 100 && Number(str) <= 200))) result.scale = str;
    else if (key === 'auto_update' && (value === 'true' || value === 'false')) result.autoUpdate = value === 'true';
    else if (key === 'update_channel' && (str === 'stable' || str === 'beta')) result.updateChannel = str;
    else if (key === 'zwift_tag' && str && str !== 'latest' && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(str)) result.zwiftTag = str;
    else if (key === 'zwift_digest' && str && /^sha256:[0-9a-f]{64}$/.test(str)) result.zwiftDigest = str;
  }
  return result;
}

export function serializeConfig(settings: Settings): string {
  const lines: string[] = [];
  if (settings.language !== DEFAULTS.language) lines.push(`language = "${settings.language}"`);
  if (settings.theme !== DEFAULTS.theme) lines.push(`theme = "${settings.theme}"`);
  if (settings.scale !== DEFAULTS.scale) lines.push(`scale = "${settings.scale}"`);
  if (settings.autoUpdate !== DEFAULTS.autoUpdate) lines.push(`auto_update = ${settings.autoUpdate}`);
  if (settings.updateChannel !== DEFAULTS.updateChannel) lines.push(`update_channel = "${settings.updateChannel}"`);
  if (settings.zwiftTag !== DEFAULTS.zwiftTag) lines.push(`zwift_tag = "${settings.zwiftTag}"`);
  if (settings.zwiftDigest !== DEFAULTS.zwiftDigest) lines.push(`zwift_digest = "${settings.zwiftDigest}"`);
  return lines.length ? `# Rollout: only deviations from the defaults\n${lines.join('\n')}\n` : '';
}

export const fileStore: SettingsStore = {
  load(): Settings {
    try {
      return parseConfig(fs.readFileSync(configFile(), 'utf8'));
    } catch {
      return { ...DEFAULTS };
    }
  },
  save(settings: Settings): void {
    const file = configFile();
    const text = serializeConfig(settings);
    try {
      if (!text) {
        fs.rmSync(file, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, text);
      fs.renameSync(temp, file);
    } catch { /* settings are then lost on quit, the app keeps running */ }
  }
};

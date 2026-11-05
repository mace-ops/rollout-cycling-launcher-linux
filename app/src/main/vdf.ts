// Binary VDF as Steam uses it for shortcuts.vdf. Unknown types lead to an error instead of silent data loss.

export type VdfValue = string | number | VdfMap;
export interface VdfEntry {
  key: string;
  value: VdfValue;
}
export type VdfMap = VdfEntry[];

const T_MAP = 0;
const T_STRING = 1;
const T_INT = 2;
const T_END = 8;

export function parseVdf(buf: Buffer): VdfMap {
  let pos = 0;
  const cstring = (): string => {
    const end = buf.indexOf(0, pos);
    if (end < 0) throw new Error('VDF: unterminated string');
    const text = buf.toString('utf8', pos, end);
    pos = end + 1;
    return text;
  };
  const readMap = (): VdfMap => {
    const entries: VdfMap = [];
    for (;;) {
      if (pos >= buf.length) throw new Error('VDF: end of file before completion');
      const type = buf[pos++];
      if (type === T_END) return entries;
      const key = cstring();
      if (type === T_MAP) entries.push({ key, value: readMap() });
      else if (type === T_STRING) entries.push({ key, value: cstring() });
      else if (type === T_INT) {
        if (pos + 4 > buf.length) throw new Error('VDF: Zahl abgeschnitten');
        entries.push({ key, value: buf.readUInt32LE(pos) });
        pos += 4;
      } else throw new Error(`VDF: unbekannter Typ ${type}`);
    }
  };
  const root = readMap();
  if (pos !== buf.length) throw new Error('VDF: data after the end');
  return root;
}

export function serializeVdf(map: VdfMap): Buffer {
  const parts: Buffer[] = [];
  const cstr = (text: string): Buffer => Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);
  const write = (entries: VdfMap): void => {
    for (const { key, value } of entries) {
      if (typeof value === 'string') parts.push(Buffer.from([T_STRING]), cstr(key), cstr(value));
      else if (typeof value === 'number') {
        const n = Buffer.alloc(4);
        n.writeUInt32LE(value >>> 0);
        parts.push(Buffer.from([T_INT]), cstr(key), n);
      } else {
        parts.push(Buffer.from([T_MAP]), cstr(key));
        write(value);
      }
    }
    parts.push(Buffer.from([T_END]));
  };
  write(map);
  return Buffer.concat(parts);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(text: string): number {
  let c = 0xffffffff;
  for (const byte of Buffer.from(text, 'utf8')) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** AppID of a non-Steam entry: crc32(exe including quotes + name) with the highest bit set. */
export const shortcutAppId = (exe: string, name: string): number => (crc32(exe + name) | 0x80000000) >>> 0;

const field = (map: VdfMap, key: string): VdfEntry | undefined => map.find((e) => e.key.toLowerCase() === key.toLowerCase());

export interface ShortcutSpec {
  name: string;
  exe: string;
  startDir: string;
  icon: string;
  launchOptions: string;
}

const quote = (path: string): string => `"${path}"`;

export function buildShortcut(spec: ShortcutSpec): VdfMap {
  const exe = quote(spec.exe);
  return [
    { key: 'appid', value: shortcutAppId(exe, spec.name) },
    { key: 'appname', value: spec.name },
    { key: 'exe', value: exe },
    { key: 'StartDir', value: quote(spec.startDir) },
    { key: 'icon', value: spec.icon },
    { key: 'ShortcutPath', value: '' },
    { key: 'LaunchOptions', value: spec.launchOptions },
    { key: 'IsHidden', value: 0 },
    { key: 'AllowDesktopConfig', value: 1 },
    { key: 'AllowOverlay', value: 1 },
    { key: 'OpenVR', value: 0 },
    { key: 'Devkit', value: 0 },
    { key: 'DevkitGameID', value: '' },
    { key: 'DevkitOverrideAppID', value: 0 },
    { key: 'LastPlayTime', value: 0 },
    { key: 'FlatpakAppID', value: '' },
    { key: 'sortas', value: '' },
    { key: 'tags', value: [] }
  ];
}

function shortcutsOf(root: VdfMap, create: boolean): VdfMap | null {
  let entry = field(root, 'shortcuts');
  if (!entry && create) {
    entry = { key: 'shortcuts', value: [] };
    root.push(entry);
  }
  return entry && typeof entry.value !== 'string' && typeof entry.value !== 'number' ? entry.value : null;
}

const same = (entry: VdfEntry, spec: ShortcutSpec): boolean => {
  if (typeof entry.value === 'string' || typeof entry.value === 'number') return false;
  const exe = field(entry.value, 'exe')?.value;
  const name = field(entry.value, 'appname')?.value;
  return exe === quote(spec.exe) && name === spec.name;
};

export const hasShortcut = (root: VdfMap, spec: ShortcutSpec): boolean => !!shortcutsOf(root, false)?.some((e) => same(e, spec));

/** Adds the entry if it is missing. Foreign entries stay untouched. Returns whether anything was changed. */
export function addShortcut(root: VdfMap, spec: ShortcutSpec): boolean {
  const list = shortcutsOf(root, true) as VdfMap;
  if (list.some((e) => same(e, spec))) return false;
  const next = list.reduce((max, e) => (/^\d+$/.test(e.key) ? Math.max(max, Number(e.key) + 1) : max), 0);
  list.push({ key: String(next), value: buildShortcut(spec) });
  return true;
}

export function removeShortcut(root: VdfMap, spec: ShortcutSpec): boolean {
  const list = shortcutsOf(root, false);
  if (!list) return false;
  const keep = list.filter((e) => !same(e, spec));
  if (keep.length === list.length) return false;
  list.splice(0, list.length, ...keep);
  return true;
}

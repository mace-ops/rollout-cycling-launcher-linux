// Eigener Mauszeiger für MyWhoosh: ein runder, gut sichtbarer Punkt (weißer Kreis mit dunklem Rand und blauer Mitte) als X-Cursor-Thema.
// Der Controller steuert im Spiel einen Zeiger (gamepad-bridge.ts), und der normale Pfeil ist auf dem Bildschirm des Ally schwer zu finden.
// Kein Electron: Das Thema entsteht als Dateien (Xcursor-Format, ein Bild je Datei) und wird dem Spiel über XCURSOR_PATH/THEME/SIZE genannt.
import fs from 'node:fs';
import path from 'node:path';

export const THEME = 'rollout-dot';
export const SIZE = 48;
const XCUR_MAGIC = 0x72756358; // "Xcur"
const IMAGE_TYPE = 0xfffd0002;
/** Namen, unter denen Anwendungen ihren Zeiger suchen: alle bekommen dasselbe runde Bild. */
export const CURSOR_NAMES = [
  'left_ptr', 'default', 'arrow', 'top_left_arrow', 'right_ptr', 'pointer', 'hand', 'hand1', 'hand2', 'text', 'xterm', 'crosshair', 'cross',
  'watch', 'wait', 'progress', 'move', 'fleur', 'grab', 'grabbing', 'not-allowed', 'help', 'question_arrow'
];

/** Bildpunkte als ARGB (vormultipliziert, 32 Bit je Punkt): Kreise mit weichem Rand von einem Pixel. */
export function dotPixels(size: number = SIZE): Uint32Array {
  const px = new Uint32Array(size * size);
  const c = (size - 1) / 2;
  const rOuter = size / 2 - 1;
  const rWhite = rOuter - size * 0.08;
  const rDot = size * 0.16;
  // Anteil eines Punktes innerhalb des Radius r (weicher Rand über 1 Pixel)
  const inside = (d: number, r: number): number => Math.max(0, Math.min(1, r - d + 0.5));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x - c, y - c);
      const outer = inside(d, rOuter);
      const white = inside(d, rWhite);
      const dot = inside(d, rDot);
      // Ebenen von unten nach oben: dunkler Rand (Alpha .92), weiß, blaue Mitte.
      const layers: [number, [number, number, number], number][] = [[outer, [10, 12, 24], 0.92], [white, [255, 255, 255], 1], [dot, [61, 107, 255], 1]];
      let r = 0, g = 0, b = 0, a = 0;
      for (const [cover, [lr, lg, lb], alpha] of layers) {
        const la = cover * alpha;
        r = lr * la + r * (1 - la); g = lg * la + g * (1 - la); b = lb * la + b * (1 - la); a = la + a * (1 - la);
      }
      // r, g, b sind schon mit dem Alpha gewichtet (vormultipliziert)
      px[y * size + x] = ((Math.round(a * 255) << 24) | (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)) >>> 0;
    }
  }
  return px;
}

/** Eine Xcursor-Datei mit einem Bild (Hotspot in der Mitte). */
export function cursorFile(size: number = SIZE): Buffer {
  const px = dotPixels(size);
  const header = 16;
  const toc = 12;
  const imageOffset = header + toc;
  const buf = Buffer.alloc(imageOffset + 36 + px.length * 4);
  buf.writeUInt32LE(XCUR_MAGIC, 0); buf.writeUInt32LE(header, 4); buf.writeUInt32LE(0x10000, 8); buf.writeUInt32LE(1, 12);
  buf.writeUInt32LE(IMAGE_TYPE, 16); buf.writeUInt32LE(size, 20); buf.writeUInt32LE(imageOffset, 24);
  buf.writeUInt32LE(36, imageOffset); buf.writeUInt32LE(IMAGE_TYPE, imageOffset + 4); buf.writeUInt32LE(size, imageOffset + 8); buf.writeUInt32LE(1, imageOffset + 12);
  buf.writeUInt32LE(size, imageOffset + 16); buf.writeUInt32LE(size, imageOffset + 20);
  buf.writeUInt32LE(Math.floor(size / 2), imageOffset + 24); buf.writeUInt32LE(Math.floor(size / 2), imageOffset + 28); buf.writeUInt32LE(0, imageOffset + 32);
  px.forEach((v, i) => buf.writeUInt32LE(v, imageOffset + 36 + i * 4));
  return buf;
}

/** Legt das Thema unter `<dir>/rollout-dot/` an (vorhandene Dateien werden ersetzt) und gibt die Umgebung für das Spiel zurück. */
export function writeCursorTheme(dir: string): NodeJS.ProcessEnv {
  const themeDir = path.join(dir, THEME);
  fs.mkdirSync(path.join(themeDir, 'cursors'), { recursive: true });
  fs.writeFileSync(path.join(themeDir, 'index.theme'), `[Icon Theme]\nName=Rollout\nComment=Runder Zeiger\n`);
  const file = cursorFile();
  for (const name of CURSOR_NAMES) fs.writeFileSync(path.join(themeDir, 'cursors', name), file);
  return { XCURSOR_PATH: dir, XCURSOR_THEME: THEME, XCURSOR_SIZE: String(SIZE) };
}

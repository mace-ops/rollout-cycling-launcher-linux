// Erzeugt die Bilder für die Steam-Bibliothek aus der Marke und dem Hintergrund der App. Nichts davon liegt im Repo,
// die Dateien entstehen lokal in config/grid und enthalten keine Herstellerlogos.
import { BrowserWindow, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { artworkFiles } from './steam';

/** `transparent`: Das Bild wird auf Schwarz gerendert und die Deckkraft danach aus der Helligkeit gerechnet, weil verborgene Fenster keinen Alphakanal liefern. */
interface Art { kind: 'portrait' | 'wide' | 'hero' | 'logo'; width: number; height: number; transparent: boolean }

const ART: Record<string, Art> = {
  p: { kind: 'portrait', width: 600, height: 900, transparent: false },
  '': { kind: 'wide', width: 920, height: 430, transparent: false },
  _hero: { kind: 'hero', width: 1920, height: 620, transparent: false },
  _logo: { kind: 'logo', width: 1280, height: 720, transparent: true }
};

function withAlphaFromBlack(image: Electron.NativeImage): Electron.NativeImage {
  const { width, height } = image.getSize();
  const bitmap = Buffer.from(image.toBitmap());
  for (let i = 0; i < bitmap.length; i += 4) {
    const alpha = Math.max(bitmap[i], bitmap[i + 1], bitmap[i + 2]);
    if (alpha === 0) {
      bitmap[i + 3] = 0;
      continue;
    }
    for (let c = 0; c < 3; c += 1) bitmap[i + c] = Math.min(255, Math.round((bitmap[i + c] * 255) / alpha));
    bitmap[i + 3] = alpha;
  }
  return nativeImage.createFromBitmap(bitmap, { width, height });
}

async function render(art: Art): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    width: art.width,
    height: art.height,
    useContentSize: true,
    backgroundColor: art.transparent ? '#000000' : '#08090E',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  try {
    win.setContentSize(art.width, art.height);
    const page = path.join(__dirname, '../renderer/art.html');
    for (let attempt = 1; ; attempt += 1) {
      try {
        await win.loadFile(page, { query: { kind: art.kind } });
        break;
      } catch (error) {
        if (attempt >= 3) throw error;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    for (let i = 0; i < 200 && win.getTitle() !== 'ready'; i += 1) await new Promise((r) => setTimeout(r, 100));
    if (win.getTitle() !== 'ready') throw new Error(`Bild ${art.kind} wurde nicht fertig`);
    await new Promise((r) => setTimeout(r, art.kind === 'hero' ? 2500 : 300));
    const image = await win.webContents.capturePage();
    // Bei skalierter Anzeige ist das Bild größer: auf die Maße bringen, die Steam erwartet.
    const size = image.getSize();
    const exact = size.width === art.width && size.height === art.height ? image : image.resize({ width: art.width, height: art.height, quality: 'best' });
    return art.transparent ? withAlphaFromBlack(exact).toPNG() : exact.toPNG();
  } finally {
    win.destroy();
  }
}

/** Schreibt fehlende Bilder (oder alle mit `force`). Gibt die Zahl der geschriebenen Dateien zurück. */
export async function writeArtwork(configDir: string, appId: number, force = false): Promise<number> {
  const grid = path.join(configDir, 'grid');
  fs.mkdirSync(grid, { recursive: true });
  let written = 0;
  for (const [suffix, art] of Object.entries(ART)) {
    const file = path.join(grid, `${appId}${suffix}.png`);
    if (!force && fs.existsSync(file)) continue;
    const png = await render(art);
    const temp = `${file}.rollout-tmp`;
    fs.writeFileSync(temp, png);
    fs.renameSync(temp, file);
    written += 1;
  }
  return written;
}

/** Prüft, ob alle Bilder da sind und die richtige Größe haben. */
export function artworkComplete(configDir: string, appId: number): boolean {
  return artworkFiles(configDir, appId).every((file) => {
    if (!fs.existsSync(file)) return false;
    const suffix = path.basename(file).slice(String(appId).length).replace(/\.png$/, '');
    const art = ART[suffix];
    const size = nativeImage.createFromPath(file).getSize();
    return !!art && size.width === art.width && size.height === art.height;
  });
}

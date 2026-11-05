// Rohaufnahmen (site/shots-raw/en/s<n>-<name>.png, 1600 × 1000, englische Oberfläche) → Website (site/static/screens/en) und README (docs/media).
// Aufruf: node scripts/process-shots.mjs [Rohordner]. Aufnahme siehe site/README.md (app/test/shots.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..');
const REPO = path.resolve(SITE, '..');
const RAW = path.resolve(process.argv[2] ?? path.join(SITE, 'shots-raw'));
// Alle Sprachseiten und beide READMEs zeigen dieselben englischen Aufnahmen (nur die Bildtexte sind übersetzt).
const LANGS = ['en'];
const NAMES = ['home', 'pick', 'before-install', 'installing', 'done', 'bluetooth', 'starting', 'error', 'settings', 'advanced', 'light', 'steam'];
const README_LANGS = ['en'];
const README_MAX = 300 * 1024;
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });

function rawFile(lang, name) {
  const dir = path.join(RAW, lang);
  const hit = fs.readdirSync(dir).find((f) => f.replace(/^s\d+-/, '') === `${name}.png`);
  if (!hit) throw new Error(`Aufnahme fehlt: ${lang}/${name}`);
  return path.join(dir, hit);
}

async function jpgUnder(buf, max) {
  for (const q of [82, 76, 70, 64, 58, 52]) {
    const out = await sharp(buf).jpeg({ quality: q, mozjpeg: true }).toBuffer();
    if (out.length < max) return out;
  }
  throw new Error('JPG bleibt über dem Limit');
}

const frames = {};
for (const lang of LANGS) {
  const web = path.join(SITE, 'static', 'screens', lang);
  mkdir(web);
  for (const name of NAMES) {
    const src = rawFile(lang, name);
    const full = await sharp(src).resize(1280, 800, { fit: 'cover' }).png().toBuffer();
    fs.writeFileSync(path.join(web, `${name}.webp`), await sharp(full).webp({ quality: 80, effort: 5 }).toBuffer());
    fs.writeFileSync(path.join(web, `${name}-640.webp`), await sharp(full).resize(640, 400).webp({ quality: 78, effort: 5 }).toBuffer());
    fs.writeFileSync(path.join(web, `${name}.jpg`), await jpgUnder(full, 400 * 1024));
    if (README_LANGS.includes(lang)) {
      const out = path.join(REPO, 'docs', 'media', 'screens', lang);
      mkdir(out);
      fs.writeFileSync(path.join(out, `${name}.jpg`), await jpgUnder(full, README_MAX));
    }
    if (lang === 'en') frames[name] = full;
  }
  console.log('Bilder', lang);
}

// README-Kopfbild: 960 px breit, 5 Ansichten im Wechsel
const GIF = ['home', 'before-install', 'installing', 'bluetooth', 'settings'];
const w = 960, h = 600;
const pages = await Promise.all(GIF.map((n) => sharp(frames[n]).resize(w, h).png().toBuffer()));
const gif = await sharp(pages, { join: { animated: true } }).gif({ delay: GIF.map(() => 2200), loop: 0, effort: 7, colours: 128, dither: 0.6 }).toBuffer();
const gifOut = path.join(REPO, 'docs', 'media', 'hero-carousel.gif');
mkdir(path.dirname(gifOut));
fs.writeFileSync(gifOut, gif);
console.log('hero-carousel.gif', (gif.length / 1024 / 1024).toFixed(2), 'MB');

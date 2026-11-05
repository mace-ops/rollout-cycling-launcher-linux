// Statische Website bauen: eine Vorlage (src/page.html) + Texte je Sprache (i18n/<lang>.json) → dist/.
// Aufruf: node build.mjs. Bricht ab, wenn ein Schlüssel fehlt oder übrig ist. Einzige Abhängigkeit: sharp (Bilder).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DIST = path.join(HERE, 'dist');
const BASE = 'https://mace-ops.github.io/rollout-cycling-launcher-linux/';
const BASE_PATH = '/rollout-cycling-launcher-linux/';
const DESKTOP_URL = 'https://github.com/mace-ops/rollout-cycling-launcher-linux/releases/latest/download/Rollout.desktop';
const LANGS = ['en', 'de', 'es', 'fr', 'it', 'pt', 'nl', 'pl'];
const NATIVE = { en: 'English', de: 'Deutsch', es: 'Español', fr: 'Français', it: 'Italiano', pt: 'Português', nl: 'Nederlands', pl: 'Polski' };
const LOCALE = { en: 'en_US', de: 'de_DE', es: 'es_ES', fr: 'fr_FR', it: 'it_IT', pt: 'pt_BR', nl: 'nl_NL', pl: 'pl_PL' };
// Karussell (Reihenfolge = Ablauf) und Ton (Akzent der App); `steam` kommt nur im Funktionsteil vor.
const SLIDES = [['home', 'zwift'], ['pick', 'zwift'], ['before-install', 'mywhoosh'], ['installing', 'zwift'], ['done', 'zwift'], ['bluetooth', 'mywhoosh'],
  ['starting', 'mywhoosh'], ['error', 'mywhoosh'], ['settings', 'zwift'], ['advanced', 'mywhoosh'], ['light', 'zwift']];
const SHOTS = [...SLIDES.map(([n]) => n), 'steam'];
// Funktionen: Schlüssel, Bild, Chips ({key} übersetzt, {lit} wörtlich, {kc} Tastenkappe vor dem übersetzten Text)
const FEATURES = [
  { id: 'f0', shot: 'home', chips: [{ kc: ['✚', 'L'], key: 'f0.c1' }, { kc: ['A'], key: 'f0.c2' }, { kc: ['B'], key: 'f0.c3' }, { kc: ['R'], key: 'f0.c4' }] },
  { id: 'f1', shot: 'installing', chips: [{ key: 'f1.c1' }, { key: 'f1.c2' }] },
  { id: 'f2', shot: 'settings', chips: [{ lit: 'Ed25519' }, { lit: 'SHA-256' }, { key: 'f2.c1' }] },
  { id: 'f3', shot: 'steam', chips: [{ key: 'f3.c1' }, { key: 'f3.c2' }] },
  { id: 'f4', shot: 'bluetooth', chips: [{ lit: 'FTMS' }, { lit: 'Cycling Power' }, { lit: 'Heart Rate' }] },
  { id: 'f5', shot: 'error', chips: [{ key: 'f5.c1' }, { key: 'f5.c2' }] },
  { id: 'f6', shot: 'advanced', chips: [{ lit: 'GE-Proton' }, { key: 'f6.c1' }, { key: 'f6.c2' }] }
];
const FAQ_COUNT = 8;
// Solange Rollout.desktop kein Release-Asset ist: config.json { "downloadLive": false } graut die Download-Knöpfe aus und lässt downloadUrl weg.
const DOWNLOAD_LIVE = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8')).downloadLive === true;

const log = (...a) => console.log('[build]', ...a);
const die = (msg) => { throw new Error(msg); };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const read = (...p) => fs.readFileSync(path.join(HERE, ...p), 'utf8');
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });

// --- Texte laden und prüfen ------------------------------------------------------------------------------------------------
const messages = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(read('i18n', `${l}.json`))]));
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const l of LANGS) {
  const missing = Object.keys(messages.en).filter((k) => !(k in messages[l]));
  const extra = Object.keys(messages[l]).filter((k) => !(k in messages.en));
  if (missing.length || extra.length) die(`i18n/${l}.json: fehlt ${JSON.stringify(missing)}, übrig ${JSON.stringify(extra)}`);
  for (const [k, v] of Object.entries(messages[l])) {
    if (typeof v !== 'string' || !v.trim()) die(`i18n/${l}.json: ${k} ist leer`);
    if (placeholders(v) !== placeholders(messages.en[k])) die(`i18n/${l}.json: Platzhalter von ${k} weichen von en ab`);
  }
}
const used = new Set();
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'app', 'package.json'), 'utf8'));
const VERSION = pkg.version;

// --- Vorlage ---------------------------------------------------------------------------------------------------------------
function render(template, lang, vars, loops = {}) {
  const m = messages[lang];
  const tr = (key, raw) => {
    if (!(key in m)) die(`Schlüssel fehlt: ${key} (${lang})`);
    used.add(key);
    return raw ? m[key] : esc(m[key]);
  };
  let out = template.replace(/<!--each:(\w+)-->([\s\S]*?)<!--\/each-->/g, (_all, name, body) => {
    const items = loops[name] ?? die(`Schleife fehlt: ${name}`);
    return items.map((item, i) => body
      .replace(/\{\{([thv]):([^}]+)\}\}/g, (_x, kind, key) => {
        const k = key.replace(/\$/g, item.id);
        if (kind === 'v') {
          const val = key === '#' ? String(i + 1) : key === '##' ? String(i + 1).padStart(2, '0') : key === 'total' ? String(items.length) : key === 'i' ? String(i) : item.vars?.[key];
          return val ?? die(`Schleifenvariable fehlt: ${key} in ${name}`);
        }
        return tr(k, kind === 'h');
      })).join('');
  });
  out = out.replace(/\{\{([thv]):([^}]+)\}\}/g, (_x, kind, key) => {
    if (kind === 'v') return vars[key] ?? die(`Variable fehlt: ${key}`);
    return tr(key, kind === 'h');
  });
  return out;
}
const T = (lang, key) => { used.add(key); return messages[lang][key] ?? die(`Schlüssel fehlt: ${key} (${lang})`); };

// --- Bilder ----------------------------------------------------------------------------------------------------------------
// Bilder gibt es nur englisch; die Sprachseiten setzen übersetzte Bildtexte darauf.
const SHOT_LANG = 'en';
const screenPath = (_lang, name, ext) => path.join(HERE, 'static', 'screens', SHOT_LANG, `${name}${ext}`);
function picture(root, lang, name, alt, { eager = false, sizes, cls = '' } = {}) {
  for (const ext of ['.jpg', '.webp', '-640.webp']) if (!fs.existsSync(screenPath(lang, name, ext))) die(`Screenshot fehlt: static/screens/${SHOT_LANG}/${name}${ext} (npm run shots)`);
  const dir = `${root}assets/screens/${SHOT_LANG}/${name}`;
  return `<picture${cls ? ` class="${cls}"` : ''}><source type="image/webp" srcset="${dir}-640.webp 640w, ${dir}.webp 1280w" sizes="${sizes}"><img src="${dir}.jpg" alt="${esc(alt)}" width="1280" height="800" ${eager ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"'}></picture>`;
}

const PHOTO_SRC = { mywhoosh: path.join(REPO, 'app/src/renderer/assets/img/mywhoosh.jpg'), zwift: path.join(REPO, 'app/src/renderer/assets/img/zwift.jpg') };
const PHOTO_SIZES = [800, 1600];
async function buildPhotos() {
  const dir = path.join(DIST, 'assets', 'photos');
  mkdir(dir);
  const cache = path.join(HERE, '.cache', 'photos');
  mkdir(cache);
  for (const [name, src] of Object.entries(PHOTO_SRC)) {
    const hash = createHash('sha1').update(fs.readFileSync(src)).digest('hex').slice(0, 10);
    for (const w of PHOTO_SIZES) {
      const h = Math.round(w * 10 / 16);
      for (const fmt of ['avif', 'webp', 'jpg']) {
        const file = `${name}-${w}.${fmt}`, cached = path.join(cache, `${hash}-${file}`);
        if (!fs.existsSync(cached)) {
          let img = sharp(src).resize(w, h, { fit: 'cover', position: 'centre' });
          img = fmt === 'avif' ? img.avif({ quality: 52, effort: 4 }) : fmt === 'webp' ? img.webp({ quality: 74 }) : img.jpeg({ quality: 76, mozjpeg: true });
          fs.writeFileSync(cached, await img.toBuffer());
        }
        fs.copyFileSync(cached, path.join(dir, file));
      }
    }
  }
}
function photo(root, name, alt) {
  const d = `${root}assets/photos/${name}`, sizes = '(min-width:1160px) 568px, (min-width:681px) 46vw, 92vw';
  const set = (ext) => PHOTO_SIZES.map((w) => `${d}-${w}.${ext} ${w}w`).join(', ');
  return `<picture><source type="image/avif" srcset="${set('avif')}" sizes="${sizes}"><source type="image/webp" srcset="${set('webp')}" sizes="${sizes}"><img src="${d}-800.jpg" srcset="${set('jpg')}" sizes="${sizes}" alt="${esc(alt)}" width="1600" height="1000" loading="lazy" decoding="async"></picture>`;
}

// Open-Graph-Bild 1200 × 630: Claim links, Startbildschirm im Geräterahmen rechts. Schriften: static/og-fonts (Instanzen der Variablenschriften).
async function ogImage(lang) {
  const W = 1200, H = 630;
  const fonts = path.join(HERE, 'static', 'og-fonts');
  const text = async (markup, font, file, width) => sharp({ text: { text: markup, font, fontfile: path.join(fonts, file), width, rgba: true, dpi: 72, wrap: 'word', align: 'left' } }).png().toBuffer({ resolveWithObject: true });
  const claim = await text(`<span foreground="#F4F4F6">${esc(T(lang, 'og.claim'))}</span>`, 'Archivo OG 56', 'archivo-display.ttf', 480);
  const sub = await text(`<span foreground="#A0A3AD">${esc(T(lang, 'og.sub'))}</span>`, 'Figtree OG 30', 'figtree-medium.ttf', 480);
  const brand = await text('<span foreground="#F4F4F6">Rollout</span>', 'Archivo OG 34', 'archivo-display.ttf', 300);
  const logo = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="130 130 764 764" width="44" height="44" fill="none" stroke-linecap="round"><path d="M750.5 242.4A360 360 0 1 0 772.3 263.3" stroke="#F4F4F6" stroke-width="32"/><path d="M700.3 291.5A290 290 0 1 0 725.1 315.3" stroke="#F4F4F6" stroke-width="32"/><path d="M713.1 303L759.5 254.8" stroke="#FF7A2F" stroke-width="40"/></svg>`), { density: 144 }).resize(44, 44).png().toBuffer();
  const bar = await sharp({ create: { width: 48, height: 4, channels: 3, background: '#FF7A2F' } }).png().toBuffer();
  const sw = 560, sh = 350, fx = 592, fy = 140; // Bild im Rahmen
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${sw}" height="${sh}"><rect width="${sw}" height="${sh}" rx="18" fill="#fff"/></svg>`);
  const shot = await sharp(screenPath(lang, 'home', '.jpg')).resize(sw, sh).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const frame = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#0B0C10"/><rect x="${fx - 10}" y="${fy - 10}" width="${sw + 20}" height="${sh + 20}" rx="26" fill="#14161C" stroke="#2A2D36" stroke-width="2"/></svg>`);
  const blockH = claim.info.height + 30 + sub.info.height, y1 = Math.round((H - blockH) / 2) + 24;
  return sharp(frame).composite([
    { input: logo, left: 64, top: 56 }, { input: brand.data, left: 120, top: 58 },
    { input: bar, left: 64, top: y1 - 28 }, { input: claim.data, left: 64, top: y1 }, { input: sub.data, left: 64, top: y1 + claim.info.height + 30 },
    { input: shot, left: fx, top: fy }
  ]).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
}

// --- Seiten ----------------------------------------------------------------------------------------------------------------
const pageUrl = (lang) => (lang === 'en' ? BASE : `${BASE}${lang}/`);
const relPath = (from, to) => (from === 'en' ? (to === 'en' ? './' : `${to}/`) : (to === 'en' ? '../' : to === from ? './' : `../${to}/`));

function jsonLd(lang, root) {
  const m = messages[lang];
  const app = {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Rollout', description: T(lang, 'meta.description'), url: pageUrl(lang),
    applicationCategory: 'GameApplication', applicationSubCategory: 'Game launcher', operatingSystem: 'SteamOS, Bazzite', softwareVersion: VERSION,
    inLanguage: LANGS, isAccessibleForFree: true, license: 'https://opensource.org/licenses/MIT',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' }, ...(DOWNLOAD_LIVE ? { downloadUrl: DESKTOP_URL } : {}),
    screenshot: `${BASE}assets/screens/${SHOT_LANG}/home.jpg`, image: `${BASE}assets/og/${lang}.jpg`,
    featureList: FEATURES.map((f) => T(lang, `${f.id}.t`))
  };
  const faq = {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: Array.from({ length: FAQ_COUNT }, (_v, i) => ({ '@type': 'Question', name: T(lang, `faq.${i + 1}.q`), acceptedAnswer: { '@type': 'Answer', text: T(lang, `faq.${i + 1}.a`) } }))
  };
  void m; void root;
  const ser = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
  return { app: ser(app), faq: ser(faq) };
}

function buildPage(template, lang, buildId) {
  const root = lang === 'en' ? '' : '../';
  const sizesHero = '(min-width:1160px) 1112px, calc(100vw - 32px)';
  const sizesSlide = '(min-width:1116px) 960px, 86vw';
  const sizesApp = '(min-width:1160px) 568px, (min-width:681px) 46vw, 92vw';
  const sizesStage = '(min-width:1160px) 640px, 55vw';
  const alt = (n) => T(lang, `shot.${n}.alt`);
  const ld = jsonLd(lang, root);
  const hreflang = [...LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${pageUrl(l)}">`), `<link rel="alternate" hreflang="x-default" href="${BASE}">`].join('\n');
  const ogAlternates = LANGS.filter((l) => l !== lang).map((l) => `<meta property="og:locale:alternate" content="${LOCALE[l]}">`).join('\n');
  const langLinks = LANGS.map((l) => `          <li><a href="${relPath(lang, l)}" hreflang="${l}" lang="${l}"${l === lang ? ' aria-current="page"' : ''}>${NATIVE[l]}<small>${l}</small></a></li>`).join('\n');
  let hint = '';
  if (lang === 'en') {
    const data = Object.fromEntries(LANGS.map((l) => [l, { text: T(l, 'hint.text'), go: T(l, 'hint.go'), close: T(l, 'hint.close'), href: relPath('en', l) }]));
    hint = `<div class="hint" id="hint" role="status" hidden><span id="hint-text"></span> <a id="hint-link" href="./"></a><button type="button" id="hint-close">×</button></div>\n<script type="application/json" id="hints">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
  }
  const slides = SLIDES.map(([name, tone]) => ({ id: `${name}`, vars: { tone, img: picture(root, lang, name, alt(name), { sizes: sizesSlide }) } }));
  const features = FEATURES.map((f, i) => {
    const chips = f.chips.map((c) => {
      if (c.lit) return `<span>${esc(c.lit)}</span>`;
      const caps = (c.kc ?? []).map((k) => `<i class="kc">${esc(k)}</i>`).join('');
      return `<span>${caps}${esc(T(lang, c.key))}</span>`;
    }).join('');
    return { id: f.id, vars: { on: i === 0 ? ' on' : '', chips, inlineImg: picture(root, lang, f.shot, alt(f.shot), { sizes: '(min-width:1160px) 568px, 92vw' }) } };
  });
  const stageImgs = FEATURES.map((f, i) => picture(root, lang, f.shot, '', { sizes: sizesStage, cls: i === 0 ? 'on' : '' })).join('');
  const faq = Array.from({ length: FAQ_COUNT }, (_v, i) => ({ id: String(i + 1) }));
  const vars = {
    lang, root, url: pageUrl(lang), home: './', hreflang, ogLocale: LOCALE[lang], ogAlternates, ogimage: `${BASE}assets/og/${lang}.jpg`, buildId,
    ldApp: ld.app, ldFaq: ld.faq, langCode: lang.toUpperCase(), langLinks, hint, version: VERSION,
    dlClass: DOWNLOAD_LIVE ? '' : ' disabled', dlAttrs: DOWNLOAD_LIVE ? `href="${DESKTOP_URL}" download` : 'role="link" aria-disabled="true"',
    dlSoon: DOWNLOAD_LIVE ? (T(lang, 'dl.soon'), '') : `<p class="soon">${esc(T(lang, 'dl.soon'))}</p>`,
    heroShot: picture(root, lang, 'home', alt('home'), { eager: true, sizes: sizesHero }),
    appShotMywhoosh: picture(root, lang, 'starting', alt('starting'), { sizes: sizesApp }),
    appShotZwift: picture(root, lang, 'installing', alt('installing'), { sizes: sizesApp }),
    stageImgs,
    photoMywhoosh: photo(root, 'mywhoosh', T(lang, 'final.photo.mywhoosh')), photoZwift: photo(root, 'zwift', T(lang, 'final.photo.zwift'))
  };
  // Bildbeschreibungen, die nur im Funktionsteil oder in Datenfeldern vorkommen, zählen als benutzt
  used.add('shot.steam.alt');
  return render(template, lang, vars, { slides, features, faq });
}

// --- Lauf ------------------------------------------------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  fs.rmSync(DIST, { recursive: true, force: true });
  mkdir(path.join(DIST, 'assets'));
  // Assets mit Inhaltsstempel
  const css = read('src', 'site.css'), bg = read('src', 'bg.js'), js = read('src', 'site.js');
  const buildId = createHash('sha1').update(css + bg + js).digest('hex').slice(0, 8);
  fs.writeFileSync(path.join(DIST, 'assets', 'site.css'), css);
  fs.writeFileSync(path.join(DIST, 'assets', 'bg.js'), bg);
  fs.writeFileSync(path.join(DIST, 'assets', 'site.js'), js);
  fs.cpSync(path.join(HERE, 'static', 'fonts'), path.join(DIST, 'assets', 'fonts'), { recursive: true });
  fs.copyFileSync(path.join(HERE, 'static', 'favicon.svg'), path.join(DIST, 'assets', 'favicon.svg'));
  fs.cpSync(path.join(HERE, 'static', 'screens'), path.join(DIST, 'assets', 'screens'), { recursive: true });
  await buildPhotos();
  fs.writeFileSync(path.join(DIST, '.nojekyll'), '');

  // OG-Bilder
  mkdir(path.join(DIST, 'assets', 'og'));
  for (const lang of LANGS) fs.writeFileSync(path.join(DIST, 'assets', 'og', `${lang}.jpg`), await ogImage(lang));

  // Seiten
  const template = read('src', 'page.html');
  for (const lang of LANGS) {
    const html = buildPage(template, lang, buildId);
    const dir = lang === 'en' ? DIST : path.join(DIST, lang);
    mkdir(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), html);
  }

  // 404 (eine Datei, alle Sprachen versteckt eingebettet; Skript wählt nach Pfad)
  const blocks = LANGS.map((l) => `<div data-nf="${l}" lang="${l}"${l === 'en' ? '' : ' hidden'} style="display:flex;flex-direction:column;align-items:center;gap:20px"><h1 class="display" style="font-size:clamp(36px,6vw,64px)">${esc(T(l, 'nf.title'))}</h1><p class="lead">${esc(T(l, 'nf.text'))}</p><a class="btn primary" href="${BASE_PATH}${l === 'en' ? '' : `${l}/`}">${esc(T(l, 'nf.home'))}</a></div>`).join('\n');
  const nf = read('src', '404.html').replace(/\{\{([thv]):([^}]+)\}\}/g, (_x, kind, key) => {
    if (kind === 'v') return { base: BASE_PATH, basePath: BASE_PATH, buildId, blocks }[key] ?? die(`404: Variable fehlt: ${key}`);
    return esc(T('en', key));
  });
  fs.writeFileSync(path.join(DIST, '404.html'), nf);

  // sitemap.xml, robots.txt
  const today = new Date().toISOString().slice(0, 10);
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${LANGS.map((l) => `  <url>\n    <loc>${pageUrl(l)}</loc>\n    <lastmod>${today}</lastmod>\n${LANGS.map((x) => `    <xhtml:link rel="alternate" hreflang="${x}" href="${pageUrl(x)}"/>`).join('\n')}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE}"/>\n  </url>`).join('\n')}\n</urlset>\n`;
  fs.writeFileSync(path.join(DIST, 'sitemap.xml'), sitemap);
  fs.writeFileSync(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${BASE}sitemap.xml\n`);

  // Schlüssel, die keine Vorlage und kein Builder benutzt
  const unused = Object.keys(messages.en).filter((k) => !used.has(k));
  if (unused.length) die(`Ungenutzte Schlüssel in en.json: ${unused.join(', ')}`);
  log(`fertig in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${LANGS.length} Sprachen, Version ${VERSION}`);
}

main().catch((e) => { console.error(`[build] FEHLER: ${e.message}`); process.exit(1); });

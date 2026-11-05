// Prüfskript für site/dist (npm test baut vorher): Seiten, SEO-Pflichten, hreflang, JSON-LD, Links, Bilder, Inhalt.
// Jede Verletzung steht in der Ausgabe, Exit-Code 1 bei mindestens einer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
const BASE = 'https://mace-ops.github.io/rollout-cycling-launcher-linux/';
const LANGS = ['en', 'de', 'es', 'fr', 'it', 'pt', 'nl', 'pl'];
const LOCALE = { en: 'en_US', de: 'de_DE', es: 'es_ES', fr: 'fr_FR', it: 'it_IT', pt: 'pt_BR', nl: 'nl_NL', pl: 'pl_PL' };
const LIVE = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')).downloadLive === true;
const url = (l) => (l === 'en' ? BASE : `${BASE}${l}/`);
const problems = [];
const bad = (msg) => problems.push(msg);
const ok = (cond, msg) => { if (!cond) bad(msg); return cond; };
const file = (...p) => path.join(DIST, ...p);
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const attr = (tag, name) => (tag.match(new RegExp(`\\s${name}="([^"]*)"`)) ?? [])[1];
const metaContent = (html, key, val) => (html.match(new RegExp(`<meta[^>]*${key}="${val}"[^>]*>`)) ?? []).map?.((t) => attr(t, 'content'))[0];
const unescape = (s) => (s ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

ok(fs.existsSync(DIST), 'dist/ fehlt (node build.mjs)');
const pages = {};
for (const l of LANGS) {
  const f = l === 'en' ? file('index.html') : file(l, 'index.html');
  if (!ok(fs.existsSync(f), `Seite fehlt: ${l}`)) continue;
  pages[l] = fs.readFileSync(f, 'utf8');
}
for (const f of ['sitemap.xml', 'robots.txt', '404.html', '.nojekyll']) ok(fs.existsSync(file(f)), `${f} fehlt`);
for (const l of LANGS) ok(fs.existsSync(file('assets', 'og', `${l}.jpg`)), `OG-Bild fehlt: ${l}`);

// OG-Bildgröße
for (const l of LANGS) {
  const f = file('assets', 'og', `${l}.jpg`);
  if (!fs.existsSync(f)) continue;
  const m = await sharp(f).metadata();
  ok(m.width === 1200 && m.height === 630, `OG-Bild ${l}: ${m.width}×${m.height}, erwartet 1200×630`);
}

const allLinks = new Map();
for (const [l, html] of Object.entries(pages)) {
  const P = `[${l}]`;
  ok(new RegExp(`<html lang="${l}">`).test(html), `${P} <html lang> falsch`);
  const title = unescape((html.match(/<title>([^<]*)<\/title>/) ?? [])[1]);
  ok(title && title.length <= 60, `${P} Titel ${title.length} Zeichen (max. 60): ${title}`);
  const desc = unescape(metaContent(html, 'name', 'description'));
  ok(desc && desc.length <= 155 && desc.length >= 70, `${P} Beschreibung ${desc.length} Zeichen (70–155)`);
  ok((html.match(/<h1[ >]/g) ?? []).length === 1, `${P} genau ein h1 erwartet`);
  for (const tag of ['header', 'main', 'footer']) ok(new RegExp(`<${tag}[ >]`).test(html), `${P} <${tag}> fehlt`);
  const sections = [...html.matchAll(/<section\b[^>]*>/g)].map((m) => m[0]);
  for (const s of sections) {
    const id = attr(s, 'aria-labelledby');
    ok(id && html.includes(`id="${id}"`), `${P} section ohne gültiges aria-labelledby: ${s}`);
  }
  // canonical, hreflang
  ok(html.includes(`<link rel="canonical" href="${url(l)}">`), `${P} canonical zeigt nicht auf sich selbst`);
  for (const x of LANGS) ok(html.includes(`<link rel="alternate" hreflang="${x}" href="${url(x)}">`), `${P} hreflang ${x} fehlt`);
  ok(html.includes(`hreflang="x-default" href="${BASE}"`), `${P} x-default fehlt`);
  // Open Graph, Twitter
  ok(metaContent(html, 'property', 'og:locale') === LOCALE[l], `${P} og:locale falsch`);
  ok((html.match(/property="og:locale:alternate"/g) ?? []).length === LANGS.length - 1, `${P} og:locale:alternate unvollständig`);
  for (const k of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type']) ok(metaContent(html, 'property', k), `${P} ${k} fehlt`);
  ok(metaContent(html, 'property', 'og:image') === `${BASE}assets/og/${l}.jpg`, `${P} og:image zeigt auf das falsche Bild`);
  ok(metaContent(html, 'name', 'twitter:card') === 'summary_large_image', `${P} twitter:card fehlt`);
  // JSON-LD
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  ok(blocks.length === 2, `${P} zwei JSON-LD-Blöcke erwartet, ${blocks.length} gefunden`);
  const ld = [];
  for (const b of blocks) { try { ld.push(JSON.parse(b)); } catch (e) { bad(`${P} JSON-LD nicht parsebar: ${e.message}`); } }
  const app = ld.find((o) => o['@type'] === 'SoftwareApplication'), faq = ld.find((o) => o['@type'] === 'FAQPage');
  if (app) {
    const v = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'app', 'package.json'), 'utf8')).version;
    ok(app.softwareVersion === v, `${P} softwareVersion ${app.softwareVersion} ≠ package.json ${v}`);
    ok(app.offers?.price === '0' && app.operatingSystem && (LIVE ? app.downloadUrl?.endsWith('/releases/latest/download/Rollout.desktop') : app.downloadUrl === undefined) && app.screenshot && app.featureList?.length === 7, `${P} SoftwareApplication unvollständig`);
  } else bad(`${P} SoftwareApplication fehlt`);
  if (faq) {
    const visible = [...html.matchAll(/<details><summary>([\s\S]*?)<\/summary><p>([\s\S]*?)<\/p><\/details>/g)].map((m) => [unescape(m[1]), unescape(m[2])]);
    ok(visible.length === faq.mainEntity.length && visible.length >= 6, `${P} FAQ: ${visible.length} sichtbar, ${faq.mainEntity.length} im JSON-LD`);
    faq.mainEntity.forEach((q, i) => ok(visible[i] && visible[i][0] === q.name && visible[i][1] === q.acceptedAnswer.text, `${P} FAQ ${i + 1}: sichtbarer Text ≠ JSON-LD`));
  } else bad(`${P} FAQPage fehlt`);
  // Bilder
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    const t = m[0], src = attr(t, 'src');
    ok(attr(t, 'width') && attr(t, 'height'), `${P} Bild ohne width/height: ${src}`);
    ok(t.includes(' alt="'), `${P} Bild ohne alt: ${src}`);
    ok(!/^https?:/.test(src ?? ''), `${P} externes Bild: ${src}`);
  }
  const eager = [...html.matchAll(/<img\b[^>]*>/g)].filter((m) => !m[0].includes('loading="lazy"'));
  ok(eager.length === 1 && eager[0][0].includes('fetchpriority="high"'), `${P} genau ein eager-Bild (LCP, fetchpriority=high) erwartet, ${eager.length} gefunden`);
  const emptyAlt = [...html.matchAll(/<img\b[^>]*alt=""[^>]*>/g)].length;
  ok(emptyAlt >= 7, `${P} Funktionsbühne sollte dekorative Bilder (alt="") enthalten`);
  // keine fremden Skripte, Schriften, Tracking
  for (const m of html.matchAll(/<(script|link)\b[^>]*>/g)) {
    const u = attr(m[0], 'src') ?? attr(m[0], 'href');
    if (u && /^https?:/.test(u) && !/rel="(canonical|alternate)"/.test(m[0])) bad(`${P} externe Ressource: ${u}`);
  }
  ok(!/googletagmanager|google-analytics|fonts\.googleapis|fonts\.gstatic|plausible|matomo/i.test(html), `${P} Tracking oder Google Fonts gefunden`);
  // Inhalt: kein Claude/KI, kein CLI-Befehl, kein „Open Source“-Versprechen ohne MIT (MIT steht in final.sub)
  const plain = text(html);
  ok(!/claude|anthropic|artificial|künstliche|inteligencia artificial|intelligence artificielle/i.test(plain) && !/\b(KI|AI)\b/.test(plain), `${P} Erwähnung von Claude/KI`);
  ok(!/\b(curl|wget|sudo \w|bash -c|sh -c|chmod \+x|\| ?sh)\b/.test(plain.replace(/no sudo|kein sudo|sin sudo|sans sudo|senza sudo|sem sudo|geen sudo|bez sudo|Kein sudo|No sudo|Sin sudo|Sans sudo|Senza sudo|Sem sudo|Geen sudo|Bez sudo/gi, '')), `${P} CLI-Befehl im sichtbaren Text`);
  ok(/Zwift, Inc\./.test(plain) && /MyWhoosh/.test(plain) && /Valve/.test(plain), `${P} Marken-Hinweis fehlt`);
  const dl = [...html.matchAll(/href="([^"]*Rollout\.desktop)"/g)].map((m) => m[1]);
  if (LIVE) ok(dl.length === 2 && dl.every((d) => d === 'https://github.com/mace-ops/rollout-cycling-launcher-linux/releases/latest/download/Rollout.desktop'), `${P} zwei Download-Knöpfe mit Rollout.desktop erwartet`);
  else ok(dl.length === 0 && (html.match(/aria-disabled="true"/g) ?? []).length === 2 && html.includes('class="soon"'), `${P} Download-Knöpfe sollen ausgegraut sein (downloadLive=false)`);
  // interne Links und Anker
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>/g)) {
    const href = m[1];
    if (/^(https?:|mailto:)/.test(href)) continue;
    if (href.startsWith('#')) { if (href.length > 1) ok(html.includes(`id="${href.slice(1)}"`), `${P} Anker ${href} ohne Ziel`); continue; }
    allLinks.set(`${l}|${href}`, { l, href });
  }
  for (const m of html.matchAll(/(?:src|href|srcset)="([^"]+)"/g)) {
    for (const part of m[1].split(',')) {
      const u = part.trim().split(/\s+/)[0];
      if (!u || /^(https?:|#|mailto:|data:)/.test(u)) continue;
      allLinks.set(`${l}|${u}`, { l, href: u });
    }
  }
}
// Linkziele auflösen
for (const { l, href } of allLinks.values()) {
  const dir = l === 'en' ? DIST : file(l);
  const clean = href.split('#')[0].split('?')[0];
  let target = path.resolve(dir, clean);
  if (!target.startsWith(DIST)) { bad(`[${l}] Link verlässt dist: ${href}`); continue; }
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  ok(fs.existsSync(target), `[${l}] toter Link: ${href}`);
}
// Screenshots: Größe und Format
for (const l of LANGS) {
  const dir = file('assets', 'screens', l);
  if (!ok(fs.existsSync(dir), `Screenshots fehlen: ${l}`)) continue;
  for (const f of fs.readdirSync(dir)) {
    const m = await sharp(path.join(dir, f)).metadata();
    const w = f.endsWith('-640.webp') ? 640 : 1280;
    ok(m.width === w && m.height === w * 10 / 16, `Screenshot ${l}/${f}: ${m.width}×${m.height}, erwartet ${w}×${w * 10 / 16}`);
    ok(fs.statSync(path.join(dir, f)).size < 400 * 1024, `Screenshot ${l}/${f} über 400 KB`);
  }
}
// sitemap
const sm = fs.existsSync(file('sitemap.xml')) ? fs.readFileSync(file('sitemap.xml'), 'utf8') : '';
for (const l of LANGS) {
  ok(sm.includes(`<loc>${url(l)}</loc>`), `sitemap: ${l} fehlt`);
  for (const x of LANGS) ok(sm.split(`<loc>${url(l)}</loc>`)[1]?.split('</url>')[0].includes(`hreflang="${x}" href="${url(x)}"`), `sitemap: ${l} ohne Alternate ${x}`);
}
ok(/Sitemap: https:\/\/mace-ops\.github\.io\/rollout-cycling-launcher-linux\/sitemap\.xml/.test(fs.existsSync(file('robots.txt')) ? fs.readFileSync(file('robots.txt'), 'utf8') : ''), 'robots.txt ohne Sitemap-Verweis');
// Gesamtgröße der Auslieferung
const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
const mb = size(DIST) / 1024 / 1024;
ok(mb < 60, `dist ist ${mb.toFixed(1)} MB (Limit 60)`);

if (problems.length) {
  console.log(`✗ ${problems.length} Problem(e):`);
  for (const p of problems) console.log('  -', p);
  process.exit(1);
}
console.log(`✓ alle Prüfungen bestanden (${LANGS.length} Seiten, dist ${mb.toFixed(1)} MB)`);

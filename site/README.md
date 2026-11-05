# Rollout-Website

Statische, mehrsprachige Seite für GitHub Pages: <https://mace-ops.github.io/rollout-cycling-launcher-linux/>. Sprachen: en, de, es, fr, it, pt, nl, pl (Pfade `/`, `/de/`, `/es/` …).
Jede Seite ist vorgerendert und ohne JavaScript lesbar; das Skript (`src/site.js`) ist nur Komfort (Theme-Umschalter, Karussell, Feature-Bühne, Einblenden, Sprachhinweis).
Keine externen Skripte, keine Google Fonts, kein Tracking. Kein Actions-Workflow, die Veröffentlichung läuft lokal über `deploy.sh`.

## Aufbau

```text
src/page.html      eine Vorlage für alle Sprachen ({{t:key}} Text, {{h:key}} Text mit HTML, {{v:name}} Wert des Builders, <!--each:name--> Schleifen)
src/site.css       Gestaltung („clean“: flache Flächen, eine Akzentfarbe), hell/dunkel nach System
src/site.js        Komfort-Skript
src/bg.js          animierter Hintergrund „Two riders“ (Canvas, Punktraster, pausiert bei verstecktem Tab, steht still bei reduzierter Bewegung)
src/404.html       404-Seite (alle Sprachen eingebettet, das Skript wählt nach Pfad)
i18n/<lang>.json   Texte je Sprache; en.json ist die Quelle
static/            Schriften (Archivo, Figtree samt OFL), Favicon, Screenshots je Sprache, Schrift-Instanzen für die OG-Bilder
build.mjs          baut nach dist/ (Node ohne Framework, sharp für Bilder)
check.mjs          Prüfskript (npm test)
deploy.sh          baut, prüft, veröffentlicht auf den Branch gh-pages
scripts/process-shots.mjs   Rohaufnahmen → static/screens und docs/media
```

`npm test` baut und prüft. Der Build bricht ab, wenn in einer Sprache ein Schlüssel fehlt oder übrig ist, ein Platzhalter von en abweicht oder ein Schlüssel aus en.json nirgends benutzt wird.
`check.mjs` prüft: alle Seiten und Dateien vorhanden, `<html lang>`, Titel ≤ 60 und Beschreibung ≤ 155 Zeichen, genau ein `h1`, canonical, hreflang wechselseitig inkl. `x-default`, Open Graph und
Twitter, JSON-LD parsebar (SoftwareApplication mit Version aus `app/package.json`, FAQPage identisch zum sichtbaren Text), keine toten Links und Anker, Bilder mit Größe und Alt-Text, genau ein eager-Bild
(LCP), keine externen Ressourcen, Marken-Hinweis, kein CLI-Befehl, keine Erwähnung von KI, sitemap und robots.

## Befehle

```sh
cd site
npm ci
npm test          # bauen + prüfen
npm run serve     # dist/ lokal ansehen (npx serve)
```

Zum Bauen braucht sharp nur Node ≥ 20. Die OG-Bilder setzen Text mit den Schriften aus `static/og-fonts/` (Instanzen von Archivo und Figtree, umbenannt in „Archivo OG“ und „Figtree OG“, Lizenz OFL
wie in `static/fonts/`); dafür muss auf dem Rechner ein funktionierendes Fontconfig vorhanden sein.

## Neue Sprache

1. `i18n/<lang>.json` aus `en.json` ableiten (alle Schlüssel, gleiche Platzhalter). Fachbegriffe aus `app/src/renderer/locales/<lang>.ts` übernehmen, damit Website und App gleich sprechen.
2. Code in `LANGS`, `NATIVE` und `LOCALE` in `build.mjs` und `LANGS`/`LOCALE` in `check.mjs` eintragen.
3. Screenshots aufnehmen (unten) und `npm test`.

## Screenshots neu erzeugen

Die Bilder kommen aus der echten App mit simulierten Daten (kein Konto, kein Spiel), nicht aus dem Mockup. Aufnahme je Sprache mit `app/test/shots.mjs` (nutzt den Rahmen der Klicktests,
1600 × 1000, Selektoren statt Beschriftungen):

```sh
cd app && npm run build
for l in en de es fr it pt nl pl; do
  ROLLOUT_SIM_LANG=$l ROLLOUT_SHOTS=../site/shots-raw/$l ELECTRON_RUN_AS_NODE=1 npx electron test/shots.mjs
done
cd ../site && node scripts/process-shots.mjs
```

Am Ally `DISPLAY=:0` und `TMPDIR` auf btrfs setzen (siehe `app/README.md`). `process-shots.mjs` schreibt je Sprache `static/screens/<lang>/<name>.{webp,jpg}` und `<name>-640.webp` (1280 × 800 und 640 × 400)
sowie für das README `docs/media/screens/{en,de}/<name>.jpg` (je unter 300 KB) und `docs/media/hero-carousel.gif` (960 px, 5 Ansichten). Namen: home, pick, before-install, installing, done,
bluetooth, starting, error, settings, advanced, light, steam. `shots-raw/` ist nicht im Repo.

## Veröffentlichen

1. Voraussetzung: `Rollout.desktop` ist Asset des neuesten Releases (`releases/latest/download/Rollout.desktop`), sonst sind die Download-Knöpfe tot. `deploy.sh` prüft das vorab.
2. `site/deploy.sh` baut, prüft, committet den Inhalt von `dist/` in einen Worktree des Branches `gh-pages` (mit `.nojekyll`) und fragt vor dem Push nach. `--no-push` lässt den Push aus, `--yes` überspringt die Frage.
3. Einmalig: GitHub Pages auf „Deploy from branch“, Branch `gh-pages`, Ordner `/` stellen (Einstellungen oder `gh api repos/mace-ops/rollout-cycling-launcher-linux/pages`).

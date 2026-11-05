# Rollout website

Static, multilingual site for GitHub Pages: <https://mace-ops.github.io/rollout-cycling-launcher-linux/>. Languages: en, de, es, fr, it, pt, nl, pl (paths `/`, `/de/`, `/es/` …).
Every page is pre-rendered and readable without JavaScript; the script (`src/site.js`) is only a convenience (theme switch, carousel, feature stage, fade-in, language hint).
No external scripts, no Google Fonts, no tracking. No Actions workflow; publishing runs locally through `deploy.sh`.

## Layout

```text
src/page.html      one template for all languages ({{t:key}} text, {{h:key}} text with HTML, {{v:name}} builder value, <!--each:name--> loops)
src/site.css       styling ("clean": flat surfaces, one accent colour), light/dark by system
src/site.js        convenience script
src/bg.js          animated "Two riders" background (canvas, dot grid, pauses on a hidden tab, still with reduced motion)
src/404.html       404 page (all languages embedded, the script picks by path)
i18n/<lang>.json   texts per language; en.json is the source
static/            fonts (Archivo, Figtree with OFL), favicon, screenshots per language, font instances for the OG images
build.mjs          builds into dist/ (plain Node, sharp for images)
check.mjs          check script (npm test)
deploy.sh          builds, checks, publishes to the gh-pages branch
scripts/process-shots.mjs   raw captures → static/screens and media
```

`npm test` builds and checks. The build aborts if a language has a missing or extra key, a placeholder differs from en, or a key from en.json is not used anywhere.
`check.mjs` checks: all pages and files present, `<html lang>`, title ≤ 60 and description ≤ 155 characters, exactly one `h1`, canonical, reciprocal hreflang including `x-default`, Open Graph and
Twitter, JSON-LD parsable (SoftwareApplication with the version from `app/package.json`, FAQPage identical to the visible text), no dead links and anchors, images with size and alt text, exactly one eager image
(LCP), no external resources, trademark notice, no CLI command, no mention of AI, sitemap and robots.

## Commands

```sh
cd site
npm ci
npm test          # build + check
npm run serve     # view dist/ locally (npx serve)
```

Building needs only Node ≥ 20 for sharp. The OG images set text with the fonts from `static/og-fonts/` (instances of Archivo and Figtree, renamed "Archivo OG" and "Figtree OG", OFL licence
as in `static/fonts/`); this requires a working Fontconfig on the machine.

## New language

1. Derive `i18n/<lang>.json` from `en.json` (all keys, same placeholders). Take technical terms from `app/src/renderer/locales/<lang>.ts` so the website and the app speak the same way.
2. Add the code to `LANGS`, `NATIVE` and `LOCALE` in `build.mjs` and `LANGS`/`LOCALE` in `check.mjs`.
3. Capture screenshots (below) and run `npm test`.

## Regenerating screenshots

The images come from the real app with simulated data (no account, no game), not from the mockup. All language pages and both READMEs show the same English captures, only the captions are translated. Capturing uses `app/test/shots.mjs` (it uses the click tests' frame,
1600 × 1000, selectors instead of labels):

```sh
cd app && npm run build
ROLLOUT_SIM_LANG=en ROLLOUT_SHOTS=../site/shots-raw/en ELECTRON_RUN_AS_NODE=1 npx electron test/shots.mjs
cd ../site && node scripts/process-shots.mjs
```

On the Ally set `DISPLAY=:0` and `TMPDIR` on btrfs (see `app/README.md`). `process-shots.mjs` writes `static/screens/en/<name>.{webp,jpg}` and `<name>-640.webp` (1280 × 800 and 640 × 400)
and, for the READMEs, `media/screens/en/<name>.jpg` (each under 300 KB) and `media/hero-carousel.gif` (960 px, 5 views). Names: home, pick, before-install, installing, done,
bluetooth, starting, error, settings, advanced, light, steam. `shots-raw/` is not in the repo.

## Publishing

1. Download buttons: as long as `config.json` has `"downloadLive": false`, they are greyed out ("download coming", no `downloadUrl` in the JSON-LD). Set it to `true` as soon as `Rollout.desktop` is an asset of the latest release (`releases/latest/download/Rollout.desktop`), otherwise the download buttons are dead. `deploy.sh` checks this beforehand.
2. `site/deploy.sh` builds, checks, commits the content of `dist/` into a worktree of the `gh-pages` branch (with `.nojekyll`) and asks before pushing. `--no-push` skips the push, `--yes` skips the question.
3. Once: set GitHub Pages to "Deploy from branch", branch `gh-pages`, folder `/` (settings or `gh api repos/mace-ops/rollout-cycling-launcher-linux/pages`).
